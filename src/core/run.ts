import type { SpanError } from './trace.js';

/**
 * Agentia —— run 生命周期数据模型（spec §6.1）。
 *
 * 放在 core 的理由：`RunStatus` / `RunMeta` 是纯数据，只依赖 `core/trace`。
 * store / transport / runtime 都要读它，下沉 core 后三者都不必再向上引 runtime
 * （此前 `store → runtime` 是未声明的兄弟层依赖，见 AGENTS.md 分层约定）。
 */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * run 的运行记录（供持久化 / 读取）。字段**必填但可为 undefined**：它们是框架在 run
 * 生命周期各阶段**总是写进对象**的状态（`toMeta()` 一次构造全量），「缺省」在这里不是
 * 一个有意义的语义 —— 与「可选入参」不同。这条区分由 tsconfig 的
 * `exactOptionalPropertyTypes` 强制：可选入参保持 `?: T`（调用点不许显式传 undefined），
 * 而状态/结果记录写成必填 `T | undefined`（字段在场、值可能没有）。
 */
export interface RunMeta {
  runId: string;
  status: RunStatus;
  idempotencyKey: string | undefined;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  error: SpanError | undefined;
}
