import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTaskStore } from '../../src/store/sqliteStore.js';
import { FileTaskStore } from '../../src/store/fsStore.js';
import type { TaskRecord, TaskStore } from '../../src/store/store.js';

let n = 0;
function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${++n}`,
    status: 'queued',
    spec: { messages: [{ role: 'user', content: 'a' }] },
    createdAt: 1000 + n,
    ...over,
  };
}

function tmpFile(name: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-sqlite-'));
  return { dir, file: join(dir, name) };
}

describe('SqliteTaskStore', () => {
  it(':memory: —— save/get/byIdempotency/list/clear 全语义', () => {
    const store = new SqliteTaskStore(':memory:');
    try {
      assert.equal(store.get('nope'), undefined);
      assert.equal(store.byIdempotency('k'), undefined);
      assert.deepEqual(store.list(), []);

      const a = rec({ idempotencyKey: 'k' });
      const b = rec();
      store.save(a);
      store.save(b);
      assert.deepEqual(store.get(a.taskId), a);
      assert.deepEqual(store.byIdempotency('k'), a);
      assert.equal(store.list().length, 2);

      // save 覆写（last-wins）：同 taskId 推进状态
      const a2 = { ...a, status: 'succeeded' as const };
      store.save(a2);
      assert.equal(store.get(a.taskId)?.status, 'succeeded');
      assert.equal(store.list().length, 2);

      store.clear();
      assert.deepEqual(store.list(), []);
      assert.equal(store.get(a.taskId), undefined);
      assert.equal(store.byIdempotency('k'), undefined);
    } finally {
      store.close();
    }
  });

  it('byIdempotency last-wins：失败重提的新任务覆盖旧记录', () => {
    const store = new SqliteTaskStore(':memory:');
    try {
      const failed = rec({ idempotencyKey: 'k', status: 'failed' });
      store.save(failed);
      const retried = rec({ idempotencyKey: 'k' });
      store.save(retried);
      assert.equal(store.byIdempotency('k')?.taskId, retried.taskId);
    } finally {
      store.close();
    }
  });

  it('临时文件：重开续读（模拟宿主重启）', () => {
    const { dir, file } = tmpFile('tasks.db');
    try {
      const s1 = new SqliteTaskStore(file);
      const a = rec({ idempotencyKey: 'k', status: 'running' });
      s1.save(a);
      s1.save(rec({ status: 'succeeded' }));
      s1.close();

      // “重启”后新实例读回全部记录（running 残留交给 resumePending 续跑）
      const s2 = new SqliteTaskStore(file);
      try {
        assert.equal(s2.list().length, 2);
        assert.deepEqual(s2.get(a.taskId), a);
        assert.equal(s2.byIdempotency('k')?.taskId, a.taskId);
      } finally {
        s2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('与 FileTaskStore 语义对照：同一操作序列结果一致', () => {
    const { dir, file } = tmpFile('ref.jsonl');
    const fileStore: TaskStore = new FileTaskStore(file);
    const sqliteStore: TaskStore = new SqliteTaskStore(':memory:');
    try {
      // 两 store 用同一批记录对象走同一序列（含同键重提）
      const records = [rec({ idempotencyKey: 'k1' }), rec({ idempotencyKey: 'k2' })];
      const retried = rec({ idempotencyKey: 'k1', status: 'failed' });
      for (const s of [fileStore, sqliteStore]) {
        for (const r of [...records, retried]) s.save(r);
      }

      assert.deepEqual(sqliteStore.list(), fileStore.list());
      assert.deepEqual(sqliteStore.byIdempotency('k1'), fileStore.byIdempotency('k1'));
      assert.equal(sqliteStore.byIdempotency('k1')?.taskId, retried.taskId);
      for (const r of records) {
        assert.deepEqual(sqliteStore.get(r.taskId), fileStore.get(r.taskId));
      }

      fileStore.clear();
      sqliteStore.clear();
      assert.deepEqual(sqliteStore.list(), fileStore.list());
    } finally {
      (sqliteStore as SqliteTaskStore).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('busy_timeout：他进程占住写锁时等锁重试，而非立即 SQLITE_BUSY', async () => {
    // 多进程共库的承诺靠 WAL + busy_timeout 兑现；只设 WAL 时第二个写者立即
    // SQLITE_BUSY，而 AsyncRunner 的 #safeSave 会把失败静默吞掉 → 记录无声丢失。
    // 用 worker 线程持锁（同进程不同连接，等价于另一个宿主进程）。
    const { dir, file } = tmpFile('busy.db');
    const store = new SqliteTaskStore(file);
    const holder = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(workerData.file);
       db.exec('PRAGMA journal_mode = WAL');
       db.exec('BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       setTimeout(() => {
         try { db.exec('COMMIT'); } catch {}
         parentPort.postMessage('released');
       }, 200);`,
      { eval: true, workerData: { file } },
    );
    let locked!: () => void;
    let released!: () => void;
    const gotLocked = new Promise<void>((r) => (locked = r));
    const gotReleased = new Promise<void>((r) => (released = r));
    holder.on('message', (m) => {
      if (m === 'locked') locked();
      else if (m === 'released') released();
    });
    try {
      await gotLocked; // 写锁已被他进程占住
      const a = rec();
      store.save(a); // 无 busy_timeout 会在此立即抛 SQLITE_BUSY
      await gotReleased;
      assert.deepEqual(store.get(a.taskId), a, '等锁后写入成功');
    } finally {
      await holder.terminate();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
