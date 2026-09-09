import type { Run } from './run.js';

/**
 * RunContext —— run scope（spec §9.2 上下文传播的载体）。
 * blackboard：单次 run 内累积的项目事实/产物，随 run 释放（spec §2）。
 * 当前 span 句柄与单元 span 容器将在 Turn 2（unit span + TraceInterceptor）接入。
 */
export class RunContext {
  private readonly blackboard = new Map<string, unknown>();

  constructor(readonly run: Run) {}

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
