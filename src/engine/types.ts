import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool } from '../core/tool.js';
import type { SpanError, Trace } from '../core/trace.js';

export type AgentStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'max_iterations'
  | 'tool_use_no_blocks'
  | 'error';

/** 可携带 cache_control 的 system 文本块（见 run/systemPrompt.ts） */
export interface SystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}
/** system 参数：纯文本，或可缓存块数组（稳定段带 breakpoint，volatile 段放其后不带） */
export type SystemParam = string | SystemTextBlock[];

export interface RunAgentOptions {
  /** 顶层 system（SystemPrompt 产物）。稳定内容应放在 tools 之后、第一个 breakpoint 前 */
  system?: SystemParam;
  /** 初始消息；Turn 0 由调用方给 user 起始消息 */
  messages: Anthropic.MessageParam[];
  /** 主 agent 可调工具（v1 裸 JSON schema） */
  tools?: AgentTool[];
  model?: string;
  /** 流式请求的 max_tokens，给足避免中途截断 */
  maxTokens?: number;
  /** 循环安全上限，防止无限 tool 往返 */
  maxIterations?: number;
  /** 注入 client（默认 new Anthropic()，读 env/ant auth） */
  client?: Anthropic;
  /** 注入 recorder（run 层复用；不注入则内部新建，traceId 即 runId） */
  recorder?: import('./tracer.js').TraceRecorder;
  /** 文本增量回调（终端/SSE 用） */
  onText?: (delta: string) => void;
  runName?: string;
}

export interface AgentRunResult {
  /** 本次 run 的完整调用树 + usage（traceId == runId） */
  trace: Trace;
  stopReason: AgentStopReason;
  /** 最终文本（结构化输出在后续 Turn 接入） */
  finalText: string;
  iterations: number;
  error?: SpanError;
}
