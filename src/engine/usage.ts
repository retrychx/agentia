import type Anthropic from '@anthropic-ai/sdk';
import type { Usage } from '../core/trace.js';

/** $/1M tokens（输入/输出）。未知模型不估成本。 */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export function usageFromAnthropic(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** 近似成本估计：缓存写≈1.25×输入，缓存读≈0.1×输入。 */
export function costEstimate(model: string, usage: Usage): number | undefined {
  const p = PRICING[model];
  if (!p) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usage;
  const cost =
    (inputTokens / 1e6) * p.in +
    (outputTokens / 1e6) * p.out +
    (cacheReadTokens / 1e6) * p.in * 0.1 +
    (cacheCreationTokens / 1e6) * p.in * 1.25;
  return Math.round(cost * 1e6) / 1e6;
}
