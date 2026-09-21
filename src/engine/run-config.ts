import type { JsonSchema } from '../core/tool.js';
import { resolveRetry } from './retry.js';
import type { ContextPolicy, RunAgentOptions } from './types.js';
import type { TraceLimits } from './tracer.js';

/**
 * Agentia —— run 生效旋钮：**缺省解析 + 快照编码**（spec §5 / §9 G3）。
 *
 * 本文件回答两件事，而且是同一件事的两面：
 *   ① 跑一条 run 时各项旋钮**实际取到什么值**（显式传入 / env / 缺省）；
 *   ② 这些值**怎么记进 run 根**（`config.*` attributes）。
 * 认下缺省值的人必须是把它写进 trace 的人 —— 否则「记录的」与「生效的」会漂移。
 *
 * 文件分工：本文件只做**纯映射**（读 options 与 env，不碰 recorder / 网络 / 时钟，
 * 不构造 span，不写属性）；开 run 根、把快照写进去、循环编排都在 engine/loop.ts。
 */

/**
 * 缺省模型解析：显式传入 > AGENTIA_MODEL env > 'claude-opus-5'。
 * 不把端点私有模型写死在代码里 —— 走 Anthropic 兼容网关（如 DeepSeek 端点）时
 * export AGENTIA_MODEL=deepseek-… 即可全局覆盖，无需逐处传 model。
 */
export function resolveDefaultModel(over?: string): string {
  if (over) return over;
  return process.env.AGENTIA_MODEL?.trim() || 'claude-opus-5';
}

/** 缺省单次 maxTokens / 循环上限：runAgent 与 runAgentScoped 共用，避免两处各写一遍漂移。 */
export const DEFAULT_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_ITERATIONS = 40;

/**
 * 生效配置快照（G3）：把本 run 实际生效的旋钮整理成 run 根的 `config.*` attributes。
 * 只放标量（OTLP/日志/看板都能直接吃）；缺省值也记，这样"没配"与"配了缺省值"可区分于
 * "该项不存在"。函数型选项只记"配没配"，不记函数体。
 */
export function runConfigSnapshot(
  // traceLimits 不在 RunAgentOptions 上：它是 run 层（ExecuteRunOptions /
  // RunInvocationOptions）的旋钮 —— executeRun 在 run 入口用 resolveTraceLimits
  // 校验后交给 recorder（见 runtime/run.ts），再把**同一份** options 透传到本函数，
  // 所以这里读到的就是生效值（「认下缺省值的人就是写进 trace 的人」）。
  options: RunAgentOptions<JsonSchema> & { traceLimits?: TraceLimits },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    'config.model': resolveDefaultModel(options.model),
    'config.maxTokens': options.maxTokens ?? DEFAULT_MAX_TOKENS,
    'config.maxIterations': options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
  if (options.maxTotalTokens != null) out['config.maxTotalTokens'] = options.maxTotalTokens;
  if (options.maxCostUsd != null) out['config.maxCostUsd'] = options.maxCostUsd;
  if (options.toolTimeoutMs != null) out['config.toolTimeoutMs'] = options.toolTimeoutMs;
  // 非正 / 非有限值在 `mapWithConcurrency` 里一律等于「不限并发」，但原样记进 trace 会写成
  // `NaN`（过不了 JSON/OTLP 序列化，到看板上是 null）或 `-1`（读起来像「卡在负数个并发」）。
  // 记**生效的**整数（`floor` 且至少 1，见 `concurrency.ts`），不限则同 `maxEventChars` 记 'off'。
  if (options.maxToolConcurrency != null)
    out['config.maxToolConcurrency'] =
      Number.isFinite(options.maxToolConcurrency) && options.maxToolConcurrency > 0
        ? Math.max(1, Math.floor(options.maxToolConcurrency))
        : 'off';
  // 事件截断关掉时记 'off' 而不是 false：`maxEventChars: false` 在日志/看板里
  // 容易被读成「上限为 0」，'off' 一句话说清是**没有上限**
  if (options.maxEventChars != null)
    out['config.maxEventChars'] = options.maxEventChars === false ? 'off' : options.maxEventChars;
  // 记账数量闸：与 maxEventChars（管「多长」）正交，这个管「多少」。键名镜像选项路径
  //（同 config.retry.maxAttempts / config.contextPolicy.budgetTokens 的口径）。
  // 0 = 「一条都不记」是有意义的值，原样记 0 —— 不记成 'off'（本文件里 'off' = 不设上限，
  // 与上限为 0 是两回事）。坏值（NaN / 负数 / 小数）在 run 入口已被 resolveTraceLimits
  // 拦下（抛 TypeError），走不到这里，所以不需要 maxToolConcurrency 那样的净化分支。
  const maxEvents = options.traceLimits?.maxEvents;
  if (maxEvents != null) out['config.traceLimits.maxEvents'] = maxEvents;
  // 重试：记生效的 maxAttempts（0 = 关闭）—— 比记 "custom/default" 更有信息量
  const retryCfg = resolveRetry(options.retry);
  out['config.retry.maxAttempts'] = retryCfg ? retryCfg.maxAttempts : 0;
  const policy: ContextPolicy | undefined = options.contextPolicy;
  if (policy) {
    out['config.contextPolicy'] = true;
    if (policy.budgetTokens != null) out['config.contextPolicy.budgetTokens'] = policy.budgetTokens;
  } else {
    out['config.contextPolicy'] = false;
  }
  // 价格覆盖：只记覆盖了哪几个模型（不记单价 —— 单价在价格表里，重复记会漂移）
  const overridden = options.priceOverrides ? Object.keys(options.priceOverrides) : [];
  if (overridden.length > 0) out['config.priceOverrides'] = overridden.sort().join(',');
  if (options.resultSchema) out['config.resultSchema'] = true;
  return out;
}
