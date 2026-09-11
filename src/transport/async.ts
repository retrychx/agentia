import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../core/tool.js';
import type { AgentRunResult } from '../engine/types.js';
import { classifyError } from '../engine/errors.js';
import type { RunStatus } from '../runtime/types.js';
import { normalizeMessages } from '../runtime/spec.js';
import type { RunInvocationOptions } from '../runtime/spec.js';
import { InMemoryTaskStore, isThenable, nextTaskId } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';
import { combineSignals } from '../core/abort.js';

/**
 * Agentia —— 异步任务宿主（spec §6.3 异步 / §6.5 确定性 / §6.6 换宿主不换语义）。
 *
 * - submit 即回（queued），后台驱动状态机 queued → running → succeeded/failed；
 * - **at-least-once 去重**：同一 idempotencyKey 重复 submit，若上一任务仍在
 *   queued/running/succeeded 则直接返回既有记录，不重复执行（失败可重试新任务）；
 * - run 记录落 TaskStore（v1 InMemoryTaskStore），trace 随 result 一同保留；
 *   DB/队列宿主只需实现 TaskStore。
 *
 * 异步 TaskStore（R6，TaskStore 方法返回 MaybePromise）：
 * - 内部执行路径（#execute / awaitTask / resumePending）全部 await 化，两种 store 通吃；
 * - submit/poll/byIdempotency/list 是**同步门面**，为同步 store 保持原有用法与返回类型
 *   （http/scheduler/既有调用方零改动）。接异步 store 时：submit 的即时去重无法进行
 *   （推迟到 #execute：同键已有 succeeded 记录则采纳其结果、不重复执行），poll 等
 *   返回 Promise 需调用方自行 await。
 */

/**
 * 任务完成回调（C5）。任务达终态、记录已落库后调用。
 * **抛错被吞**，绝不影响任务状态（与 trace sink / memory 回写同款防护）。
 *
 * webhook 故意**不做进框架**：用本接口 + 你自己的 `fetch` 就能搭（含签名与重试策略），
 * 而那会引入「出站请求 + 重试 + 签名」一整套复杂度。
 */
export interface TaskSink {
  onFinished(rec: TaskRecord): void | Promise<void>;
}

export interface AsyncRunnerOptions {
  client?: ModelClient;
  store?: TaskStore;
  /** 同时执行的任务上限；缺省不限。超出部分排队等槽位（状态保持 queued） */
  concurrency?: number;
  /** 任务完成回调（进程内）；见 TaskSink */
  taskSinks?: TaskSink[];
  /**
   * 单任务执行超时（毫秒）；缺省 0 = 不限。
   *
   * **超时即中止**：到点会 abort 本次 run 的 signal —— 对尊重 signal 的模型客户端
   * （框架自带的 Anthropic / OpenAI 适配器都转发 signal）是**真中止**，token 不再继续烧；
   * 不尊重 signal 的自定义 client 则仍等价于「放弃等待」（run 在后台跑完、产物丢弃）。
   * 槽位无论如何立即回收；被放弃且仍在跑的任务会让实际并发短暂高于 concurrency。
   */
  runTimeoutMs?: number;
}

/** resumePending 的启动扫描选项 */
export interface ResumePendingOptions {
  /**
   * 他进程任务的「保鲜期」（毫秒）；缺省 0 = 不判断，一律重派（重启即续跑）。
   * > 0 时跳过 startedAt/createdAt 距今不足该值的他进程记录 —— 那些任务大概
   * 正在别的进程里跑着，抢过来会重复执行。0 适合单进程部署（旧语义）。
   */
  staleAfterMs?: number;
}

/** 应用最小调用面（agent 装配无关，避免 run 层向上依赖 toolkit） */
export interface AppCallable {
  readonly name: string;
  run(
    messages: Anthropic.MessageParam[],
    opts?: RunInvocationOptions,
  ): Promise<{ run: { runId: string; status: RunStatus }; result: AgentRunResult }>;
}

export class AsyncRunner {
  readonly store: TaskStore;
  /** 本进程标识：写进认领的 TaskRecord.ownerId，供 resumePending 区分他我 */
  readonly ownerId: string;
  private readonly client?: ModelClient;
  private readonly concurrency: number;
  private readonly runTimeoutMs: number;
  private running = 0;
  private readonly waitQueue: Array<() => void> = [];
  /** 已受理但未达终态的任务数（queued + running）—— /healthz 与 drain 共用 */
  private active = 0;
  private draining = false;
  private readonly drainWaiters: Array<() => void> = [];
  private readonly taskSinks: TaskSink[];

