import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, InMemoryTaskStore } from '../../src/index.js';
import type { AppCallable } from '../../src/index.js';
import type { AgentRunResult } from '../../src/index.js';
import type { TaskRecord, TaskStore } from '../../src/index.js';

/** 模拟 fsStore/sqliteStore 这类**同步** store：终态落库时同步抛错（磁盘满、库锁） */
class SyncThrowOnTerminalStore extends InMemoryTaskStore {
  override save(rec: TaskRecord): void {
    if (rec.status === 'succeeded') throw new Error('disk full');
    super.save(rec);
  }
}

function fakeApp(fn?: () => Promise<void>): AppCallable & { calls: number } {
  const app = {
    name: 'fake',
    calls: 0,
    async run() {
      app.calls++;
      await fn?.();
      return {
        run: { runId: `r-${app.calls}`, status: 'succeeded' as const },
        result: {} as AgentRunResult,
      };
    },
  };
  return app;
}

describe('AsyncRunner', () => {
  it('幂等键去重：未失败的同键返回既有记录，失败的同键可重提', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const t1 = runner.submit('a', { idempotencyKey: 'k' });
    await runner.awaitTask(t1.taskId);
    const t2 = runner.submit('a', { idempotencyKey: 'k' }); // succeeded → 去重
    assert.equal(t2.taskId, t1.taskId);
    assert.equal(app.calls, 1);

    // failed → 允许新任务
    const failApp: AppCallable = {
      name: 'f',
      run: async () => ({
        run: { runId: 'x', status: 'failed' as const },
        result: { error: { type: 'api', message: 'm', retryable: false } } as AgentRunResult,
      }),
    };
    const r2 = new AsyncRunner(failApp);
    const f1 = r2.submit('a', { idempotencyKey: 'k' });
    await r2.awaitTask(f1.taskId);
    assert.equal(r2.poll(f1.taskId)?.status, 'failed');
    const f2 = r2.submit('a', { idempotencyKey: 'k' });
    assert.notEqual(f2.taskId, f1.taskId);
  });

  it('concurrency=1：第二个任务在槽位释放前保持 queued；submit 返回快照不被原地改', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp(() => gate);
    const runner = new AsyncRunner(app, { concurrency: 1 });
    const t1 = runner.submit('a');
    const t2 = runner.submit('b');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.calls, 1);
    assert.equal(runner.poll(t2.taskId)?.status, 'queued');
    assert.equal(t1.status, 'queued', 'submit 返回的是提交时刻快照');
    release();
    await runner.awaitTask(t1.taskId);
    await runner.awaitTask(t2.taskId);
    assert.equal(app.calls, 2);
  });

  it('同步 store 落库抛错：不逃逸成 unhandled rejection，槽位照常释放', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const store = new SyncThrowOnTerminalStore();
      const app = fakeApp();
      const runner = new AsyncRunner(app, { store, concurrency: 1 });
      const t1 = runner.submit('a');
      const t2 = runner.submit('b');
      await runner.awaitTask(t1.taskId, { timeoutMs: 2_000 });
      await runner.awaitTask(t2.taskId, { timeoutMs: 2_000 }); // 槽位泄漏时这里会超时
      assert.equal(app.calls, 2, '落库抛错后槽位必须仍被释放');
      assert.equal(runner.poll(t1.taskId)?.status, 'succeeded');
      await new Promise((r) => setTimeout(r, 20)); // 给潜在的 unhandled rejection 落地机会
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('非法 concurrency 抛错', () => {
    assert.throws(() => new AsyncRunner(fakeApp(), { concurrency: 0 }), /concurrency/);
  });

  it('awaitTask 超时抛错', async () => {
    let never!: () => void;
    const gate = new Promise<void>(() => {
      never = () => {};
    });
    const app = fakeApp(() => gate);
    const runner = new AsyncRunner(app);
    const t = runner.submit('a');
    await assert.rejects(runner.awaitTask(t.taskId, { timeoutMs: 50 }), /等待超时/);
    void never;
  });

  it('resumePending：认领他进程的残留记录，跳过本进程的自己（一定还活着）', async () => {
    const store = new InMemoryTaskStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hang = fakeApp(() => gate); // 进程 A：认领后卡住（模拟中断）
    const a = new AsyncRunner(hang, { store, concurrency: 1 });
    const t = a.submit('a');
    for (let i = 0; i < 100 && store.get(t.taskId)?.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(store.get(t.taskId)!.ownerId, a.ownerId);

    // 同一进程 resumePending：自己的记录还在内存里跑，重派就是跑两遍
    assert.equal(a.resumePending(), 0);
    assert.equal(hang.calls, 1);

    // 新进程（同 store）：把他进程的残留认领过来执行
    const b = fakeApp();
    const rb = new AsyncRunner(b, { store });
    assert.equal(rb.resumePending(), 1);
    assert.equal(store.get(t.taskId)!.ownerId, rb.ownerId, '认领时改写 ownerId');
    await rb.awaitTask(t.taskId);
    assert.equal(store.get(t.taskId)!.status, 'succeeded');
    assert.equal(b.calls, 1);
    release(); // 放掉 A 那次挂起的执行（其残留写入不再断言）
  });

  it('resumePending({staleAfterMs})：跳过刚起的他进程记录，超保鲜期的才抢', async () => {
    const store = new InMemoryTaskStore();
    const app = fakeApp();
    const runner = new AsyncRunner(app, { store });
    const mk = (taskId: string, startedAt: number): TaskRecord => ({
      taskId,
      status: 'running',
      spec: { messages: [{ role: 'user', content: 'x' }] },
      createdAt: startedAt,
      startedAt,
      ownerId: 'p999-otherproc', // 他进程（可能仍在跑）
    });
    const now = Date.now();
    store.save(mk('task_fresh', now));
    store.save(mk('task_old', now - 10 * 60_000));

    // 缺省 0 = 不判断，一律重派（单进程旧语义）
    assert.equal(runner.resumePending(), 2);

    // 保鲜期 5 分钟：刚起的那个不抢（大概正被那个进程执行），超期的照抢
    const store2 = new InMemoryTaskStore();
    const runner2 = new AsyncRunner(fakeApp(), { store: store2 });
    store2.save(mk('task_fresh', now));
    store2.save(mk('task_old', now - 10 * 60_000));
    assert.equal(runner2.resumePending({ staleAfterMs: 5 * 60_000 }), 1);
    assert.equal(store2.get('task_old')!.status, 'queued');
    assert.equal(store2.get('task_fresh')!.status, 'running', '不动的记录保持原状');
    await runner2.awaitTask('task_old');
  });

  it('runTimeoutMs：超时任务标 failed 并回收槽位（底层执行无法真正取消）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const app: AppCallable = {
      name: 'fake',
      async run() {
        call++;
        if (call === 1) await gate; // 第一个任务永不返回
        return {
          run: { runId: `r-${call}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { concurrency: 1, runTimeoutMs: 30 });
    const t1 = runner.submit('a');
    const rec = await runner.awaitTask(t1.taskId, { timeoutMs: 2_000 });
    assert.equal(rec.status, 'failed');
    assert.match(rec.error?.message ?? '', /执行超时/);

    // 槽位已回收：concurrency=1 下第二个任务仍能起跑（不被超时任务永久占住）
    const t2 = runner.submit('b');
    const rec2 = await runner.awaitTask(t2.taskId, { timeoutMs: 2_000 });
    assert.equal(rec2.status, 'succeeded');
    assert.equal(call, 2);
    release(); // 放掉第一次被放弃的执行（其结果无人接收）
  });

  it('runTimeoutMs 校验：负数抛错', () => {
    assert.throws(() => new AsyncRunner(fakeApp(), { runTimeoutMs: -1 }), /runTimeoutMs/);
  });

  it('异步 store 的 byIdempotency reject：同步门面必须订阅，不得逃逸成 unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const map = new Map<string, TaskRecord>();
      let lookups = 0;
      const store: TaskStore = {
        save: (rec) => {
          map.set(rec.taskId, { ...rec });
        },
        get: (id) => map.get(id),
        // 异步 store：**submit 的即时去重**这一次 lookup 直接 reject（Redis 抖动）。
        // submit 的同步门面无法 await，但必须订阅该 Promise —— 否则就是
        // unhandledRejection（Node ≥15 终止宿主）。后续 #execute 的 lookup 正常。
        byIdempotency: () => {
          lookups++;
          return lookups === 1 ? Promise.reject(new Error('redis down')) : undefined;
        },
        list: () => [...map.values()],
        clear: () => map.clear(),
      };
      const runner = new AsyncRunner(fakeApp(), { store });
      const t = runner.submit('a', { idempotencyKey: 'k' });
      const rec = await runner.awaitTask(t.taskId, { timeoutMs: 2_000 });
      assert.equal(rec.status, 'succeeded', '即时去重的 lookup 失败不得影响任务执行');
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(rejections, [], '被拒的 Promise 必须已订阅，不得逃逸');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('初始 save 迟到 reject：不得把已成功的 run 覆写成 failed', async () => {
    let rejectInitial!: (e: unknown) => void;
    const initialSave = new Promise<void>((_, rej) => {
      rejectInitial = rej;
    });
    let saveCalls = 0;
    const map = new Map<string, TaskRecord>();
    const store: TaskStore = {
      save: (rec) => {
        saveCalls++;
        map.set(rec.taskId, { ...rec }); // 本地已落，但**初始 save 的 Promise 稍后 reject**
        return saveCalls === 1 ? initialSave : undefined;
      },
      get: (id) => map.get(id),
      byIdempotency: () => undefined,
      list: () => [...map.values()],
      clear: () => map.clear(),
    };
    const runner = new AsyncRunner(fakeApp(), { store });
    const t = runner.submit('a');
    const rec = await runner.awaitTask(t.taskId, { timeoutMs: 2_000 });
    assert.equal(rec.status, 'succeeded');

    // 此刻 run 已成功落库；初始 save 的 reject 迟到 —— 不得改判为 failed
    rejectInitial(new Error('disk full'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(map.get(t.taskId)?.status, 'succeeded', '落库终态必须与真实结果一致');
  });
});
