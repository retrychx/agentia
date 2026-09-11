import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
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
    this.healTail(raw);
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

  /**
   * 尾部残行自愈：文件不以 `\n` 结尾说明最后一次 append 写残了（进程被杀、磁盘满、断电）。
   * 不处理的话后续 append 会把新记录**粘在残行尾部**——两行并一行，重启后两条一起丢。
   * - 残行本身是完整记录（只是丢了换行）→ 补一个换行，记录不丢；
   * - 残行是半截 JSON → 截到最后一个换行处，之后 append 从干净的边界开始。
   */
  private healTail(raw: string): void {
    if (!raw || raw.endsWith('\n')) return;
    const cut = raw.lastIndexOf('\n') + 1; // 最后一个完整行的末尾（字符下标）
    const tail = raw.slice(cut);
    let complete = false;
    try {
      const rec = JSON.parse(tail) as TaskRecord | null;
      complete = !!rec && typeof rec.taskId === 'string';
    } catch {
      complete = false;
    }
    try {
      if (complete) appendFileSync(this.file, '\n'); // 记录是完整的，只差换行
      else truncateSync(this.file, Buffer.byteLength(raw.slice(0, cut), 'utf8'));
    } catch {
      // 修不了就照旧读：能解析的行照常入内存，损坏行由下面的 parse 守卫跳过
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

  /**
   * 压实日志：把「一 task 一行」的最新快照整体重写回文件，丢弃同一 task 的历史覆写行。
   *
   * append-only 的 JSONL 每 save 一次就追加一行，**容量随 save 次数线性增长**（构造期
   * load 也全量读回）——长期运行的宿主迟早要压。本方法是 TaskStore 接口之外的能力，
   * 由宿主按需周期性调用（如低频 cron）；压实时文件短暂不含历史行，但内存态不受影响。
   */
  compact(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = [...this.byTask.values()].map((r) => `${JSON.stringify(r)}\n`).join('');
    writeFileSync(this.file, body);
  }
}
