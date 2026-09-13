import { randomUUID } from 'node:crypto';
import type { AsyncRunner } from './async.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import { isThenable } from '../store/store.js';

/**
 * Agentia —— 定时触发（spec §6.3 定时事件）。
 * 依赖 AsyncRunner：每次触发 = submit 一次异步任务。
 *
 * 周期任务去重：幂等键按 interval 窗口分片（同一片只算一次）；
 * 即便上一片还没跑完，下一片仍会重新 submit —— 同步 store 下若上一任务的同窗口键
 * 还在 queued/running/succeeded，AsyncRunner 的 at-least-once 去重会直接返回既有记录，
 * 同窗口不并发跑两遍；**异步 store 下该保证减弱**：submit 即时去重让位于执行前去重
 * （只采纳 succeeded），上一片仍 running 时新片可能并发执行 —— at-least-once 语义允许，
 * 窗口推进后新键正常执行。
 *
 * v1 提供 everyMs / at；cron 表达式解析后置（宿主可用队列 cron 替换语义）。
 */

interface Job {
  id: string;
  kind: 'every' | 'at';
  timer: ReturnType<typeof setTimeout>;
  intervalMs?: number;
  input: unknown;
  options?: RunInvocationOptions;
  source?: string;
  prefix?: string;
  /** 未到终态的已派发任务（仅 'every'）：用于 maxInFlight 闸门 */
  inFlight?: Set<string>;
  maxInFlight?: number;
}

export interface ScheduleEveryOptions {
  /** 任务级调用参数 */
  options?: RunInvocationOptions;
  /** 幂等键前缀；周期任务按 interval 窗口分片去重 */
  idempotencyPrefix?: string;
  /** 覆盖触发来源标记 */
  source?: string;
  /**
   * 同时未终态的任务数上限；缺省 1（上一片没跑完就跳过本次 tick）。
   * 没有它时 `every(1000)` + 60s 任务会每个 tick 都 submit 一次，任务无上限堆积。
   * 传 `Infinity` 关闭闸门（旧行为）。'at' 单发天然不受影响。
   */
  maxInFlight?: number;
}

export interface ScheduleHandle {
  id: string;
  cancel(): void;
}

export class Scheduler {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly runner: AsyncRunner) {}

  /** 周期触发（毫秒间隔）。首次触发在 intervalMs 之后。 */
  every(intervalMs: number, input: unknown, opts: ScheduleEveryOptions = {}): ScheduleHandle {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      // setInterval(0) 会退化成「尽快重复」的空转循环，把事件循环打满（Node 会把
      // 0 钳到 1ms 但仍是每毫秒一次的忙轮询）。这是配置错误，直接报错。
      throw new Error(`Scheduler.every 的 intervalMs 必须为正有限数，收到 ${intervalMs}`);
    }
    const id = randomUUID();
    const timer = setInterval(() => {
      const job = this.jobs.get(id);
      if (job) this.dispatch(job);
    }, intervalMs);
    if (typeof timer === 'object' && 'unref' in timer) (timer as ReturnType<typeof setTimeout>).unref?.();
    this.jobs.set(id, {
      id,
      kind: 'every',
      timer,
      intervalMs,
      input,
      options: opts.options,
      source: opts.source,
      prefix: opts.idempotencyPrefix,
      inFlight: new Set<string>(),
      maxInFlight: opts.maxInFlight ?? 1,
    });
    return { id, cancel: () => this.cancel(id) };
  }

  /** 单次触发（指定时刻）。 */
  at(when: Date, input: unknown, opts: ScheduleEveryOptions = {}): ScheduleHandle {
    if (!(when instanceof Date) || !Number.isFinite(when.getTime())) {
      // 非法日期 → delay 为 NaN → setTimeout(fn, NaN) 会立即触发且无任何提示
      throw new Error(`Scheduler.at 需要一个合法 Date（非 Invalid Date），收到 ${String(when)}`);
    }
    const id = randomUUID();
    const delay = Math.max(0, when.getTime() - Date.now());
    const timer = setTimeout(() => {
      const job = this.jobs.get(id);
      this.jobs.delete(id);
      if (job) this.dispatch(job);
    }, delay);
    // 与 every() 一致：定时器不阻止进程退出（宿主 stop() 仍可显式取消）
    if (typeof timer === 'object' && 'unref' in timer) (timer as ReturnType<typeof setTimeout>).unref?.();
    this.jobs.set(id, {
      id,
      kind: 'at',
      timer,
      input,
      options: opts.options,
      source: opts.source,
      prefix: opts.idempotencyPrefix,
    });
    return { id, cancel: () => this.cancel(id) };
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer as ReturnType<typeof setTimeout>);
    this.jobs.delete(id);
  }

  stop(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  get active(): number {
    return this.jobs.size;
  }

  /** 清掉已到终态的追踪项（异步 store 下 poll 返回 Promise，到货后再清） */
  private pruneInFlight(inFlight: Set<string>): void {
    const forget = (taskId: string) => inFlight.delete(taskId);
    for (const taskId of inFlight) {
      const rec = this.runner.poll(taskId);
      if (isThenable(rec)) {
        void rec
          .then((r) => {
            if (!r || r.status === 'succeeded' || r.status === 'failed') forget(taskId);
          })
          .catch(() => forget(taskId)); // 查不到就别再挡住后续 tick
        continue;
      }
      const r = rec as { status?: string } | undefined;
      if (!r || r.status === 'succeeded' || r.status === 'failed') forget(taskId);
    }
  }

  private dispatch(job: Job): void {
    // maxInFlight 闸门（仅周期任务）：上一片还在跑就跳过本次 tick —— 否则
    // every(1000) + 60s 任务会每个 tick 都派发，任务无上限堆积。
    // Infinity = 闸门关闭：也不追踪（否则 inFlight 集合随 tick 无界增长）。
    const maxInFlight = job.maxInFlight ?? 1;
    const track = maxInFlight === Number.POSITIVE_INFINITY ? undefined : job.inFlight;
    if (track) {
      this.pruneInFlight(track);
      if (track.size >= maxInFlight) return;
    }
    // 'at' 单发：有 prefix 则用固定键（同次重复提交去重）；周期任务用窗口键
    const idempotencyKey = job.prefix
      ? job.kind === 'every'
        ? `${job.prefix}:${Math.floor(Date.now() / (job.intervalMs ?? 1))}`
        : job.prefix
      : undefined;
    try {
      const rec = this.runner.submit(job.input, {
        idempotencyKey,
        options: job.options,
        source: job.source ?? `schedule:${job.id.slice(0, 8)}`,
      });
      // 追踪未终态的派发（去重命中已有终态记录时不计入）
      if (track && (rec.status === 'queued' || rec.status === 'running')) {
        track.add(rec.taskId);
      }
    } catch (e) {
      // 调度触发不应崩掉宿主进程：入参非法等以 console 形式暴露
      console.error(`[agentia:scheduler] ${job.id} 触发失败`, (e as Error)?.message ?? e);
    }
  }
}
