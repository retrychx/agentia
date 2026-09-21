/**
 * **limits 语义的集中对账**（`docs/guards.md` §2 第一条待守形状的机器守卫）。
 *
 * 待守形状：`0` 的双重语义 —— 同一个 `0`，在 `drain` 里是「不限」、在 `maxRetries` 里是
 * 「不重试」、在 `Scheduler.every` 里是**配置错误**。历史事故：`drain({ timeoutMs: 1 })`
 * 跨过 deadline 后**永不返回**（调用方与实现各按一套读法猜）。
 *
 * 这个文件只做一件事：拿 `src/core/limits.ts` 的那张表，去**驱动真实站点**逐条对账。
 * 所以它有两条性质，缺一不可：
 *
 * 1. **穷尽**：`PROBES` 的类型是 `Record<LimitKnob, …>` ⇒ 表里加了旋钮而没加探针，
 *    `typecheck:tests` 直接红（不是「忘了补文档」，是构建失败）。
 * 2. **真跑**：每个探针调的是**那个 API 本身**（`new AsyncRunner(...)`、`mapWithConcurrency(...)`、
 *    `resolveTraceRetries(...)`），不是在本文件里复刻一遍判定 —— 复刻出来的绿只能证明
 *    「我抄对了」，证明不了产物。这也是本仓对测试的既有口径（见 `e2e-cli` 那条：
 *    字面跑产物自己的命令）。
 *
 * ⚠️ 探针必须能把声明的读法**与相邻读法区分开**，否则它只是走过场。例如
 * `runTimeoutMs: 0` 的探针不能只断言「构造没抛错」（那对 `unlimited` / `disabled` 都成立），
 * 而要断言「任务真的没被打断」；`Scheduler.every(0)` 的探针必须断言**抛错**
 * （那才对 `invalid` 成立）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, executeRun } from '../src/index.js';
import type { AgentTool, AppCallable } from '../src/index.js';
import { LIMIT_SEMANTICS, type LimitKnob, type ZeroMeaning } from '../src/core/limits.js';
import { interruptibleSleep, withTimeout, TIMED_OUT } from '../src/core/timeout.js';
import { mapWithConcurrency } from '../src/engine/concurrency.js';
import { runAgent } from '../src/engine/loop.js';
import { resolveTraceLimits, TraceRecorder } from '../src/engine/tracer.js';
import { toolInputPayload } from '../src/engine/tool-events.js';
import { resolveMaxRetries } from '../src/integrations/adapter-options.js';
import { createAnthropicClient } from '../src/integrations/anthropic.js';
import { metricsSink } from '../src/integrations/metrics.js';
import { DrainGate } from '../src/transport/drain-gate.js';
import { Scheduler } from '../src/transport/scheduler.js';
import { endTurnMsg, mockClient, toolUseMsg } from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一个「跑得慢但会成功」的 app：用来观察 runTimeoutMs 到底有没有把任务砍掉 */
function slowApp(ms: number): AppCallable {
  return {
    name: 'slow',
    async run() {
      await sleep(ms);
      return {
        run: { runId: 'r', status: 'succeeded' as const },
        result: { finalText: 'ok' },
      } as never;
    },
  };
}

const OBJ = { type: 'object', properties: {} } as const;

/** 真路径 HITL app（同 `tests/transport/approval.test.ts` 的夹具口径：走真引擎） */
function hitlApp(): AppCallable {
  const { client } = mockClient([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('t1 done')]);
  const tools: AgentTool[] = [
    {
      name: 'danger',
      description: '危险操作',
      inputSchema: OBJ,
      approval: 'required',
      run: () => 'done',
    },
  ];
  return {
    name: 'hitl',
    run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
  };
}

async function pollUntil(runner: AsyncRunner, taskId: string, status: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = await runner.poll(taskId);
    if (rec?.status === status) return;
    if (Date.now() > deadline)
      throw new Error(`等 ${taskId} 进 ${status} 超时（现 ${rec?.status}）`);
    await sleep(5);
  }
}

