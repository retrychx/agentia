import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPricing } from '../core/tool.js';
import type { Usage } from '../core/trace.js';

/**
 * Agentia —— 模型用量与成本估算（spec §6.4 成本硬管控的地基）。
 *
 * **成本是"可调优"的一部分，但历史实现有两处硬伤**（可观测·可调优设计 F1/F2）：
 * 1. 价格表是模块内常量 → 走 OpenAI 兼容端点（DeepSeek / 自建）的宿主**永远算不出成本**；
 * 2. 未定价模型返回 `undefined` → 成本恒 0 → `maxCostUsd` 这条护栏**静默失效**、且无任何提示。
 *
 * 现在：价格表可经 `priceOverrides` 覆盖/追加（`buildPricing`），未定价模型会在 run 根
 * 记 `usage.unpriced` 事件并有 `agentia_model_unpriced_turns_total` 指标 —— 护栏是否
 * 真的生效**看得见**。
 */

/** 内置价格表（$/1M tokens）。宿主用 `priceOverrides` 覆盖同名项或追加新模型。 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
});

/**
 * 合并内置表与宿主覆盖（**覆盖优先**）；返回合并后的表。
 * 不给覆盖时直接复用内置表（同一引用，零拷贝）。
 *
 * 非法单价（非有限数 / 负数）在**构造期抛错** —— 与其让它算出 NaN 成本、再让
 * `maxCostUsd` 拿 NaN 去比较（永远 false，护栏静默失效），不如立刻响亮失败。
 */
export function buildPricing(overrides?: Record<string, ModelPricing>): Record<string, ModelPricing> {
  if (!overrides) return DEFAULT_PRICING as Record<string, ModelPricing>;
  for (const [model, p] of Object.entries(overrides)) {
    const ok = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (!p || !ok(p.in) || !ok(p.out)) {
      throw new Error(
        `priceOverrides["${model}"] 非法：需要 { in, out } 两个非负有限数（$/1M tokens），收到 ${JSON.stringify(p)}`,
      );
    }
  }
  return { ...DEFAULT_PRICING, ...overrides };
}

export function usageFromAnthropic(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * 近似成本估计：缓存写≈1.25×输入，缓存读≈0.1×输入。
 * 模型不在传入的价格表内时返回 `undefined` —— 调用方须把"未定价"**显式**表达出来
 * （记 `usage.unpriced` 事件 / 计数），不要当成"成本 0"。
 */
export function costEstimate(
  model: string,
  usage: Usage,
  pricing: Record<string, ModelPricing> = DEFAULT_PRICING as Record<string, ModelPricing>,
): number | undefined {
  const p = pricing[model];
  if (!p) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usage;
  const cost =
    (inputTokens / 1e6) * p.in +
    (outputTokens / 1e6) * p.out +
    (cacheReadTokens / 1e6) * p.in * 0.1 +
    (cacheCreationTokens / 1e6) * p.in * 1.25;
  return Math.round(cost * 1e6) / 1e6;
}
