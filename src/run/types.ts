import type { SpanError } from '../core/trace.js';

/** run 生命周期状态机（spec §6.1） */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface RunMeta {
  runId: string;
  status: RunStatus;
  idempotencyKey?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: SpanError;
}
