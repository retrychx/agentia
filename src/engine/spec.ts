import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelPricing } from '../core/tool.js';
import type { AgentTool } from '../core/tool.js';
import type { BlackboardSeed } from '../core/blackboard.js';
import type { ContextPolicy } from './types.js';
import type { RetryOptions } from './retry.js';

/**
 * Agentia —— run 调用契约（spec §6.3 三类触发共用同一份入参形态）。
 * transport 层（同步 RPC / 异步任务 / 定时）只谈 RunInput / RunSpec，
 * 与具体 agent 装配解耦 —— 换宿主（HTTP/队列/DB）不换语义（spec §6.6）。
 *
 * 放在 engine 的理由：这是 transport 与 runtime **共用**的入参契约，而 engine
 * 在两者之下。此前它在 runtime，导致 store 为了 `TaskRecord.spec` 反向依赖
 * runtime（兄弟层）—— 移到 engine 后 store/toolkit/transport 都能合法引用。
 */

/** 单次 run 透传给引擎/应用的可选调用参数（与 toolkit/module 的 RunAppOptions 子集对齐） */
export interface RunInvocationOptions {
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  client?: ModelClient;
  onText?: (delta: string) => void;
  /** 中断信号：中止则在飞请求被取消，run 以 stopReason='aborted' 收尾 */
  signal?: AbortSignal;
  /** 预置进本次 RunContext.blackboard（扩展过 Blackboard 时键有补全） */
  blackboard?: BlackboardSeed;
  /** 上下文预算策略（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /** 模型请求重试策略（覆盖应用级缺省）；见 RunAgentOptions.retry */
  retry?: RetryOptions | false;
  /** 幂等键：异步宿主的 at-least-once 去重依据 */
  idempotencyKey?: string;
  /** 硬失败是否抛出；缺省 true（异步宿主置 false 落 failed 记录） */
  rethrow?: boolean;
  tools?: AgentTool[];
  /** 成本硬管控：整条 run 累计 token 上限；超限以 stopReason='budget_exceeded' 收尾（算失败） */
  maxTotalTokens?: number;
  /** 成本硬管控：累计成本（美元）上限；依赖模型在价格表内，见 createBudgetGuard */
  maxCostUsd?: number;
  /** 价格表覆盖/追加（$/1M tokens）；见 RunAgentOptions.priceOverrides */
  priceOverrides?: Record<string, ModelPricing>;
  /** 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run */
  toolTimeoutMs?: number;
  /** 同回合并行工具上限；缺省不限 */
  maxToolConcurrency?: number;
}

/** 一次任务的规范化入参：messages（已由 normalizeMessages 规整） */
export interface RunSpec {
  messages: Anthropic.MessageParam[];
  options?: RunInvocationOptions;
  /** 触发来源标记（sync / async / schedule:<id>），供 run 记录审计 */
  source?: string;
}

/** transport 层接受的原始入参形态 */
export type RunInput =
  | string
  | Anthropic.MessageParam[]
  | { prompt?: string; text?: string; messages?: Anthropic.MessageParam[] };

/** 把任意任务入参规范成 messages（首条缺省包成 user）。 */
export function normalizeMessages(input: RunInput | unknown): Anthropic.MessageParam[] {
  if (typeof input === 'string') {
    // 空串与 []、{prompt:''} 一致报错：返回 [] 会带着空 messages 去调模型
    if (!input) throw new Error('任务 messages 不能为空');
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    if (input.length === 0) throw new Error('任务 messages 不能为空');
    return input as Anthropic.MessageParam[];
  }
  if (input && typeof input === 'object') {
    const o = input as { prompt?: unknown; text?: unknown; messages?: unknown };
    if (Array.isArray(o.messages)) {
      if (o.messages.length === 0) throw new Error('任务 messages 不能为空');
      return o.messages as Anthropic.MessageParam[];
    }
    if (typeof o.prompt === 'string' && o.prompt) return [{ role: 'user', content: o.prompt }];
    if (typeof o.text === 'string' && o.text) return [{ role: 'user', content: o.text }];
  }
  throw new Error(`无法识别为任务输入: ${JSON.stringify(input)?.slice(0, 200)}`);
}
