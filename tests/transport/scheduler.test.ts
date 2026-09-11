import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, Scheduler } from '../../src/index.js';
import type { AppCallable, AgentRunResult, TaskRecord } from '../../src/index.js';

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

/**
 * 取任务记录快照。`AsyncRunner.list` 的返回类型是 MaybePromise（异步 store 下是 Promise）；
 * 本套用例用缺省 InMemoryTaskStore（同步），断言成同步数组以便直接 `.length` / `.map`。
 */
const listOf = (runner: AsyncRunner): TaskRecord[] =>
  runner.list() as TaskRecord[]; // 同步 store：断言掉 MaybePromise 的 Promise 分支

describe('Scheduler', () => {
  it('at：定时器 unref（与 every 一致，不阻止宿主进程退出）', () => {
    const scheduler = new Scheduler(new AsyncRunner(fakeApp()));
    const g = globalThis as unknown as {
      setTimeout: (fn: () => void, ms?: number) => unknown;
    };
    const real = g.setTimeout;
    let captured: { hasRef(): boolean } | undefined;
    g.setTimeout = (fn, ms) => {
      captured = real(fn, ms) as { hasRef(): boolean };
      return captured;
    };
    try {
      const h = scheduler.at(new Date(Date.now() + 60_000), 'later');
      assert.ok(captured, 'at 应挂一个 timer');
      assert.equal(captured!.hasRef(), false, 'at 的 timer 必须 unref');
      h.cancel();
      assert.equal(scheduler.active, 0);
    } finally {
      g.setTimeout = real;
    }
  });

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
      const sources = listOf(runner).map((r) => r.spec.source ?? '');
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
      await waitFor(() => listOf(runner).length >= 2);
      scheduler.stop();

      const keys = listOf(runner).map((r) => r.idempotencyKey ?? '');
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

      const rec = listOf(runner)[0];
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

  it('maxInFlight 缺省 1：上一片未终态则跳过本次 tick（任务不再无上限堆积）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const slow: AppCallable = {
      name: 'slow',
      async run() {
        calls++;
        await gate;
        return { run: { runId: `r-${calls}`, status: 'succeeded' as const }, result: {} as AgentRunResult };
      },
    };
    const runner = new AsyncRunner(slow);
    const scheduler = new Scheduler(runner);
    try {
      scheduler.every(10, 'tick');
      await sleep(120); // 十来个 tick
      assert.equal(calls, 1, '上一片还在跑：后续 tick 全部跳过');
      assert.equal(listOf(runner).length, 1);

      // 上一片终态后恢复派发（闸门不会永久关闭）
      release();
      await waitFor(() => listOf(runner).length >= 2);
    } finally {
      scheduler.stop();
    }
  });

  it('maxInFlight: Infinity → 关闭闸门（旧行为：每 tick 都派发）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const slow: AppCallable = {
      name: 'slow',
      async run() {
        calls++;
        await gate;
        return { run: { runId: `r-${calls}`, status: 'succeeded' as const }, result: {} as AgentRunResult };
      },
    };
    const runner = new AsyncRunner(slow);
    const scheduler = new Scheduler(runner);
    try {
      scheduler.every(10, 'tick', { maxInFlight: Number.POSITIVE_INFINITY });
      await waitFor(() => calls >= 3, 3000);
    } finally {
      scheduler.stop();
      release();
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

  it('every(0) / 负值 / 非有限数：占位空转是配置错误，直接抛错', () => {
    const scheduler = new Scheduler(new AsyncRunner(fakeApp()));
    assert.throws(() => scheduler.every(0, 'x'), /intervalMs 必须为正有限数/);
    assert.throws(() => scheduler.every(-5, 'x'), /intervalMs 必须为正有限数/);
    assert.throws(() => scheduler.every(Number.NaN, 'x'), /intervalMs 必须为正有限数/);
    assert.equal(scheduler.active, 0, '抛错前不得留下 job');
  });
});
