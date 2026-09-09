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
export type { AgentRunResult, AgentStopReason, RunAgentOptions } from './engine/types.js';
