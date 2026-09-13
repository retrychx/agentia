/*
 * 架构守卫 —— AGENTS.md「硬约定 · 分层单向」的**可执行版本**。
 *
 * 为什么需要它：分层约定此前只写在 AGENTS.md 里、没有测试兜底，于是
 * `store → runtime`（未声明的兄弟层依赖）能悄悄存在很久。这里把约定变成断言：
 *
 *   ① 层的依赖边必须落在允许集合内（越权/反向立刻失败）；
 *   ② 依赖图必须无环；
 *   ③ src 不得 import 到 src 之外（tests / packages / examples / scripts）。
 *
 * 新增分层、或有意改变依赖方向时，必须同步改本文件的 ALLOWED 与 AGENTS.md ——
 * 两边不一致会在这里失败（这是设计意图，不是障碍）。
 *
 * 只统计**相对导入**（'./x'、'../y'）。包名（@anthropic-ai/sdk 等）是外部依赖，
 * 不参与分层；类型导入（import type）同样计入 —— 它虽在运行期擦除，但仍是编译期
 * 依赖边，而分层约定管的是编译期依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 tests/architecture/ —— 回退两层才是仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(repoRoot, 'src');

/**
 * 每层**允许**依赖的下游层（不含自身）。
 * 与 AGENTS.md「分层单向」一字对应：core ← engine ← { runtime, store }，
 * store ← transport，runtime ← toolkit；integrations 只依赖 core；
 * container 与 core 是叶子。
 */
const ALLOWED: Record<string, readonly string[]> = {
  core: [],
  engine: ['core'],
  runtime: ['core', 'engine'],
  store: ['core', 'engine'],
  transport: ['core', 'engine', 'store'],
  integrations: ['core'],
  container: [],
  toolkit: ['container', 'core', 'engine', 'runtime'],
  eval: ['core', 'engine', 'toolkit'],
};

const ALL_LAYERS = Object.keys(ALLOWED);
/** src 根下的 index.ts 是公共唯一出口，允许引用任意层 */
const BARREL = 'index';

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** 文件所属层：src/<layer>/x.ts → <layer>；src/index.ts → 'index' */
function layerOf(abs: string): string {
  const rel = relative(SRC, abs);
  return rel.includes(sep) ? rel.split(sep)[0] : BARREL;
}

/** 相对导入的来源串（'./x.js' / '../y.js'），外部包名不计 */
function relativeImports(text: string): string[] {
  return [...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
}

/** 把相对来源解析成 src 内实际文件（补 .js→.ts、index.ts），解析不到返回 null */
function resolveTarget(fromAbs: string, spec: string): string | null {
  let t = resolve(dirname(fromAbs), spec);
  if (t.endsWith('.js')) t = `${t.slice(0, -3)}.ts`;
  for (const c of [t, `${t}.ts`, join(t, 'index.ts')]) if (existsSync(c)) return c;
  return null;
}

const files = walkTs(SRC);

/** layer → 依赖的层集合 */
const layerEdges: Record<string, Set<string>> = {};
/** 「越界」明细，用于失败信息 */
const outside: string[] = [];

for (const p of files) {
  const from = layerOf(p);
  (layerEdges[from] ??= new Set());
  for (const spec of relativeImports(readFileSync(p, 'utf8'))) {
    const tgt = resolveTarget(p, spec);
    if (tgt === null) {
      // 相对导入却解析不到 src 内文件 → 说明指向了 src 之外
      outside.push(`${relative(repoRoot, p)}  →  ${spec}`);
      continue;
    }
    const to = layerOf(tgt);
    if (to !== from) layerEdges[from].add(to);
  }
}

test('出现的每一层都在 AGENTS.md 约定内（新增层必须同步登记）', () => {
  for (const p of files) {
    const l = layerOf(p);
    assert.ok(
      l === BARREL || l in ALLOWED,
      `src/${l}/ 是未知层 —— 请在 tests/architecture/layering.test.ts 的 ALLOWED 与 AGENTS.md 里登记它`,
    );
  }
});

test('层间依赖不得越权：每条边都落在允许集合内', () => {
  const violations: string[] = [];
  for (const [from, tos] of Object.entries(layerEdges)) {
    if (from === BARREL) continue; // 出口层允许引用全部
    const allowed = new Set(ALLOWED[from] ?? []);
    for (const to of tos) {
      if (!allowed.has(to)) violations.push(`${from} → ${to}（${from} 只允许 → {${[...allowed].join(', ')} }）`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `发现未声明的分层依赖（要么改代码，要么同步更新 AGENTS.md 与本测试的 ALLOWED）：\n${violations.join('\n')}`,
  );
});

test('依赖图无环', () => {
  const state = new Map<string, 'gray' | 'black'>();
  const cycles: string[] = [];
  const dfs = (u: string, path: string[]): void => {
    state.set(u, 'gray');
    for (const v of layerEdges[u] ?? []) {
      if (state.get(v) === 'gray') cycles.push([...path, u, v].join(' → '));
      else if (!state.has(v)) dfs(v, [...path, u]);
    }
    state.set(u, 'black');
  };
  for (const n of Object.keys(layerEdges)) if (!state.has(n)) dfs(n, []);
  assert.deepEqual(cycles, [], `分层必须是有向无环图，发现环：\n${cycles.join('\n')}`);
});

test('src 不得 import 到 src 之外（tests / packages / examples / scripts）', () => {
  assert.deepEqual(
    outside,
    [],
    `src 里的相对导入跑到了 src 之外（分层与打包都会破）：\n${outside.join('\n')}`,
  );
});

test('约定表非空且与 src 实际分层一致（防 ALLOWED 写到一半）', () => {
  assert.ok(ALL_LAYERS.length >= 9, 'ALLOWED 少于 9 层 —— 大概率漏登记');
  for (const l of ALL_LAYERS) assert.ok(existsSync(join(SRC, l)), `ALLOWED 里的层 src/${l}/ 不存在`);
});
