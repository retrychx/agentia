import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { TaskRecord, TaskStore } from './store.js';

// node:sqlite 是 Node ≥22.5 才有的内置模块。这里**延迟加载**而非顶层静态 import：
// 顶层 import 会让**整个包**在未提供该模块的运行时「加载即崩」——`src/index.ts` 对
// SqliteTaskStore 是 eager 再导出，于是连不用 SQLite 的用户也被殃及。延迟到真正构造
// store 时才要求它，并给出可操作的报错（而不是一句 ERR_UNKNOWN_BUILTIN_MODULE）。
const requireBuiltin = createRequire(import.meta.url);

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  try {
    return (requireBuiltin('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } catch {
    throw new Error('SqliteTaskStore 需要 Node ≥ 22.5（依赖内置 node:sqlite 模块）');
  }
}

/**
 * Agentia —— SQLite 宿主 TaskStore（spec §6.6：异步耐久 = 换宿主不换语义，roadmap R3）。
 *
 * 基于 Node 内置 node:sqlite（DatabaseSync），零外部依赖。语义与 FileTaskStore 逐字对齐：
 * - save = INSERT OR REPLACE（整行记录 JSON 存 json 列，last-wins）；
 * - byIdempotency 取该键最近一次 save 的记录（按 rowid 倒序，失败重提产生的新任务胜出）；
 * - list 按写入顺序返回；clear 清空整表；
 * - 构造即就绪（建表 + 索引，无异步），重启续跑同样交给 AsyncRunner.resumePending()。
 *
 * 对比 FileTaskStore 的**单写者前提**：多进程安全由 SQLite WAL/事务天然保证 ——
 * 多个宿主进程可同时打开同一库文件，写事务由 SQLite 串行化，无需部署层加锁。
 */
export class SqliteTaskStore implements TaskStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(path);
    // busy_timeout 必须先于 WAL 设置：WAL 转换本身要拿写锁，他进程占锁时若
    // busy_timeout 尚未生效，多进程同时首启会在「PRAGMA journal_mode = WAL」上
    // 立即抛 SQLITE_BUSY。先设 busy_timeout ⇒ 写事务争用时等待至多 5s 再重试。
    // 没有它，多进程共库时第二个写者立即失败 —— 而 AsyncRunner 的 #safeSave 会把
    // save 失败静默吞掉（不遮罩主流程），结果是任务记录无声丢失。
    // 内存库同样支持该 pragma（合法 no-op），无需分支。
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      // WAL：读写不互斥，多进程共库的基础（内存库不支持，跳过）
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    // status 列是 json 内 status 的反规范化副本：本 store 的 SELECT 只读 json，
    // 该列专供外部/DBA 直接按状态统计（如 SELECT status, count(*) FROM tasks GROUP BY status）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT,
        status TEXT,
        json TEXT
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key)');
  }

  save(rec: TaskRecord): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO tasks (task_id, idempotency_key, status, json) VALUES (?, ?, ?, ?)',
      )
      .run(rec.taskId, rec.idempotencyKey ?? null, rec.status, JSON.stringify(rec));
  }

  get(taskId: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT json FROM tasks WHERE task_id = ?').get(taskId) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as TaskRecord) : undefined;
  }

  byIdempotency(key: string): TaskRecord | undefined {
    // last-wins：INSERT OR REPLACE 会删除旧行重插，rowid 最大者即最近一次 save
    const row = this.db
      .prepare('SELECT json FROM tasks WHERE idempotency_key = ? ORDER BY rowid DESC LIMIT 1')
      .get(key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TaskRecord) : undefined;
  }

  list(): TaskRecord[] {
    const rows = this.db.prepare('SELECT json FROM tasks ORDER BY rowid').all() as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as TaskRecord);
  }

  clear(): void {
    this.db.exec('DELETE FROM tasks');
  }

  /** 关闭底层连接（测试/进程收尾用；TaskStore 接口之外的能力） */
  close(): void {
    this.db.close();
  }
}
