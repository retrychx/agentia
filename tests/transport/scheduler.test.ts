import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, Scheduler } from '../../src/index.js';
import type { AppCallable, AgentRunResult, TaskRecord, TaskStore } from '../../src/index.js';
import { waitFor } from '../helpers.js';

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

/**
 * 取任务记录快照。`AsyncRunner.list` 的返回类型是 MaybePromise（异步 store 下是 Promise）；
 * 本套用例用缺省 InMemoryTaskStore（同步），断言成同步数组以便直接 `.length` / `.map`。
 */
const listOf = (runner: AsyncRunner): TaskRecord[] => runner.list() as TaskRecord[]; // 同步 store：断言掉 MaybePromise 的 Promise 分支

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
      await waitFor(() => app.calls >= 2, 'every 应周期触发到第 2 次（cancel 之前）');

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
      await waitFor(
        () => listOf(runner).length >= 2,
        '每个 interval 窗口应各派发一次（记录 >= 2）',
      );
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
      await waitFor(() => app.calls === 1, 'at 到点应触发一次');
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
      await waitFor(() => app.calls === 1, 'at 到点应触发一次');
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
        return {
          run: { runId: `r-${calls}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
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
      await waitFor(
        () => listOf(runner).length >= 2,
        '每个 interval 窗口应各派发一次（记录 >= 2）',
      );
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
        return {
          run: { runId: `r-${calls}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(slow);
    const scheduler = new Scheduler(runner);
    try {
      scheduler.every(10, 'tick', { maxInFlight: Number.POSITIVE_INFINITY });
      await waitFor(() => calls >= 3, 'maxInFlight=Infinity 时每 tick 都派发（>= 3 次）');
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
      await waitFor(() => logged.length >= 1, '触发入参非法应经 console.error 暴露，而非崩宿主');
      assert.match(String(logged[0][0]), /\[agentia:scheduler\].*触发失败/);
      assert.match(String(logged[0][1]), /无法识别为任务输入/);
      assert.equal(app.calls, 0);
    } finally {
      console.error = orig;
      scheduler.stop();
    }
  });

  it('pruneInFlight 同步抛错（如 store 已 close）：被捕获，不崩进程、闸门不自锁', async () => {
    const app = fakeApp();
    const map = new Map<string, TaskRecord>();
    // 同步 store 的 get 同步抛错 —— 复刻「停机先 store.close() 后 scheduler.stop()」时
    // SqliteTaskStore 的行为。修复前该异常逃出 setInterval 回调 → uncaughtException 崩进程。
    const store: TaskStore = {
      save: (r) => void map.set(r.taskId, { ...r }),
      get: () => {
        throw new Error('database is closed');
      },
      byIdempotency: () => undefined,
      list: () => [...map.values()],
      clear: () => map.clear(),
    };
    const runner = new AsyncRunner(app, { store });
    const scheduler = new Scheduler(runner);
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      scheduler.every(10, 'tick');
      // 首个 tick 派发并追踪；次 tick 起 pruneInFlight 撞到同步抛错的 poll ——
      // 捕获后 forget（与异步 .catch 同口径），闸门放行、继续派发
      await waitFor(() => app.calls >= 2, 'poll 同步抛错被吞后闸门应放行后续 tick');
      assert.ok(
        logged.some((a) => String(a[0]).includes('状态查询失败')),
        '同步抛错应经 console.error 暴露（不静默、不崩进程）',
      );
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

  it('every / at：超过 2^31-1ms 的延迟会被 Node 静默钳到 1ms —— 构造期抛错', () => {
    const scheduler = new Scheduler(new AsyncRunner(fakeApp()));
    // 约 34 天：不挡的话 setInterval 退化成每 1ms 空转
    assert.throws(() => scheduler.every(3_000_000_000, 'x'), /定时器上限/);
    // 30 天后：不挡的话 setTimeout 1ms 后立即触发
    assert.throws(
      () => scheduler.at(new Date(Date.now() + 30 * 24 * 3600 * 1000), 'x'),
      /定时器上限/,
    );
    // 上限边界内（恰好 2^31-1）合法
    const ok = scheduler.at(new Date(Date.now() + 2_147_483_647), 'x');
    ok.cancel();
    assert.equal(scheduler.active, 0, '抛错前不得留下 job');
  });

  it('at：非法 Date → 抛错（原会算出 NaN 延迟并立即触发）', () => {
    const scheduler = new Scheduler(new AsyncRunner(fakeApp()));
    assert.throws(() => scheduler.at(new Date('garbage'), 'x'), /合法 Date/);
    assert.throws(() => scheduler.at('2020-01-01' as unknown as Date, 'x'), /合法 Date/);
    assert.equal(scheduler.active, 0, '抛错前不得留下 job');
  });
});
