/**
 * Agentia —— Trace / 调用树 类型草稿。
 * 设计见 docs/spec.md §9。一次 run == 一条 trace（v1 中 traceId == runId）。
 */

export type TraceId = string;
export type SpanId = string;

/** span 层级：run=整次运行；unit=对单元的调用；llm.turn=每次模型往返。
 *  注意 unit span 只由 skill / subagent 创建（toolkit/skill.ts、toolkit/subagent.ts 里的
 *  recorder.begin('unit', …)）；普通工具与 @Prompt 资产【不建 span】，只记 turn 上的
 *  tool.input / tool.output 事件（engine/loop.ts）。 */
export type SpanKind = 'run' | 'unit' | 'llm.turn';

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
  /**
   * usage —— 语义按 kind 区分：
   * - `llm.turn`：该次模型往返的**自身计量**，是 Trace.totalUsage 的唯一来源；
   * - `unit`（skill / subagent）：其**子孙 llm.turn 的聚合**，仅供展示（看某个单元花了多少），
   *   **不**计入 totalUsage（否则与子孙重复计数）。
   */
  usage?: Usage;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface Trace {
  traceId: TraceId;
  rootSpanId: SpanId;
  spans: Span[];
  status: SpanStatus;
  totalUsage: Usage; // run 汇总 = 各 llm.turn span 求和（不含 unit 聚合，避免重复计数）
}

/**
 * trace 出口：run 收尾（成功或失败）后，框架把【完整 Trace】交给每个 sink。
 * sink 抛错由框架吞掉，绝不影响 run 结果（与 memory 回写同款防护）。
 * 形状与 OtlpExporter 一致 —— createOtlpExporter() 的返回值天然满足本接口。
 */
export interface TraceSink {
  export(trace: Trace): void | Promise<void>;
}
