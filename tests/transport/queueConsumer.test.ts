/**
 * **队列消费者配方的门禁**（`docs/guards.md` §2 的第三条待守形状）。
 *
 * 待守形状：`docs/usage-guide.md` §6.4「队列消费者（Kafka / RabbitMQ / SQS）的形态」那条
 * 二十行样板，此前**没有任何 gate 真跑过** —— 它是宿主侧代码，框架侧没有可测的实现，
 * 所以配方里的三条承诺全靠人记得：
 *
 *   1. **拿消息键当 `idempotencyKey`** ⇒ 重投不重复执行（副作用只发生一次）；
 *   2. **`traceparent` 一并带进去** ⇒ 它随 `spec.options` 落进 `TaskRecord`，所以
 *      **另一个进程** `resumePending` 接着跑的那次 run 也带得上，关联不断链；
 *   3. **位移提交点与 run 终态不是一个时刻** ⇒ 「先 ack 后崩」会丢消息，重复靠幂等键兜。
 *
 * 这个文件把配方**逐条真跑一遍**：内存版 broker（at-least-once：ack 前不删、未 ack 与
 * nack 一律重投、可模拟崩溃）+ 真 `AsyncRunner` + 真引擎（`executeRun` + `mockClient`）。
 * 它证明的是「配方依赖的那几条框架语义确实成立」—— 配方本身是宿主代码，写不进框架，
 * 但**它承诺的每一条都必须在框架侧被机器验证过**。
 *
 * ⚠️ 不新起示例工程 + e2e 脚本，理由有两条，都是本仓的既有约束：
 * ① `scripts/verify-all.sh` 的**步骤数写在 CI 的必需检查名里**（「verify-all 8 步」），
 *    加检查一律折进已有步骤；本文件落在 `npm test`，已经是第 6 步，零接线。
 * ② 真 broker 要起 Kafka/RabbitMQ（网络 + 分钟级），而这条配方真正的风险不在协议实现，
 *    而在**提交位移与幂等的时机**——那正是内存 broker 能确定性地钉住的部分。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, InMemoryTaskStore, executeRun, parseTraceparent } from '../../src/index.js';
import type { AgentTool, AppCallable, TaskRecord, Trace, TraceSink } from '../../src/index.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

// ── 内存版 broker：at-least-once ────────────────────────────────────────────

interface Msg {
  /** 消息 id（broker 自己给的，重投时会换新的 —— 位移是**按投递**算的） */
  id: string;
  /** 业务键：同一笔业务被重投时**不变**，所以它才是幂等键的来源 */
  key: string;
  value: string;
  headers: Record<string, string>;
}

/**
 * 交付即「在飞」，`ack` 才算完 —— at-least-once 的代价面全在 `crash()`：
 * 崩在 ack 之前，消费者重启后会再收到同一条（**同 key**），于是「会不会重复执行」
 * 这个问题必须由幂等键回答。这正是本仓承诺的那条边界。
 */
class MemoryBroker {
  #ready: Msg[] = [];
  #unacked = new Map<string, Msg>();
  readonly acks: string[] = [];
  readonly nacks: string[] = [];
  /** 每次「投递」都记一笔：用来断言重投真的发生过（否则用例可能什么都没测到） */
  readonly deliveries: string[] = [];

  publish(m: Msg): void {
    this.#ready.push(m);
  }

  /** 取一批（不删）：交付后处于「未 ack」状态 */
  take(limit = 10): Msg[] {
    const batch = this.#ready.splice(0, limit);
    for (const m of batch) {
      this.#unacked.set(m.id, m);
      this.deliveries.push(m.id);
    }
    return batch;
  }

  ack(id: string): void {
    this.#unacked.delete(id);
    this.acks.push(id);
  }

  /** 处理失败：退回队列等重投（Kafka 里是「不提交位移 + 等再平衡」） */
  nack(id: string): void {
    const m = this.#unacked.get(id);
    this.#unacked.delete(id);
    this.nacks.push(id);
    if (m) this.#ready.push(m);
  }

