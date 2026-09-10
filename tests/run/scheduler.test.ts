import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, Scheduler } from '../../src/index.js';
import type { AppCallable, AgentRunResult } from '../../src/index.js';

function fakeApp(): AppCallable & { calls: number } {
  const app = {
    name: 'fake',
    calls: 0,
    async run() {
      app.calls++;
      return {
        run: { runId: `r-${app.calls}`, status: 'succeeded' as const },
        result: {} as AgentRunResult,
      };
    },
  };
  return app;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await sleep(5);
  }
}

describe('Scheduler', () => {
  it('every：周期触发多次，cancel 后不再触发', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const scheduler = new Scheduler(runner);
    try {
      const h = scheduler.every(20, 'tick');
      assert.equal(scheduler.active, 1);
      await waitFor(() => app.calls >= 2);

      h.cancel();
      assert.equal(scheduler.active, 0);
      await sleep(10); // 让 cancel 前已派发的微任务落地
      const settled = app.calls;
      await sleep(70);
      assert.equal(app.calls, settled, 'cancel 后不再派发新任务');

      // 每次触发 = submit 一次异步任务，默认 source 带调度 id 前缀
      const sources = runner.list().map((r) => r.spec.source ?? '');
      assert.ok(sources.length >= 2);
      for (const s of sources) assert.match(s, /^schedule:[0-9a-f]{8}/);
    } finally {
      scheduler.stop();
    }
  });

  it('every + idempotencyPrefix：幂等键按 interval 窗口分片，同窗口不重复', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const scheduler = new Scheduler(runner);
    try {
      scheduler.every(20, 'tick', { idempotencyPrefix: 'p' });
      await waitFor(() => runner.list().length >= 2);
      scheduler.stop();

      const keys = runner.list().map((r) => r.idempotencyKey ?? '');
      for (const k of keys) assert.match(k, /^p:\d+$/, '窗口分片键 = 前缀:窗口序号');
      assert.equal(new Set(keys).size, keys.length, '每个窗口一个键，互不重复');
      assert.equal(app.calls, keys.length, '同窗口去重：任务数 = 执行次数');
    } finally {
      scheduler.stop();
    }
  });

  it('at：一次性触发，固定幂等键，触发后 job 自动移除', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const scheduler = new Scheduler(runner);
    try {
      scheduler.at(new Date(Date.now() + 30), 'once', {
        idempotencyPrefix: 'one',
        source: 'custom-src',
      });
      assert.equal(scheduler.active, 1);
      await waitFor(() => app.calls === 1);
      await sleep(60);
      assert.equal(app.calls, 1, '单发任务不重复触发');
      assert.equal(scheduler.active, 0);

      const rec = runner.list()[0];
      assert.equal(rec.idempotencyKey, 'one', 'at 单发用固定键而非窗口键');
      assert.equal(rec.spec.source, 'custom-src');
    } finally {
      scheduler.stop();
    }
  });

  it('at：fire 前 cancel → 永不触发；过去时刻立即触发', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const scheduler = new Scheduler(runner);
    try {
      const h = scheduler.at(new Date(Date.now() + 40), 'never');
      h.cancel();
      assert.equal(scheduler.active, 0);
      await sleep(80);
      assert.equal(app.calls, 0);

      // when 在过去：delay 截断为 0，尽快触发一次
      scheduler.at(new Date(Date.now() - 1000), 'past');
      await waitFor(() => app.calls === 1);
    } finally {
      scheduler.stop();
    }
  });

  it('触发入参非法：不崩宿主，错误经 console.error 暴露', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const scheduler = new Scheduler(runner);
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      scheduler.every(10, 123); // normalizeMessages 无法识别 → dispatch 内捕获
      await waitFor(() => logged.length >= 1);
      assert.match(String(logged[0][0]), /\[agentia:scheduler\].*触发失败/);
      assert.match(String(logged[0][1]), /无法识别为任务输入/);
      assert.equal(app.calls, 0);
    } finally {
      console.error = orig;
      scheduler.stop();
    }
  });
});
