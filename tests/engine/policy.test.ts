import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageParam } from '../../src/index.js';
import { createBudgetPolicy, runAgent } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/** 4 条普通消息（> keepRecent=2，保证压缩真的会调 summarize） */
function fourMessages(): MessageParam[] {
  return [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
  ];
}

describe('createBudgetPolicy 的 per-run 状态隔离（ContextPolicy.forRun）', () => {
  it('同一策略实例连跑两条 run：压缩滞回不跨 run 泄漏（两条 run 都照常压缩）', async () => {
    let summarizeCalls = 0;
    // 应用级单例的典型形态：同一个策略实例被所有 run 复用（AppOptions.contextPolicy）
    const shared = createBudgetPolicy({
      budgetTokens: 1, // 永远超预算 → 每回合都走降级分支
      keepRecent: 2,
      compactEvery: 10, // 滞回窗口刻意拉大：不隔离的话第二条 run 前 10 回合永不压缩
      summarize: () => {
        summarizeCalls++;
        return '摘要';
      },
    });

    const first = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: fourMessages(),
      contextPolicy: shared,
    });
    assert.equal(first.stopReason, 'end_turn');
    assert.equal(summarizeCalls, 1, '第一条 run 的回合 0 即压缩（lastCompactAt 初始 -∞）');

    const second = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: fourMessages(),
      contextPolicy: shared,
    });
    assert.equal(second.stopReason, 'end_turn');
    assert.equal(
      summarizeCalls,
      2,
      '第二条 run 必须同样能在自己的回合 0 压缩 —— 不被上一条 run 的 lastCompactAt 卡住',
    );
  });

  it('forRun 产物互不影响：fork 出的实例压缩过，不影响下一次 forRun 的滞回起点', async () => {
    let summarizeCalls = 0;
    const policy = createBudgetPolicy({
      budgetTokens: 1,
      keepRecent: 2,
      compactEvery: 10,
      summarize: () => {
        summarizeCalls++;
        return '摘要';
      },
    });
    const msgs1 = fourMessages();
    const fork1 = policy.forRun!();
    await fork1.beforeTurn(msgs1, { iteration: 0, model: 'm' });
    assert.equal(summarizeCalls, 1);
    // 同一 fork 内滞回生效：iteration 1 距上次压缩 1 < 10 → 不再压缩
    const msgs1b = fourMessages();
    await fork1.beforeTurn(msgs1b, { iteration: 1, model: 'm' });
    assert.equal(summarizeCalls, 1, '滞回在**同一 run 内**仍然生效');
    // 新 fork（= 新 run）滞回从零开始
    const fork2 = policy.forRun!();
    await fork2.beforeTurn(fourMessages(), { iteration: 0, model: 'm' });
    assert.equal(summarizeCalls, 2, '新 run 的滞回起点必须独立');
  });

  it('未实现 forRun 的自定义策略：原样复用（向后兼容），beforeTurn 正常被调', async () => {
    let calls = 0;
    const custom = {
      budgetTokens: 100,
      async beforeTurn(messages: MessageParam[]): Promise<MessageParam[]> {
        calls++;
        return messages;
      },
    };
    const result = await runAgent({
      client: mockClient([endTurnMsg('done')]).client,
      messages: [{ role: 'user', content: 'go' }],
      contextPolicy: custom,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(calls, 1, '无状态自定义策略不需要 forRun 也能用');
  });
});
