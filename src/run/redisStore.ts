import type { TaskRecord, TaskStore } from './store.js';

/**
 * Agentia —— Redis 宿主 TaskStore（spec §6.6：异步耐久 = 换宿主不换语义，roadmap R6）。
 *
 * duck-typed 客户端：框架不 import 任何 redis 包，用户传 ioredis / node-redis /
 * 任何满足 RedisLike 结构面的客户端（含测试 fake）。TaskStore 方法已放宽为
 * MaybePromise（见 store.ts），本实现全部异步。
 *
 * 存储模型（prefix 缺省 'agentia:'）：
 * - `${prefix}task:<taskId>` → 整行记录 JSON（save = SET 覆写，last-wins）；
 * - `${prefix}idem:<idempotencyKey>` → taskId（同键重提覆写，byIdempotency last-wins）。
 *
 * 语义对照 FileTaskStore / SqliteTaskStore：save 覆写、byIdempotency 取最近、
 * clear 清空本前缀全部 key。差异在 list 序：Redis 本身无序，按 createdAt
 * （同刻按 taskId）排序 —— 「写入顺序」语义的确定性近似（FileTaskStore 保插入位、
 * SqliteTaskStore 覆写后移到末尾，三者本就不逐字一致，排序给出稳定契约）。
 *
 * 前提：**单宿主写者**。save 是两次 SET（记录 + 幂等索引），未走 MULTI 事务；
 * 多写者并发下同键写可能交错，跨进程协调属部署层职责（与 FileTaskStore 一致）。
 *
 * 注意（load-bearing）：AsyncRunner 的延迟幂等去重依赖本实现「先 SET 记录、
 * await 后再 SET idem 索引」的写入顺序（见 async.ts #execute 注释）——若改为
 * 先写索引或 MULTI 事务，需同步复核该去重路径。
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  /** 单键删除（ioredis / node-redis 的公共最小面；批量清理由多次单删组成） */
  del(key: string): Promise<unknown>;
  /** 模式枚举（node-redis / ioredis 均有）；与 scanIterator 至少提供其一 */
  keys?(pattern: string): Promise<string[]>;
  /**
   * 增量枚举（node-redis v4+ 形态，生产友好不阻塞）；yield 单键或一批键均可。
   * 提供时优先于 keys 使用。
   */
  scanIterator?(opts?: { MATCH?: string; COUNT?: number }): AsyncIterable<string | string[]>;
}

export interface RedisTaskStoreOptions {
  /** key 前缀，缺省 'agentia:' */
  prefix?: string;
}

export class RedisTaskStore implements TaskStore {
  private readonly prefix: string;

  constructor(
    private readonly client: RedisLike,
    opts: RedisTaskStoreOptions = {},
  ) {
    if (!client.scanIterator && !client.keys) {
      throw new Error('RedisTaskStore 需要 client 提供 scanIterator 或 keys 之一（list/clear 依赖按键枚举）');
    }
    this.prefix = opts.prefix ?? 'agentia:';
  }

  private taskKey(taskId: string): string {
    return `${this.prefix}task:${taskId}`;
  }

  private idemKey(key: string): string {
    return `${this.prefix}idem:${key}`;
  }

  async save(rec: TaskRecord): Promise<void> {
    await this.client.set(this.taskKey(rec.taskId), JSON.stringify(rec));
    if (rec.idempotencyKey) await this.client.set(this.idemKey(rec.idempotencyKey), rec.taskId);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    return parseRecord(await this.client.get(this.taskKey(taskId)));
  }

  async byIdempotency(key: string): Promise<TaskRecord | undefined> {
    const taskId = await this.client.get(this.idemKey(key));
    return taskId ? this.get(taskId) : undefined;
  }

  async list(): Promise<TaskRecord[]> {
    const keys = await this.enumerate(`${this.prefix}task:*`);
    const recs: TaskRecord[] = [];
    for (const k of keys) {
      const rec = parseRecord(await this.client.get(k));
      if (rec) recs.push(rec);
    }
    recs.sort(
      (a, b) => a.createdAt - b.createdAt || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    );
    return recs;
  }

  async clear(): Promise<void> {
    const keys = await this.enumerate(`${this.prefix}*`);
    for (const k of keys) await this.client.del(k);
  }

  /** 按键枚举：优先 scanIterator，缺则退回 keys(pattern) */
  private async enumerate(pattern: string): Promise<string[]> {
    if (this.client.scanIterator) {
      const out: string[] = [];
      for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(batch)) out.push(...batch);
        else out.push(batch);
      }
      return out;
    }
    return this.client.keys!(pattern);
  }
}

/** 解析整行 JSON；单条损坏按缺失处理，不整库崩（与 FileTaskStore 对齐） */
function parseRecord(raw: string | null): TaskRecord | undefined {
  if (!raw) return undefined;
  try {
    const rec = JSON.parse(raw) as TaskRecord;
    return rec && typeof rec.taskId === 'string' ? rec : undefined;
  } catch {
    return undefined;
  }
}
