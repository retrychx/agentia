import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, JsonSchema, ModelClient } from '../core/tool.js';
import type { SpanError, Trace } from '../core/trace.js';

export type { ModelClient } from '../core/tool.js';

export type AgentStopReason =
  /** 模型自然结束（含 stop_sequence：命中 stop 序列同样是正常收尾） */
  | 'end_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'max_iterations'
  /** stop_reason=tool_use 但回合里没有可执行块（畸形响应），防死循环直接停 */
  | 'tool_use_no_blocks'
  /** 模型/网关返回了本框架未识别的 stop_reason：保留文本，但按失败收尾 */
  | 'unknown_stop_reason'
  | 'error';

/**
 * 是否「正常收尾」：end_turn（自然结束）与 stop_sequence（命中 stop 序列）都算。
 * run 状态机 / trace 状态 / 子 agent 交回判定共用这一把尺子 —— 三处各写各的
 * `=== 'end_turn'` 时，新增一个正常收尾原因就会漏改其中一处（stop_sequence 落地时
 * 就出现过：loop 判成功、Run 判失败）。
 */
export function isSuccessStopReason(reason: AgentStopReason): boolean {
  return reason === 'end_turn' || reason === 'stop_sequence';
}

/** 可携带 cache_control 的 system 文本块（见 run/systemPrompt.ts） */
export interface SystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}
/** system 参数：纯文本，或可缓存块数组（稳定段带 breakpoint，volatile 段放其后不带） */
export type SystemParam = string | SystemTextBlock[];

/**
 * 上下文预算策略（spec §5/§6 —— compaction / context editing）。
 * 引擎在每个 llm 回合发送前调用 beforeTurn；返回的 messages 即本回合发送内容。
 * 实现见 engine/policy.ts 的 createBudgetPolicy，或自实现（如每次用 /count_tokens）。
 */
export interface ContextPolicy {
  /** 预算（估算 input tokens）；超预算的回合触发降级。供观测/文档用 */
  readonly budgetTokens?: number;
  beforeTurn(
    messages: Anthropic.MessageParam[],
    info: { iteration: number; model: string },
  ): Promise<Anthropic.MessageParam[]>;
}

/**
 * engine 对模型端的最小结构面（R4 多模型）：Anthropic SDK 天然满足，
 * 其他 provider（OpenAI 兼容端点等）只需适配出同一形态。
 * 定义在 core/tool.js 并从此处转导出。
 */
export interface RunAgentOptions<S extends JsonSchema = JsonSchema> {
  /** 顶层 system（SystemPrompt 产物）。稳定内容应放在 tools 之后、第一个 breakpoint 前 */
  system?: SystemParam;
  /** 初始消息；由调用方给 user 起始消息 */
  messages: Anthropic.MessageParam[];
  /** 主 agent 可调工具（v1 裸 JSON schema） */
  tools?: AgentTool[];
  model?: string;
  /** 流式请求的 max_tokens，给足避免中途截断 */
  maxTokens?: number;
  /** 循环安全上限，防止无限 tool 往返 */
  maxIterations?: number;
  /** 注入 client（默认 new Anthropic()，读 env/ant auth）；多模型见 ModelClient */
  client?: ModelClient;
  /** 注入 recorder（run 层复用；不注入则内部新建，traceId 即 runId） */
  recorder?: import('./tracer.js').TraceRecorder;
  /** 文本增量回调（终端/SSE 用） */
  onText?: (delta: string) => void;
  runName?: string;
  /** 上下文预算策略：每回合发送前可编辑/压缩消息（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /**
   * 结构化结果 schema（R2）：给出后 engine 追加隐藏工具 submit_result，
   * 模型调用它提交符合 schema 的最终结果，校验通过即结束循环并写入 AgentRunResult.typed；
   * 模型始终未提交则 typed 为 undefined（行为与不设时一致）。
   *
   * 泛型 S：传 `fromZod<T>(...)`（TypedSchema<T>）时，返回值 `typed` 自动是 `T | undefined`；
   * 传裸 JsonSchema 时回落 `unknown`。
   */
  resultSchema?: S;
}

export interface AgentRunResult<T = unknown> {
  /** 本次 run 的完整调用树 + usage（traceId == runId） */
  trace: Trace;
  stopReason: AgentStopReason;
  /** 最终文本（提交结构化结果的回合若带文本则取之，可空） */
  finalText: string;
  iterations: number;
  error?: SpanError;
  /**
   * resultSchema 校验通过的结构化结果；模型没提交（或未设 resultSchema）则为 undefined。
   * 类型由 resultSchema 推导（见 RunAgentOptions.resultSchema 的泛型说明）。
   */
  typed?: T;
}
