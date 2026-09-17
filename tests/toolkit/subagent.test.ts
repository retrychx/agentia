import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, runAgent, subagentToTool } from '../../src/index.js';
import type { AgentTool, JsonSchema, SubAgentCapability, ToolRunContext } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { task: { type: 'string' } },
  required: ['task'],
};

const RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

function researcherCapability(over: Partial<SubAgentCapability['spec']> = {}): SubAgentCapability {
  const spec: SubAgentCapability['spec'] = {
    description: '调研子 agent',
    schema: TASK_SCHEMA,
    system: '你是调研员，完成后提交结构化结论。',
    ...over,
  };
  return {
    name: 'researcher',
    description: spec.description,
    inputSchema: spec.schema,
    spec,
  };
}

/** 模拟主 agent 运行中的调用现场（engine 注入的 ToolRunContext） */
function makeCtx(
  client: ToolRunContext['client'],
  over: Partial<ToolRunContext> = {},
): { ctx: ToolRunContext; recorder: TraceRecorder } {
  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', 'test.run', null);
  const ctx: ToolRunContext = { client, recorder, parentSpanId: rootId, ...over };
  return { ctx, recorder };
}

describe('子 agent typed 结果（SubAgentSpec.resultSchema）', () => {
  it('子 agent 调 submit_result：{ report, result } 结构化 tool_result 交回主 agent', async () => {
    const { seen, client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu1'),
        content: [
          { type: 'text', text: '调研结论：答案是 42' },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'submit_result',
            input: { answer: '42', confidence: 0.9 },
          },
        ],
      },
    ]);
    const { ctx, recorder } = makeCtx(client);
    const tool = subagentToTool(researcherCapability({ resultSchema: RESULT_SCHEMA }), () => []);

    const out = await tool.run({ task: '调研答案' }, ctx);

    // 结构化交回：report = 子 agent 最终报告（可读性优先），result = typed 结果
    assert.deepEqual(out, {
      report: '调研结论：答案是 42',
      result: { answer: '42', confidence: 0.9 },
    });

    // 子 agent 循环拿到了隐藏 submit_result 工具（input_schema = resultSchema）
    const childTools = (seen[0] as { tools: Array<{ name: string; input_schema: unknown }> }).tools;
    assert.deepEqual(
      childTools.map((t) => t.name),
      ['submit_result'],
    );
    assert.equal(childTools[0].input_schema, RESULT_SCHEMA);

    // capability span 正常收尾
    const capability = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.name, 'researcher');
    assert.equal(capability.status, 'ok');
    assert.equal(capability.attributes.stop_reason, 'end_turn');
  });

  it('resultSchema 已给但子 agent 未提交（纯文本 end_turn）：退化为纯文本报告', async () => {
    const { client } = mockClient([endTurnMsg('只有文字结论')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(researcherCapability({ resultSchema: RESULT_SCHEMA }), () => []);

    const out = await tool.run({ task: 't' }, ctx);
    assert.equal(out, '只有文字结论'); // 保持报告可读性：无 typed 时与不设 resultSchema 同形
  });

  it('未设 resultSchema：交回最终文本（行为与现状一致），子循环无隐藏工具', async () => {
    const { seen, client } = mockClient([endTurnMsg('普通报告')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(researcherCapability(), () => []);

    const out = await tool.run({ task: 't' }, ctx);
    assert.equal(out, '普通报告');
    const params = seen[0] as { tools?: Array<{ name: string }> };
    assert.equal(params.tools, undefined); // 无工具菜单（resolveTools 空 + 无隐藏工具）
  });

  it('子 agent 未正常收尾（max_iterations）：is_error 语义不变（抛错）', async () => {
    const { client } = mockClient([toolUseMsg('echo', { text: 'x' })]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(
      researcherCapability({ resultSchema: RESULT_SCHEMA, maxIterations: 1 }),
      () => [],
    );
    // 子 agent 死循环工具调用、超出 maxIterations → 抛错（engine 包成 is_error 回主 agent）
    await assert.rejects(async () => tool.run({ task: 't' }, ctx), /max_iterations/);
  });
});

describe('预算护栏透传子 agent 循环（C1：预算是整条 run 的口径）', () => {
  it('子循环每回合同样检查：子 agent 超支即停、主循环不再发新请求', async () => {
    let noopRan = 0;
    const noop: AgentTool = {
      name: 'noop',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        noopRan++;
        return 'ok';
      },
    };
    // 主 turn（15）+ 子 turn×2（累计 45 ≤ 50）→ 子第 3 回合记账后 60 > 50 → 子循环停；
    // 修复前：子循环看不到预算，会一直跑满脚本（5 次子请求 + 主循环还会继续发请求）
    const { seen, client } = mockClient([
      toolUseMsg('researcher', { task: 't' }, 'tu_main'),
      toolUseMsg('noop', {}, 's1'),
      toolUseMsg('noop', {}, 's2'),
      toolUseMsg('noop', {}, 's3'),
      toolUseMsg('noop', {}, 's4'),
      endTurnMsg('不该被请求到'),
    ]);
    const tool = subagentToTool(researcherCapability({ tools: ['noop'] }), () => [noop]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxTotalTokens: 50,
    });

    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(result.error?.type, 'budget_exceeded');
    assert.equal(result.trace.status, 'error');
    assert.equal(seen.length, 4, '主 1 次 + 子 3 次；子超支后主循环不得再发请求');
    assert.equal(noopRan, 2, '子循环超支的那个回合不执行工具');

    // 子循环的收尾语义：capability span 记 stop_reason=budget_exceeded + budget.exceeded 事件
    const capability = result.trace.spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    assert.equal(capability.attributes.stop_reason, 'budget_exceeded');
    assert.equal(capability.error?.type, 'budget_exceeded');
    assert.ok(
      capability.events.some((e) => e.name === 'budget.exceeded'),
      '超限事件要记在子 agent 的 capability span 上（哪一级烧穿的看得见）',
    );
    // 交回主 agent 的是 is_error 的 tool_result（不是正常报告）
    const mainTurn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const toolOut = mainTurn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((toolOut.body as { ok: boolean }).ok, false);
    // 主循环回合入口的再判也在 run 根留下痕迹
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    assert.ok(root.events.some((e) => e.name === 'budget.exceeded'));
  });

  it('工具超时口径透传子循环：子 agent 里的慢工具按超时记账，不得「永不超时」', async () => {
    // `toolTimeoutMs` 是 ToolRunContext 上唯一一件「主循环注入、嵌套能力必须往下交」的东西。
    // 漏了它不是「少一层保险」而是**反的**：子循环里 `args.toolTimeoutMs` 为 undefined
    // → `withTimeout(p, 0)` 直接返回原 promise（core/timeout.ts 的 `!(t > 0)`）= 永不超时；
    // 同时 MCP 桥找不到引擎预算，又起自己的 60s 兜底 = 双计时器 + 双账本。
    //
    // 直接喂一个带 toolTimeoutMs 的 ctx（engine 注入的现场）：这里要隔离的正是
    // 「ctx → 子循环」这一段，跑整条 run 的话外层那个 20ms 会先把 researcher 自己掐掉。
    let slowFinished = 0;
    const slow: AgentTool = {
      name: 'slow',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () =>
        new Promise((res) =>
          setTimeout(() => {
            slowFinished++;
            res('late');
          }, 200),
        ),
    };
    const { client } = mockClient([
      toolUseMsg('slow', {}, 's1'), // 子 agent 第一回合调慢工具
      endTurnMsg('调研报告'), // 超时不影响子循环跑完
    ]);
    const { ctx, recorder } = makeCtx(client, { toolTimeoutMs: 20 });
    const tool = subagentToTool(researcherCapability({ tools: ['slow'] }), () => [slow]);
    assert.equal(await tool.run({ task: 't' }, ctx), '调研报告');

    const capability = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability')!;
    const subTurn = recorder
      .snapshot('ok')
      .spans.find((s) => s.kind === 'llm.turn' && s.parentSpanId === capability.spanId)!;
    const out = subTurn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false, '子 agent 里的超时必须记成失败');
    assert.equal((out.body as { errorKind: string }).errorKind, 'timeout');
    assert.equal(slowFinished, 0, '超时是硬的：慢工具不得事后把结果写回');
  });

  it('子循环不超支时照常交回报告（透传不影响正常路径）', async () => {
    const { client } = mockClient([
      toolUseMsg('researcher', { task: 't' }, 'tu_main'),
      endTurnMsg('调研报告'),
      endTurnMsg('汇总完毕'),
    ]);
    const tool = subagentToTool(researcherCapability(), () => []);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxTotalTokens: 1000,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '汇总完毕');
    assert.equal(result.trace.status, 'ok');
  });
});
