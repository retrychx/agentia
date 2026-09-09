export const AGENTIA_VERSION = '0.0.1';

// core：数据模型
export type {
  Trace,
  Span,
  SpanEvent,
  SpanError,
  SpanId,
  SpanKind,
  SpanStatus,
  TraceId,
  UnitType,
  Usage,
} from './core/trace.js';
export type { AgentTool, JsonSchema } from './core/tool.js';

// engine：Turn 0 内核
export { runAgent } from './engine/loop.js';
export { TraceRecorder } from './engine/tracer.js';
export { classifyError } from './engine/errors.js';
export type {
  AgentRunResult,
  AgentStopReason,
  RunAgentOptions,
  SystemParam,
  SystemTextBlock,
} from './engine/types.js';

// run：Turn 1 生命周期
export { Run, executeRun } from './run/run.js';
export { RunContext } from './run/context.js';
export { SystemPrompt } from './run/systemPrompt.js';
export type { SystemSection } from './run/systemPrompt.js';
export type { ExecuteRunOptions } from './run/run.js';
export type { RunMeta, RunStatus } from './run/types.js';
