import { randomUUID } from 'node:crypto';
import type { AsyncRunner } from './async.js';
import type { RunInvocationOptions } from './spec.js';

/**
 * Agentia —— 定时触发（spec §6.3 定时事件）。
 * 依赖 AsyncRunner：每次触发 = submit 一次异步任务。
 *
 * 周期任务去重：幂等键按 interval 窗口分片（同一片只算一次）；
 * 即便上一片还没跑完，下一片仍会重新 submit —— 但若上一任务的同窗口键还在
 * queued/running/succeeded，AsyncRunner 的 at-least-once 去重会直接返回既有记录，
 * 保证同窗口不并发跑两遍；窗口推进后新键正常执行。
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
}

export interface ScheduleEveryOptions {
  /** 任务级调用参数 */
  options?: RunInvocationOptions;
  /** 幂等键前缀；周期任务按 interval 窗口分片去重 */
  idempotencyPrefix?: string;
  /** 覆盖触发来源标记 */
  source?: string;
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
    });
    return { id, cancel: () => this.cancel(id) };
  }

  /** 单次触发（指定时刻）。 */
  at(when: Date, input: unknown, opts: ScheduleEveryOptions = {}): ScheduleHandle {
    const id = randomUUID();
    const delay = Math.max(0, when.getTime() - Date.now());
    const timer = setTimeout(() => {
      const job = this.jobs.get(id);
      this.jobs.delete(id);
      if (job) this.dispatch(job);
    }, delay);
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

  private dispatch(job: Job): void {
    // 'at' 单发：有 prefix 则用固定键（同次重复提交去重）；周期任务用窗口键
    const idempotencyKey = job.prefix
      ? job.kind === 'every'
        ? `${job.prefix}:${Math.floor(Date.now() / (job.intervalMs ?? 1))}`
        : job.prefix
      : undefined;
    try {
      this.runner.submit(job.input, {
        idempotencyKey,
        options: job.options,
        source: job.source ?? `schedule:${job.id.slice(0, 8)}`,
      });
    } catch (e) {
      // 调度触发不应崩掉宿主进程：入参非法等以 console 形式暴露
      console.error(`[agentia:scheduler] ${job.id} 触发失败`, (e as Error)?.message ?? e);
    }
  }
}
