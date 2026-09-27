import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, runAgentScoped } from '../../src/engine/loop.js';
import { forwardToolContext } from '../../src/engine/forwarded.js';
import { attachScore } from '../../src/core/trace.js';
import type { AgentTool, ToolRunContext } from '../../src/core/tool.js';
import { mockClient, endTurnMsg, toolUseMsg, U } from '../helpers.js';
import { exportRun } from '../../src/eval/export.js';

/**
 * trace → 训练数据导出（R8-P3b）的框架侧纯函数。
 *
 * 夹具全是**真引擎跑出来的** trace（mockClient 驱动），不手搓 span 树 ——
 * 手搓的夹具会与真实记账形状漂开而没人发现。
 */

const noop: AgentTool = {
  name: 'noop',
  description: 'no-op',
  inputSchema: { type: 'object', properties: {} },
  run: async (input) => `结果:${JSON.stringify(input)}`,
};

async function realTrace(traceContent?: 'full') {
  const r = await runAgent({
    messages: [{ role: 'user', content: '查一下天气' }],
    client: mockClient([toolUseMsg('noop', { city: '北京' }, 'tu1'), endTurnMsg('北京今天晴，25℃')])
      .client,
    tools: [noop],
    ...(traceContent ? { traceContent } : {}),
  });
  return r.trace;
}

