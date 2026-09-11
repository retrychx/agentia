/**
 * MemoryStore —— 跨 run 记忆（R4）。
 *
 * blackboard（RunContext）随单次 run 释放；MemoryStore 在 run 边界做
 * 水合/回写：run 开始时把 load(keys) 注入 blackboard，run 结束时把
 * 这些 key 的当前值 save 回 store —— 同一份 store 跨多次 executeRun
 * 复用即得跨 run 记忆。接线见 run/run.ts 的 ExecuteRunOptions.memory。
 */
export interface MemoryStore {
  load(keys: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  save(entries: Record<string, unknown>): void | Promise<void>;
}

/** Map 实现：测试与缺省场景用（进程内，无持久化） */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly data = new Map<string, unknown>();

  load(keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = this.data.get(key);
    }
    return out;
  }

  save(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) {
      this.data.set(key, value);
    }
  }
}
