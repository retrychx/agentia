import type Anthropic from '@anthropic-ai/sdk';
import type { SpanError, SpanId, SpanKind, SpanStatus, Trace, Usage } from './trace.js';

/**
 * Agentia —— 工具定义。
 * Turn 0：v1 用裸 JSON Schema，不引 zod；装饰器 → schema 在 Turn 2 接入。
 * Turn 3：run 执行体可接收第二参 ctx（ToolRunContext），供子 agent/嵌套单元把
 * 自己的 llm.turn 递归挂进当前 trace（unit span 的父由 engine 给定）。
 */

/** JSON Schema 对象子集，供工具的 input_schema */
export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/**
 * engine 的 TraceRecorder 面向子单元的最小结构面（core 不依赖 engine）。
 * 需要开嵌套 span 的单元（如 @SubAgent）通过 ctx.recorder 记账，
 * 其余工具可完全忽略它。
 */
export interface RecorderBackend {
  readonly traceId: string;
  begin(kind: SpanKind, name: string, parentSpanId: SpanId | null): SpanId;
  end(id: SpanId, patch?: { status?: SpanStatus; error?: SpanError; usage?: Usage }): void;
  event(id: SpanId, name: string, body: unknown): void;
  setAttribute(id: SpanId, key: string, value: string | number | boolean): void;
  snapshot(status: SpanStatus): Trace;
}

/**
 * engine 在调用每个工具时注入的执行上下文（spec §9.2：当前 span 句柄随调用传播，
 * 不用全局单例，保证并行工具调用父子关系准确）。
 * - recorder：整条 run 共享的 recorder（新子单元/子 agent 的 span 写它下面）；
 * - parentSpanId：发起本次调用的上层 span —— 子单元 span 应挂它下面；
 * - client：与主循环同一注入（子 agent 独立循环复用它）。
 */
export interface ToolRunContext {
  client: Anthropic;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
}

export interface AgentTool<I = unknown, O = unknown> {
  /** 模型可见的唯一名（建议 snake_case） */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 开启严格参数校验（schema 需 additionalProperties:false + required） */
  strict?: boolean;
  /**
   * 执行体。入参 = 模型按 schema 解析的结构化 input；
   * ctx 由 engine 注入（含 recorder/父 span），需要开嵌套 span 的单元（子 agent）用，
   * 普通工具可忽略。抛错会被包成 is_error 的 tool_result 回给模型，不中断 run。
   */
  run: (input: I, ctx?: ToolRunContext) => Promise<O> | O;
}