  constructor(
    private readonly app: AppCallable,
    opts: AsyncRunnerOptions = {},
  ) {
    this.store = opts.store ?? new InMemoryTaskStore();
    this.client = opts.client;
    this.taskSinks = opts.taskSinks ?? [];
    this.concurrency = opts.concurrency ?? Number.POSITIVE_INFINITY;
    if (!(this.concurrency > 0)) {
      throw new Error(`concurrency 必须为正数，收到 ${opts.concurrency}`);
    }
    this.runTimeoutMs = opts.runTimeoutMs ?? 0;
    if (this.runTimeoutMs < 0) {
      throw new Error(`runTimeoutMs 不能为负，收到 ${opts.runTimeoutMs}`);
    }
    this.ownerId = `p${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * 提交一次异步任务。入参可为 string / messages / {prompt|text|messages}。
   * 幂等键存在且上一任务未失败 → 直接返回既有记录（去重）；失败的同键可产生新任务。
   * 同步门面：同步 store 下立即去重并返回快照；异步 store 下 save 在后台完成、
   * 去重推迟到执行前（见 #execute），返回新建任务的提交时刻快照。
   */
  submit(
    input: unknown,
    opts: { idempotencyKey?: string; source?: string; options?: RunInvocationOptions } = {},
  ): TaskRecord {
    // 停机中不接单（drain 之后）；宿主据此回 503。放在最前：连入参规整都省了。
    if (this.draining) {
      throw new Error('runner 正在优雅停机，不再接受新任务');
    }
    const messages = normalizeMessages(input);
    if (opts.idempotencyKey) {
      const existing = this.store.byIdempotency(opts.idempotencyKey);
      if (isThenable(existing)) {
        // 异步 store 返回 Promise —— 同步门面无法 await，去重交给 #execute。
        // 但**必须订阅它**：byIdempotency 的 reject（Redis 抖动等）若无人处理就是
        // unhandledRejection（Node ≥15 默认终止宿主进程）。这里只做「查不到既有记录」
        // 处理，拒绝即视为无记录，交 #execute 的去重兜底。
        existing.catch(() => undefined);
      } else if (existing && existing.status !== 'failed') {
        return { ...existing }; // at-least-once 去重：不重复执行
      }
    }
    const rec: TaskRecord = {
      taskId: nextTaskId(),
      status: 'queued',
      idempotencyKey: opts.idempotencyKey,
      spec: { messages, options: opts.options, source: opts.source ?? 'async' },
      createdAt: Date.now(),
      ownerId: this.ownerId,
    };
    const saved = this.store.save(rec);
    if (isThenable(saved)) {
      // 异步落库失败：尽力把任务标记为 failed 重存，避免静默吞错 / unhandled rejection。
      // 但只在任务**尚未被 #execute 推进**时改判：初始 save 的 reject 可能迟到，
      // 那时 run 已跑完并写了成功终态，无条件覆写会把成功翻成失败（落库终态与真实结果相反）。
      saved.catch((e) => {
        if (rec.status !== 'queued' || rec.finishedAt !== undefined) return;
        rec.status = 'failed';
        rec.error = classifyError(e);
        rec.finishedAt = Date.now();
        void this.#safeSave(rec);
      });
    }
    void this.#execute(rec);
    // 返回浅拷贝：记录会被后台状态机原地推进，调用方拿到的是提交时刻的快照
    return { ...rec };
  }

  /** 查任务当前记录（异步 store 下返回 Promise，调用方 await） */
  poll(taskId: string): MaybePromise<TaskRecord | undefined> {
    return this.store.get(taskId);
  }

  byIdempotency(key: string): MaybePromise<TaskRecord | undefined> {
    return this.store.byIdempotency(key);
  }

  list(): MaybePromise<TaskRecord[]> {
    return this.store.list();
  }

  /** 已受理但未达终态的任务数（queued + running）—— 健康检查与 drain 共用同一口径 */
  get inFlight(): number {
    return this.active;
  }

  /** 是否已进入优雅停机（drain 之后为 true）—— HTTP 宿主据此对新单回 503 */
  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * 优雅停机：停止接单（此后 `submit` 抛错），等待已受理任务排空（或超时）。
   *
   * 返回是否排空干净：超时仍返回 `false`，**未完成的任务留在 store 里**，下次启动由
   * `resumePending` 续跑（所以 drain 不是「丢弃」，是「不再往前推」）。
   * - `timeoutMs` 缺省 0 = 一直等。
   * - 等待的是**所有已受理**的任务（queued 的也在内），不只是正在占槽位的那些。
   */
  async drain(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    this.draining = true;
    const timeoutMs = opts.timeoutMs ?? 0;
    if (this.active === 0) return true;
    const drained = new Promise<boolean>((resolve) =>
      this.drainWaiters.push(() => resolve(true)),
    );
    if (timeoutMs <= 0) return drained;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        drained,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.(); // 兜底计时器不该让宿主为它续命
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 排空通知：只在确无在飞任务时唤醒等待者（drain 的唯一出口） */
  #notifyDrained(): void {
    if (this.active !== 0 || this.drainWaiters.length === 0) return;
    const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
    for (const w of waiters) w();
  }

  /** 等到任务终态；超时抛错。 */
  async awaitTask(
    taskId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TaskRecord> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 5;
    const start = Date.now();
    for (;;) {
      const rec = await this.store.get(taskId);
      if (!rec) throw new Error(`task 不存在: ${taskId}`);
      if (rec.status === 'succeeded' || rec.status === 'failed') return rec;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`task ${taskId} 等待超时（${rec.status}）`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * 宿主重启续跑：把 store 里 queued | running 的记录重新派发执行
   * （running 视为进程中断）。返回重派数量（异步 store 下返回 Promise<number>）。
   * 幂等键去重照常生效。
   *
   * 多进程共用一个 store 时靠 `ownerId` 区分他我：
   * - 本进程的记录一律跳过（它还在本进程内存里跑，重派 = 跑两遍）；
   * - `staleAfterMs > 0` 时，startedAt/createdAt 距今不足该值的他进程记录也跳过
   *   （大概正被那个进程执行）。缺省 0 = 不判断、一律重派（单进程旧语义）。
   */
  resumePending(opts: ResumePendingOptions = {}): number | Promise<number> {
    const listed = this.store.list();
    const staleAfterMs = opts.staleAfterMs ?? 0;
    if (isThenable(listed)) {
      return listed.then((recs) => this.#redispatch(recs, staleAfterMs));
    }
    return this.#redispatch(listed, staleAfterMs);
  }

  #redispatch(recs: TaskRecord[], staleAfterMs: number): number {
    const now = Date.now();
    const pending = recs.filter((r) => {
      if (r.status !== 'queued' && r.status !== 'running') return false;
      if (r.ownerId === this.ownerId) return false; // 自己的一定还活着
      if (staleAfterMs > 0 && r.ownerId !== undefined) {
        const since = r.startedAt ?? r.createdAt;
        if (now - since < staleAfterMs) return false; // 他进程刚起的，别抢
      }
      return true;
    });
    for (const rec of pending) {
      rec.status = 'queued'; // 重新入队，由 #execute 统一推进
      rec.ownerId = this.ownerId; // 认领：此后本进程的记录不再被（自己）重派
      void this.#execute(rec);
    }
    return pending.length;
  }

  /**
   * 在飞计数包裹层：#executeInner 是状态机主体，这里只负责 active 计数与排空通知。
   * 计数在**同步段**（第一个 await 之前）自增 —— 所以 `void this.#execute(rec)` 一返回，
   * 该任务就已经计入了，drain 不会漏掉「刚 submit、还没开始跑」的任务。
   */
  async #execute(rec: TaskRecord): Promise<void> {
    this.active++;
    try {
      await this.#executeInner(rec);
    } finally {
      // 通知在飞递减**之前**：drain() 返回时保证「任务已终态 + 回调已发完」。
      // 内层 finally 保证回调万一抛错（理论上被吞掉）也不泄漏在飞计数。
      try {
        await this.#notifySinks(rec);
      } finally {
        this.active--;
        this.#notifyDrained();
      }
    }
  }

