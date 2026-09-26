import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `packages/trace-view` README 的导出表必须覆盖该包的公共导出面。
 *
 * 为什么值得单独钉：这个包从不发布（`private: true`），README 就是「这份共用渲染器对外是什么」
 * 的唯一说明；而它的两个宿主（官网 playground 与 CLI inspector）都直接吃导出面。
 * `rawArg` 正是漏在这儿的：代码导出了它、README 里一个字没有 —— 与官网 API 页
 * （`api-page.test.ts` 的反向全覆盖）同一个病：改了 API 忘了改文档。
 *
 * ⚠️ **2026-09-26：这条断言原来是 `readme.includes(name)`，即子串匹配 —— 实测两处漏网**：
 *   ① 把表里的 `rawArg` 改名成 `rawArgument`（旧名是新名的**前缀**）⇒ **照样绿**；
 *   ② 往表里塞一个**根本不存在的** `ghostExport` ⇒ 没有判据（只查了「缺」，没查「多」）。
 *   ⇒ 已换成与 `api-page.test.ts` 同款的**集合相等**：抠出导出表第一列的标识符，
 *   与 `src/index.js` 的导出面**互为真值**。两个方向都钉，且不再是子串游戏。
 *   ⚠️ 射程：只认**导出表**（表头首列为「导出」）的第一列 —— 正文里提到某个导出名**不算**说明；
 *   这是有意的（否则「正文里恰好出现过一次」就能满足守卫）。
 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TV = join(repoRoot, 'packages', 'trace-view');
const README = join(TV, 'README.md');

/** 从 `src/index.js` 抠导出名（覆盖 `export { a, b } from './x.js'` 与 `export { a as b }`） */
function exportedNames(): string[] {
  const text = readFileSync(join(TV, 'src', 'index.js'), 'utf8');
  const out = new Set<string>();
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out].sort();
}

/**
 * 从 README 的**导出表**第一列抠出标识符：`` `name(args)` `` 取 `name`，
 * `` `a(x)` / `B` `` 取两个。只认这一张表 —— 正文里的提及不算「说明」。
 */
function tableExports(readme: string): string[] {
  const lines = readme.split('\n');
  const head = lines.findIndex((l) => /^\|\s*导出\s*\|/.test(l));
  assert.notEqual(head, -1, 'README 里找不到导出表（表头首列应为「导出」）—— 解析锚点没了');
  const out: string[] = [];
  for (const line of lines.slice(head + 2)) {
    // +2：跳过表头与 `|---|---|` 分隔行
    if (!line.startsWith('|')) break;
    const cell = line.split('|')[1] ?? '';
    for (const m of cell.matchAll(/`([A-Za-z_$][\w$]*)/g)) out.push(m[1]);
  }
  return out;
}

describe('trace-view README 的导出表', () => {
  const readme = readFileSync(README, 'utf8');
  const names = exportedNames();

  it('解析到了导出（防「扫了个空文件」的假绿）', () => {
    assert.ok(
      names.length >= 8,
      `从 src/index.js 只解析到 ${names.length} 个导出：${names.join(', ')}`,
    );
  });

  it('导出表与源码导出面**互为真值**（集合相等，不是子串包含）', () => {
    const onPage = new Set(tableExports(readme));
    assert.ok(
      onPage.size >= 8,
      `导出表只抠出 ${onPage.size} 个名字 —— 解析锚点坏了（表头改了？表换成别的写法了？）`,
    );
    const missing = names.filter((n) => !onPage.has(n));
    const invented = [...onPage].filter((n) => !names.includes(n));
    assert.deepEqual(missing, [], `README 的导出表缺这些导出：${missing.join(', ')}`);
    assert.deepEqual(
      invented,
      [],
      `README 的导出表写了不是导出的名字：${invented.join(', ')}` +
        '（源码删了导出却忘了改文档，或名字写错了 —— 只查「缺」的那一版查不到这种）',
    );
  });

  it('样式入口与 package.json 的 exports 子路径一致', () => {
    const pkg = JSON.parse(readFileSync(join(TV, 'package.json'), 'utf8')) as {
      private?: boolean;
      exports: Record<string, string>;
    };
    assert.equal(pkg.private, true, 'trace-view 应为 private（有意不单独发布）');
    assert.ok(pkg.exports['./style.css'], 'package.json 应有 ./style.css 子路径导出');
    assert.ok(readme.includes('@migor/trace-view/style.css'), 'README 应写明样式引入路径');
  });
});
