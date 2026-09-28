import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, InMemoryTaskStore } from '../../src/index.js';
import type { AgentRunResult, AppCallable, TaskRecord } from '../../src/index.js';
import { TaskApproveError } from '../../src/transport/async.js';

/**
 * `approve` 的**入参校验**（外部深评 P1-2，2026-09-28）。
 *
 * 事实（实证复现见「5000 个无关键」那条）：`#approveInner` 把 decisions 里的每个键都写进
 * `rec.approvals`，**不校验它是不是本任务待决的 id**；而 `approvalsComplete` 只保证
 * 「待决的都齐了」，对多出来的键完全沉默。多出来的键随每次 `save` 全文重写落库、
 * 并随任务**永久保留**（终态也不清：审批记录是审计的一部分）⇒ 一个**认证调用方**
 * 单次请求就能把记录从几百字节撑到几百 KB，反复调用可无限叠加。
 *
 * 这与 `parseApproveBody`（形状全有或全无）、`parseEventBody`（多一个字段即拒）是同一条纪律：
 * **拒整批比半接受安全** —— 调用方本来就知道要批哪些 id（它从记录的 `pendingApprovals` 读的）。
 */

const suspended: TaskRecord = {
  taskId: 'task_ap',
  status: 'suspended',
  suspendedReason: 'approval',
  suspendedSince: Date.now() - 1_000,
  pendingApprovals: ['tu1'],
  spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
  createdAt: Date.now() - 60_000,
} as TaskRecord;

const app: AppCallable = {
  name: 'probe',
  async run() {
    return { run: { runId: 'r1', status: 'succeeded' as const }, result: {} as AgentRunResult };
  },
};

async function seeded(): Promise<{ runner: AsyncRunner; store: InMemoryTaskStore }> {
  const store = new InMemoryTaskStore();
  await store.save({ ...suspended });
  return { runner: new AsyncRunner(app, { store }), store };
}

describe('approve —— 入参校验：只许批本任务待决的 id', () => {
  it('多出来的 id ⇒ 整批拒（400），记录**一字不动**（不写进 approvals、状态不变）', async () => {
    const { runner, store } = await seeded();
    const before = JSON.stringify(await store.get('task_ap'));

    const err = await runner
      .approve('task_ap', {
        tu1: { approved: true },
        'pump-0': { approved: true },
      })
      .then(() => undefined)
      .catch((e: unknown) => e);

    assert.ok(err instanceof TaskApproveError, '抛 TaskApproveError（HTTP 侧据此回 400）');
    assert.equal((err as TaskApproveError).status, 400);
    assert.match(
      (err as TaskApproveError).message,
      /不在.*待决列表/,
      '文案点名「不在待决列表」（调用方据此知道该去读 pendingApprovals）',
    );
    const after = JSON.stringify(await store.get('task_ap'));
    assert.equal(after, before, '整批拒 ⇒ 记录一个字节都没动（连那个合法的 tu1 也不收）');
    assert.equal((await store.get('task_ap'))?.status, 'suspended', '状态不动');
  });

  it('实证那 5000 个无关键：现在整批拒，记录体积不变（原先 +418 974 字节）', async () => {
    const { runner, store } = await seeded();
    const before = JSON.stringify(await store.get('task_ap')).length;

    const junk: Record<string, { approved: boolean }> = {};
    for (let i = 0; i < 5000; i++) junk[`pump-${i}`] = { approved: true };
    const err = await runner
      .approve('task_ap', { tu1: { approved: true }, ...junk })
      .then(() => undefined)
      .catch((e: unknown) => e);

    assert.ok(err instanceof TaskApproveError);
    const after = JSON.stringify(await store.get('task_ap')).length;
    assert.equal(after, before, '体积不变（这是 P1-2 的判据：记录随 save 全文重写、终态也不清）');
  });

  it('阳性对照：只批待决的那个 ⇒ 照常恢复（校验没有把正常路径一起拒掉）', async () => {
    const store = new InMemoryTaskStore();
    await store.save({ ...suspended });
    // 挂着不返回的 app：派发出去的那次 run 不许把记录推成终态（本用例读的是「恢复那一刻」）
    const hanging: AppCallable = { name: 'hang', run: () => new Promise<never>(() => {}) };
    const runner = new AsyncRunner(hanging, { store });
    const rec = await runner.approve('task_ap', { tu1: { approved: true, reason: '看过' } });
    assert.equal(rec.approvals?.tu1.approved, true);
    assert.equal(rec.status, 'running', '决定齐了 ⇒ 恢复');
    assert.equal((await store.get('task_ap'))?.status, 'running');
  });
});
