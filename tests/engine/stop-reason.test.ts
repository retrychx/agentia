import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, Message } from '../../src/core/message.js';
import { resolveStopReason } from '../../src/engine/stop-reason.js';

/**
 * 夹具：判定只读 stop_reason 与 content —— id/model/usage 不参与，故用最小形状 + 断言式转型
 * （这条转型是夹具的边界，不是被测面上的口子）。
 */
const msg = (stop_reason: string | null, content: ContentBlock[] = []): Message =>
  ({
    id: 'm1',
    type: 'message',
    role: 'assistant',
    content,
    model: 'm',
    stop_reason,
    stop_sequence: null,
    usage: {},
  }) as unknown as Message;

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string, name: string): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});

describe('stop-reason —— 回合收尾的纯判定（从 turn.ts 抽出）', () => {
  it('end_turn / stop_sequence：正常收尾，**不挂**结构化 error', () => {
    for (const sr of ['end_turn', 'stop_sequence'] as const) {
      const r = resolveStopReason(msg(sr, [text('done')]), 1_000);
      if (r.kind !== 'finish') throw new Error(`应为 finish，实际 ${r.kind}`);
      assert.equal(r.stopReason, sr);
      assert.equal(
        r.error,
        undefined,
        `${sr} 是正常收尾 —— 挂 error 会让「护栏拦下的」与「自然结束」混为一谈`,
      );
      assert.equal(r.finalText, 'done');
    }
  });

  it('refusal / max_tokens / pause_turn：非正常收尾一律挂结构化 error（retryable: false）', () => {
    for (const sr of ['refusal', 'max_tokens', 'pause_turn'] as const) {
      const r = resolveStopReason(msg(sr, [text('x')]), 4_096);
      if (r.kind !== 'finish') throw new Error(`应为 finish，实际 ${r.kind}`);
      assert.equal(r.stopReason, sr);
      assert.ok(r.error, `${sr} 不带 error ⇒ trace 里这个 run「失败却没有原因」`);
      assert.equal(r.error.retryable, false);
    }
  });

  it('max_tokens 的 error 带上 maxTokens 数值（截断要看得见顶在哪）', () => {
    const r = resolveStopReason(msg('max_tokens', [text('t')]), 4_096);
    if (r.kind !== 'finish') throw new Error('应为 finish');
    assert.match(r.error?.message ?? '', /4096/);
  });

  it('tool_use 且有块 ⇒ tools，只留 tool_use 块（顺序保持）', () => {
    const r = resolveStopReason(
      msg('tool_use', [text('想一下'), toolUse('tu1', 'echo'), toolUse('tu2', 'fetch')]),
      1_000,
    );
    if (r.kind !== 'tools') throw new Error('应为 tools');
    assert.deepEqual(
      r.toolUses.map((t) => t.id),
      ['tu1', 'tu2'],
    );
  });

  it('tool_use 但块为空（畸形响应）⇒ tool_use_no_blocks + 结构化 error（这条曾漏挂过）', () => {
    const r = resolveStopReason(msg('tool_use', [text('只有文本，没有工具块')]), 1_000);
    if (r.kind !== 'finish') throw new Error('应为 finish');
    assert.equal(r.stopReason, 'tool_use_no_blocks');
    assert.equal(r.error?.type, 'agent_error');
    assert.match(r.error?.message ?? '', /没有任何 tool_use 块/);
  });

  it('未识别的 stop_reason（含 null）且无块 ⇒ unknown_stop_reason，error 里带原值', () => {
    for (const sr of ['banana', null]) {
      const r = resolveStopReason(msg(sr, []), 1_000);
      if (r.kind !== 'finish') throw new Error('应为 finish');
      assert.equal(r.stopReason, 'unknown_stop_reason');
      assert.match(r.error?.message ?? '', new RegExp(String(sr)));
    }
  });

  it('未识别的 stop_reason 但**有**块 ⇒ 仍然执行工具（块优先于字符串）', () => {
    const r = resolveStopReason(msg('banana', [toolUse('tu1', 'echo')]), 1_000);
    assert.equal(r.kind, 'tools');
  });

  it('finalText 走引擎口径：多文本块按 \n 连接（保住模型的分段）', async () => {
    const r = resolveStopReason(msg('end_turn', [text('第一段'), text('第二段')]), 1_000);
    if (r.kind !== 'finish') throw new Error('应为 finish');
    assert.equal(r.finalText, '第一段\n第二段');
  });
});
