/**
 * `AsyncRunnerOptions.maxQueued` —— **排队段**的上限（2026-09-28 外部深评 T5 的收口用例）。
 *
 * 待守形状：`concurrency` 只约束「同时在跑几个」，而「跑不上、排在后面」的那一段此前
 * **没有任何上限** —— `submit` 永远收单、`POST /tasks` 永远 202，排队段随调用方灌入
 * 无界增长（每条排队任务 = 一条 `TaskRecord` + 一棵 `#execute` 的悬挂 promise +
 * 一个 `#slots` 等待者，全在内存里）。`concurrency: 1` 挡不住它，那只是让排队段更长。
 *
 * 判据（`#queueDepth`）：**真正在排队的深度** = `max(0, 已受理未持槽的任务数 + 1 − 空槽位数)`，
 * 超 `maxQueued` 即拒。用例钉住四件容易写错的事：
 *
 * 1. **闸必须有判据**：只断言「第 N 条被拒」的用例在「闸判太早」时照样绿 —— 所以每条用例
 *    都先断言**前几条真的受理了**，并断言 `queued` 读数与判据一致。
 * 2. **「立刻就能跑的」不算排队**：`concurrency: 1` + `maxQueued: 1` 下同步连灌两条
 *    （第 1 条马上拿槽位、第 2 条排队 = 正好用满额度）**两条都必须受理**。
 *    ⚠️ 第一版实现拿「已受理未持槽」的集合大小当深度，就把第 2 条误拒了 —— 这条用例是
 *    当时抓住它的那条，别把它改松。
 * 3. **计数不能泄漏**：额度是「拿槽位就还」的，漏还 = 服务永久 503（比原本的无界增长更糟）。
 *    所以有往返灌满 / 排空的多轮 soak，断言每轮行为逐字一致、计数归零。
 * 4. **HTTP 上是 503 + Retry-After，不是 400**：排队满不是调用方的错（同一请求稍后重发
 *    就该过）。另：闸只挡**新活** —— 恢复路径推进的是已受理任务，拦下来等于把它搁死在 store 里。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncRunner, TaskQueueFullError } from '../../src/transport/async.js';
import type { AppCallable } from '../../src/transport/async.js';
import { createHttpHandler } from '../../src/transport/http.js';
import type { AgentRunResult } from '../../src/engine/types.js';

function fakeResult(text: string): AgentRunResult {
  return {
    trace: {
      traceId: 'trace-1',
      rootSpanId: 'span-1',
      spans: [],
      status: 'ok',
      totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    stopReason: 'end_turn',
    finalText: text,
    iterations: 1,
    error: undefined,
    typed: undefined,
    suspendedMessages: undefined,
    pendingApprovals: undefined,
    suspendedReason: undefined,
    wakeAt: undefined,
    eventsDelivered: false,
  };
}

/**
 * 一道可控闸：run 会一直停在 `await gate.wait()`，直到用例调 `gate.open()`。
 * 为什么不用 `setTimeout(ms)`：那样「槽位是否还被占着」取决于机器快慢 ——
 * 闸满 / 排队这些断言必须**不靠等待**才成立（本仓对时序用例的一贯口径）。
 */
function makeGate(): { wait: () => Promise<void>; open: () => void } {
  let open: (() => void) | undefined;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return {
    wait: () => p,
    open: () => open?.(),
  };
}

/** 每次 run 都等闸的 app —— 让「槽位被占住、后续排上」成为确定状态 */
function gatedApp(gate: { wait: () => Promise<void> }): AppCallable & { started: number } {
  const app = {
    name: 'gated',
    started: 0,
    async run() {
      app.started += 1;
      await gate.wait();
      return {
        run: { runId: `r-${app.started}`, status: 'succeeded' as const },
        result: fakeResult('ok'),
      };
    },
  };
  return app;
}

