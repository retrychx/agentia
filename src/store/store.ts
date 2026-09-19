import { randomUUID } from 'node:crypto';
import type { AgentRunResult } from '../engine/types.js';
import type { SpanError } from '../core/trace.js';
import type { RunStatus } from '../core/run.js';
import type { ApprovalDecision } from '../core/tool.js';
import type { RunSpec } from '../engine/spec.js';

/**
 * Agentia —— run 存储（spec §6.6：异步耐久 = 换宿主不换语义）。
 * 宿主接口：队列/DB 版只需实现 TaskStore，AsyncRunner/调度逻辑不变。
 * v1 交付 InMemoryTaskStore；trace 随 result 一同落记录（§9.3 v1：随 run 结果返回）。
 *
 * 方法返回 MaybePromise（R6）：同步实现（InMemory/File/Sqlite）原样返回同步值；
 * 异步实现（如 RedisTaskStore —— 网络客户端天然异步）返回 Promise。
 * 调用方用 await 兼容两种；AsyncRunner 的同步门面（submit/poll 等）面向同步 store，
 * 异步 store 下它们的行为见 async.ts 注释。
 */

/** 同步或异步返回值：await 化后两种实现统一（同步值 await 即自身） */
export type MaybePromise<T> = T | Promise<T>;

/** store 返回值可能是同步值或 Promise —— 区分用（同步门面只在同步值上工作） */
export function isThenable<T>(x: MaybePromise<T>): x is Promise<T> {
  return !!x && typeof (x as Promise<T>).then === 'function';
}

/** 生成任务 id（与具体 store 实现无关；AsyncRunner 等统一从这里取） */
export function nextTaskId(): string {
  return `task_${randomUUID()}`;
}

export interface TaskRecord {
  taskId: string;
  status: RunStatus;
  idempotencyKey?: string | undefined;
  spec: RunSpec;
  /** 执行完成后回填 runId（runId == traceId） */
  runId?: string | undefined;
  createdAt: number;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  /**
   * 认领该任务的进程标识（AsyncRunner 在 submit/重派时写入）。
   * 多进程共用一个 store 时，`resumePending` 靠它跳过「自己进程的记录」——
   * 本进程的记录一定还在内存里跑，重派只会让它跑两遍。
   */
  ownerId?: string | undefined;
  result?: AgentRunResult | undefined;
  error?: SpanError | undefined;
  /**
   * HITL：已收到的审批决定（tool_use_id → 决定）。**随任务落库**（进程重启不丢）；
   * 逐 id 幂等（第一次决定赢，见 `AsyncRunner.approve`）。
   */
  approvals?: Record<string, ApprovalDecision> | undefined;
  /**
   * HITL：当前**待决**的 tool_use_id 列表（挂起时由引擎写进结果、宿主落库）。
   * 审批方据此知道该批哪些 id；决定齐了之后宿主把任务恢复执行。
   */
  pendingApprovals?: string[] | undefined;
  /**
   * HITL：进入挂起的时刻（epoch ms）。`approvalTimeoutMs` 的**惰性**判定与
   * `approval.decided` 事件的 `waitedMs` 都以它为基准。
   */
  approvalPendingSince?: number | undefined;
}

export interface TaskStore {
  save(rec: TaskRecord): MaybePromise<void>;
  get(taskId: string): MaybePromise<TaskRecord | undefined>;
  /** 幂等键 → 最近一次任务（last-wins） */
  byIdempotency(key: string): MaybePromise<TaskRecord | undefined>;
  list(): MaybePromise<TaskRecord[]>;
  clear(): MaybePromise<void>;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly byTask = new Map<string, TaskRecord>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey → taskId
  /** 记录条数上限；Infinity = 不限（缺省，保持旧行为） */
  private readonly maxRecords: number;

  /**
   * `maxRecords` 给长期运行的宿主一个内存闸门：超过上限时从最旧的**已终态**记录起
   * 淘汰（queued/running 在飞的记录永不淘汰）。缺省 Infinity = 不淘汰 ——
   * 每条记录含完整 trace（可能很大），长跑宿主（尤其 createHttpHandler 的缺省
   * runner）应显式设一个上限或换耐久 store。
   */
  constructor(opts: { maxRecords?: number } = {}) {
    const max = opts.maxRecords ?? Number.POSITIVE_INFINITY;
    if (max !== Number.POSITIVE_INFINITY && !(max > 0)) {
      throw new Error(
        `InMemoryTaskStore 的 maxRecords 必须为正数或 Infinity，收到 ${opts.maxRecords}`,
      );
    }
    this.maxRecords = max;
  }

  save(rec: TaskRecord): void {
    this.byTask.set(rec.taskId, rec);
    if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
    if (this.byTask.size > this.maxRecords) this.evict();
  }

  /** 超过上限时按插入序淘汰已终态记录（在飞/挂起记录跳过，避免丢正在跑或等人的任务） */
  private evict(): void {
    for (const [taskId, rec] of this.byTask) {
      if (this.byTask.size <= this.maxRecords) break;
      // awaiting_approval 同样不可淘汰：它不在跑、但也没完 —— 淘汰了审批决定就无家可归
      if (rec.status === 'queued' || rec.status === 'running' || rec.status === 'awaiting_approval')
        continue;
      this.byTask.delete(taskId);
      if (rec.idempotencyKey && this.byKey.get(rec.idempotencyKey) === taskId) {
        this.byKey.delete(rec.idempotencyKey);
      }
    }
  }

  get(taskId: string): TaskRecord | undefined {
    return this.byTask.get(taskId);
  }
  byIdempotency(key: string): TaskRecord | undefined {
    const taskId = this.byKey.get(key);
    return taskId ? this.byTask.get(taskId) : undefined;
  }
  list(): TaskRecord[] {
    return [...this.byTask.values()];
  }
  clear(): void {
    this.byTask.clear();
    this.byKey.clear();
  }
}
