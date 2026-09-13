#!/usr/bin/env node
/**
 * 发版一致性自检 —— 把「四个版本同步点」在**发布前**钉死。
 *
 * 为什么挂在 `prepublishOnly` 而不是 `verify-all`：未发布窗口内 `AGENTIA_VERSION` 是
 * **有意落后**于 package.json 的（包版本先行，发布时同步 —— 见官网 API 页对该常量的说明）。
 * 所以这项检查只在**真发**时生效：忘了 bump 就发不出去，而不会在平时把全链弄红。
 *
 * 四个同步点（任一不同步都会让使用者拿到错东西）：
 *   1. 根 `package.json` 的 version        —— 发布版本的唯一真源
 *   2. `packages/cli/package.json` 的 version —— 两包版本须同步（AGENTS.md 硬约定）
 *   3. `src/index.ts` 的 AGENTIA_VERSION   —— 使用者能读到的「框架版本」（漏 bump 就谎报旧版）
 *   4. `packages/cli/src/templates.ts` 的框架依赖 pin —— 漏 bump 则新项目装到旧框架
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从脚本位置推仓库根 —— 不要硬编码绝对路径（CI / 他人机器上必挂）
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const version = readJson('package.json').version;
const problems = [];

const cliVersion = readJson('packages/cli/package.json').version;
if (cliVersion !== version) {
  problems.push(`packages/cli/package.json 是 ${cliVersion}，根包是 ${version} —— 两包版本必须同步`);
}

const av = read('src/index.ts').match(/export const AGENTIA_VERSION = '([^']+)'/);
if (!av) {
  problems.push('src/index.ts 里找不到 AGENTIA_VERSION');
} else if (av[1] !== version) {
  problems.push(`src/index.ts 的 AGENTIA_VERSION 是 '${av[1]}'，根包是 ${version} —— 发布前须同步（否则对外谎报版本）`);
}

const pin = read('packages/cli/src/templates.ts').match(/'@migor\/agentia': '\^([^']+)'/);
if (!pin) {
  problems.push('packages/cli/src/templates.ts 里找不到框架依赖 pin');
} else if (pin[1] !== version) {
  problems.push(`脚手架模板 pin 的是 ^${pin[1]}，根包是 ${version} —— 新项目会装到旧框架`);
}

if (problems.length) {
  console.error(`发版自检未通过（根包版本 ${version}）：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n提示：未发布窗口内 AGENTIA_VERSION 落后是正常的 —— 这一项只在**发布时**要求一致。');
  process.exit(1);
}

console.log(`发版自检通过：${version}（根包 / CLI 包 / AGENTIA_VERSION / 脚手架 pin 四处一致）`);
