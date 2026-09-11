import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultEstimateTokens,
  estimateMessages,
  trimToolPairs,
  compactMessages,
  createBudgetPolicy,
} from '../../src/index.js';
import type Anthropic from '@anthropic-ai/sdk';

describe('长上下文策略', () => {
  it('defaultEstimateTokens：ASCII 按 4 字符/token，CJK 按 1.5 字/token', () => {
    assert.equal(defaultEstimateTokens('a'.repeat(40)), 10);
    const zh = defaultEstimateTokens('汉'.repeat(30)); // 30 中文字符 ≈ 20 token
    assert.ok(zh >= 18 && zh <= 22, `得到 ${zh}`);
    const mixed = defaultEstimateTokens('a'.repeat(40) + '汉'.repeat(30));
    assert.ok(mixed >= 28 && mixed <= 32, `混合 ${mixed}`);
  });

  it('estimateMessages 累计 role 与内容', () => {
    const n = estimateMessages([{ role: 'user', content: 'a'.repeat(40) }]);
    assert.ok(n > 10 && n < 20, `得到 ${n}`);
  });

  it('trimToolPairs：丢旧工具对、保留最近 keepRecent 对', () => {
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }] });
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r' }] });
    }
    const trimmed = trimToolPairs(msgs, { keepRecent: 2 });
    assert.equal(trimmed.length, 4); // 5 对丢 3 对留 2 对
    assert.ok(JSON.stringify(trimmed).includes('t3'), '保留的是最近的工具对');
    assert.ok(!JSON.stringify(trimmed).includes('t0'));
    // 无需裁剪时返回原数组引用
    assert.equal(trimToolPairs(trimmed, { keepRecent: 2 }), trimmed);
  });

  it('compactMessages：旧前缀变摘要并入尾段首条 user', async () => {
    const msgs: Anthropic.MessageParam[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const out = await compactMessages(msgs, { keepRecent: 2, summarize: (h) => `SUM(${h.length})` });
    assert.equal(out.length, 2); // 摘要并入尾段首条普通 user + 末尾 assistant
    assert.ok(JSON.stringify(out[0]).includes('SUM('));
    assert.ok(JSON.stringify(out[1]).includes('m9'));
  });

  it('createBudgetPolicy：预算内原样放行；超预算先裁剪；滞回防连续压缩', async () => {
    const small: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
    const policy = createBudgetPolicy({ budgetTokens: 100, summarize: () => 'S', keepRecent: 1, compactEvery: 2 });
    assert.equal(await policy.beforeTurn(small, { iteration: 0, model: 'm' }), small);

    const big: Anthropic.MessageParam[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(100) + i,
    }));
    const c1 = await policy.beforeTurn(big, { iteration: 1, model: 'm' });
    assert.ok(JSON.stringify(c1).includes('S'), '应发生压缩');
    // 滞回：距上次压缩 < compactEvery 回合，不再压
    const c2 = await policy.beforeTurn(big, { iteration: 2, model: 'm' });
    assert.ok(!JSON.stringify(c2).includes('S'));
  });

  it('trimToolPairs：非严格交替（连续两条 assistant 带 tool_use）→ 放弃裁剪，不切出孤立块', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'go' },
      // 畸形：两条 assistant 各带 tool_use，结果挤在第三条 user 里
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't0', content: 'r0' },
          { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
        ],
      },
    ];
    // 按相邻性配对会只丢 [1,2] 对，把 t0 的 tool_use 变成孤立块 → 后续请求 400。
    // 检测到畸形即整体放弃裁剪（返回原数组引用）。
    assert.equal(trimToolPairs(msgs, { keepRecent: 0 }), msgs);
  });

  it('trimToolPairs：孤立的 tool_result（上一条不是带 tool_use 的 assistant）→ 放弃裁剪', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'r0' }] },
    ];
    assert.equal(trimToolPairs(msgs, { keepRecent: 0 }), msgs);
  });

  it('createBudgetPolicy：keepToolPairs 决定编辑保留的「对数」（与 keepRecent 的「条数」分离）', async () => {
    // 每条消息都很大，确保超预算；5 对工具交换
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: 'x'.repeat(400) }];
    for (let i = 0; i < 5; i++) {
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: { pad: 'y'.repeat(200) } }],
      });
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'z'.repeat(200) }],
      });
    }
    // 无摘要器 → 只做 context editing，不会压缩；budgetTokens 故意极小
    const policy = createBudgetPolicy({ budgetTokens: 10, editBeforeCompact: true, keepToolPairs: 2 });
    const out = await policy.beforeTurn(msgs, { iteration: 0, model: 'm' });
    assert.ok(JSON.stringify(out).includes('t3'), '保留最近 2 对');
    assert.ok(!JSON.stringify(out).includes('t0'), '丢掉更旧的对');
  });
});
