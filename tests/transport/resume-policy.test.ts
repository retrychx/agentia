import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resumeSkipReason } from '../../src/transport/resume-policy.js';
import type { TaskRecord } from '../../src/store/store.js';

/** 认领判定只读 status / ownerId / startedAt / createdAt —— 不读 spec，夹具用最小形状 */
const rec = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    taskId: 't1',
    status: 'running',
    createdAt: 1_000,
    ...over,
  }) as unknown as TaskRecord;

const ME = 'proc-me';
const OTHER = 'proc-other';

describe('resume-policy —— 崩溃恢复的认领判定（从 AsyncRunner 抽出）', () => {
  it('状态不合法 ⇒ terminal；且状态**先判**（终态记录即便 ownerId 是自己也不是 own-process）', () => {
    for (const status of ['succeeded', 'failed', 'awaiting_approval'] as const) {
      assert.equal(
        resumeSkipReason(rec({ status }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
        'terminal',
        status,
      );
    }
    assert.equal(
      resumeSkipReason(rec({ status: 'succeeded', ownerId: ME }), {
        ownerId: ME,
        staleAfterMs: 0,
        now: 9e9,
      }),
      'terminal',
      '顺序：先判状态再判归属',
    );
  });

  it('本进程的记录一律不碰（它一定还活着）—— 这条就是「重复执行」那个 bug 的闸', () => {
    assert.equal(
      resumeSkipReason(rec({ ownerId: ME }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
      'own-process',
    );
    assert.equal(
      resumeSkipReason(rec({ ownerId: ME, startedAt: 0 }), {
        ownerId: ME,
        staleAfterMs: 10 ** 12,
        now: 1,
      }),
      'own-process',
      '保鲜期开了也不影响：自己的记录永远不抢',
    );
  });

  it('他进程刚起的别抢；边界是严格小于（恰好到期即可抢）', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000 };
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt: 6_000 }), opts),
      'too-fresh',
      '距今 4000ms < 5000ms',
    );
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt: 5_000 }), opts),
      undefined,
      '恰好 5000ms = 到期，可抢（严格小于）',
    );
  });

  it('起跑时间退化链 startedAt → createdAt（容忍手工塞进来的记录）', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000 };
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, createdAt: 9_000 }), opts),
      'too-fresh',
      '缺 startedAt ⇒ 退到 createdAt',
    );
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, createdAt: 1_000 }), opts), undefined);
  });

  it('staleAfterMs = 0：不看他进程的起跑时间，立刻可抢', () => {
    const opts = { ownerId: ME, staleAfterMs: 0, now: 10_000 };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 9_999 }), opts), undefined);
  });

  it('无主记录（ownerId 缺失）永远可抢 —— 否则崩溃留下的孤儿会「看起来太新」而无人捡', () => {
    const opts = { ownerId: ME, staleAfterMs: 10 ** 9, now: 10 };
    assert.equal(resumeSkipReason(rec({ createdAt: 10 }), opts), undefined);
  });

  it('可抢的常规情形：queued/running + 他进程 + 已过保鲜期', () => {
    for (const status of ['queued', 'running'] as const) {
      assert.equal(
        resumeSkipReason(rec({ status, ownerId: OTHER, startedAt: 0 }), {
          ownerId: ME,
          staleAfterMs: 1_000,
          now: 10_000,
        }),
        undefined,
        status,
      );
    }
  });
});
