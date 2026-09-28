/**
 * Agentia —— 两条模型适配器**共用的选项判定**。
 *
 * 为什么要有这个文件：`anthropic.ts` 与 `openai.ts` 是**同一契约（`ModelClient`）的两条实现**，
 * 规则写两份就会漂（历史上「同一个 429，两侧尝试次数不同」正是这么来的，见
 * `tests/integrations/adapter-parity.test.ts`）。所以判定只写一次，两条适配器都调它。
 */
import { zeroClauseOf } from '../core/limits.js';

/**
 * 流内 error 分片的 type/code → HTTP status。
 *
 * **为什么必须共用一份**（2026-09-28 外部深评 S3）：`anthropic.ts` 与 `openai.ts` 是同一
 * 契约（`ModelClient`）的两条实现，同一判定原本**各写一份**，一致性只靠两边注释里
 * 「与那边同口径」互相喊话 —— 而注释不会在被改的那一刻失败（本仓已有前科：同一个 429
 * 两侧尝试次数不同，见 `tests/integrations/adapter-parity.test.ts` 的文件头）。
 * 现在判定只写一处，两条适配器都调它：改口径只能改这里，漂不了。
 *
 * 目的：兼容端点（DeepSeek 等）常把限流 / 内部故障塞进 **HTTP 200** 的流里，不给非 2xx。
 * 不反推成 status，引擎就无法识别这是可重试的限流，重试层照样不生效。
 *
 * 为什么不细分 401/403/404：`engine/errors.ts` 的鸭子分类只看「4xx = 改配置才有救、
 * 别白重试」，401 与 403 在引擎侧是同一处置；细分只会多三个没人读的分支。
 *
 * 值域：**只回 429 / 529 / 400 / 500 四个**（均为「引擎侧已有处置」的档位）——
 * 别在这里返回 4xx 里没人处理的状态码。
 */
export function statusOfStreamError(err: {
  // 显式带 `| undefined`：调用点直接传 `{ type: someMaybeUndefined }`（exactOptionalPropertyTypes
  // 下 `type?: string | null` 不接受显式 undefined，那样每个调用点都得写条件展开 —— 噪音）
  type?: string | null | undefined;
  code?: string | null | undefined;
}): number {
  const key = `${err.type ?? ''} ${err.code ?? ''}`.toLowerCase();
  // 限流档：可重试短路
  if (
    key.includes('rate_limit') ||
    key.includes('insufficient_quota') ||
    key.includes('too_many')
  ) {
    return 429;
  }
  // 过载档（Anthropic 的 overloaded_error = 529，语义就是「稍后重试」）；
  // OpenAI 侧的兼容端点也用同一个词，两侧同判 —— 它同样是 5xx 可重试，但保留 529 让
  // trace / 指标能把它与「真故障」分开数
  if (key.includes('overloaded')) return 529;
  // 4xx 档：这些是**改配置才有救**的病因（上下文超限 / 模型名错 / 鉴权 / 内容策略），
  // 一律 500 + retryable 会让引擎白重试 3 次（3 次网络请求 + 3 倍等待），
  // 且 trace 记成 `server` 而非 `api` —— 排障方向被带偏。
  //
  // 用 `includes` 而不是枚举：OpenAI 兼容生态的类型/错误码多得多（下面全部来自真实
  // 兼容端点的读数），枚举会把没列到的私下归 500。两侧原本各自枚举得**不完全一致**
  // （anthropic 列 `not_found_error`、openai 列 `model_not_found`/`does_not_exist`），
  // 合并时取**并集**：这是本函数存在的意义 —— 同一病因在两条适配器上必须同一档。
  if (
    key.includes('invalid_request') ||
    key.includes('context_length') ||
    key.includes('model_not_found') ||
    key.includes('does_not_exist') ||
    key.includes('not_found') ||
    key.includes('content_filter') ||
    key.includes('authentication') ||
    key.includes('permission')
  ) {
    return 400;
  }
  return 500;
}

/** 适配器缺省内层重试次数（与 Anthropic SDK 的缺省对齐：2） */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * 解析 `maxRetries` —— **构造期**校验，不接受「看起来像数字」的坏值。
 *
 * 为什么必须响亮失败（2026-09-21 外部复核实测）：网络失败路径上的判定是
 * `attempt >= maxRetries`，于是
 * - `NaN` ⇒ 比较恒 false ⇒ **无限重试**（每次都判「还没到上限」）；
 * - `Infinity` ⇒ 永远达不到 ⇒ **无限重试**；
 * - `-1` ⇒ `0 >= -1` 为真 ⇒ 静默变成「不重试」；
 * - `1.5` ⇒ 实际只允许 1 次，但读数上看不出来。
 * 四种值都不会报错，使用者以为自己设了上限。这与本仓 `0` 的双重语义（`0` = 不重试，
 * 是**有意义的值**，必须放行）刻意区分：坏的是「非整数 / 负数 / 非有限」，不是 0。
 */
export function resolveMaxRetries(raw: unknown, owner: string): number {
  if (raw === undefined) return DEFAULT_MAX_RETRIES;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TypeError(
      `${owner}：maxRetries 必须是非负安全整数（${zeroClauseOf('maxRetries')}），收到 ${String(raw)} —— ` +
        'NaN / Infinity / 负数 / 小数都会让「重试几次」变成猜的（`attempt >= maxRetries` ' +
        '对 NaN 恒假、对 Infinity 永不成立 ⇒ 无限重试）',
    );
  }
  return raw;
}
