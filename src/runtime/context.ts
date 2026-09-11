import { AsyncLocalStorage } from 'node:async_hooks';
import type { Run } from './run.js';

/**
 * Agentia —— run 作用域上下文（spec §2/§9：blackboard + 上下文传播载体）。
 *
 * 传播机制：executeRun 在建 Run 后、跑 engine 前，把本次
 * RunContext 放进 AsyncLocalStorage；runAgent 内任何异步调用（含工具执行、
 * 后续 subagent/skill 执行体）同处该 async 上下文，因此工具方法体内可直接
 * `RunContext.current()` 拿到当前 run —— 无需把 ctx 作为参数层层下传。
 *
 * blackboard：单次 run 内累积的项目事实/产物，随 run 释放（spec §2）。
 */
const store = new AsyncLocalStorage<RunContext>();

/**
 * 类型化黑板（**可选**，靠 TS 声明合并扩展）。
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

/** 在指定 ctx 下执行（executeRun 内部使用）；当前上下文对外以 current() 读取。
 *  返回类型随 fn 而定：async fn → Promise<T>，同步 fn → T（不再是恒 Promise 的假类型）。 */
export function withRunContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T>;
export function withRunContext<T>(ctx: RunContext, fn: () => T): T;
export function withRunContext<T>(ctx: RunContext, fn: () => T | Promise<T>): T | Promise<T> {
  return store.run(ctx, fn);
}

export class RunContext {
  private readonly blackboard = new Map<string, unknown>();

  constructor(readonly run: Run) {}

  /** 当前 run 的上下文。不在 run 内调用时返回 undefined。 */
  static current(): RunContext | undefined {
    return store.getStore();
  }

  get runId(): string {
    return this.run.runId;
  }

  /**
   * 读黑板。键经 `Blackboard` 声明后：字面量键 → 对应值类型；未知键 → 编译期报错。
   * 未声明 `Blackboard` 时键为 `string`、值为 `unknown`（旧行为）。
   */
  get<K extends BlackboardKey>(key: K): BlackboardValue<K> | undefined {
    return this.blackboard.get(key) as BlackboardValue<K> | undefined;
  }
  /** 写黑板。值类型与 `Blackboard` 声明的键对齐（未声明时不校验）。 */
  set<K extends BlackboardKey>(key: K, value: BlackboardValue<K>): this {
    this.blackboard.set(key, value);
    return this;
  }
  has(key: BlackboardKey): boolean {
    return this.blackboard.has(key);
  }
  delete(key: BlackboardKey): boolean {
    return this.blackboard.delete(key);
  }
  /** 当前黑板上的全部键（扩展过 `Blackboard` 时为键联合数组，字面量有补全） */
  keys(): BlackboardKey[] {
    return [...this.blackboard.keys()] as BlackboardKey[];
  }
}

