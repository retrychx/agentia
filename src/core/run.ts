import type { SpanError } from './trace.js';

/**
 * Agentia —— run 生命周期数据模型（spec §6.1）。
 *
 * 放在 core 的理由：`RunStatus` / `RunMeta` 是纯数据，只依赖 `core/trace`。
 * store / transport / runtime 都要读它，下沉 core 后三者都不必再向上引 runtime
 * （此前 `store → runtime` 是未声明的兄弟层依赖，见 AGENTS.md 分层约定）。
 */
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
