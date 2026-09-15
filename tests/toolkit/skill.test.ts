import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Skill, collectSkills, skillToTool, TraceRecorder, runAgent } from '../../src/index.js';
import type { AgentTool, SkillContext, SkillCapability, ToolRunContext } from '../../src/index.js';
import { mockClient, endTurnMsg, toolUseMsg, U } from '../helpers.js';

/** 自造 stop_reason：让受限子运行以「未识别的 stop_reason」失败（loop.error 由 engine 挂） */
function rawMsg(stop_reason: string, text = 'part'): Record<string, unknown> {
  return {
    id: 'm-raw',
    model: 'claude-opus-5',
    stop_reason,
    usage: U,
    content: [{ type: 'text', text }],
  };
}

/** 模拟主 agent 运行中的调用现场（engine 注入的 ToolRunContext） */
function makeCtx(client: ToolRunContext['client']) {
  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', 'test.run', null);
  const ctx: ToolRunContext = { client, recorder, parentSpanId: rootId };
  return { ctx, recorder };
}

/** 取容器实例上的唯一 skill 能力 */
function onlySkill(instance: object): SkillCapability {
  const capabilities = collectSkills(instance);
  assert.equal(capabilities.length, 1);
  return capabilities[0];
}

describe('Skill 能力（ctx.llm 受限子运行）', () => {
  it('方法体调 ctx.llm 拿到文本；capability span 正常收尾且 llm.turn 递归其下', async () => {
    class Summarizer {
      @Skill({ description: 'd' })
      async summarize(input: { text: string }, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: `总结：${input.text}` });
        return `[${out.stopReason}] ${out.text}`;
      }
    }
    const { client } = mockClient([endTurnMsg('摘要内容')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Summarizer()), () => []);

    const out = await tool.run({ text: 't' }, ctx);
    assert.equal(out, '[end_turn] 摘要内容');

    const trace = recorder.snapshot('ok');
    const capability = trace.spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'ok');
    // 受限子运行的回合挂在 capability 下（不双开 run 根）
    const turn = trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(turn.parentSpanId, capability.spanId);
  });

  it('受限子运行失败：capability span 挂的是 engine 的丰富 error（type/retryable），不是新造的 Error', async () => {
    class Fragile {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const { client } = mockClient([rawMsg('model_context_window_exceeded', '半截')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Fragile()), () => []);

    // 对主 agent 仍是 is_error 语义（抛错 → engine 包成 tool_result）
    await assert.rejects(async () => tool.run({}, ctx), /unknown_stop_reason/);

    const capability = recorder.snapshot('error').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    // loop.error 是 { type:'agent_error', retryable:false }（engine 判定的语义）；
    // 若走外层 catch 的 classifyError(new Error(report)) 会退化成 type:'unknown'，
    // 「不可重试的模型侧异常」这个信息就丢了
    assert.equal(capability.error?.type, 'agent_error');
    assert.equal(capability.error?.retryable, false);
    assert.match(capability.error?.message ?? '', /model_context_window_exceeded/);
  });

  it('预算护栏透传 ctx.llm 子循环（C1）：子循环超支即停，主 run 以 budget_exceeded 收尾', async () => {
    class Searcher {
      @Skill({ description: 'd', tools: ['noop'] })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const noop: AgentTool = {
      name: 'noop',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () => 'ok',
    };
    // 主 turn（15）+ 子 turn×2（45 ≤ 50）→ 子第 3 回合后 60 > 50 → 子循环 budget_exceeded
    const { seen, client } = mockClient([
      toolUseMsg('go', {}, 'tu_main'),
      toolUseMsg('noop', {}, 's1'),
      toolUseMsg('noop', {}, 's2'),
      toolUseMsg('noop', {}, 's3'),
      toolUseMsg('noop', {}, 's4'),
      endTurnMsg('不该被请求到'),
    ]);
    const tool = skillToTool(onlySkill(new Searcher()), () => [noop]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxTotalTokens: 50,
    });

    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(seen.length, 4, '主 1 次 + 子 3 次；子循环超支后主循环不得再发请求');
    const capability = result.trace.spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    assert.equal(capability.error?.type, 'budget_exceeded');
  });
});
