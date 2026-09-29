/*
 * 元守卫 —— 「examples 清单本身不得腐化」的可执行版本。
 *
 * 为什么需要它（2026-09-29 实测）：`examples/README.md` 那张表是**读者找示例的唯一入口**，
 * 而它此前**没有任何守卫**，于是它安静地烂了 —— 同一份文件里三个读数互不相同：
 * 文案写「四个示例」、表里 5 行、目录里 6 个（`eval-gate` 整行缺席）；依赖说明那段的
 * 「三个应用示例」也对不上实况（六个全都用 `file:../..`）。
 * 与本仓反复踩的「文档承诺了、代码没有」是同一病根：**凡不能被机械复算的承诺都会腐烂**——
 * 而这张表恰好是可复算的（目录就躺在盘上）。
 *
 * 守三件事：
 * ① 表里登记的目录 ↔ `examples/` 下的实际目录 **双向相等**（漏登记 = 加了示例读者看不到；
 *   多登记 = 示例已删、表还指着它）；
 * ② 表里每一行的链接与显示名一致、且指向真实存在的目录；
 * ③ 条目密度下限 —— 解析器若退化成抽不到东西，① 会 vacuously 全绿（同 `guards-registry` 的取舍）。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLES_DIR = join(repoRoot, 'examples');
const README = join(EXAMPLES_DIR, 'README.md');

/** 派生目录不算示例 —— 与 `guards-registry.test.ts` 跳过 node_modules/dist 同一口径 */
const DERIVED = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** `examples/` 下的实际示例目录（顶层，排除派生目录与点开头者） */
function exampleDirs(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !DERIVED.has(d.name))
    .map((d) => d.name)
    .sort();
}

/** 表里登记的行：`| [`<name>/`](./<name>/) | … |` → { name, target } */
function tableRows(): Array<{ name: string; target: string }> {
  const md = readFileSync(README, 'utf8');
  const rows: Array<{ name: string; target: string }> = [];
  for (const m of md.matchAll(/^\|\s*\[`([^`\n]+)`\]\(\.\/([^)\n]+)\)/gm)) {
    rows.push({ name: (m[1] ?? '').replace(/\/$/, ''), target: (m[2] ?? '').replace(/\/$/, '') });
  }
  return rows;
}

test('examples/README.md 的表与 examples/ 目录双向一致', () => {
  const dirs = exampleDirs();
  const rows = tableRows();

  // ③ 先防「解析器退化成空」——否则下面两条会 vacuously 通过
  assert.ok(
    rows.length >= 5,
    `表里只解析出 ${rows.length} 行 —— 解析器或表格结构坏了，这条守卫会变成橡皮图章`,
  );
  assert.ok(dirs.length >= 5, `examples/ 下只数出 ${dirs.length} 个示例目录，与实况不符`);

  // ② 每行的显示名与链接目标要一致，且是一个真实目录
  for (const { name, target } of rows) {
    assert.equal(name, target, `表里那一行的显示名（${name}）与链接目标（${target}）不一致`);
    assert.ok(
      existsSync(join(EXAMPLES_DIR, target)) && statSync(join(EXAMPLES_DIR, target)).isDirectory(),
      `表里登记了 \`${target}/\`，但 examples/${target}/ 不是目录 —— 示例被删/改名了`,
    );
  }

  // ① 双向相等 —— 两个方向分别报，好让失败信息直接说出「该改哪边」
  const registered = [...new Set(rows.map((r) => r.name))].sort();
  const missing = dirs.filter((d) => !registered.includes(d));
  const extra = registered.filter((r) => !dirs.includes(r));
  assert.deepEqual(
    missing,
    [],
    `这些示例目录没有登记进表里：${missing.join(', ')}（加了示例就要写一行）`,
  );
  assert.deepEqual(
    extra,
    [],
    `表里这些行指向的目录已不存在：${extra.join(', ')}（删了示例就要删这一行）`,
  );
  assert.deepEqual(registered, dirs, '表里登记的集合与 examples/ 下的目录集合不一致');
});
