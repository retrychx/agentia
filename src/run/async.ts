import type Anthropic from '@anthropic-ai/sdk';
import type { AgentRunResult } from '../engine/types.js';
import { classifyError } from '../engine/errors.js';
import type { RunStatus } from './types.js';
import { normalizeMessages } from './spec.js';
import type { RunInvocationOptions } from './spec.js';
import { InMemoryTaskStore } from './store.js';
import type { TaskRecord, TaskStore } from './store.js';

/**
 * Agentia —— 异步任务宿主（spec §6.3 异步 / §6.5 确定性 / §6.6 换宿主不换语义）。
 *
 * - submit 即回（queued），后台驱动状态机 queued → running → succeeded/failed；
 * - **at-least-once 去重**：同一 idempotencyKey 重复 submit，若上一任务仍在
 *   queued/running/succeeded 则直接返回既有记录，不重复执行（失败可重试新任务）；
 * - run 记录落 TaskStore（v1 InMemoryTaskStore），trace 随 result 一同保留；
 *   DB/队列宿主只需实现 TaskStore。
 */

export interface AsyncRunnerOptions {
  client?: Anthropic;
  store?: TaskStore;
  /** 同时执行的任务上限；缺省不限。超出部分排队等槽位（状态保持 queued） */
  concurrency?: number;
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
  private readonly client?: Anthropic;
  private readonly concurrency: number;
  private running = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    private readonly app: AppCallable,
    opts: AsyncRunnerOptions = {},
  ) {
    this.app = app;
    this.store = opts.store ?? new InMemoryTaskStore();
    this.client = opts.client;
    this.concurrency = opts.concurrency ?? Number.POSITIVE_INFINITY;
    if (!(this.concurrency > 0)) {
      throw new Error(`concurrency 必须为正数，收到 ${opts.concurrency}`);
    }
  }

  /**
   * 提交一次异步任务。入参可为 string / messages / {prompt|text|messages}。
   * 幂等键存在且上一任务未失败 → 直接返回既有记录（去重）；失败的同键可产生新任务。
   */
  submit(
    input: unknown,
    opts: { idempotencyKey?: string; source?: string; options?: RunInvocationOptions } = {},
  ): TaskRecord {
    const messages = normalizeMessages(input);
    if (opts.idempotencyKey) {
      const existing = this.store.byIdempotency(opts.idempotencyKey);
      if (existing && existing.status !== 'failed') {
        return { ...existing }; // at-least-once 去重：不重复执行
      }
    }
    const rec: TaskRecord = {
      taskId: InMemoryTaskStore.nextTaskId(),
      status: 'queued',
      idempotencyKey: opts.idempotencyKey,
      spec: { messages, options: opts.options, source: opts.source ?? 'async' },
      createdAt: Date.now(),
    };
    this.store.save(rec);
    void this.#execute(rec.taskId);
    // 返回浅拷贝：记录会被后台状态机原地推进，调用方拿到的是提交时刻的快照
    return { ...rec };
  }

  /** 查任务当前记录 */
  poll(taskId: string): TaskRecord | undefined {
    return this.store.get(taskId);
  }

  byIdempotency(key: string): TaskRecord | undefined {
    return this.store.byIdempotency(key);
  }

  list(): TaskRecord[] {
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
      const rec = this.store.get(taskId);
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
   * （running 视为进程中断）。返回重派数量。幂等键去重照常生效。
   */
  resumePending(): number {
    const pending = this.store
      .list()
      .filter((r) => r.status === 'queued' || r.status === 'running');
    for (const rec of pending) {
      rec.status = 'queued'; // 重新入队，由 #execute 统一推进
      void this.#execute(rec.taskId);
    }
    return pending.length;
  }

  async #execute(taskId: string): Promise<void> {
    const rec = this.store.get(taskId);
    if (!rec) return;
    await this.#acquireSlot();
    rec.status = 'running';
    rec.startedAt = Date.now();
    this.store.save(rec);

    try {
      const callOpts: RunInvocationOptions = {
        ...(rec.spec.options ?? {}),
        client: rec.spec.options?.client ?? this.client,
        idempotencyKey: rec.idempotencyKey,
        rethrow: false, // 硬失败也以 failed 记录落库
      };
      const out = await this.app.run(rec.spec.messages, callOpts);
      rec.runId = out.run.runId;
      rec.status = out.run.status;
      rec.result = out.result;
      rec.error = out.result.error;
    } catch (e) {
      rec.error = classifyError(e);
      rec.status = 'failed';
    } finally {
      rec.finishedAt = Date.now();
      this.store.save(rec);
      this.#releaseSlot();
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
