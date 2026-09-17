/**
 * Agentia —— 对象工具（core 叶子，零依赖）。
 */

/**
 * 去掉值为 `undefined` 的键，**只过滤 undefined**（`null` / `0` / `''` / `false` 一律保留）。
 *
 * 为什么需要它：`tsconfig` 开了 `exactOptionalPropertyTypes` 之后，`{foo: x}`（`x: T | undefined`）
 * **不再是**合法的 `foo?: T` —— 显式传 `undefined` 与「不传这个键」被区分开了（这正是那个开关
 * 要守的东西：`retry.ts` 的「显式 undefined 覆盖缺省」事故）。框架内部把「可能 undefined 的
 * 变量」拼进可选参数对象时（如 `AgentApp.run` 把 per-run 覆盖转交给 `executeRun`），
 * 用它把 undefined 键摘掉，类型上就能安全赋给 `foo?: T`。
 *
 * 返回类型里每个键的值都排除了 `undefined`，所以赋给可选属性是**类型准确**的
 * （不是 `as any` 式的谎言；运行时确实过滤了）。
 *
 * @example
 * executeRun({ messages, ...omitUndefined({ model: opts.model, client: opts.client }) })
 */
export function omitUndefined<T extends object>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
