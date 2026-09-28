/*
 * `usage.missing` 事件的**发射条件** —— 引擎侧（2026-09-28 外部深评 S2）。
 *
 * 为什么要有这一条：适配器标出 `MessageUsage.unreported` 只完成了一半 ——
 * 真正让运维「看得见」的是 llm.turn span 上那条事件（报告与指标按事件名计数：
 * `usageMissingTurns` / `agentia_model_usage_missing_turns_total`）。
 * 事件发不发得出来、发在哪条 span 上、与 `usage.unpriced` 会不会串味，都在这里钉死。
 *
 * 顺带钉住那条**代价**：unreported 时成本估算会算出 0（模型有定价 ⇒ 不是 unpriced）
 * —— 这正是「`maxCostUsd` 静默失效」的机制，写成断言免得被当成 bug 改掉。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordTurnUsage } from '../../src/engine/turn.js';
import type { Message } from '../../src/core/message.js';

/** 在 DEFAULT_PRICING 里有定价的模型（见 engine/usage.ts） */
const PRICED = 'claude-opus-5';
/** 不在价格表里的模型（触发 usage.unpriced 的那一档） */
const UNPRICED = 'some-model-nobody-priced';

function harness(model = PRICED) {
  const events: Array<{ name: string; body: unknown }> = [];
  const ended: Array<{ usage?: { costEstimate?: number } }> = [];
  const ctx = {
    args: {
      model,
      recorder: {
        event: (_id: string, name: string, body: unknown) => {
          events.push({ name, body });
        },
        end: (_id: string, payload: { usage?: { costEstimate?: number } }) => {
          ended.push(payload);
        },
        // recordTurnUsage 还会把 token 数写成 span 属性（见 turn.ts）—— 本文件不关心，给个空实现
        setAttribute: () => {},
      },
    },
    pricing: undefined,
    unpricedSeen: new Set<string>(),
  } as unknown as Parameters<typeof recordTurnUsage>[0];
  return { ctx, events, ended };
}

function msg(usage: Record<string, unknown>): Message {
  return {
    id: 'm1',
    type: 'message',
    role: 'assistant',
    content: [],
    model: PRICED,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  } as unknown as Message;
}

const ZERO = { input_tokens: 0, output_tokens: 0 };

describe('S2：引擎按 `usage.unreported` 记 usage.missing 事件', () => {
  it('上游没给 usage ⇒ 记一条 usage.missing（带模型名），且成本算出来是 0（护栏因此不可用）', () => {
    const { ctx, events, ended } = harness();
    recordTurnUsage(ctx, 'turn_1', msg({ ...ZERO, unreported: true }), PRICED);
    assert.deepEqual(
      events.filter((e) => e.name === 'usage.missing').map((e) => e.body),
      [{ model: PRICED }],
      '必须出声：这才是「成本恒 0」被看见的那条通道',
    );
    assert.equal(
      events.some((e) => e.name === 'usage.unpriced'),
      false,
      '这不是「未定价」—— 模型有价格，是上游没给读数，两条信号不许串',
    );
    assert.equal(ended[0]?.usage?.costEstimate, 0, '代价如实：成本看起来就是 0');
  });

  it('上游给了 usage ⇒ 一条 usage.missing 都不发（不许假警报）', () => {
    const { ctx, events } = harness();
    recordTurnUsage(ctx, 'turn_1', msg({ input_tokens: 12, output_tokens: 9 }), PRICED);
    assert.equal(events.filter((e) => e.name === 'usage.missing').length, 0);
  });

  it('未定价模型 + 有计量 ⇒ 只发 usage.unpriced（两条信号互不冒充）', () => {
    const { ctx, events } = harness();
    recordTurnUsage(ctx, 'turn_1', msg({ input_tokens: 12, output_tokens: 9 }), UNPRICED);
    assert.deepEqual(
      events.map((e) => e.name),
      ['usage.unpriced'],
    );
  });
});
