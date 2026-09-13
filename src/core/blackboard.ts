/**
 * Agentia —— 类型化黑板（**可选**，靠 TS 声明合并扩展）。core 层：纯类型、零依赖。
 *
 * 不扩展时（默认空前接口）：键回落 `string`、值回落 `unknown`、种子回落
 * `Record<string, unknown>` —— 与旧版逐字一致，既有代码零改动。
 *
 * 扩展后，`RunContext.get/set/has/delete/keys` 与 `run({ blackboard })` 种子
 * 都会得到**键补全 + 拼写检查 + 值类型**：
 *
 * ```ts
 * // 在你自己项目的任意 .ts / .d.ts 里写一次（全局生效）
 * declare module '@migor/agentia' {
 *   interface Blackboard {
 *     profile: { name: string; vip: boolean };
 *     turnCount: number;
 *   }
 * }
 * // 之后：
 * ctx.get('profile')   // { name: string; vip: boolean } | undefined
 * ctx.set('turnCount', 1);   // ✓ 值类型不对会报错
 * ctx.get('profil')    // ✗ 编译期报错（键不存在）
 * ```
 *
 * 动态键（键是运行时算出来的 `string`）拿不到字面量联合，需自行断言：
 * `ctx.get(key as BlackboardKey)`。
 *
 * 说明：类型定义在 core（纯数据），而读写它的 `RunContext`（含 ALS 传播）
 * 留在 runtime —— 契约下沉、机制留层，避免 runtime 的类型被 store 反向依赖。
 */
export interface Blackboard {}

/** 黑板键：扩展过 `Blackboard` → 其键联合；未扩展 → `string`（向后兼容） */
export type BlackboardKey = [keyof Blackboard] extends [never] ? string : keyof Blackboard;

/** 键对应的值类型：未扩展 / 未知键 → `unknown` */
export type BlackboardValue<K> = K extends keyof Blackboard ? Blackboard[K] : unknown;

/** blackboard 种子：扩展过 `Blackboard` → `Partial<Blackboard>`（键有补全）；未扩展 → `Record<string, unknown>` */
export type BlackboardSeed = [keyof Blackboard] extends [never]
  ? Record<string, unknown>
  : Partial<Blackboard>;
