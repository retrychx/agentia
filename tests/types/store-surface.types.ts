/*
 * 「可选能力进接口」—— 类型级守卫（外部深评 S5）。
 *
 * 只做类型检查（文件名不是 `*.test.ts`，`node:test` 不收）：由 **`npm run typecheck:types`**
 * 校验（`tsconfig.types.json` 的 `include: ["tests/types"]`）。
 *
 * 守的是什么：`TaskStore` 的 `compact?()` / `close?()` 必须在**接口上**（且**可选**），
 * 而不是只活在 `FileTaskStore` / `SqliteTaskStore` 这些具体类里 —— 宿主拿到的通常是接口类型
 * （DI 注入 / 工厂返回 / 配置驱动选 store 都是这形态）。没有这两个成员就只能 `as` 强转，
 * 而强转在换 store 时**不报错**（sqlite 没有 compact、file 没有 close），要到运行期才炸。
 *
 * ⚠️ 下面那条 `@ts-expect-error` 是**正控**，不是装饰：它证明「这两个能力是**可选**的」
 * 这件事真的在岗。谁把它们改成必填，所有只实现基本面的 store（含测试桩）当场编译不过，
 * 而这条指令会变成**未使用** ⇒ `TS2578` ⇒ 类型检查红。
 */
import type { TaskStore } from '../../src/index.js';

declare const store: TaskStore;

/* ============ 正向：接口类型上就能多态调用（`?.` 是「可能没有」的显式表达，不用强转） ============ */

store.compact?.();
store.close?.();

/** 只实现基本面的 store 仍然满足 `TaskStore` —— 可选能力不许是必填 */
const minimal: TaskStore = {
  save: async () => {},
  get: async () => undefined,
  byIdempotency: async () => undefined,
  list: async () => [],
  clear: async () => {},
};

/* ============ @ts-expect-error：不该过的 ============ */

// @ts-expect-error 可选成员不能当「必定存在」直接调 —— 这正是原来只能 `as` 强转的那一步
store.compact();

void minimal;
