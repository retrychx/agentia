import type Anthropic from '@anthropic-ai/sdk';
import type { SpanError, SpanId, SpanKind, SpanStatus, Trace, Usage } from './trace.js';

/**
 * Agentia —— 工具定义。
 * v1 用裸 JSON Schema，不引 zod。
 * run 执行体可接收第二参 ctx（ToolRunContext），供子 agent/嵌套单元把
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
 * 泛型 schema：在普通 JSON Schema 上挂一个**纯类型**的幻影字段，把「校验通过后的
 * 结果类型」带进类型系统 —— 框架据此推导 `AgentRunResult.typed` 与 `@Tool` 方法的
 * 入参类型。运行时**不存在**该字段（见 toolkit/zod.ts 的 fromZod）。
 *
 * 不是必须的：直接给裸 JsonSchema（旧写法）时回落 unknown/any，行为与之前逐字一致。
 */
export interface TypedSchema<T> extends JsonSchema {
  /** 幻影字段（永不在运行时出现）：仅用于类型推导，勿读取 */
  readonly __typed?: T;
}

/**
 * 从 schema 提取「结果类型」：`TypedSchema<T>` → `T`；普通 `JsonSchema` → `unknown`
 * （与 typed 字段旧语义一致）。用于 `runAgent` / `executeRun` / `app.run` 的返回值。
 */
export type SchemaType<S> = S extends TypedSchema<infer T> ? T : unknown;

/**
 * 装饰器方法入参类型：与 SchemaType 同源，但**未给出具体类型时回落 any** ——
 * 这样「裸 JsonSchema」与「fromZod(...) 没写 <T>」两种既有写法都不被破坏
 * （不校验方法签名），只有 `fromZod<T>()` 明确了 T 后才开始校验
 * 「方法签名 vs schema」的一致性。
 */
export type SchemaInput<S> = S extends TypedSchema<infer T>
  ? unknown extends T
    ? any
    : T
  : any;

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
 * engine 对模型端的最小结构面（R4 多模型）：Anthropic SDK 天然满足，
 * 其他 provider（OpenAI 兼容端点等）只需适配出同一形态。
 */
export interface ModelClient {
  messages: {
    stream(params: {
      model: string;
      max_tokens: number;
      system?: string | Anthropic.TextBlockParam[];
      tools?: Anthropic.Tool[];
      messages: Anthropic.MessageParam[];
      /** 中断信号（可选）：实现须转发给底层请求，否则调用方无法中止在飞 run */
      signal?: AbortSignal;
    }): {
      on(event: 'text', cb: (delta: string) => void): void;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

/**
 * 模型单价（美元 / 1M tokens）。内置表见 `engine/usage.ts`；宿主可用
 * `priceOverrides` 覆盖或追加（非 Anthropic 端点也能算成成本）。
 * 定义在 core 是为了让 `ToolRunContext` 能带上它 —— core 不能依赖 engine。
 */
export interface ModelPricing {
  in: number;
  out: number;
}

/**
 * engine 在调用每个工具时注入的执行上下文（spec §9.2：当前 span 句柄随调用传播，
 * 不用全局单例，保证并行工具调用父子关系准确）。
 * - recorder：整条 run 共享的 recorder（新子单元/子 agent 的 span 写它下面）；
 * - parentSpanId：发起本次调用的上层 span —— 子单元 span 应挂它下面；
 * - client：与主循环同一注入（子 agent 独立循环复用它）。
 */
export interface ToolRunContext {
  client: ModelClient;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  /**
   * 本次 run 的中断信号。工具**自行决定**是否尊重（如传给 fetch）；框架不会
   * 强制中断工具 —— 工具副作用无法回滚，强行中止只会留下不一致的中间态。
   */
  signal?: AbortSignal;
  /**
   * 宿主的价格覆盖表（见 `engine/usage.ts` 的 `buildPricing`）。嵌套单元
   * （@SubAgent / @Skill）拉起自己的 llm 循环时必须原样传下去，否则自定义定价的
   * 模型在子循环里会退化成"未定价"（成本恒 0，`maxCostUsd` 静默失效）。
   */
  priceOverrides?: Record<string, ModelPricing>;
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
