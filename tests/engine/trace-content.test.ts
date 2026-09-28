import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, runAgentScoped } from '../../src/engine/loop.js';
import { forwardToolContext } from '../../src/engine/forwarded.js';
import type { AgentTool, ToolRunContext } from '../../src/core/tool.js';
import type { Span } from '../../src/core/trace.js';
import { mockClient, endTurnMsg, toolUseMsg } from '../helpers.js';

/**
 * opt-in 记录 assistant 文本（R8-P3a，`traceContent: 'full'`）。
 *
 * 钉住的语义：
 * - 缺省**不记**（现状逐字不变 —— llm.turn 只有 usage/事件，replay 的有损边界不动）；
 * - 'full' 时每回合模型文本落该 llm.turn 的 `output.text`（多块 `\n` 连接，引擎口径）；
 * - 截断过 `maxEventChars` 同一道闸（它管「多长」，traceContent 管「记不记」）；
 * - 纯 tool_use 回合（无文本块）不记 —— 空串属性是「这回合说了什么」的假信号；
 * - 透传子循环（forwarded.ts 同一棵树同口径）；快照记 `config.traceContent`。
 */

const llmSpans = (spans: Span[]) => spans.filter((s) => s.kind === 'llm.turn');

describe('traceContent: 记录 assistant 文本（R8-P3a）', () => {
  it('缺省不记：llm.turn 没有 output.text 属性', async () => {
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('正文不该进 trace')]).client,
    });
    const turn = llmSpans(r.trace.spans)[0]!;
    assert.equal('output.text' in turn.attributes, false, '缺省不得记录模型正文');
    // 既有记账面不受影响
    assert.equal(typeof turn.attributes.output_tokens, 'number');
  });

  it("'full'：output.text = 模型文本（多块按 \\n 连接，引擎口径）", async () => {
    const twoBlocks = {
      id: 'm',
      model: 'm',
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    };
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([twoBlocks]).client,
      traceContent: 'full',
    });
    const turn = llmSpans(r.trace.spans)[0]!;
    assert.equal(turn.attributes['output.text'], '第一段\n第二段');
  });

  it('纯 tool_use 回合不记（无文本块），后续文本回合照记', async () => {
    const tool: AgentTool = {
      name: 'noop',
      description: 'no-op',
      inputSchema: { type: 'object', properties: {} },
      run: async () => 'done',
    };
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([toolUseMsg('noop', {}, 'tu1'), endTurnMsg('收尾文本')]).client,
      tools: [tool],
      traceContent: 'full',
    });
    const turns = llmSpans(r.trace.spans);
    assert.equal(turns.length, 2);
    assert.equal(
      'output.text' in turns[0]!.attributes,
      false,
      '纯 tool_use 回合没有文本可记，不该留空串属性',
    );
    assert.equal(turns[1]!.attributes['output.text'], '收尾文本');
  });

  it('截断走 maxEventChars 同一道闸：数字上限带省略标记，false 不截断', async () => {
    const long = 'x'.repeat(100);
    const capped = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg(long)]).client,
      traceContent: 'full',
      maxEventChars: 10,
    });
    assert.equal(
      llmSpans(capped.trace.spans)[0]!.attributes['output.text'],
      'xxxxxxxxxx…(+90)',
      '数字上限：截断 + 省略标记（与事件正文同口径）',
    );

    const uncapped = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg(long)]).client,
      traceContent: 'full',
      maxEventChars: false,
    });
    assert.equal(llmSpans(uncapped.trace.spans)[0]!.attributes['output.text'], long);
  });

  it('缺省上限 = 成功出参档（2000 字符）', async () => {
    const long = 'y'.repeat(2100);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg(long)]).client,
      traceContent: 'full',
    });
    const text = llmSpans(r.trace.spans)[0]!.attributes['output.text'] as string;
    assert.equal(text, `${'y'.repeat(2000)}…(+100)`, '缺省按 2000 截断');
  });

  it('透传子循环：同一棵调用树上子 agent 的 llm.turn 也记 output.text', async () => {
    // 工具体内拉起子循环（subagent.ts/skill.ts 同款姿势：...forwardToolContext(ctx)）
    const childRunner: AgentTool = {
      name: 'child',
      description: '拉起子循环',
      inputSchema: { type: 'object', properties: {} },
      run: async (_input, ctx?: ToolRunContext) => {
        const r = await runAgentScoped({
          client: mockClient([endTurnMsg('子 agent 正文')]).client,
          messages: [{ role: 'user', content: 'child task' }],
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
    const texts = llmSpans(r.trace.spans).map((s) => s.attributes['output.text']);
    assert.deepEqual(
      texts,
      [undefined, '子 agent 正文', '主收尾'],
      '子循环的回合也要记（同树同口径）',
    );
  });

  it('快照：开启时记 config.traceContent，缺省不记', async () => {
    const on = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('ok')]).client,
      traceContent: 'full',
    });
    assert.equal(
      on.trace.spans.find((s) => s.kind === 'run')!.attributes['config.traceContent'],
      'full',
    );
    const off = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('ok')]).client,
    });
    assert.equal(
      'config.traceContent' in off.trace.spans.find((s) => s.kind === 'run')!.attributes,
      false,
    );
  });
});
