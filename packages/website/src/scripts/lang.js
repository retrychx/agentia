/* 官网客户端脚本的**运行时语言**（2026-10-08 官网英文版）。
 *
 * 为什么需要它：`scenarios.js`（演示剧本）、`playground.js`（回放面板）、`playground-real.js`
 * （BYOK 真实模式）里的文案**不在 Astro 的模板里** —— 它们是运行期由 JS 插进 DOM 的字符串，
 * 构建期无从替换。中文版与英文版**共用同一份脚本**，所以语言只能在运行期判定。
 *
 * 判据取 `<html lang>`（`en` / `zh-CN`，由 Base.astro 按页面语言写死）——
 * 它是**服务端已经决定好的**事实，不像 `navigator.language` 那样取决于访客环境：
 * 页面是中文版就该出中文（哪怕访客系统是英文，那也是他自己选的 / 自动跳转后的结果）。
 *
 * ⚠️ 别在这里读 `hl` cookie —— 那是**服务端** `public/_worker.js` 的输入（它据此决定要不要
 * 把中文路径 302 到 `/en`），而它已经决定过「这一页该是哪种语言」并把结果落在 `<html lang>` 上了。
 * 两处各判一次，就会出现「端点渲了英文页、脚本文案却按 cookie 出中文」的错配。
 */

/** 当前页面是不是英文版（构建期写死的 `<html lang>`）。 */
export const PG_EN = /^en/i.test(
  typeof document !== 'undefined' ? document.documentElement.getAttribute('lang') || '' : '',
);

/**
 * 双语取一：中文在前（默认），英文在后。
 * 用法：`pt('等待 run 开始…', 'waiting for the run to start…')`
 */
export const pt = (zh, en) => (PG_EN ? en : zh);
