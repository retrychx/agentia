import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncRunner, InMemoryTaskStore } from '../../src/index.js';
import type { AgentRunResult, AppCallable, TaskEvent, TaskRecord } from '../../src/index.js';
import { TaskEventError } from '../../src/transport/async.js';
import { createHttpHandler } from '../../src/transport/http.js';

/**
 * **待注入事件的上限**（2026-09-28 复审第三轮，定案 B：满了**说出来**，不静默丢）。
 *
 * 为什么这条闸存在：`TaskRecord.deliveredEventIds`（幂等簿记）是有界 FIFO 256，而**事件缓冲
 * `pendingEvents` 本身原先没有上限** —— 两条累积路径都不需要攻击者：调方反复投递、而这条 run
 * 每次都在恢复段**再次挂起**（事件刻意不在再挂起出口注入，见 spec §10 ⑥ 第 4 条）⇒ 每条事件
 * 都留在记录上，而记录随 trace 一起落库、每次 save 全文重写。
 *
 * 定案 **B**（满了拒绝：409 + 说清「本次事件没有被记录」）而不是 A（丢最旧）：A 若只丢缓冲、
 * 不摘 `deliveredEventIds`，发件方重投会拿到「已投递」的 409 **而事件其实已经没了** ——
 * 那是最坏的一种谎（静默丢事件）。「说出来，不静默」是本仓对这类边界的一贯口径。
 *
 * ⚠️ 「攒事件」在真实路径上只能靠**反复再挂起**（每次都要真跑一个 run）—— 用例不该为此跑 64 个
 * 回合。这里是**种记录**（与 durable-timer.test.ts 末尾那条探针同款）：考的是 `signalTask` 入口
 * 那道闸本身，而闸的判据与「攒到 64 条」的过程无关。
 */

/** 与 `async.ts` 的 `MAX_PENDING_EVENTS` 同值 —— 本文件钉的正是这个边界，改实现要一起改这里 */
const CAP = 64;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function events(n: number, withIds = false): TaskEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    type: `evt.${i}`,
    payload: 'x',
    ...(withIds ? { eventId: `id-${i}` } : {}),
  }));
}

/** 一条「挂着、且缓冲已有 n 条待注入事件」的记录 */
function suspended(id: string, pending: TaskEvent[], withIds = false): TaskRecord {
  return {
    taskId: id,
    status: 'suspended',
    suspendedReason: 'timer',
    suspendedSince: Date.now() - 60_000,
    wakeAt: Date.now() + 3_600_000,
    pendingEvents: pending,
    ...(withIds ? { deliveredEventIds: pending.map((e) => e.eventId!) } : {}),
    spec: { messages: [{ role: 'user', content: 'x' }], options: {}, source: 'async' },
    createdAt: Date.now() - 60_000,
  } as TaskRecord;
}

const app: AppCallable = {
  name: 'probe',
  async run() {
    return {
      run: { runId: 'r1', status: 'succeeded' as const },
      result: {} as AgentRunResult,
    };
  },
};

