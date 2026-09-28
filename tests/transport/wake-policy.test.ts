import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSuspended, timerDue } from '../../src/transport/wake-policy.js';
import type { TaskRecord } from '../../src/store/store.js';

/**
 * 夹具：纯判定只读 status / suspendedReason / wakeAt，**不读 spec** ——
 * 所以用最小形状（与 approval-policy.test.ts 的夹具同一约定）。
 * 缺省时刻是「睡着的 timer」：本文件测的就是这条闸。
 */
const rec = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    taskId: 't1',
    status: 'suspended',
    suspendedReason: 'timer',
    wakeAt: 2_000,
    spec: {},
    createdAt: 1_000,
    ...over,
  }) as unknown as TaskRecord;

describe('wake-policy —— 到期唤醒的纯判定', () => {
  it('timerDue：到点即唤醒（边界是 `wakeAt <= now`，恰好等于也算到）', () => {
    assert.equal(timerDue(rec({ wakeAt: 2_000 }), 1_999), false, '还差 1ms：不叫醒');
    assert.equal(timerDue(rec({ wakeAt: 2_000 }), 2_000), true, '恰好到点：叫醒');
    assert.equal(timerDue(rec({ wakeAt: 2_000 }), 2_001), true, '过点了（进程睡过头）：照样叫醒');
  });

  it('timerDue：只在 suspended 上成立（在跑 / 终态 / 排队都不算）', () => {
    for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
      assert.equal(timerDue(rec({ status }), 10 ** 12), false, status);
    }
    assert.equal(timerDue(rec(), 10 ** 12), true, '只有挂起才谈「到点」');
  });

  it('timerDue：**原因**必须是 timer（等审批的挂起没有到点这回事）', () => {
    assert.equal(
      timerDue(rec({ suspendedReason: 'approval', wakeAt: undefined }), 10 ** 12),
      false,
    );
    // 阳性对照：同一条记录只把原因换成 timer、并给出时刻 ⇒ 立刻到点。
    // 没有这个对照，上面那句可能是靠「时间挂起永远不到点」蒙对的（真空变绿）
    assert.equal(timerDue(rec({ suspendedReason: 'timer', wakeAt: 1 }), 10 ** 12), true);
  });

  it('timerDue：缺 wakeAt ⇒ 永远不到点（**不**退化到 createdAt —— 猜错方向是提前开跑）', () => {
    assert.equal(timerDue(rec({ wakeAt: undefined }), 10 ** 12), false);
  });
});

describe('wake-policy —— 挂起读数（/healthz 的 suspended 段）', () => {
  it('空集：三个位都在，计数 0、nextWakeAt 是 **null**（不是 0）', () => {
    assert.deepEqual(summarizeSuspended([]), { approval: 0, timer: 0, nextWakeAt: null });
  });

  it('按**原因**分组计数（两种挂起混在一起也分得开）', () => {
    const s = summarizeSuspended([
      { reason: 'approval', wakeAt: undefined },
      { reason: 'approval', wakeAt: undefined },
      { reason: 'timer', wakeAt: 5_000 },
    ]);
    assert.equal(s.approval, 2);
    assert.equal(s.timer, 1);
  });

  it('nextWakeAt 取时间挂起里**最早**的那个；等审批的不参与（它没有时刻）', () => {
    const s = summarizeSuspended([
      { reason: 'timer', wakeAt: 9_000 },
      { reason: 'timer', wakeAt: 3_000 },
      { reason: 'approval', wakeAt: undefined },
    ]);
    assert.equal(s.nextWakeAt, 3_000);
  });

  it('只有等审批的挂起 ⇒ nextWakeAt 仍然是 null（不能退化成 0）', () => {
    const s = summarizeSuspended([{ reason: 'approval', wakeAt: undefined }]);
    assert.equal(s.timer, 0);
    assert.equal(s.nextWakeAt, null);
  });
});
