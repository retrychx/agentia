import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, InMemoryTaskStore } from '../../src/index.js';
import type { AppCallable } from '../../src/index.js';
import type { AgentRunResult } from '../../src/index.js';

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

  it('resumePending：queued/running 记录重新派发执行', async () => {
    const store = new InMemoryTaskStore();
    const app = fakeApp();
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('a');
    store.save({ ...store.get(t.taskId)!, status: 'running' }); // 模拟进程中断残留
    const n = runner.resumePending();
    assert.equal(n, 1);
    await runner.awaitTask(t.taskId);
    assert.equal(runner.poll(t.taskId)?.status, 'succeeded');
  });
});
