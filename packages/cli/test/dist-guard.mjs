/**
 * 构建产物守卫（CLI 去类型移植副本 vs 框架真源的对拍、以及命令级用例共用）。
 *
 * 产物缺失时对拍/命令级用例没法跑 —— 但**不许静默 skip**（静默跳过 = 假装验过）：
 * - 本地裸跑 `node --test`（dist 可能还没 build）：打醒目警告，调用方照旧 skip；
 * - CI 里（verify-all 链 build / build:cli 先于 npm test，产物恒在）：直接判失败 ——
 *   那里缺产物是真事故，不该用 skip 混过去。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

/**
 * 产物在 → true；不在 → CI 判失败（抛 AssertionError）/ 本地醒目警告并返回 false
 * （调用方据返回值 skip 整个 describe 或 return 跳过单条对拍）。
 */
export function distReadyOrLoud(path, what) {
  if (existsSync(path)) return true;
  const msg =
    `对拍/产物守护未真正执行：${what}缺失（${path}）—— 先跑 npm run build && npm run build:cli。` +
    'verify-all / CI 里 build 先于测试，产物恒在，那里不该走到这条分支';
  if (process.env.CI) assert.fail(`⚠️ ${msg}`);
  console.error(`\n⚠️⚠️ ${msg} ⚠️⚠️\n`);
  return false;
}
