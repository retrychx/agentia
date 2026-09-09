import { randomUUID } from 'node:crypto';
import type { AgentRunResult } from '../engine/types.js';
import type { SpanError } from '../core/trace.js';
import type { RunStatus } from './types.js';
import type { RunSpec } from './spec.js';

/**
 * Agentia —— run 存储（spec §6.6：异步耐久 = 换宿主不换语义）。
 * 宿主接口：队列/DB 版只需实现 TaskStore，AsyncRunner/调度逻辑不变。
 * v1 交付 InMemoryTaskStore；trace 随 result 一同落记录（§9.3 v1：随 run 结果返回）。
 */

export interface TaskRecord {
  taskId: string;
  status: RunStatus;
  idempotencyKey?: string;
  spec: RunSpec;
  /** 执行完成后回填 runId（runId == traceId） */
  runId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: AgentRunResult;
  error?: SpanError;
}

export interface TaskStore {
  save(rec: TaskRecord): void;
  get(taskId: string): TaskRecord | undefined;
  /** 幂等键 → 最近一次任务（last-wins） */
  byIdempotency(key: string): TaskRecord | undefined;
  list(): TaskRecord[];
  clear(): void;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly byTask = new Map<string, TaskRecord>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey → taskId

  save(rec: TaskRecord): void {
    this.byTask.set(rec.taskId, rec);
    if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
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
  static nextTaskId(): string {
    return `task_${randomUUID()}`;
  }
}