describe('AsyncRunner.maxQueued：排队段的上限', () => {
  it('排队满 → submit 同步抛 TaskQueueFullError（status 503）；额度内的每一条都真的受理', async () => {
    const gate = makeGate();
    // concurrency 1 + maxQueued 2 ⇒ 额度是「1 条在跑 + 2 条在排」= 同步灌进来最多 3 条。
    const runner = new AsyncRunner(gatedApp(gate), { concurrency: 1, maxQueued: 2 });

    const a = runner.submit('a');
    assert.equal(a.status, 'queued');
    runner.submit('b');
    runner.submit('c'); // 第 3 条：正好把「2 条排队」用满
    assert.equal(runner.queued, 2, '读数必须与判据同源：此刻真有 2 条排不上槽位');

    const err = (() => {
      try {
        runner.submit('d');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    assert.ok(err instanceof TaskQueueFullError, '第 4 条必须抛 TaskQueueFullError');
    assert.equal((err as TaskQueueFullError).status, 503);
    // 文案要指路（运维看得到「排了几条、往哪调」），不是一句「失败了」
    assert.match((err as TaskQueueFullError).message, /排队已满/);
    assert.match((err as TaskQueueFullError).message, /maxQueued=2/);
    assert.match((err as TaskQueueFullError).message, /concurrency=1/);

    gate.open();
    await runner.drain({ timeoutMs: 5_000 });
    assert.equal(runner.queued, 0);
  });

  it('「立刻就能跑的」不算排队：同步连灌 concurrency 条，一条都不该被拒', async () => {
    // 这是第一版实现的漏洞现场：拿「已受理未持槽」的集合大小当深度时，
    // concurrency: 1 + maxQueued: 1 下连灌两条会把第 2 条误拒（它其实只是还没轮到 acquire）。
    const gate = makeGate();
    const runner = new AsyncRunner(gatedApp(gate), { concurrency: 1, maxQueued: 1 });
    runner.submit('a'); // 会立刻拿槽位
    const b = runner.submit('b'); // 会排队 —— 但正好用满 maxQueued=1，必须受理
    assert.equal(b.status, 'queued', '第 2 条必须受理（它是那 1 条合法的排队）');
    assert.equal(runner.queued, 1, '读数：1 条在排队（第 1 条还没持槽但马上就能持）');
    // 再加一条才是真的溢出
    assert.throws(() => runner.submit('c'), /排队已满/);
    gate.open();
    await runner.drain({ timeoutMs: 5_000 });
  });

  it('幂等键命中的重复提交**不吃** 503（闸在去重之后）', async () => {
    const gate = makeGate();
    const runner = new AsyncRunner(gatedApp(gate), { concurrency: 1, maxQueued: 1 });
    const first = runner.submit('a', { idempotencyKey: 'k1' });
    runner.submit('b', { idempotencyKey: 'k2' }); // 排队 → 额度已满
    // 控制组：闸此刻确实在拦（不然下面的「不吃 503」证明不了任何事）
    assert.throws(() => runner.submit('fresh'), /排队已满/);

    // 这两个提交都不产生新活，因此不该被排队闸拒 —— 否则「重试同一个键」会变成看运气：
    // 服务越忙，越可能把一个**本来会命中缓存**的重试打成 503。
    const dupInFlight = runner.submit('a-again', { idempotencyKey: 'k1' });
    assert.equal(dupInFlight.taskId, first.taskId, '在飞同键 → 直接返回既有记录');
    const dupQueued = runner.submit('b-again', { idempotencyKey: 'k2' });
    assert.equal(dupQueued.status, 'queued');

    gate.open();
    await runner.drain({ timeoutMs: 5_000 });
    assert.equal(runner.queued, 0, '排空后计数归零');
  });

  it('额度「拿槽位就还」：第 1 条跑完后第 2 条起跑，此时又能收第 3 条', async () => {
    const gates = [makeGate(), makeGate()];
    let call = 0;
    const app: AppCallable = {
      name: 'two-step',
      async run() {
        const g = gates[Math.min(call++, gates.length - 1)];
        await g!.wait();
        return {
          run: { runId: `r-${call}`, status: 'succeeded' as const },
          result: fakeResult('ok'),
        };
      },
    };
    const runner = new AsyncRunner(app, { concurrency: 1, maxQueued: 1 });
    runner.submit('a'); // 占槽位
    runner.submit('b'); // 排队（额度满）
    assert.throws(() => runner.submit('c'), /排队已满/);

    // 放行第 1 条：槽位**交接**给 b（slot-pool 的移交语义）⇒ b 离开排队段 ⇒ 额度回 1
    gates[0]!.open();
    for (let i = 0; i < 200 && runner.queued !== 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(
      runner.queued,
      0,
      'b 拿到槽位后必须离开排队段（释放点是「拿槽位」不是「任务终态」）',
    );
    const c = runner.submit('c'); // 额度已还 → 必须能收
    assert.equal(c.status, 'queued');

    gates[1]!.open();
    await runner.drain({ timeoutMs: 5_000 });
    assert.equal(runner.queued, 0);
  });

  it('多轮灌满 / 排空：额度不泄漏（漏还 = 服务永久 503）', async () => {
    // ⚠️ 这里**不能用 `drain()` 来排空**：它是单向闩（停机后不再接单），
    // 用它排空再提交必然撞停机闸 —— 那样测的是停机，不是额度。
    for (let round = 0; round < 3; round++) {
      const gate = makeGate();
      const runner = new AsyncRunner(gatedApp(gate), { concurrency: 1, maxQueued: 1 });
      const a = runner.submit(`a${round}`);
      runner.submit(`b${round}`);
      // ⚠️ 读进局部变量再断言：`assert.equal` 在 @types/node 里是**断言函数**（`asserts actual is T`），
      // 断言 `runner.queued === 1` 会把 getter 的静态类型**窄化成字面量 1**，
      // 于是下面那句 `runner.queued !== 0` 被判成「恒真、疑似写错」（TS2367）——
      // 该用例在 CI 的 `typecheck:tests` 上真红过。断言局部变量就没有这层副作用。
      const queuedNow = runner.queued;
      assert.equal(queuedNow, 1, `第 ${round} 轮：1 条在排队`);
      assert.throws(() => runner.submit(`c${round}`), /排队已满/, `第 ${round} 轮：满则拒`);
      gate.open();
      await runner.awaitTask(a.taskId, { timeoutMs: 5_000 });
      for (let i = 0; i < 200 && runner.queued !== 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(runner.queued, 0, `第 ${round} 轮排空后必须归零（否则下一轮会误拒）`);
      // 归零之后必须还能收 —— 「额度泄漏」的典型表现就是从这一句开始 503
      const again = runner.submit(`d${round}`);
      assert.equal(again.status, 'queued', `第 ${round} 轮排空后应能再收一条`);
      await runner.awaitTask(again.taskId, { timeoutMs: 5_000 });
      assert.equal(runner.queued, 0, `第 ${round} 轮收尾后仍须归零`);
    }
  });

  it('闸只挡新活：排队满时在跑的那条照常跑完、排队的那条照常起跑', async () => {
    const gate = makeGate();
    const app = gatedApp(gate);
    const runner = new AsyncRunner(app, { concurrency: 1, maxQueued: 1 });
    const a = runner.submit('a');
    runner.submit('b'); // 排队满
    assert.throws(() => runner.submit('c'), /排队已满/);
    gate.open();
    await runner.drain({ timeoutMs: 5_000 });
    assert.equal(app.started, 2, '被拒的第 3 条不该影响前两条 —— 两条都必须真的跑过');
    assert.equal((runner.poll(a.taskId) as { status: string }).status, 'succeeded');
  });

  it('构造期校验：-1 / 1.5 / NaN / Infinity 一律响亮失败，文案给出「0 = 不限」', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new AsyncRunner(gatedApp(makeGate()), { maxQueued: bad }),
        /maxQueued 必须为 ≥ 0 的整数（0 = 不限（不设排队上限））/,
        `maxQueued=${String(bad)} 必须构造期抛错`,
      );
    }
    // 0 是**合法**值（= 不限）—— 别把它当成坏值一起拒了
    const ok = new AsyncRunner(gatedApp(makeGate()), { maxQueued: 0 });
    assert.equal(ok.queued, 0);
  });

  it('HTTP：排队满 → 503 + Retry-After（不是 400）；未满 → 202', async () => {
    const gate = makeGate();
    const app = gatedApp(gate);
    const runner = new AsyncRunner(app, { concurrency: 1, maxQueued: 1 });
    const server: Server = createServer(createHttpHandler(app, { runner }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const post = (input: string): Promise<Response> =>
        fetch(`${base}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
        });
      assert.equal((await post('a')).status, 202, '第 1 条：占槽位');
      assert.equal((await post('b')).status, 202, '第 2 条：排队（额度用满）');
      const third = await post('c');
      assert.equal(third.status, 503, '第 3 条：排队满 ⇒ 503（不是 400）');
      assert.equal(
        third.headers.get('retry-after'),
        '1',
        '503 必须带 Retry-After（与 maxConcurrentRuns 那支同款）',
      );
      const body = (await third.json()) as { error?: string };
      assert.match(String(body.error), /排队已满/, '503 的 body 要说清是「排队满」');
      gate.open();
      await runner.drain({ timeoutMs: 5_000 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
