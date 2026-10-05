/**
 * 模型接线 —— 框架**不读 env**（deployment.md §1）：凭据由宿主代码显式传入。
 * 这里就是把宿主的 env 约定收敛到一处，并顺带处理 DeepSeek 那个**必须显式配**的东西：
 * 价格表。
 *
 * 为什么价目表是硬要求：`maxCostUsd` 这类「钱的上限」只在模型**有价**时才算得出来，
 * 而框架缺省价目表里只有 Anthropic 系。不覆盖的后果不是报错，是**静默不生效**
 * （`AppOptions.priceOverrides` 的注释原话），也就是「以为设了保险丝其实没设」。
 */
import { createOpenAIClient } from '@migor/agentia';
import type { ModelClient, ModelPricing } from '@migor/agentia';

/** 缺省模型：DeepSeek 的 OpenAI 兼容端点。可用 AGENTIA_MODEL 覆盖。 */
export const DEFAULT_MODEL = 'deepseek-v4-pro';

export interface ModelWiring {
  client: ModelClient;
  model: string;
  priceOverrides: Record<string, ModelPricing>;
  /** 价目表用的是占位值还是 env 给的真值 —— 读数里要如实标注 */
  pricingIsPlaceholder: boolean;
}

/** 占位价（$/1M tokens）。**必须用 PATROL_PRICE_IN/OUT 换成你端点的真实价目**，否则成本读数是假的。 */
const PLACEHOLDER_PRICING: ModelPricing = { in: 1, out: 2 };

export function wireModel(env: NodeJS.ProcessEnv = process.env): ModelWiring {
  const apiKey = env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '缺少 DEEPSEEK_API_KEY（或 OPENAI_API_KEY）—— 框架不读 env，是本进程要求它；' +
        '本地开发可 `set -a; . ~/.hermes/.env; set +a`，生产用编排平台的 secret 注入',
    );
  }
  const model = env.AGENTIA_MODEL ?? DEFAULT_MODEL;
  const baseURL = env.DEEPSEEK_BASE_URL ?? env.OPENAI_BASE_URL ?? 'https://api.deepseek.com';

  const inUsd = numOrUndefined(env.PATROL_PRICE_IN);
  const outUsd = numOrUndefined(env.PATROL_PRICE_OUT);
  const pricingIsPlaceholder = inUsd === undefined || outUsd === undefined;
  const pricing: ModelPricing = pricingIsPlaceholder
    ? PLACEHOLDER_PRICING
    : { in: inUsd as number, out: outUsd as number };

  return {
    // stream: false —— 兼容端点不认 stream_options 时退回一次性响应（见 OpenAIClientOptions 注释）；
    // 本示例用非流式换取「读数更稳」，生产交互式场景建议留默认的流式。
    client: createOpenAIClient({ apiKey, baseURL, stream: false }),
    model,
    priceOverrides: { [model]: pricing },
    pricingIsPlaceholder,
  };
}

function numOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
