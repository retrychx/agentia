import type { Trace } from '../core/trace.js';

/**
 * Agentia —— 成本硬管控（C1，补 spec §6.4 的欠账）。
 *
 * ⚠️ **与 `createBudgetPolicy` 的分工（文档必须并列讲清，别混）**：
 * - `createBudgetPolicy`（engine/policy.ts）= **发送前**的上下文裁剪：防止历史过长把请求撞成
 *   400、或过早触发压缩。它改的是 messages；
 * - `createBudgetGuard`（本文件）= **记账后**的硬停止：每回合 `llm.turn` 的 usage 落账后累计判断，
 *   超限即把 run 停掉。它不改 messages，目的是**控制花钱**。
 *
 * 两者互补，可以同时用。
 */

/** 超限快照：记进 run 根的 `budget.exceeded` 事件，也回调给 `onExceed` */
export interface BudgetSnapshot {
  /** 先触发的那条护栏（**先算 tokens 再算 cost**） */
  kind: 'tokens' | 'cost';
  /** 该护栏的上限 */
  limit: number;
  /** 触发时的实际值（必然 > limit） */
  actual: number;
  /** 累计 token = input + output + cacheRead + cacheCreation */
  totalTokens: number;
  /** 累计成本估算（美元）；模型不在价格表内时恒为 0（见 maxCostUsd 说明） */
  costUsd: number;
}

export interface BudgetGuardOptions {
  /** 整条 run（含子 agent）的累计 token 上限 */
  maxTotalTokens?: number;
  /**
   * 累计成本上限（美元）。**依赖 span 级 usage 的 `costEstimate`** ——
   * 模型不在 `engine/usage.ts` 的价格表里时成本恒为 0，这条护栏**永远不触发**；
   * 要无条件兜底请用 `maxTotalTokens`。同理，缓存 token 的单价是近似值（见 usage.ts）。
   */
  maxCostUsd?: number;
  /**
   * 超限时的回调（在 `check` 返回前调用）。**抛错会冒泡进引擎** ——
   * 想记日志/告警请自行保证不抛（引擎侧装配的那条已经做了 try 包裹）。
   */
  onExceed?: (snapshot: BudgetSnapshot) => void;
}

export interface BudgetGuard {
  /** 每回合记账完成后调用；超限返回 `'tokens' | 'cost'`，否则 `null` */
  check(trace: Trace): 'tokens' | 'cost' | null;
}

/**
 * 建一个预算护栏。`check` 只看 **trace.totalUsage**（已由 recorder 按 llm.turn 求和，
 * 子 agent 的往返也在内 —— 所以这是**整条 run** 的口径，不只是主循环）。
 */
export function createBudgetGuard(opts: BudgetGuardOptions = {}): BudgetGuard {
  const { maxTotalTokens, maxCostUsd, onExceed } = opts;
  return {
    check(trace: Trace): 'tokens' | 'cost' | null {
      const u = trace.totalUsage;
      const totalTokens =
        u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      const costUsd = u.costEstimate ?? 0;
      if (maxTotalTokens != null && totalTokens > maxTotalTokens) {
        onExceed?.({ kind: 'tokens', limit: maxTotalTokens, actual: totalTokens, totalTokens, costUsd });
        return 'tokens';
      }
      if (maxCostUsd != null && costUsd > maxCostUsd) {
        onExceed?.({ kind: 'cost', limit: maxCostUsd, actual: costUsd, totalTokens, costUsd });
        return 'cost';
      }
      return null;
    },
  };
}