/**
 * 每个旋钮一支探针：**跑真站点**，返回实测出来的 0 语义。
 *
 * 返回值必须用证据得出，而不是「我知道它是这个」（不许直接 `return 'unlimited'` 了事 ——
 * 下面的断言就是证据本身；`assert` 抛了就说明实测与声明不符）。
 */
const PROBES: Record<LimitKnob, () => Promise<ZeroMeaning>> = {
  // ── 0 = 不限 ────────────────────────────────────────────────────────────
  async 'AsyncRunner.runTimeoutMs'() {
    // 坏值响亮失败（否则 NaN/Infinity 会被 setTimeout 钳到 1ms ⇒ 每个任务立即「超时」）
    assert.throws(
      () => new AsyncRunner(slowApp(10), { runTimeoutMs: Number.POSITIVE_INFINITY }),
      /有限数/,
      '坏值必须抛错',
    );
    // 0 放行，且**真的不限**：任务活过一段远超任何「立即超时」的观察窗
    const runner = new AsyncRunner(slowApp(400), { runTimeoutMs: 0 });
    const t = runner.submit('x');
    await sleep(200);
    assert.equal(
      (await runner.poll(t.taskId))?.status,
      'running',
      '0 必须读作「不限」：任务不该在 0ms 预算下被砍掉',
    );
    await runner.awaitTask(t.taskId);
    return 'unlimited';
  },

  async 'AsyncRunner.approvalTimeoutMs'() {
    assert.throws(
      () => new AsyncRunner(hitlApp(), { approvalTimeoutMs: Number.NaN }),
      /有限数/,
      '坏值必须抛错',
    );
    // 0 = 不限：挂起后不会被「超时兜底拒绝」收掉，而是一直等人
    const runner = new AsyncRunner(hitlApp(), { approvalTimeoutMs: 0 });
    const t = runner.submit('x');
    await pollUntil(runner, t.taskId, 'awaiting_approval');
    await sleep(250);
    assert.equal(
      (await runner.poll(t.taskId))?.status,
      'awaiting_approval',
      '0 必须读作「不限」：挂起不该被自动拒绝',
    );
    return 'unlimited';
  },

  async 'AsyncRunner.drain.timeoutMs'() {
    const gate = new DrainGate();
    let idle = false;
    const waiting = gate.waitForIdle(() => idle, 0);
    // 0 = 一直等：非空闲时**不能**立刻返回 false（历史事故正是这里读错）
    const raced = await Promise.race([
      waiting.then(() => 'settled' as const),
      sleep(150).then(() => 'still-waiting' as const),
    ]);
    assert.equal(raced, 'still-waiting', '0 必须读作「一直等」，而不是「已到点立刻返回 false」');
    // 归零后被唤醒（证明上面那个「还在等」是真的在等，而不是卡死）
    idle = true;
    gate.signalIdle(() => idle);
    assert.equal(await waiting, true, '归零应唤醒等待者');
    return 'unlimited';
  },

  async 'mapWithConcurrency.limit'() {
    const ran: number[] = [];
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      ran.push(n);
      return n * 2;
    });
    // 0 worker 会让 fn 一次都不调、results 全是 undefined，而调用方拿到「成功」的空结果
    assert.deepEqual(ran, [1, 2, 3], '0 必须读作「不限」：三项都要真跑到');
    assert.deepEqual(out, [2, 4, 6]);
    return 'unlimited';
  },

  // ── 0 = 机制关掉 / 一次都不做 ───────────────────────────────────────────
  async 'traceLimits.maxEvents'() {
    assert.throws(() => resolveTraceLimits({ maxEvents: -1 }, 'x'), /非负安全整数/);
    assert.deepEqual(resolveTraceLimits({ maxEvents: 0 }, 'x'), { maxEvents: 0 }, '0 是有意义的值');
    // 0 = 一条都不记（**不是**「不限条数」）：真记一笔 span，事件数必须还是 0
    const rec = new TraceRecorder({ maxEvents: 0 });
    const root = rec.begin('run', 'app', null);
    rec.setAttribute(root, 'k', 'v');
    rec.event(root, 'e', {});
    rec.end(root, { status: 'ok' });
    const events = rec.snapshot('ok').spans[0]!.events;
    assert.equal(
      events.filter((e) => e.name === 'e').length,
      0,
      '0 必须读作「一条都不记」—— 若读成「不限」，这里会是 1 条 e 事件',
    );
    // 但「少记了」这件事本身必须留下痕迹（有计数才叫可解释）：设计上交付时补一笔摘要
    const trunc = events.find((e) => e.name === 'trace.truncated');
    assert.ok(trunc, 'maxEvents:0 也应留一笔 trace.truncated —— 否则使用者会以为 trace 是完整的');
    assert.equal((trunc.body as { limit: number }).limit, 0, '摘要里的 limit 应如实反映生效的上限');
    assert.ok((trunc.body as { droppedEvents: number }).droppedEvents >= 1, '丢了多少条必须有计数');
    return 'disabled';
  },

  async maxRetries() {
    assert.throws(
      () => resolveMaxRetries(Number.NaN, 'x'),
      /非负安全整数/,
      'NaN ⇒ 无限重试，必须拦',
    );
    // 0 = 不重试（与「不限」相反）：必须放行，且解析出来的就是 0
    assert.equal(resolveMaxRetries(0, 'x'), 0, '0 = 不重试，是有意义的值');
    return 'disabled';
  },

  async maxEventChars() {
    const body = { a: 'x'.repeat(50) };
    const use = { id: 'tu1', name: 't', input: body } as never;
    const off = toolInputPayload(use, false);
    const full = toolInputPayload(use, JSON.stringify(body).length);
    const zero = toolInputPayload(use, 0);
    assert.ok(off.input.includes(body.a), 'false = 不截断：全文必须在场');
    assert.ok(zero.input.length < full.input.length, '0 不是「不截断」—— 它把正文截得更短');
    assert.ok(zero.input.length < off.input.length);
    return 'disabled';
  },

  async 'runAgent.maxIterations'() {
    const { client, seen } = mockClient([toolUseMsg('t', {}), endTurnMsg('never reached')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', description: 't', inputSchema: OBJ, run: () => 'ok' }],
      client,
      maxIterations: 0,
    });
    // 0 = 一次都不跑：模型请求压根没发出（不是「不限次」）
    assert.equal(seen.length, 0, 'maxIterations:0 必须读作「一次都不跑」—— 不该发出任何模型请求');
    assert.equal(r.stopReason, 'max_iterations', `实际 stopReason=${r.stopReason}`);
    return 'disabled';
  },

  async 'withTimeout.ms'() {
    // 非正 = 不设超时、原样透传：预算被忽略，拿回的是原 promise 的值而不是 TIMED_OUT
    const ok = await withTimeout(
      sleep(30).then(() => 'ok' as const),
      0,
    );
    assert.equal(ok, 'ok', '非正必须透传：若读成「立即超时」这里会是 TIMED_OUT');
    assert.notEqual(ok as unknown, TIMED_OUT);
    return 'disabled';
  },

  // ── 0 = 立即执行 ────────────────────────────────────────────────────────
  async 'interruptibleSleep.ms'() {
    const t0 = Date.now();
    await interruptibleSleep(0);
    assert.ok(Date.now() - t0 < 50, '非正 = 不睡（立即 resolve）');
    return 'immediate';
  },

  async 'metricsSink.intervalMs'() {
    // 0 = 立即导出：export() 当场发请求并交回 Promise（由框架 await）
    const trace = { traceId: 't1', rootSpanId: 's1', status: 'ok', spans: [], totalUsage: {} };
    const zero = metricsSink({
      export: 'otlp',
      endpoint: 'http://127.0.0.1:9',
      intervalMs: 0,
      onExportError: () => undefined,
    });
    const ret = zero.export(trace as never);
    zero.stop();
    assert.ok(
      ret instanceof Promise,
      'intervalMs:0 必须读作「立即导出」（返回 Promise 交给框架 await）',
    );
    await ret.catch(() => undefined); // 端点不存在：失败交 onExportError，不抛给测试

    // 对照组：>0 只累加，由定时器负责导出 ⇒ export() 返回 undefined
    const every = metricsSink({
      export: 'otlp',
      endpoint: 'http://127.0.0.1:9',
      intervalMs: 60_000,
      onExportError: () => undefined,
    });
    const none = every.export(trace as never);
    every.stop();
    assert.equal(none, undefined, 'intervalMs>0 应只累加，不在 export() 里导出');
    return 'immediate';
  },

  // ── 0 = 非法配置（响亮失败）─────────────────────────────────────────────
  async 'AsyncRunner.concurrency'() {
    assert.throws(() => new AsyncRunner(slowApp(1), { concurrency: 0 }), /必须为正数/);
    assert.throws(() => new AsyncRunner(slowApp(1), { concurrency: -2 }), /必须为正数/);
    return 'invalid';
  },

  async 'Scheduler.every.intervalMs'() {
    const scheduler = new Scheduler(new AsyncRunner(slowApp(1)));
    assert.throws(() => scheduler.every(0, 'x'), /必须为正有限数/);
    assert.throws(() => scheduler.every(Number.NaN, 'x'), /必须为正有限数/);
    return 'invalid';
  },

  async 'createAnthropicClient.timeout'() {
    assert.throws(() => createAnthropicClient({ timeout: 0 }), /正的有限毫秒数/);
    assert.throws(() => createAnthropicClient({ timeout: -1 }), /正的有限毫秒数/);
    // 「不限」的表达是**不传**，而不是传 0 —— 与 runTimeoutMs 相反，这条差别必须钉住
    const client = createAnthropicClient({ apiKey: 'k' });
    assert.equal(typeof client.messages.stream, 'function', '不传 timeout = 不限，必须构造成功');
    return 'invalid';
  },

  async 'metricsSink.windowSize'() {
    assert.throws(() => metricsSink({ windowSize: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ maxCapabilities: 0 }), /必须为正数/);
    return 'invalid';
  },
};

