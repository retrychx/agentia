/*
 * 「可选能力进接口」—— MemoryStore 版的类型级守卫（外部深评 K5 的 CAS 那一半）。
 *
 * 只做类型检查（文件名不是 `*.test.ts`，`node:test` 不收）：由 **`npm run typecheck:types`**
 * 校验（`tsconfig.types.json` 的 `include: ["tests/types"]`）。
 *
 * 守的是什么：`loadWithRev` / `saveIfRev` 必须在**接口上**（且**可选**）——
 *   - 在接口上：宿主拿到的是 `MemoryStore`（DI 注入 / 工厂返回），没有这两个成员就只能 `as` 强转，
 *     而强转在换 store 时不报错、运行期才炸（与 `TaskStore.compact?()` 同因，见 store-surface.types.ts）；
 *   - 可选：只有 `load` / `save` 的 store（含所有既有测试桩与第三方实现）仍然满足接口 ——
 *     把它们变成必填 = 破坏性变更，且与「不支持版本号也能用」的语义矛盾（见 run.ts 的
 *     `assertMemoryStoreShape`：**半个** CAS 才是错误，**没有** CAS 是合法形态）。
 */

import type { MemorySnapshot, MemoryStore, MemoryWriteResult } from '../../src/index.js';

declare const store: MemoryStore;

/* ============ 正向：接口类型上就能多态调用（`?.` 是「可能没有」的显式表达，不用强转） ============ */

void store.loadWithRev?.(['k']);
void store.saveIfRev?.({ k: 1 }, 1);

/** 只实现基本面的 store 仍然满足 `MemoryStore` —— 可选能力不许是必填 */
const minimal: MemoryStore = {
  load: () => ({}),
  save: () => {},
};

/** 两个 CAS 成员成对实现也满足（返回形状按 `MemorySnapshot` / `MemoryWriteResult`） */
const withCas: MemoryStore = {
  load: () => ({}),
  save: () => {},
  loadWithRev: (keys) => ({ values: {}, rev: keys.length }) satisfies MemorySnapshot,
  saveIfRev: () => ({ committed: false, reason: 'conflict' }) satisfies MemoryWriteResult,
};

/* ============ @ts-expect-error：不该过的 ============ */

// @ts-expect-error 可选成员不能当「必定存在」直接调 —— 这正是原来只能 `as` 强转的那一步
store.loadWithRev(['k']);

// @ts-expect-error `committed` 是必填：只回一个原因不算「回写结果」（`!== true` 一律按未提交处理）
const missingCommitted: MemoryWriteResult = { reason: 'conflict' };

void minimal;
void withCas;
void missingCommitted;
