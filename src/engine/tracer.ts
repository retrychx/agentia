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
  /** parentSpanId → 直接子 span（增量维护，供 unit 结束时就地聚合子孙 usage，O(子孙) 而非每次重建） */
  private readonly children = new Map<SpanId | null, Span[]>();
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
    const siblings = this.children.get(parentSpanId);
    if (siblings) siblings.push(span);
    else this.children.set(parentSpanId, [span]);
    return id;
  }

  get rootStarted(): boolean {
    return this.rootSpanId !== null;
  }

  /**
   * 结束 span。容错策略：未知 span id 抛错（程序员错误要响亮）；
   * 对已结束的 span 幂等忽略（重复 end 视为无害）。event/setAttribute 对未知
   * span 静默忽略 —— 观测不应中断业务，与 end 的严格性刻意区分。
   *
   * `unit` span 收尾时若调用方**未**显式给 usage，就地聚合其**子孙 llm.turn** 的
   * usage 写回该 span —— 兑现 `core/trace.ts` 里「unit.usage = 其子孙聚合，仅供展示」
   * 的已声明语义（此前该字段从不写入，指标/报告拿不到「某个子 agent 花了多少」）。
   * 只累加 llm.turn，故层层嵌套也不会重复计数。
   */
  end(id: SpanId, patch: { status?: SpanStatus; error?: SpanError; usage?: Usage } = {}): void {
    const span = this.index.get(id);
    if (!span) throw new Error(`span not found: ${id}`);
    if (span.endedAt !== undefined) return; // 幂等：重复 end 忽略
    span.endedAt = Date.now();
    if (patch.status) span.status = patch.status;
    if (patch.error) span.error = patch.error;
    if (patch.usage) span.usage = patch.usage;
    else if (span.kind === 'unit') {
      const aggregated = this.aggregateDescendantUsage(id);
      if (aggregated) span.usage = aggregated;
    }
  }

  /** 子孙里所有 `llm.turn` 的 usage 之和（不含自身）；无任何计量时返回 undefined */
  private aggregateDescendantUsage(id: SpanId): Usage | undefined {
    const total: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let cost = 0;
    let priced = false;
    let any = false;
    const stack = [...(this.children.get(id) ?? [])];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (s.kind === 'llm.turn' && s.usage) {
        any = true;
        total.inputTokens += s.usage.inputTokens;
        total.outputTokens += s.usage.outputTokens;
        total.cacheReadTokens += s.usage.cacheReadTokens;
        total.cacheCreationTokens += s.usage.cacheCreationTokens;
        if (s.usage.costEstimate != null) {
          priced = true;
          cost += s.usage.costEstimate;
        }
      }
      const kids = this.children.get(s.spanId);
      if (kids) stack.push(...kids);
    }
    if (!any) return undefined;
    // 与 usage.ts 的取整口径一致（1e-6 美元），避免浮点尾差进 trace/OTLP
    if (priced) total.costEstimate = Math.round(cost * 1e6) / 1e6;
    return total;
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
