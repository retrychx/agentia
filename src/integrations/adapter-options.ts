/**
 * Agentia —— 两条模型适配器**共用的选项判定**。
 *
 * 为什么要有这个文件：`anthropic.ts` 与 `openai.ts` 是**同一契约（`ModelClient`）的两条实现**，
 * 规则写两份就会漂（历史上「同一个 429，两侧尝试次数不同」正是这么来的，见
 * `tests/integrations/adapter-parity.test.ts`）。所以判定只写一次，两条适配器都调它。
 */

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
      `${owner}：maxRetries 必须是非负安全整数（0 = 不重试），收到 ${String(raw)} —— ` +
        'NaN / Infinity / 负数 / 小数都会让「重试几次」变成猜的（`attempt >= maxRetries` ' +
        '对 NaN 恒假、对 Infinity 永不成立 ⇒ 无限重试）',
    );
  }
  return raw;
}
