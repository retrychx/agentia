import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, InMemoryTaskStore } from '../../src/index.js';
import type { AgentRunResult, AppCallable, TaskRecord } from '../../src/index.js';

/**
 * **drain 竞态：三条恢复路径的闸必须对齐**（2026-09-28 复审第二轮的产物）。
 *
 * 背景（为什么这条缝存在）：三条「外部输入把挂起任务推进起来」的路径都是同一个形状 ——
 * **先落库（status → running + ownerId）、再派发 `#execute`**。落库与派发之间隔着 store
 * 往返的窗口，`drain()` 若在这个窗口里完成（`active === 0` 于是返回），那条被推进的任务
 * 就会在**停机完成之后**才开跑 —— 部署进程已经在退出的路上。
 *
 * 已修的只有「到期唤醒」那一支（`#wakeDueInner` 里的 `if (this.#drain.isDraining) return target`）。
 * 本文件的用例把「三支」这个集合钉住：`approve` / `signalTask` 两支今天**没有**那道闸 ——
 * 同一个窗口、同一条后果。所以先红的那两条就是本轮的缺陷，第三条是**阳性对照**
 * （证明「不派发」这件事本身可观测、不是靠任务本来就跑不起来蒙对的）。
 *
 * 修法（与 wakeDue 一字不差）：窗口过后若已在停机，就**不派发** —— 状态已落库成
 * `running`，记录留给下次启动的 `resumePending()` 认领（at-least-once 兜底，
 * 与「先落库再派发」的崩窗同形）。事件与审批决定都在记录里，不会丢。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一条挂起记录的最小形状（与 durable-timer.test.ts 末尾那条探针同款） */
function suspended(id: string, extra: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: id,
    status: 'suspended',
    suspendedSince: Date.now() - 60_000,
    spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
    createdAt: Date.now() - 60_000,
    ...extra,
  } as TaskRecord;
}

function probeApp(runs: { count: number }): AppCallable {
  return {
    name: 'probe',
    async run() {
      runs.count++;
      return {
        run: { runId: `r-${runs.count}`, status: 'succeeded' as const },
        result: {} as AgentRunResult,
      };
    },
  };
}

describe('drain 竞态 —— 三条恢复路径的闸要对齐', () => {
  it('approve：drain 完成之后不许开跑（状态已落库成 running，留给下次启动认领）', async () => {
    const runs = { count: 0 };
    const store = new InMemoryTaskStore();
    await store.save(
      suspended('task_ap', { suspendedReason: 'approval', pendingApprovals: ['tu1'] }),
    );
    const runner = new AsyncRunner(probeApp(runs), { store });

    // 没有在飞任务 ⇒ 排空立刻完成（正是「窗口」发生的那一刻）
    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '挂起任务不挡排空');

    const rec = await runner.approve('task_ap', { tu1: { approved: true } });
    assert.equal(rec.status, 'running', '决定齐了 ⇒ 状态落 running（先落库再派发）');
    await sleep(50);
    assert.equal(runs.count, 0, 'drain 已完成 ⇒ 不许再派发（否则停机之后才开跑）');
    assert.equal(
      (await store.get('task_ap'))?.status,
      'running',
      '记录留给下次启动的 resumePending 认领（不派发 ≠ 丢决定）',
    );
  });

  it('signalTask：drain 完成之后不许开跑；事件必须留在记录上', async () => {
    const runs = { count: 0 };
    const store = new InMemoryTaskStore();
    await store.save(
      suspended('task_ev', { suspendedReason: 'timer', wakeAt: Date.now() + 3_600_000 }),
    );
    const runner = new AsyncRunner(probeApp(runs), { store });

    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '挂起任务不挡排空');

    const rec = await runner.signalTask('task_ev', { type: 'batch.done', payload: 'ok' });
    assert.equal(rec.status, 'running', '事件投递 ⇒ 状态落 running（先落库再派发）');
    await sleep(50);
    assert.equal(runs.count, 0, 'drain 已完成 ⇒ 不许再派发');
    const after = await store.get('task_ev');
    assert.equal(after?.status, 'running', '记录留给下次启动认领');
    assert.equal(after?.pendingEvents?.length, 1, '事件在记录里（下次认领时注入，不丢）');
  });

  it('阳性对照：到期唤醒这一支**本来就有**闸（证明上两条不是「任务本来就跑不起来」）', async () => {
    const runs = { count: 0 };
    const store = new InMemoryTaskStore();
    await store.save(
      suspended('task_due', { suspendedReason: 'timer', wakeAt: Date.now() - 1_000 }),
    );
    const runner = new AsyncRunner(probeApp(runs), { store });

    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '挂起任务不挡排空');
    assert.equal(runner.resumePending(), 0, '到期也不叫醒（#wakeDue 的闸）');
    await sleep(50);
    assert.equal(runs.count, 0, '没有派发');
  });
});
