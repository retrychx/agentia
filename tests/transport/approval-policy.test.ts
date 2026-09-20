import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalExpired,
  approvalsComplete,
  fillTimeoutDenials,
} from '../../src/transport/approval-policy.js';
import type { TaskRecord } from '../../src/store/store.js';

/**
 * 夹具：纯判定只读 status / approvals / pendingApprovals / 三个时间戳与 timeoutMs，
 * **不读 spec** —— 所以这里用最小形状（不必造一条合法 RunSpec 送进引擎）。
 * 这条 `as unknown as` 是夹具的边界，不是被测面上的口子。
 */
const rec = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    taskId: 't1',
    status: 'awaiting_approval',
    spec: {},
    createdAt: 1_000,
    ...over,
  }) as unknown as TaskRecord;

describe('approval-policy —— 审批的纯判定（从 AsyncRunner 抽出）', () => {
  it('approvalExpired：timeoutMs <= 0 表示不启用（再老的挂起也不算过期）', () => {
    const r = rec({ approvalPendingSince: 0 });
    assert.equal(approvalExpired(r, 10 ** 12, 0), false);
    assert.equal(approvalExpired(r, 10 ** 12, -1), false);
  });

  it('approvalExpired：只在 awaiting_approval 上成立（在跑 / 终态都不算）', () => {
    for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
      assert.equal(
        approvalExpired(rec({ status, approvalPendingSince: 0 }), 10 ** 12, 1_000),
        false,
        status,
      );
    }
    assert.equal(approvalExpired(rec({ approvalPendingSince: 0 }), 10 ** 12, 1_000), true);
  });

  it('approvalExpired：基准链 approvalPendingSince → startedAt → createdAt；边界是严格大于', () => {
    const both = { approvalPendingSince: 5_000, startedAt: 1, createdAt: 0 };
    assert.equal(approvalExpired(rec(both), 6_000, 1_000), false, '恰好等于不叫过期（严格大于）');
    assert.equal(approvalExpired(rec(both), 6_001, 1_000), true);
    assert.equal(
      approvalExpired(rec({ startedAt: 5_000, createdAt: 0 }), 6_001, 1_000),
      true,
      '缺挂起时刻 ⇒ 退到 startedAt',
    );
    // 夹具默认 createdAt=1000：要证明「退到 createdAt」，now 得比它多出**超过** timeoutMs
    assert.equal(
      approvalExpired(rec({}), 2_000, 1_000),
      false,
      '恰好超时量不算过期（退到 createdAt）',
    );
    assert.equal(approvalExpired(rec({}), 2_001, 1_000), true, '两个都缺 ⇒ 退到 createdAt');
  });

  it('fillTimeoutDenials：只补空着的待决项，人工决定一律保留（第一次决定赢）', () => {
    const r = rec({
      approvalPendingSince: 7_000,
      pendingApprovals: ['a', 'b'],
      approvals: {
        a: { approved: true, decidedBy: 'alice', decidedAt: 7_500, requestedAt: 7_000 },
      },
    });
    fillTimeoutDenials(r, 9_000);
    assert.deepEqual(
      r.approvals?.a,
      { approved: true, decidedBy: 'alice', decidedAt: 7_500, requestedAt: 7_000 },
      '人工「批准」绝不能被超时兜底翻成 deny',
    );
    assert.deepEqual(r.approvals?.b, {
      approved: false,
      reason: '审批超时',
      decidedBy: 'system',
      decidedAt: 9_000,
      requestedAt: 7_000,
    });
  });

  it('fillTimeoutDenials：approvals 缺失时建表；无挂起时刻则不写 requestedAt；无待决项是空操作', () => {
    const r = rec({ pendingApprovals: ['x'] });
    fillTimeoutDenials(r, 100);
    assert.deepEqual(r.approvals, {
      x: { approved: false, reason: '审批超时', decidedBy: 'system', decidedAt: 100 },
    });
    const empty = rec({});
    fillTimeoutDenials(empty, 100);
    assert.deepEqual(empty.approvals, {});
  });

  it('approvalsComplete：每个待决 id 都要有决定；空集为真（与抽取前的行内写法一致）', () => {
    assert.equal(
      approvalsComplete(
        rec({ pendingApprovals: ['a'], approvals: { a: { approved: false, decidedAt: 1 } } }),
      ),
      true,
    );
    assert.equal(
      approvalsComplete(
        rec({ pendingApprovals: ['a', 'b'], approvals: { a: { approved: false, decidedAt: 1 } } }),
      ),
      false,
      '缺一个就是没齐',
    );
    assert.equal(
      approvalsComplete(rec({ pendingApprovals: ['a'] })),
      false,
      'approvals 缺失 ⇒ 未齐',
    );
    assert.equal(approvalsComplete(rec({})), true, '没有待决项 ⇒ 齐（空集真值）');
  });
});
