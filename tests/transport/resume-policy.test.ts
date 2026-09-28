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
    for (const status of ['succeeded', 'failed'] as const) {
      assert.equal(
        resumeSkipReason(rec({ status }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
        'terminal',
        status,
      );
    }
    // 挂起单列一档（2026-09-28 ①）：一条在睡的 run **不是**终态 —— 把它报成 'terminal'
    // 是静默说错话（这个字段的全部用途就是诊断）。它的唤醒归各自那条闸管，不归崩溃续跑。
    assert.equal(
      resumeSkipReason(rec({ status: 'suspended' }), { ownerId: ME, staleAfterMs: 0, now: 9e9 }),
      'suspended',
    );
    assert.equal(
      resumeSkipReason(rec({ status: 'suspended', ownerId: ME }), {
        ownerId: ME,
        staleAfterMs: 0,
        now: 9e9,
      }),
      'suspended',
      '顺序：挂起最优先摘出（连归属都不看 —— 它根本不是我的活）',
    );
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

/**
 * 租约档（2026-09-28 T2）：`too-fresh` 是**新鲜度**（记录起跑多久了），不是**租约**
 * （主人还在不在）—— 上面对它的每条用例都过不了「主人其实死了 / 其实还在」这一层。
 * 本块钉的是：**能问到 pid 就问 pid，问不到才看时间**。
 */
describe('租约判定：同主机能问到 pid 就不看时间', () => {
  it('ownerAlive === true ⇒ owner-alive：**记录再老也不抢**（长跑被抢 = 真重复执行）', () => {
    // 回归：修复前只有新鲜度这一档。`now - startedAt` 早就超过 staleAfterMs ⇒ 返回 undefined
    // ⇒ 一条正在别的进程里老老实实跑着的长任务被本进程接手再跑一遍（副作用与花费翻倍）。
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10 ** 9, ownerAlive: () => true };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 0 }), opts), 'owner-alive');
  });

  it('ownerAlive === false ⇒ 立刻可抢：崩溃孤儿**不等保鲜期**（等就饿死）', () => {
    // 回归：修复前这条「刚起」的记录被 'too-fresh' 挡下。而前任已崩、继任启动即扫一次，
    // 扫描是**惰性**的（框架不养定时器）⇒ 扫完就再没人扫，那条记录永远停在 running。
    const opts = { ownerId: ME, staleAfterMs: 10 ** 9, now: 10, ownerAlive: () => false };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 10 }), opts), undefined);
  });

  it('ownerAlive === undefined（异主机 / 旧格式）⇒ 退回新鲜度，逐字 ≡ 升级前', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000, ownerAlive: () => undefined };
    assert.equal(
      resumeSkipReason(rec({ ownerId: OTHER, startedAt: 6_000 }), opts),
      'too-fresh',
      '判不了 ⇒ 还是「看起来太新」这一档',
    );
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 5_000 }), opts), undefined);
  });

  it('没接 ownerAlive（宿主不给缝）与「判不了」同义：只看保鲜期', () => {
    const opts = { ownerId: ME, staleAfterMs: 5_000, now: 10_000 };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 6_000 }), opts), 'too-fresh');
  });

  it('staleAfterMs = 0 ⇒ **根本不问探针**（缺省语义与升级前逐字一致）', () => {
    let asked = 0;
    const opts = {
      ownerId: ME,
      staleAfterMs: 0,
      now: 10,
      ownerAlive: () => {
        asked++;
        return true;
      },
    };
    assert.equal(resumeSkipReason(rec({ ownerId: OTHER, startedAt: 9 }), opts), undefined);
    assert.equal(asked, 0, '不看他进程就别去惊动进程表 —— 「缺省 0」得是免费的那条路');
  });

  it('无主记录不问探针：没有主人可问，它永远可抢', () => {
    let asked = 0;
    const opts = {
      ownerId: ME,
      staleAfterMs: 10 ** 9,
      now: 10,
      ownerAlive: () => {
        asked++;
        return true;
      },
    };
    assert.equal(resumeSkipReason(rec({ createdAt: 10 }), opts), undefined);
    assert.equal(asked, 0);
  });

  it('顺序：own-process 先于 owner-alive（自己的记录不该被说成「主人在」）', () => {
    // 两档的**处置一样**（都不抢），但诊断名不一样 —— 而这个字段的全部用途就是诊断。
    // 「本进程」是比「同主机某进程活着」更精确的答案，不能被更弱的判据抢答。
    assert.equal(
      resumeSkipReason(rec({ ownerId: ME, startedAt: 0 }), {
        ownerId: ME,
        staleAfterMs: 5_000,
        now: 10 ** 9,
        ownerAlive: () => true,
      }),
      'own-process',
    );
  });
});
