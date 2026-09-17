/*
 * 架构守卫 —— 「承重的 tsconfig 开关不得被悄悄关掉」的可执行版本。
 *
 * 为什么需要它：`exactOptionalPropertyTypes` 不是一个风格选项，它**根除了一整类缺陷**
 * （2026-09-18 第七轮迁移，39 处，见 docs/spec.md §10）。关掉它，防线不是「变弱」而是
 * **无声消失** —— 代码照常编译，`{foo: maybeUndefined}` 又能悄悄赋给 `foo?: T`，
 * 而 `retry.ts` 的「显式 undefined 覆盖缺省」正是这么发生的。
 *
 * 这个开关的承重性已经**反向验证**过：关掉它 ⇒ 本文件红，同时 `tsc` 会重新放过
 * `{foo: x | undefined}` → `foo?: T`。所以本文件是它的门禁。
 *
 * 同样钉住另外两个「看着像顺手改，实际会拆掉一层保证」的开关：
 * - `strict`：整条严格性谱系的根；
 * - `types: ["node"]`：全仓 @types/node 的显式来源（此前靠 import SDK 类型的传递链偶然
 *   进编译程序，SDK 退出运行时依赖后只能靠它，见 AGENTS.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 读一个 tsconfig（容忍 // 注释 —— 本仓库的 tsconfig 不带注释，但 examples 的可能带） */
function compilerOptions(relPath: string): Record<string, unknown> {
  const raw = readFileSync(join(repoRoot, relPath), 'utf8');
  return (JSON.parse(raw) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {};
}

test('exactOptionalPropertyTypes 必须开启（关掉 = 一整类静默失效的防线无声消失）', () => {
  const opts = compilerOptions('tsconfig.json');
  assert.equal(
    opts.exactOptionalPropertyTypes,
    true,
    'tsconfig.json 的 exactOptionalPropertyTypes 被关了。它不是风格选项：' +
      '关掉后 `{foo: maybeUndefined}` 又能赋给 `foo?: T`，' +
      '「显式 undefined 覆盖缺省」这类缺陷（详见 docs/spec.md §10 2026-09-18 第七轮）会重新变成合法代码。' +
      '要关请先在 spec §10 记决策，并删掉 docs/guards.md §1 的对应条目。',
  );
});

test('strict 与 types:["node"] 必须保留（各自承重，理由见文件头）', () => {
  const opts = compilerOptions('tsconfig.json');
  assert.equal(opts.strict, true, 'strict 是整条严格性谱系的根，不得关');
  assert.deepEqual(
    opts.types,
    ['node'],
    '@types/node 的显式来源 —— 删掉后全仓会缺 Node 类型（SDK 退出运行时依赖后已无传递链）',
  );
});