async function listen(
  app_: AppCallable,
  runner: AsyncRunner,
): Promise<{ server: Server; base: string }> {
  const server = createServer(createHttpHandler(app_, { runner }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

describe('signalTask —— 待注入事件的上限（满了说出来，不静默丢）', () => {
  it('边界：缓冲 63 条时还能收下（正好到 CAP）', async () => {
    const store = new InMemoryTaskStore();
    await store.save(suspended('task_edge', events(CAP - 1)));
    // 用「挂着不返回」的 app：派发出去的那次 run 不许把记录推成终态 —— 终态会清
    // `pendingEvents`（见 async.ts 的终态分支），而本用例要读的正是「投递那一刻的记录」
    const hanging: AppCallable = { name: 'hang', run: () => new Promise<never>(() => {}) };
    const runner = new AsyncRunner(hanging, { store });

    const rec = await runner.signalTask('task_edge', { type: 'batch.done', payload: 'ok' });
    assert.equal(rec.pendingEvents!.length, CAP, '第 CAP 条是收下的（上限是「最多 CAP 条」）');
    assert.equal(
      (await store.get('task_edge'))?.pendingEvents?.length,
      CAP,
      '落库了（先落库再派发）',
    );
  });

  it('满：409，且记录**一个字节都不动**（本次事件没有被记录）', async () => {
    const store = new InMemoryTaskStore();
    const seeded = suspended('task_full', events(CAP));
    await store.save(seeded);
    const runner = new AsyncRunner(app, { store });

    const err = await runner
      .signalTask('task_full', { type: 'overflow', payload: 'y' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    assert.ok(err instanceof TaskEventError, '抛的是 TaskEventError（HTTP 侧据此回 409）');
    assert.equal((err as TaskEventError).status, 409);
    assert.match((err as TaskEventError).message, /上限/, '文案要说清是「满了」，不是「已投递」');
    assert.match(
      (err as TaskEventError).message,
      /没有.*记录|未被记录/,
      '说清本次事件**没被收下**',
    );

    const after = await store.get('task_full');
    assert.equal(after?.status, 'suspended', '状态不动（没收下就不算投递）');
    assert.equal(after?.pendingEvents?.length, CAP, '缓冲不涨；也不丢旧的');
    assert.deepEqual(after?.pendingEvents, seeded.pendingEvents, '旧事件逐字未动');
    await sleep(20);
  });

  it('满了的 409 文案按挂起原因分叉（P2-2）：approval 指去 approve / cancel，timer 不许提 approve', async () => {
    const store = new InMemoryTaskStore();
    // approval 挂起：唯一触发源是 approve，不在投递方手里 —— 文案必须这么说（指路要指得通）
    await store.save({
      ...suspended('task_ap_full', events(CAP)),
      suspendedReason: 'approval',
      wakeAt: undefined,
      pendingApprovals: ['tu1'],
    } as TaskRecord);
    // timer 挂起：approve 对它是 409（原因闸）—— 文案**不许**指那条不存在的路
    await store.save(suspended('task_tm_full', events(CAP)));
    const runner = new AsyncRunner(app, { store });

    const errA = await runner
      .signalTask('task_ap_full', { type: 'x', payload: 'y' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    assert.match((errA as TaskEventError).message, /审批/, 'approval：要点名「在等人审批」');
    assert.match((errA as TaskEventError).message, /approve/, 'approval：触发源是 approve');

    const errT = await runner
      .signalTask('task_tm_full', { type: 'x', payload: 'y' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    assert.match((errT as TaskEventError).message, /到点|醒/, 'timer：指「等到点」');
    assert.doesNotMatch(
      (errT as TaskEventError).message,
      /先 approve/,
      'timer 挂起 approve 是 409 —— 文案不许指一条走不通的路',
    );
  });

  it('判据次序：缓冲满 + 同 eventId 重复 ⇒ 报「重复投递」（那条本来就在里面）', async () => {
    const store = new InMemoryTaskStore();
    await store.save(suspended('task_dup', events(CAP, true), true));
    const runner = new AsyncRunner(app, { store });

    const err = await runner
      .signalTask('task_dup', { type: 'again', payload: 'z', eventId: 'id-3' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    assert.ok(err instanceof TaskEventError);
    assert.equal((err as TaskEventError).status, 409);
    assert.match((err as TaskEventError).message, /重复投递/, '幂等在先：这条事件已经在缓冲里');
    assert.doesNotMatch((err as TaskEventError).message, /上限/, '不该误报成「满了」');
  });
});

describe('POST /tasks/:id/events —— 上限也是 HTTP 语义（409）', () => {
  it('缓冲满 ⇒ 409，error 文案说清「没有被记录」；不收下就不动状态', async () => {
    const store = new InMemoryTaskStore();
    await store.save(suspended('task_http_full', events(CAP)));
    const runner = new AsyncRunner(app, { store });
    const { server, base } = await listen(app, runner);
    try {
      const res = await fetch(`${base}/tasks/task_http_full/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'overflow', payload: 'y' }),
      });
      assert.equal(res.status, 409, '满了 = 说出来（不是 200，也不是静默丢弃）');
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? '', /上限/, '文案点名上限');
      assert.equal(
        (await runner.poll('task_http_full'))?.status,
        'suspended',
        '不收下 ⇒ 状态与缓冲都不动',
      );
    } finally {
      await close(server);
    }
  });
});
