import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskRecord, TaskStore } from './store.js';

/**
 * Agentia —— 文件宿主 TaskStore（spec §6.6：异步耐久 = 换宿主不换语义）。
 *
 * InMemoryTaskStore 在进程重启即丢；FileTaskStore 用 JSONL 把任务记录落到磁盘，
 * AsyncRunner/Scheduler/触发层**零改动** —— 证明耐久只是换个 store 实现。
 *
 * 语义：
 * - 一行一条记录快照；save 覆写内存 Map 并 append（boot 重读时 last-wins，无顺序依赖）；
 * - 构造即 load：文件不存在则从空开始，写入自动建目录；
 * - 宿主重启后：new FileTaskStore(path) 读回记录 → AsyncRunner.resumePending() 续跑
 *   queued/running（running 视为中断）。幂等键去重照常生效（失败可重提）。
 *
 * 前提：**单宿主写者**。append 用同步写保证进程内串行；多进程写同一文件会交错，
 * 跨进程协调（锁/队列）属于部署层职责，不在本实现内。
 */
export class FileTaskStore implements TaskStore {
  private readonly byTask = new Map<string, TaskRecord>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey → taskId

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return; // 读失败按空宿主启动（宿主可另行告警）
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as TaskRecord;
        if (!rec || typeof rec.taskId !== 'string') continue;
        this.byTask.set(rec.taskId, rec);
        if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
      } catch {
        // 单条损坏跳过，不整库崩
      }
    }
  }

  private append(rec: TaskRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(rec)}\n`, { flag: 'a' });
  }

  save(rec: TaskRecord): void {
    this.byTask.set(rec.taskId, rec);
    if (rec.idempotencyKey) this.byKey.set(rec.idempotencyKey, rec.taskId);
    this.append(rec);
  }

  get(taskId: string): TaskRecord | undefined {
    return this.byTask.get(taskId);
  }

  byIdempotency(key: string): TaskRecord | undefined {
    const taskId = this.byKey.get(key);
    return taskId ? this.byTask.get(taskId) : undefined;
  }

  list(): TaskRecord[] {
    return [...this.byTask.values()];
  }

  clear(): void {
    this.byTask.clear();
    this.byKey.clear();
    if (existsSync(this.file)) rmSync(this.file);
  }
}
