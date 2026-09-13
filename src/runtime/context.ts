import { AsyncLocalStorage } from 'node:async_hooks';
import type { Run } from './run.js';
import type { BlackboardKey, BlackboardValue } from '../core/blackboard.js';

/**
 * Agentia —— run 作用域上下文（spec §2/§9：blackboard + 上下文传播载体）。
 *
 * 传播机制：executeRun 在建 Run 后、跑 engine 前，把本次
 * RunContext 放进 AsyncLocalStorage；runAgent 内任何异步调用（含工具执行、
 * 后续 subagent/skill 执行体）同处该 async 上下文，因此工具方法体内可直接
 * `RunContext.current()` 拿到当前 run —— 无需把 ctx 作为参数层层下传。
 *
 * blackboard：单次 run 内累积的项目事实/产物，随 run 释放（spec §2）。
 * 其**类型**（Blackboard/BlackboardKey/BlackboardSeed）定义在 `core/blackboard.js`
 * —— core 是纯数据层，store 也要读这些类型；机制（ALS 传播 + 读写方法）留在这里。
 */
const store = new AsyncLocalStorage<RunContext>();

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
