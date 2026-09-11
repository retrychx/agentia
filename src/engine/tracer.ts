import { randomUUID } from 'node:crypto';
import type {
  Span,
  SpanError,
  SpanId,
  SpanKind,
  SpanStatus,
  Trace,
  TraceId,
  Usage,
} from '../core/trace.js';

/**
 * 内存 TraceRecorder —— v1 实现（spec §9.3）。
 * 显式传 parentSpanId 而非内部栈，保证并行工具调用时父子关系准确。
 * 一次 run 一个 recorder；run 与 trace 1:1。
 */
export class TraceRecorder {
  readonly traceId: TraceId = randomUUID();
  private readonly spans: Span[] = [];
  private readonly index = new Map<SpanId, Span>();
  private rootSpanId: SpanId | null = null;

  begin(kind: SpanKind, name: string, parentSpanId: SpanId | null): SpanId {
    if (kind === 'run') {
      if (this.rootSpanId) throw new Error('run root already started');
      this.rootSpanId = randomUUID();
    }
    const id = kind === 'run' ? this.rootSpanId! : randomUUID();
    const span: Span = {
      spanId: id,
      traceId: this.traceId,
      parentSpanId,
      kind,
      name,
      status: 'ok',
      startedAt: Date.now(),
      attributes: {},
      events: [],
    };
    this.spans.push(span);
    this.index.set(id, span);
    return id;
  }

  get rootStarted(): boolean {
    return this.rootSpanId !== null;
  }

  /**
   * 结束 span。容错策略：未知 span id 抛错（程序员错误要响亮）；
   * 对已结束的 span 幂等忽略（重复 end 视为无害）。event/setAttribute 对未知
   * span 静默忽略 —— 观测不应中断业务，与 end 的严格性刻意区分。
   */
  end(id: SpanId, patch: { status?: SpanStatus; error?: SpanError; usage?: Usage } = {}): void {
    const span = this.index.get(id);
    if (!span) throw new Error(`span not found: ${id}`);
    if (span.endedAt !== undefined) return; // 幂等：重复 end 忽略
    span.endedAt = Date.now();
    if (patch.status) span.status = patch.status;
    if (patch.error) span.error = patch.error;
    if (patch.usage) span.usage = patch.usage;
  }

  event(id: SpanId, name: string, body: unknown): void {
    this.index.get(id)?.events.push({ time: Date.now(), name, body });
  }

  setAttribute(id: SpanId, key: string, value: string | number | boolean): void {
    const span = this.index.get(id);
    if (span) span.attributes[key] = value;
  }

  snapshot(status: SpanStatus): Trace {
    if (!this.rootSpanId) throw new Error('run root not started');
    const totalUsage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    // 只累加「自身计量」的 span（llm.turn 是唯一 token 来源）。
    // unit span 的 usage 语义是**其子孙的聚合**（见 core/trace.ts Span.usage），
    // 若一并求和，skill/subagent 一旦写入聚合值就会把同一批 token 计两遍。
    for (const s of this.spans) {
      if (!s.usage || s.kind !== 'llm.turn') continue;
      totalUsage.inputTokens += s.usage.inputTokens;
      totalUsage.outputTokens += s.usage.outputTokens;
      totalUsage.cacheReadTokens += s.usage.cacheReadTokens;
      totalUsage.cacheCreationTokens += s.usage.cacheCreationTokens;
      if (s.usage.costEstimate != null) {
        totalUsage.costEstimate = (totalUsage.costEstimate ?? 0) + s.usage.costEstimate;
      }
    }
    return {
      traceId: this.traceId,
      rootSpanId: this.rootSpanId,
      spans: [...this.spans],
      status,
      totalUsage,
    };
  }
}
