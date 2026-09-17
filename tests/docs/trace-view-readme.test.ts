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

describe('trace-view README 的导出表', () => {
  const readme = readFileSync(README, 'utf8');
  const names = exportedNames();

  it('解析到了导出（防「扫了个空文件」的假绿）', () => {
    assert.ok(
      names.length >= 8,
      `从 src/index.js 只解析到 ${names.length} 个导出：${names.join(', ')}`,
    );
  });

  it('每个公共导出都在 README 里出现（反向全覆盖）', () => {
    const missing = names.filter((n) => !readme.includes(n));
    assert.deepEqual(missing, [], `README 缺这些导出的说明：${missing.join(', ')}`);
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
