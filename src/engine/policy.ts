import type Anthropic from '@anthropic-ai/sdk';
import type { ContextPolicy } from './types.js';
import {
  compactMessages,
  defaultEstimateTokens,
  estimateMessages,
  trimToolPairs,
} from './trimming.js';

/**
 * Agentia —— 预算驱动的上下文策略（spec §5 compaction / §6 budget）。
 *
 * 规则（带滞回，避免每回合反复压缩）：
 * 1. 估算整组消息 token；≤ budgetTokens → 原样放行（快路径）。
 * 2. 超预算：先 **context editing**（trimToolPairs 丢旧工具对，不额外调模型）；
 *    若裁剪后回到预算内即止。
 * 3. 仍超预算且有 summarize（compaction 摘要器）→ 压缩：旧前缀做成摘要，只留最近 keepRecent 条。
 *    距上次压缩 < compactEvery 个回合则跳过（滞回，防抖）。
 * 4. 无 summarize 时 compaction 不可用，编辑已是上限（返回裁剪后消息）。
 *
 * summarize 未提供时 policy 不会自己调模型 —— 框架不替你造 token（spec：不主动黑名单，
 * 预算只是护栏；真机可注入按 /count_tokens 的 estimate 与走模型的 summarize）。
 */
export interface BudgetPolicyOptions {
  /** 预算（估算 input tokens）；缺省 60_000 */
  budgetTokens?: number;
  /** compaction 保留的最近消息条数；缺省 20 */
  keepRecent?: number;
  /** token 估算函数（预算决策用，非精确记账）；缺省 CJK 感知启发式 */
  estimateTokens?: (text: string) => number;
  /** 是否先编辑再压缩；缺省 true */
  editBeforeCompact?: boolean;
  /** 提供则允许 compaction（旧前缀→摘要）。框架不自动造摘要器 */
  summarize?: (historyText: string) => string | Promise<string>;
  /** 距上次压缩至少隔几个回合才再次压缩（滞回）；缺省 1 */
  compactEvery?: number;
}

export function createBudgetPolicy(opts: BudgetPolicyOptions = {}): ContextPolicy {
  const budgetTokens = opts.budgetTokens ?? 60_000;
  const keepRecent = Math.max(1, opts.keepRecent ?? 20);
  const estimate = opts.estimateTokens ?? defaultEstimateTokens;
  const editBeforeCompact = opts.editBeforeCompact ?? true;
  const summarize = opts.summarize;
  const compactEvery = Math.max(1, opts.compactEvery ?? 1);
  let lastCompactAt = Number.NEGATIVE_INFINITY;

  return {
    budgetTokens,
    async beforeTurn(messages, info) {
      if (estimateMessages(messages, estimate) <= budgetTokens) return messages;

      // 1) context editing：先丢旧工具对
      let current = messages;
      if (editBeforeCompact) {
        const trimmed = trimToolPairs(current, { keepRecent });
        if (trimmed.length < current.length) {
          current = trimmed;
          if (estimateMessages(current, estimate) <= budgetTokens) return current;
        }
      }

      // 2) compaction：仍超预算且有摘要器
      if (!summarize) return current;
      if (info.iteration - lastCompactAt < compactEvery) return current;
      lastCompactAt = info.iteration;
      return compactMessages(current, { keepRecent, summarize });
    },
  };
}
