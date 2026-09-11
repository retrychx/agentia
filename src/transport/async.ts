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

export interface AsyncRunnerOptions {
  client?: ModelClient;
  store?: TaskStore;
  /** 同时执行的任务上限；缺省不限。超出部分排队等槽位（状态保持 queued） */
  concurrency?: number;
  /**
   * 单任务执行超时（毫秒）；缺省 0 = 不限。
   *
   * **只是「放弃等待」，不是「终止执行」**：底层模型请求没有可中断句柄，超时后
   * 那次 run 仍在后台跑完（其产物被丢弃），槽位则立即回收。因此超时值应大于
   * 任务的正常耗时上限，把它当兜底而不是调度手段；被放弃的任务若仍在跑，
   * 实际并发会短暂高于 concurrency。
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

  constructor(
    private readonly app: AppCallable,
    opts: AsyncRunnerOptions = {},
  ) {
    this.store = opts.store ?? new InMemoryTaskStore();
    this.client = opts.client;
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

  async #execute(rec: TaskRecord): Promise<void> {
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
          const callOpts: RunInvocationOptions = {
            ...(rec.spec.options ?? {}),
            client: rec.spec.options?.client ?? this.client,
            idempotencyKey: rec.idempotencyKey,
            rethrow: false, // 硬失败也以 failed 记录落库
          };
          const out = await this.#raceTimeout(
            this.app.run(rec.spec.messages, callOpts),
            rec.taskId,
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
   * 超时竞速（runTimeoutMs > 0 时）：超时即 reject → 任务按 failed 落库、槽位回收。
   * 底层 run 没有取消句柄，Promise.race 只是**停止等待**；被放弃的那次执行仍在后台
   * 跑完（结果被丢弃）。race 已订阅该 Promise，所以它此后的 reject 不会变成
   * unhandled rejection。timer 必须 clear（否则每次任务都留一个定时器）。
   */
  async #raceTimeout<T>(p: Promise<T>, taskId: string): Promise<T> {
    if (this.runTimeoutMs <= 0) return p;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`task ${taskId} 执行超时（${this.runTimeoutMs}ms）`)),
            this.runTimeoutMs,
          );
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
