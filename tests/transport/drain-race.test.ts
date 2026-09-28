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
 * ⚠️ 一版修完就发现「三支」这个清单本身是**靠枚举维护**的：外部深评（2026-09-28）指出还有
 * **第四条**（`#expireAndResume` 的审批超时兜底，由 `poll()` 驱动 —— 而停机中允许轮询）与
 * **第五条**（`resumePending` 的认领循环）。根因不是漏写一行，是七个派发点散在各处、闸靠人记。
 * ⇒ 结构性修法：所有「先落库再派发」的点收成唯一入口 `#dispatch()`（闸只在那里判一次，
 * 源码级守卫用例钉「`#execute(` 只许出现在 `#dispatch` 里」）。本文件因此覆盖**五条**路径。
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

  it('审批超时兜底（**第四条路径**）：drain 完成之后，轮询也不许把它推进起来', async () => {
    // 外部深评（2026-09-28）抓到的第四条：`#expireAndResume`（审批超时自动全拒并恢复）与
    // `approve` 是**不同触发源、同一形状**（填决定 → 落库成 running → 派发），由 poll() 的
    // 惰性闸驱动 —— 而「停机中照常可轮询」是 HTTP 宿主的明确承诺（health check / LB 探针）。
    const runs = { count: 0 };
    const store = new InMemoryTaskStore();
    await store.save(
      suspended('task_exp', {
        suspendedReason: 'approval',
        pendingApprovals: ['tu1'],
        suspendedSince: Date.now() - 60_000, // 早就过了审批超时
      }),
    );
    const runner = new AsyncRunner(probeApp(runs), { store, approvalTimeoutMs: 1 });
    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '挂起任务不挡排空');

    await runner.poll('task_exp'); // 停机窗口里这一次轮询就够（探针实证：不修就跑了 1 次）
    await sleep(50);
    assert.equal(
      runs.count,
      0,
      'drain 已完成 ⇒ 兜底恢复也不许派发（drain 说「排空干净」就得是真话）',
    );
    assert.equal(
      (await store.get('task_exp'))?.status,
      'running',
      '决定已落库（超时兜底 = 全拒），记录留给下次启动认领',
    );
  });

  it('resumePending 的认领循环：drain 完成之后也不许派发（同名第五条）', async () => {
    const runs = { count: 0 };
    const store = new InMemoryTaskStore();
    // 「他进程崩溃留下的孤儿」：状态必须是 queued/running —— resume-policy 对 `suspended`
    // 具名跳过（「在等」不是「孤儿」，唤醒是各自那条闸的事）；ownerId 不是本进程 ⇒ 会被认领。
    await store.save({
      taskId: 'task_orphan',
      status: 'running',
      ownerId: 'p99999-deadbeef',
      startedAt: Date.now() - 60_000,
      createdAt: Date.now() - 60_000,
      spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
    } as TaskRecord);
    const runner = new AsyncRunner(probeApp(runs), { store });
    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '挂起任务不挡排空');

    runner.resumePending();
    await sleep(50);
    assert.equal(runs.count, 0, 'drain 已完成 ⇒ 认领循环也不许派发');
    assert.equal((await store.get('task_orphan'))?.status, 'queued', '认领已落库，留给下次启动');
  });

  it('拒绝要出声（不静默）：停机窗口里被拒的派发打一条 warn —— 且只有一条', async () => {
    // PR #164 复核 §1：这里的拒绝此前是一条裸 `return` —— 运维只看到一个停在 `running` 的
    // 任务，无从解释它为什么不跑（而 `drain()` 此刻已给宿主加了「必须退出」的义务）。
    // 停机窗口里可能有很多条记录被拒，但它们的原因**完全相同** ⇒ 只报一条。
    // 拦 console.warn 的写法与 tests/runtime/sinks.test.ts 同款。
    const runs = { count: 0 };
    const store = new InMemoryTaskStore();
    await store.save(
      suspended('task_warn', { suspendedReason: 'approval', pendingApprovals: ['tu1'] }),
    );
    await store.save({
      taskId: 'task_orphan_warn',
      status: 'running',
      ownerId: 'p99999-deadbeef',
      startedAt: Date.now() - 60_000,
      createdAt: Date.now() - 60_000,
      spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
    } as TaskRecord);
    const runner = new AsyncRunner(probeApp(runs), { store });
    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '挂起任务不挡排空');

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
    try {
      // 两条不同的恢复路径（approve = 第三条；resumePending 认领 = 第五条）
      await runner.approve('task_warn', { tu1: { approved: true } });
      await runner.resumePending({ staleAfterMs: 0 });
    } finally {
      console.warn = origWarn;
    }

    assert.equal(warnings.length, 1, `停机窗口里的拒绝只该报一条（实际 ${warnings.length} 条）`);
    assert.match(warnings[0]!, /停机中/, '文案含「停机中」字样（可 grep）');
    assert.match(warnings[0]!, /drain\(\)/, '文案要点名宿主的义务：drain() 之后退出');
    assert.equal(runs.count, 0, '出声归出声 —— 仍然一条都不许派发');
  });
});
