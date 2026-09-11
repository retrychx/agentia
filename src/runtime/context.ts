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

/** 在指定 ctx 下执行（executeRun 内部使用）；当前上下文对外以 current() 读取 */
export function withRunContext<T>(ctx: RunContext, fn: () => T | Promise<T>): Promise<T> {
  return store.run(ctx, fn) as Promise<T>;
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

  get<T>(key: string): T | undefined {
    return this.blackboard.get(key) as T | undefined;
  }
  set(key: string, value: unknown): this {
    this.blackboard.set(key, value);
    return this;
  }
  has(key: string): boolean {
    return this.blackboard.has(key);
  }
  delete(key: string): boolean {
    return this.blackboard.delete(key);
  }
  keys(): string[] {
    return [...this.blackboard.keys()];
  }
}
