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
    // ⚠️ 这条夹具**必须带一个过去的 wakeAt**：只写 `wakeAt: undefined` 的话，「摘掉原因判据」
    // 的变异照样返回 false（缺时刻那一条也在拦），用例就等于没钉住原因这一半 —— 变异电池
    // 跑出来的真事（第一版就是这么写的：那条变异当时**一条红都没有**）。
    assert.equal(
      timerDue(rec({ suspendedReason: 'approval', wakeAt: 1 }), 10 ** 12),
      false,
      '等人工的挂起即使带着一个过去的 wakeAt（宿主手写 / 旧版本记录），也不许被到期扫描捞走',
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

/**
 * **时钟回拨**（NTP 回拨 / 手动校时）—— 2026-09-29。与 `approvalExpired` 同类：
 * 回拨 ⇒ `wakeAt <= now` 更不成立 ⇒ **推迟唤醒**（睡得比预期久）。危险方向是反的
 * （**提前开跑** = 真实副作用），而那正是上面「缺 `wakeAt` 时不退化到 createdAt」那条
 * 取舍在防的事。两个方向都钉住，别让「顺手给回拨加个容差」把方向翻过去。
 *
 * ⚠️ **诚实标注：本块不构成独立哨兵。** 任何让「回拨 ⇒ 立刻唤醒」的改法（容差 / 取绝对值 /
 * 加分支持）都会**同时**打红上面那条「还差 1ms：不叫醒」—— 同一条判据的两个距离量，
 * 拆不开。它的价值是把方向写成可执行的事实，不是多一道防线（同一位置的既有教训见
 * `docs/guards.md` 里 `metrics.test.ts` 那行的「别把两条当成两个独立哨兵」）。
 */
describe('wake-policy —— 时钟回拨', () => {
  it('回拨 ⇒ 推迟唤醒（**不是**提前开跑）', () => {
    const r = rec({ wakeAt: 10 ** 12 });
    assert.equal(timerDue(r, 10 ** 12), true, '恰好到点');
    assert.equal(
      timerDue(r, 10 ** 12 - 3_600_000),
      false,
      '往回跳 1 小时 ⇒ 那条 run 继续睡（晚醒，不是早醒）',
    );
    assert.equal(timerDue(r, 0), false, '回拨到纪元起点也一样：只是「不到点」');
  });
});