  /** 模拟消费者进程崩溃：在飞的全部回队列（没 ack 就等于没处理过） */
  crash(): void {
    for (const m of this.#unacked.values()) this.#ready.push(m);
    this.#unacked.clear();
  }

  get unacked(): number {
    return this.#unacked.size;
  }
}

// ── 真路径 app：计数工具 + 收集 trace（断言 link 要读它）─────────────────────

interface Harness {
  app: AppCallable;
  /** 工具被真正执行的次数（副作用计数 —— 幂等要守的就是它） */
  ran: Array<string>;
  /** 每次 run 交付的 trace */
  traces: Trace[];
}

function countingApp(): Harness {
  const ran: string[] = [];
  const traces: Trace[] = [];
  const sink: TraceSink = {
    export(trace: Trace) {
      traces.push(trace);
    },
  };
  const tools: AgentTool[] = [
    {
      name: 'order',
      description: '下单（有副作用，绝不能重复执行）',
      inputSchema: OBJ,
      run: (input) => {
        ran.push(JSON.stringify(input));
        return 'placed';
      },
    },
  ];
  const { client } = mockClient([toolUseMsg('order', { sku: 'A1' }, 'tu1'), endTurnMsg('done')]);
  const app: AppCallable = {
    name: 'queue-consumer',
    run: (messages, opts) => executeRun({ messages, client, tools, sinks: [sink], ...opts }),
  };
  return { app, ran, traces };
}

/** 前 `failTimes` 次 run 直接失败，之后成功（用来看「失败不 ack ⇒ 重投」） */
function flakyApp(failTimes: number): { app: AppCallable; attempts: number[] } {
  const attempts: number[] = [];
  const inner = countingApp();
  const app: AppCallable = {
    name: 'flaky',
    async run(messages, opts) {
      attempts.push(attempts.length + 1);
      if (attempts.length <= failTimes) throw new Error(`第 ${attempts.length} 次处理失败`);
      return inner.app.run(messages, opts);
    },
  };
  return { app, attempts };
}

// ── 配方本体（逐字照 usage-guide §6.4）──────────────────────────────────────

/**
 * 消费者回调的**异步形态**（照 usage-guide §6.4 的样板）：**不 await run 跑完** ——
 * 「位移提交点与 run 终态不是一个时刻」，重复靠幂等键兜。本函数把不提交位移那一半
 * （`submitOnly`）与「等终态再提交」那一半（`consumeAndCommit`）分开，好让两种时机
 * 各自被断言到，而不是混在一个函数里说不清。
 */

/** 只投递、**不提交位移**（模拟消费者崩在 ack 之前，或「不等终态」的样板形态） */
function submitOnly(
  runner: AsyncRunner,
  broker: MemoryBroker,
): Array<{ msgId: string; taskId: string }> {
  const out: Array<{ msgId: string; taskId: string }> = [];
  for (const msg of broker.take()) {
    const tc = msg.headers.traceparent ? parseTraceparent(msg.headers.traceparent) : undefined;
    const { taskId } = runner.submit(msg.value, {
      idempotencyKey: msg.key,
      ...(tc ? { options: { traceContext: tc } } : {}),
    });
    out.push({ msgId: msg.id, taskId });
  }
  return out;
}

/** 把任务推进到终态再 ack（**正确**的位移时机） */
async function consumeAndCommit(
  runner: AsyncRunner,
  broker: MemoryBroker,
): Promise<Array<{ msgId: string; taskId: string; rec: TaskRecord }>> {
  const out: Array<{ msgId: string; taskId: string; rec: TaskRecord }> = [];
  for (const msg of broker.take()) {
    const tc = msg.headers.traceparent ? parseTraceparent(msg.headers.traceparent) : undefined;
    const { taskId } = runner.submit(msg.value, {
      idempotencyKey: msg.key,
      ...(tc ? { options: { traceContext: tc } } : {}),
    });
    const rec = await runner.awaitTask(taskId, { timeoutMs: 15_000 });
    out.push({ msgId: msg.id, taskId, rec });
    // 终态才提交位移：failed 也 ack 吗？—— **不**。失败要 nack 让 broker 重投，
    // 这是 at-least-once 下「至少处理一次」得以成立的那一半（配合幂等键 = 恰好一次的效果）
    if (rec.status === 'succeeded') broker.ack(msg.id);
    else broker.nack(msg.id);
  }
  return out;
}

const msg = (id: string, key: string, headers: Record<string, string> = {}): Msg => ({
  id,
  key,
  value: '下单 A1',
  headers,
});

const linksOf = (trace: Trace): Array<{ traceId: string }> => {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  return (root?.links ?? []) as Array<{ traceId: string }>;
};

describe('队列消费者配方（guards §2 待守形状③）', () => {
  it('① 同键重投：拿消息键当 idempotencyKey ⇒ 副作用只发生一次，且复用同一个 taskId', async () => {
    const h = countingApp();
    const broker = new MemoryBroker();
    const runner = new AsyncRunner(h.app, { store: new InMemoryTaskStore() });

    broker.publish(msg('d1', 'order-42'));
    const first = await consumeAndCommit(runner, broker);
    assert.equal(first[0].rec.status, 'succeeded', '第一投应成功');
    assert.deepEqual(broker.acks, ['d1']);
    assert.equal(h.ran.length, 1);

    // 重投（同 key、新的投递 id —— 与 Kafka 重平衡后的再投同形）
    broker.publish(msg('d2', 'order-42'));
    const second = await consumeAndCommit(runner, broker);
    assert.equal(
      second[0].taskId,
      first[0].taskId,
      '同 key 重投必须复用既有任务 —— 若另起任务，副作用会翻倍',
    );
    assert.equal(h.ran.length, 1, '工具只能真执行一次（幂等承诺的实质）');
    assert.deepEqual(broker.deliveries, ['d1', 'd2'], '重投确实发生过（否则这条用例什么都没测）');
  });

  it('② 崩在 ack 之前：重投仍不重复执行（「重复靠幂等键兜」的机器版本）', async () => {
    const h = countingApp();
    const broker = new MemoryBroker();
    const runner = new AsyncRunner(h.app, { store: new InMemoryTaskStore() });

    // 投了但**没提交位移**（进程崩在 ack 之前）—— at-least-once 下这条消息会回来
    broker.publish(msg('c1', 'order-7'));
    const first = submitOnly(runner, broker);
    assert.deepEqual(broker.acks, [], '还没 ack');
    await runner.awaitTask(first[0].taskId, { timeoutMs: 15_000 });

    broker.crash(); // 未 ack 的全部回队列
    assert.equal(broker.unacked, 0, '崩溃后不该有在飞投递');

    // 重投：同 key ⇒ 幂等键把这次的 run 挡在门外（副作用不翻倍）
    const second = await consumeAndCommit(runner, broker);
    assert.equal(second.length, 1, '未 ack 的消息必须被重投');
    assert.deepEqual(broker.deliveries, ['c1', 'c1'], '重投确实发生过（否则这条用例什么都没测到）');
    assert.equal(
      second[0].taskId,
      first[0].taskId,
      '同 key 重投必须复用既有任务 —— 否则「先 ack」这种错误时机就会真造成重复副作用',
    );
    assert.equal(h.ran.length, 1, '副作用只能发生一次（这就是「重复靠幂等键兜」的实质）');
    assert.deepEqual(broker.acks, ['c1']);
    assert.equal(broker.unacked, 0);
  });

  it('③ traceparent ⇒ spec.options 落库，且他进程续跑那次 run 仍带得上这条 link', async () => {
    const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    const UP_SPAN = '00f067aa0ba902b7';
    const h = countingApp();
    const store = new InMemoryTaskStore();
    const runnerA = new AsyncRunner(h.app, { store });

    // (a) 机制本身：traceContext 随 spec.options 落进 TaskRecord（文档承诺的那一句）
    const broker = new MemoryBroker();
    broker.publish(msg('t1', 'order-link', { traceparent: `00-${UP_TRACE}-${UP_SPAN}-01` }));
    const done = await consumeAndCommit(runnerA, broker);
    const rec = await runnerA.poll(done[0].taskId);
    assert.equal(
      rec?.spec?.options?.traceContext?.traceId,
      UP_TRACE,
      'traceparent 必须随 spec.options 落库 —— 落不下就谈不上「跨进程续跑也带得上」',
    );
    // (b) 这次 run 的 trace 根确实记了一条 link（traceId == runId，由终态回填）
    const runId = rec?.runId ?? '';
    assert.ok(runId, '终态应回填 runId');
    const trace = h.traces.find((t) => t.traceId === runId);
    assert.ok(trace, `收尾应交付 trace（找 traceId=${runId}）`);
    assert.deepEqual(
      linksOf(trace).map((l) => l.traceId),
      [UP_TRACE],
      `run 根应带一条指向上游的 link，实际 ${JSON.stringify(linksOf(trace))}`,
    );

    // (c) **他进程**续跑：把记录改成别的进程留下的（模拟那个进程崩了），
    //     新 runner 用 resumePending 捡起来 —— 那次 run 也必须带得上同一条 link
    const h2 = countingApp();
    const runnerB = new AsyncRunner(h2.app, { store });
    const target = store.list()[0];
    assert.ok(target, 'store 里应有一条记录');
    // 改回 queued 并换成他进程的 ownerId（记录里带着 spec.options —— 正是要验的那条缝）
    store.save({ ...target, status: 'queued', ownerId: 'other-process-xyz' });
    await runnerB.resumePending({ staleAfterMs: 0 });
    const resumed = await runnerB.awaitTask(target.taskId, { timeoutMs: 15_000 });
    assert.equal(resumed.status, 'succeeded', `续跑应成功，实际 ${resumed.status}`);
    const resumedTrace = h2.traces.find((t) => t.traceId === resumed.runId);
    assert.ok(resumedTrace, `续跑也应交付 trace（找 traceId=${resumed.runId}）`);
    assert.deepEqual(
      linksOf(resumedTrace).map((l) => l.traceId),
      [UP_TRACE],
      '他进程续跑的那次 run 必须仍带同一条上游 link —— 这就是「关联不断链」的实质',
    );
  });

  it('④ 失败不 ack ⇒ nack 重投 ⇒ 第二次处理成功（at-least-once 的另一半）', async () => {
    const flaky = flakyApp(1); // 第 1 次处理必失败
    const broker = new MemoryBroker();
    const runner = new AsyncRunner(flaky.app, { store: new InMemoryTaskStore() });

    broker.publish(msg('f1', 'order-9'));
    const first = await consumeAndCommit(runner, broker);
    assert.equal(first[0].rec.status, 'failed', '第一次应失败');
    assert.deepEqual(broker.nacks, ['f1'], '失败必须 nack（否则这条消息永远丢了）');
    assert.equal(broker.acks.length, 0, '失败不该 ack');

    // nack 已把消息退回队列 ⇒ 再消费一次
    const second = await consumeAndCommit(runner, broker);
    assert.equal(second[0].rec.status, 'succeeded', '重投后应成功');
    assert.deepEqual(broker.acks, ['f1']);
    assert.notEqual(
      second[0].taskId,
      first[0].taskId,
      '失败的键允许新任务（幂等只锁 succeeded —— 否则重投永远拿不到第二次执行）',
    );
    assert.deepEqual(flaky.attempts, [1, 2], '应恰好处理两次');
    assert.equal(broker.unacked, 0);
  });
});