  /** 通知任务完成回调。逐个 await，**sink 抛错被吞** —— 回调失败不得影响任务状态。 */
  async #notifySinks(rec: TaskRecord): Promise<void> {
    if (this.taskSinks.length === 0) return;
    // 传快照：回调拿到的是「此刻的终态」，之后记录再被改动不会串进回调持有的引用
    const snapshot = { ...rec };
    for (const sink of this.taskSinks) {
      try {
        await sink.onFinished(snapshot);
      } catch {
        /* 回调失败不影响任务状态（同 trace sink / memory 回写的防护） */
      }
    }
  }

  async #executeInner(rec: TaskRecord): Promise<void> {
    // 顶层容错：异步 store（网络客户端）任何一处 reject 都不得逃逸成
    // unhandled rejection（Node ≥15 默认终止进程）——任务标记失败尽力落库。
    try {
      // 异步 store 的幂等去重在此补齐（submit 同步门面无法 await）：
      // 同键已有 succeeded 记录 → 采纳其结果，不重复执行；queued/running 不采纳 ——
      // 重复执行本就是 at-least-once 允许的行为。同步 store 下 submit 已完成去重，
      // 这里查到的一般是 rec 自身（taskId 相同，直接放行）。
      // 注意（load-bearing）：该去重依赖 store.save 先写记录、后写 idem 索引的顺序
      // （见 redisStore 头注释）——索引指向自身时上面的 taskId 相等判断放行。
      if (rec.idempotencyKey) {
        const existing = await this.store.byIdempotency(rec.idempotencyKey);
        if (existing && existing.taskId !== rec.taskId && existing.status === 'succeeded') {
          rec.status = 'succeeded';
          rec.runId = existing.runId;
          rec.result = existing.result;
          rec.error = existing.error;
          rec.finishedAt = Date.now();
          // 采纳既有结果：落库失败也不该把一次已知成功的任务翻成 failed
          await this.#safeSave(rec);
          return;
        }
      }

      await this.#acquireSlot();
      try {
        rec.status = 'running';
        rec.startedAt = Date.now();
        await this.store.save(rec);

        try {
          // runTimeoutMs 到点即 abort（对尊重 signal 的客户端是真中止）；与调用方
          // 可能传入的 signal 合成，任一触发都中止本次 run。
          const timeoutAc = new AbortController();
          const callOpts: RunInvocationOptions = {
            ...(rec.spec.options ?? {}),
            client: rec.spec.options?.client ?? this.client,
            idempotencyKey: rec.idempotencyKey,
            rethrow: false, // 硬失败也以 failed 记录落库
            signal: combineSignals(rec.spec.options?.signal, timeoutAc.signal),
          };
          const out = await this.#raceTimeout(
            this.app.run(rec.spec.messages, callOpts),
            rec.taskId,
            () => timeoutAc.abort(),
          );
          rec.runId = out.run.runId;
          rec.status = out.run.status;
          rec.result = out.result;
          rec.error = out.result.error;
        } catch (e) {
          rec.error = classifyError(e);
          rec.status = 'failed';
        }
      } finally {
        rec.finishedAt = Date.now();
        // 落库失败不遮罩、槽位必须释放：释放放在内层 finally，即便落库实现抛错也必达
        try {
          await this.#safeSave(rec);
        } finally {
          this.#releaseSlot();
        }
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = classifyError(e);
      rec.finishedAt = Date.now();
      await this.#safeSave(rec);
      console.error(`[agentia] task ${rec.taskId} 执行异常:`, e);
    }
  }

  /**
   * 尽力落库：**先包成 Promise 再挂 catch**。
   *
   * 同步 store（FileTaskStore 的 writeFileSync、node:sqlite）的 save 是**同步抛错**的。
   * 若写成 `Promise.resolve(this.store.save(rec)).catch(...)`，`this.store.save(rec)`
   * 会在 `Promise.resolve` 之前求值并同步抛出 —— 异常逃出 finally（跳过 #releaseSlot，
   * 并发槽位永久泄漏），再被外层 catch 里同一写法抛第二次，最终逃出 #execute 变成
   * unhandled rejection（Node ≥15 默认终止宿主进程）。
   */
  async #safeSave(rec: TaskRecord): Promise<void> {
    try {
      await Promise.resolve().then(() => this.store.save(rec));
    } catch {
      // 落库失败不遮罩主流程：任务结果仍在内存记录里可见
    }
  }

  /**
   * 超时竞速（runTimeoutMs > 0 时）：超时先 `onTimeout()`（abort 在飞请求）再 reject
   * → 任务按 failed 落库、槽位回收。尊重 signal 的客户端会被真中止；不尊重者只是
   * 停止等待（race 已订阅该 Promise，其后续 reject 不会变成 unhandled rejection）。
   * timer 必须 clear（否则每次任务都留一个定时器）。
   */
  async #raceTimeout<T>(p: Promise<T>, taskId: string, onTimeout?: () => void): Promise<T> {
    if (this.runTimeoutMs <= 0) return p;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error(`task ${taskId} 执行超时（${this.runTimeoutMs}ms）`));
          }, this.runTimeoutMs);
          timer.unref?.(); // 兜底计时器不该让宿主为它续命
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 并发槽位：超限则排队等待（任务记录保持 queued，由 store 可见） */
  #acquireSlot(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waitQueue.push(resolve));
  }

  #releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next(); // 槽位直接移交给等待者，running 计数不变
    } else {
      this.running--;
    }
  }
}