describe('exportRun（R8-P3b：trace → 训练数据记录）', () => {
  it('全量记录的 run：完整对话（真文本 + tool_use/tool_result 配对合法）', async () => {
    const trace = await realTrace('full');
    const rec = exportRun(trace);

    assert.deepEqual(rec.meta.incomplete, ['input'], '只缺原始输入（trace 不记它）');
    const roles = rec.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);

    const head = rec.messages[0]!;
    assert.match(String(head.content), /原始输入未入 trace/, '首条 user 是占位并自陈');

    const a1 = rec.messages[1]!.content as unknown as Array<Record<string, unknown>>;
    assert.equal(a1.length, 1, '纯 tool_use 回合只有 tool_use 块（没有文本块，也不算缺口）');
    const tu = a1.find((b) => b.type === 'tool_use')!;
    assert.equal(tu.id, 'tu1');
    assert.equal(tu.name, 'noop');
    assert.deepEqual(tu.input, { city: '北京' }, '入参 JSON.parse 还原为对象');

    const u2 = rec.messages[2]!.content as unknown as Array<Record<string, unknown>>;
    const tr = u2[0]!;
    assert.equal(tr.type, 'tool_result');
    assert.equal(tr.tool_use_id, 'tu1', '按 tool_use_id 配对');
    assert.equal(tr.is_error, undefined, '成功出参不带 is_error 键');
    assert.match(String(tr.content), /结果/);

    const a2 = rec.messages[3]!.content as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(a2, [{ type: 'text', text: '北京今天晴，25℃' }], '真文本（output.text）入列');
  });

  it('未开 traceContent 的 run：不造占位文本，缺席标 incomplete', async () => {
    const trace = await realTrace();
    const rec = exportRun(trace);
    assert.deepEqual(
      rec.meta.incomplete.sort(),
      ['assistant-text', 'input', 'no-final-assistant'],
      '终端回合的 assistant 文本缺席必须标注（占位文本进训练数据是投毒）；'
        + '末条是 user 就再标 no-final-assistant（这条样本没有 loss 目标）',
    );
    // 工具回合的 assistant 只剩 tool_use 块；终端回合没有真文本 ⇒ 整条 assistant 不产生
    const roles = rec.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user']);
    const flat = JSON.stringify(rec.messages);
    assert.equal(flat.includes('北京今天晴'), false, '没有真文本就一个字都不造');
  });

  it('meta：model / stopReason / status / scores 都从 run 根取', async () => {
    const trace = await realTrace('full');
    attachScore(trace, { name: 'eval', value: 1, source: 'unit', comment: '好' });
    attachScore(trace, { name: 'human', value: 0.5 });
    const rec = exportRun(trace);
    assert.equal(rec.meta.model, 'claude-opus-5');
    assert.equal(rec.meta.stopReason, 'end_turn');
    assert.equal(rec.meta.status, 'ok');
    assert.deepEqual(rec.meta.scores, [
      { name: 'eval', value: 1 },
      { name: 'human', value: 0.5 },
    ]);
  });

  it('子 agent 嵌套回合不进主线，计数记 meta.nestedTurns', async () => {
    const childRunner: AgentTool = {
      name: 'child',
      description: '拉起子循环',
      inputSchema: { type: 'object', properties: {} },
      run: async (_i, ctx?: ToolRunContext) => {
        const r = await runAgentScoped({
          client: mockClient([endTurnMsg('子 agent 的回答')]).client,
          messages: [{ role: 'user', content: '子任务' }],
          recorder: ctx!.recorder,
          parentSpanId: ctx!.parentSpanId,
          ...forwardToolContext(ctx!),
        });
        return r.finalText;
      },
    };
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([toolUseMsg('child', {}, 'tu1'), endTurnMsg('主收尾')]).client,
      tools: [childRunner],
      traceContent: 'full',
    });
    const rec = exportRun(r.trace);
    assert.equal(rec.meta.nestedTurns, 1, '嵌套回合计数');
    const assistantTexts = rec.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text);
    assert.deepEqual(assistantTexts, ['主收尾'], '嵌套回合的 assistant 文本不进主线对话');
    // （它的**结果**会进主线 —— 那是 tool_result 通道，是主线的合法视角，不算泄漏）
  });

  it('缺输出的 tool_use 补 is_error 占位（协议要求配对合法）', async () => {
    const trace = await realTrace('full');
    // 模拟半截 trace：摘掉 tool.output 事件（run 中断的 run 段长这样）
    const turn = trace.spans.find((s) => s.events.some((e) => e.name === 'tool.output'))!;
    turn.events = turn.events.filter((e) => e.name !== 'tool.output');
    const rec = exportRun(trace);
    const u2 = rec.messages[2]!.content as unknown as Array<Record<string, unknown>>;
    assert.equal(u2[0]!.is_error, true);
    assert.match(String(u2[0]!.content), /输出未入 trace/);
  });

  it('没有主循环回合的 trace：只有占位 user，incomplete 标 input + 无终答', async () => {
    const trace = await realTrace('full');
    trace.spans = trace.spans.filter((s) => s.kind !== 'llm.turn');
    const rec = exportRun(trace);
    assert.equal(rec.messages.length, 1);
    assert.deepEqual(rec.meta.incomplete, ['input', 'no-final-assistant'],
      '只有占位 user ⇒ 这条样本没有 loss 目标，必须标出来');
  });

  it('混合回合 + 未开 traceContent：正文缺席必须标注（此前静默）', async () => {
    // 反向验证：删掉 exportRun 收尾那段合取 ⇒ 本用例红在 incomplete 里没有 'assistant-text'。
    const mixed = {
      id: 'm1',
      model: 'claude-opus-5',
      stop_reason: 'tool_use' as const,
      usage: U,
      content: [
        { type: 'text', text: '我先查查天气再回答你' },
        { type: 'tool_use', id: 'tu1', name: 'noop', input: { city: '北京' } },
      ],
    };
    const r = await runAgent({
      messages: [{ role: 'user', content: '查一下天气' }],
      client: mockClient([mixed, endTurnMsg('北京晴')]).client,
      tools: [noop],
      maxIterations: 1, // 第一回合后收尾 ⇒ 没有「终端文本回合」来触发旧判据
    });
    const rec = exportRun(r.trace);
    assert.ok(
      rec.meta.incomplete.includes('assistant-text'),
      '整棵 trace 一行正文都没有 ⇒ 混合回合的正文缺席必须标注（不能因「有 tool_use」当成本来没文本）',
    );
    assert.equal(
      JSON.stringify(rec.messages).includes('我先查查天气'),
      false,
      '守的是「缺席被标注」，不是「正文被找回」：正文确实不在导出物里',
    );
  });
});
