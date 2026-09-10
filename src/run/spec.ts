import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../core/tool.js';
import type { AgentTool } from '../core/tool.js';
import type { ContextPolicy } from '../engine/types.js';

/**
 * Agentia —— run 调用契约（spec §6.3 三类触发共用同一份入参形态）。
 * transport 层（同步 RPC / 异步任务 / 定时）只谈 RunInput / RunSpec，
 * 与具体 agent 装配解耦 —— 换宿主（HTTP/队列/DB）不换语义（spec §6.6）。
 */

/** 单次 run 透传给引擎/应用的可选调用参数（与 toolkit/module 的 RunAppOptions 子集对齐） */
export interface RunInvocationOptions {
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  client?: ModelClient;
  onText?: (delta: string) => void;
  /** 预置进本次 RunContext.blackboard */
  blackboard?: Record<string, unknown>;
  /** 上下文预算策略（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /** 幂等键：异步宿主的 at-least-once 去重依据 */
  idempotencyKey?: string;
  /** 硬失败是否抛出；缺省 true（异步宿主置 false 落 failed 记录） */
  rethrow?: boolean;
  tools?: AgentTool[];
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
    return input ? [{ role: 'user', content: input }] : [];
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
