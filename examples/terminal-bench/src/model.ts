/**
 * 模型侧装配 —— 把「用哪家模型」收在一处，run.ts 与 live-probe.ts 共用。
 *
 * ## 为什么单独一个文件
 *
 * 两个入口都要「可能换端点、可能换模型名、可能要自己定价」这三件事，各写一份就会漂
 * （本仓对同一判定写两处的老毛病，见 `src/integrations/adapter-options.ts` 的文件头）。
 *
 * ## DeepSeek 不需要新代码
 *
 * 框架自带的 `createOpenAIClient` 就是 OpenAI **兼容端点**适配器
 * （`docs/usage-guide.md` §6.5 明写「OpenAI 兼容端点适配（DeepSeek 等）」）——
 * 换 `baseURL` 即可，**不新增依赖、不改 src/**。这是本仓「只给缝、不给策略」的正面例子：
 * 端点差异是宿主编的事，不该进核心。
 *
 * ## ⚠️ 价格是宿主编，且会腐烂
 *
 * 框架内置价格表只有 Anthropic 几档（`src/engine/usage.ts` 的 DEFAULT_PRICING），
 * 所以**不定价的话 DeepSeek 的成本恒 0** —— ATIF 的 `final_metrics.total_cost_usd`
 * 会是 0，评测里「每任务花了多少钱」这一维直接废掉，而且**没有任何报错**
 * （框架会在 llm.turn 上记 `usage.unpriced` 事件，但那是给你查的，不会拦你）。
 *
 * 所以 DeepSeek 路径必须传 `priceOverrides`。缺省值取自框架文档里已有的 DeepSeek 示例
 * （`src/engine/types.ts` 的注释），**不是权威报价** —— 发榜前请以官方定价为准，
 * 或用 `AGENTIA_PRICE_IN` / `AGENTIA_PRICE_OUT` 覆盖。
 *
 * ## 为什么 `model` 是可选的
 *
 * 「不给」与「给空串」在本框架里不是一回事：`createApp({ model })` 的缺省取值是
 * `?? 缺省`，空串会**真的**把模型名设成空串。所以这里一律**整体摘键**，不传空值。
 */
import type { ModelClient } from '@migor/agentia';
import { createOpenAIClient } from '@migor/agentia';

/** 价格单位与框架一致：美元 / 1M tokens */
export interface ModelPricing {
  in: number;
  out: number;
}

export interface ModelBinding {
  /** 不给 = 走框架默认（Anthropic，读 ANTHROPIC_API_KEY） */
  client?: ModelClient;
  /** 不给 = 走框架默认模型 */
  model?: string;
  priceOverrides?: Record<string, ModelPricing>;
}

/** 缺省单价（$/1M tokens）—— 取自框架文档里的 DeepSeek 示例，**非权威报价**，可用 env 覆盖 */
const DEEPSEEK_DEFAULT_PRICING: ModelPricing = { in: 0.27, out: 1.1 };

/**
 * 按 env 决定用哪家。
 *
 * env：
 *   DEEPSEEK_API_KEY        设了 ⇒ 走 DeepSeek（OpenAI 兼容端点）
 *   DEEPSEEK_BASE_URL       覆盖端点（缺省 https://api.deepseek.com）
 *   AGENTIA_MODEL           模型名（缺省：DeepSeek 走 deepseek-chat，否则不覆盖框架默认）
 *   AGENTIA_PRICE_IN/OUT    覆盖单价（$/1M tokens）—— 需要同时给两个，否则忽略
 */
export function resolveModel(): ModelBinding {
  const modelFromEnv = process.env.AGENTIA_MODEL;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  // 两个单价要成对给：只给一个会算出半边错的成本，比不覆盖更糟
  const priceIn = envNumber('AGENTIA_PRICE_IN');
  const priceOut = envNumber('AGENTIA_PRICE_OUT');
  const explicitPrice =
    priceIn !== undefined && priceOut !== undefined ? { in: priceIn, out: priceOut } : undefined;

  // Anthropic 路径：框架内置价格表已覆盖 claude-*，不需要宿主定价。
  // 只有宿主**显式**给了 model 名 + 单价时才覆盖（否则不知道该给谁定价）。
  if (!deepseekKey) {
    if (!modelFromEnv) return {};
    return {
      model: modelFromEnv,
      ...(explicitPrice ? { priceOverrides: { [modelFromEnv]: explicitPrice } } : {}),
    };
  }

  const model = modelFromEnv ?? 'deepseek-chat';
  return {
    client: createOpenAIClient({
      apiKey: deepseekKey,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    }),
    model,
    priceOverrides: { [model]: explicitPrice ?? DEEPSEEK_DEFAULT_PRICING },
  };
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  // NaN 会让成本算出 NaN 并一路污染 total_cost_usd；宁可不覆盖也别静默传坏值
  return Number.isFinite(n) ? n : undefined;
}
