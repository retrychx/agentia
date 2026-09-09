/**
 * Agentia —— Trace / 调用树 类型草稿。
 * 设计见 docs/spec.md §9。一次 run == 一条 trace（v1 中 traceId == runId）。
 */

export type TraceId = string;
export type SpanId = string;

/** span 层级：run=整次运行；unit=对单个单元(tool/skill/prompt/subagent)的调用；llm.turn=unit 内每次模型往返 */
export type SpanKind = 'run' | 'unit' | 'llm.turn' | 'internal';

export type UnitType = 'tool' | 'skill' | 'prompt' | 'subagent';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 估算成本(美元)，由 token × 单价算出，随模型表更新 */
  costEstimate?: number;
}

export type SpanStatus = 'ok' | 'error';

export interface SpanError {
  type: string;
  message: string;
  /** 是否可安全重试（429/5xx/网络 vs 400/400类） */
  retryable: boolean;
}

/** 结构化事件（日志）。工具入参/出参默认截断 + 脱敏，完整内容 opt-in */
export interface SpanEvent {
  time: number;
  name: string; // 例如 'tool.input' / 'tool.output' / 'compaction'
  body: unknown;
}

export interface Span {
  spanId: SpanId;
  traceId: TraceId;
  parentSpanId: SpanId | null;
  kind: SpanKind;
  name: string; // unit: `${unitType}:${unitName}`；llm.turn: model id
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  error?: SpanError;
  /** unit / llm.turn 的聚合用量 */
  usage?: Usage;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface Trace {
  traceId: TraceId;
  rootSpanId: SpanId;
  spans: Span[];
  status: SpanStatus;
  totalUsage: Usage; // run 汇总 = 各 span 求和
}