describe('limits 语义单一真源：表 ↔ 真实站点逐条对账（guards §2 待守形状①）', () => {
  for (const sem of LIMIT_SEMANTICS) {
    it(`${sem.knob} —— 0 读作「${sem.zero}」（${sem.where}）`, async () => {
      const observed = await PROBES[sem.knob]();
      assert.equal(
        observed,
        sem.zero,
        `${sem.knob}：limits 表声明 zero=${sem.zero}，实测=${observed}。` +
          `表与实现漂了 —— 要么改实现，要么改表（${sem.where}）`,
      );
    });
  }

  it('构造期报错文案里的「0 = …」取自同一张表（不是各写一份）', () => {
    // 这条守的是「单源」本身：文案与表若各写一份，改了表文案不会跟着改
    const cases: Array<[LimitKnob, () => unknown, RegExp]> = [
      [
        'AsyncRunner.runTimeoutMs',
        () => new AsyncRunner(slowApp(1), { runTimeoutMs: -1 }),
        /0 = 不限/,
      ],
      [
        'AsyncRunner.approvalTimeoutMs',
        () => new AsyncRunner(hitlApp(), { approvalTimeoutMs: -1 }),
        /0 = 不限/,
      ],
      ['maxRetries', () => resolveMaxRetries(-1, 'x'), /0 = 不重试/],
      [
        'traceLimits.maxEvents',
        () => resolveTraceLimits({ maxEvents: 1.5 }, 'x'),
        /0 = 一条都不记/,
      ],
    ];
    for (const [knob, run, expected] of cases) {
      const clause = LIMIT_SEMANTICS.find((s) => s.knob === knob)?.zeroClause ?? '';
      assert.match(clause, expected, `表里 ${knob} 的 zeroClause 应含 ${String(expected)}`);
      assert.throws(run, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});
