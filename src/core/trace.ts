/**
 * Agentia —— Trace / 调用树 类型草稿。
 * 设计见 docs/spec.md §9。一次 run == 一条 trace（v1 中 traceId == runId）。
 */

export type TraceId = string;
export type SpanId = string;

/** span 层级：run=整次运行；capability=对能力的调用；llm.turn=每次模型往返。
 *  注意 capability span 只由 skill / subagent 创建（toolkit/skill.ts、toolkit/subagent.ts 里的
 *  recorder.begin('capability', …)）；普通工具与 @Prompt 资产【不建 span】，只记 turn 上的
 *  tool.input / tool.output 事件（engine/loop.ts）。 */
export type SpanKind = 'run' | 'capability' | 'llm.turn';

export type CapabilityType = 'tool' | 'skill' | 'prompt' | 'subagent';

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

/**
 * 结构化事件（日志）。工具入参/出参**正文默认截断**（入参/成功出参 2000 字符、失败出参 1000），
 * 完整正文需显式开启：`RunInvocationOptions.maxEventChars: false`（缺省关）。
 * 脱敏**不在框架内** —— 那是 sink 缝外的事（spec §9.3），框架只保证出口形状。
 */
export interface SpanEvent {
  time: number;
  name: string; // 例如 'tool.input' / 'tool.output' / 'compaction'
  body: unknown;
}

/**
 * 触发来源的链路上下文（跨进程 / 跨服务关联，spec §9.2）。
 *
 * 语义是**入站**的：调用方（HTTP 网关、队列消费者、上游服务）把它自己的 span 标识
 * 传进来，本次 run 的根 span 会把它记成一条 `SpanLink` 指回去 —— 于是「这条 run 是被
 * 谁触发的」在两个系统之间可查。
 *
 * ⚠️ **不改变 `traceId == runId` 的 1:1 不变量**：run 仍是自己的一棵新树，上游只是被
 * **链接**、不是被**继承**成父 span。所以一次 run 的调用树永远自洽（不依赖上游是否
 * 还在、是否被采样掉），而因果关系仍然成立。
 */
export interface TraceContext {
  /** 上游 trace id：32 位 hex（W3C traceparent）或 UUID（带 '-'）两种形态都接受 */
  traceId: string;
  /** 上游 span id（16 位 hex）；缺省表示只知道 trace 粒度、没有具体 span */
  spanId?: string;
}

/**
 * 一条链路引用：指向**另一个** trace 里的 span（OTLP 的 span links 同语义）。
 * v1 只在 run 根 span 上写入（来源是 `RunInvocationOptions.traceContext`）。
 */
export interface SpanLink {
  traceId: TraceId;
  spanId?: SpanId;
}

/** W3C traceparent：`<2位版本>-<32位trace>-<16位span>-<2位flags>`，全小写 hex */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * 解析 W3C `traceparent` 头（spec §9.2 的「header 语义」）。这是入站唯一的字符串形态
 * —— 宿主从 HTTP 头 / 队列消息属性里取到它，直接交给 `RunInvocationOptions.traceContext`。
 *
 * **非法或缺失一律返回 `undefined`**（调用方据此当作「没有上游上下文」继续跑）：
 * 链路关联是观测行为，不该因为一个畸形头把业务请求打成 400。被拒的形态有：
 * 版本 `ff`（W3C 保留为非法）、trace/span id 全零、位宽不符、大小写之外的畸形。
 * 版本号非 `00` 时按 W3C「兼容未来」规则接受（只认前四段语义）。
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, spanId] = m;
  if (version === 'ff') return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

export interface Span {
  spanId: SpanId;
  traceId: TraceId;
  parentSpanId: SpanId | null;
  kind: SpanKind;
  name: string; // capability: `${capabilityType}:${capabilityName}`；llm.turn: model id
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  error?: SpanError;
  /**
   * 跨 trace 的链路引用（v1 只出现在 run 根 span 上，见 `TraceContext`）。
   * 缺席（而不是空数组）表示「没有上游上下文」—— 与 links 为空的 span 是同一件事，
   * 不要据此区分「没传」和「传了但为空」。
   */
  links?: SpanLink[];
  /**
   * usage —— 语义按 kind 区分：
   * - `llm.turn`：该次模型往返的**自身计量**，是 Trace.totalUsage 的唯一来源；
   * - `capability`（skill / subagent）：其**子孙 llm.turn 的聚合**，仅供展示（看某个能力花了多少），
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
  totalUsage: Usage; // run 汇总 = 各 llm.turn span 求和（不含 capability 聚合，避免重复计数）
}

/**
 * 质量评分（R7 质量闭环）：LLM-judge / 人工标注 / eval 结论挂到 trace 上，
 * 让「这条 run 好不好」与「这条 run 发生了什么」同处一份数据。
 * 评分通常来自 run **之外**（跑完后才评），所以走事件而非 span 字段。
 */
export interface Score {
  /** 评分维度名（如 'faithfulness'、'eval'）—— 指标聚合的 label */
  name: string;
  /** 数值分；约定 0–1（布尔结论用 0/1） */
  value: number;
  /** 评分来源（eval 名 / 'human' / judge 模型 id 等） */
  source?: string;
  /** 备注（失败原因、评语） */
  comment?: string;
}

/**
 * 把评分挂到 trace 根 span（一条 `score` 事件，body 即 Score）。
 * trace 找不到根 span 时静默忽略（观测不击穿业务）；多次调用即多条事件（不同维度各记各的）。
 * 出口映射：OTLP 导出时译为 `gen_ai.evaluation.result` 事件，metricsSink 聚合为 score 指标族。
 */
export function attachScore(trace: Trace, score: Score): void {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  root?.events.push({ time: Date.now(), name: 'score', body: score });
}

/**
 * 能力 span 的类型标签：`attributes.skill` 有值 → `'skill'`，`attributes.subagent` 有值
 * → `'subagent'`，否则 `'capability'`（`SpanKind` 的第三个取值，也是 span 的 kind）。
 *
 * 放在本文件（而不是各出口里）：`skill` / `subagent` 这两个 attribute 名是
 * `toolkit/skill.ts`、`toolkit/subagent.ts` 与本类型之间的共同契约 —— 判定写在契约
 * 定义处，两个出口（`metrics.ts` 的指标 label、`report.ts` 的能力排行）只消费结论。
 * 此前两处各有一份同形实现，加起来是**同一件事的三个定义**。
 *
 * 返回 `string` 而非 `CapabilityType`：`'capability'` 不在 `CapabilityType`
 * （那是「菜单四类能力」的口径）里，两者刻意不混。
 */
export function capabilityKindOf(span: Span): string {
  if (span.attributes.skill !== undefined) return 'skill';
  if (span.attributes.subagent !== undefined) return 'subagent';
  return 'capability';
}

/**
 * trace 出口：run 收尾（成功或失败）后，框架把【完整 Trace】交给每个 sink。
 * sink 抛错由框架吞掉，绝不影响 run 结果（与 memory 回写同款防护）。
 * 形状与 OtlpExporter 一致 —— createOtlpExporter() 的返回值天然满足本接口。
 */
export interface TraceSink {
  export(trace: Trace): void | Promise<void>;
}
