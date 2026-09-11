import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore } from '../../src/index.js';
import type { TaskRecord } from '../../src/index.js';

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

function tmp(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-fs-'));
  return { dir, file: join(dir, 'tasks.jsonl') };
}

describe('FileTaskStore', () => {
  it('save/get/byIdempotency/list/clear 全路径', () => {
    const { dir, file } = tmp();
    try {
      const store = new FileTaskStore(file);
      assert.equal(store.get('nope'), undefined);
      assert.equal(store.byIdempotency('k'), undefined);
      assert.deepEqual(store.list(), []);

      const a = rec({ idempotencyKey: 'k' });
      const b = rec(); // 无幂等键
      store.save(a);
      store.save(b);
      assert.deepEqual(store.get(a.taskId), a);
      assert.deepEqual(store.byIdempotency('k'), a);
      assert.equal(store.list().length, 2);
      assert.ok(existsSync(file), 'save 落盘 JSONL');

      // 同 taskId 覆写（last-wins）：内存态推进，文件 append 两行
      const a2 = { ...a, status: 'succeeded' as const };
      store.save(a2);
      assert.equal(store.get(a.taskId)?.status, 'succeeded');
      assert.equal(store.list().length, 2);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 3, 'save 是 append 快照而非原地改');

      store.clear();
      assert.deepEqual(store.list(), []);
      assert.equal(store.get(a.taskId), undefined);
      assert.equal(store.byIdempotency('k'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重启续读：new 一个实例读回记录，跨行 last-wins', () => {
    const { dir, file } = tmp();
    try {
      const s1 = new FileTaskStore(file);
      const a = rec({ idempotencyKey: 'k', status: 'running' });
      s1.save(a);
      s1.save({ ...a, status: 'succeeded' }); // 同 taskId 推进
      const failed = rec({ idempotencyKey: 'k2', status: 'failed' });
      s1.save(failed);
      const retried = rec({ idempotencyKey: 'k2' }); // 失败重提：同键新任务
      s1.save(retried);

      // 模拟宿主重启：全新实例从磁盘重建
      const s2 = new FileTaskStore(file);
      assert.equal(s2.list().length, 3);
      assert.equal(s2.get(a.taskId)?.status, 'succeeded', '后写覆盖先写');
      assert.equal(s2.byIdempotency('k')?.taskId, a.taskId);
      assert.equal(s2.byIdempotency('k2')?.taskId, retried.taskId, '幂等键 last-wins');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏行容错：坏 JSON / 缺 taskId / null 行跳过，load 不崩', () => {
    const { dir, file } = tmp();
    try {
      const s1 = new FileTaskStore(file);
      const good = rec({ idempotencyKey: 'k' });
      s1.save(good);
      appendFileSync(file, '{not json\n');
      appendFileSync(file, '{"status":"queued"}\n'); // 缺 taskId
      appendFileSync(file, 'null\n');
      appendFileSync(file, '\n'); // 空行

      const s2 = new FileTaskStore(file); // 不抛错
      assert.equal(s2.list().length, 1);
      assert.deepEqual(s2.get(good.taskId), good);
      assert.equal(s2.byIdempotency('k')?.taskId, good.taskId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('尾部残行自愈：半截 JSON 截掉后，新记录不会与残行粘成一行', () => {
    const { dir, file } = tmp();
    try {
      const s1 = new FileTaskStore(file);
      const a = rec({ idempotencyKey: 'k' });
      s1.save(a);
      // 模拟写残：第二行只写了一半、且没有结尾换行
      appendFileSync(file, '{"taskId":"task_torn","status":"que');

      const s2 = new FileTaskStore(file);
      assert.deepEqual(s2.get(a.taskId), a, '完整记录照常读回');
      assert.equal(s2.list().length, 1, '残行不产生记录');
      assert.ok(readFileSync(file, 'utf8').endsWith('\n'), '残行被截到干净边界');

      const b = rec();
      s2.save(b);
      // 关键：重启后两条都在（不修的话 append 会粘成 `…que{"taskId":…}` 一行，两条一起丢）
      const s3 = new FileTaskStore(file);
      assert.deepEqual(s3.get(a.taskId), a);
      assert.deepEqual(s3.get(b.taskId), b);
      assert.equal(s3.list().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('尾部是完整记录但缺结尾换行：补换行而非丢弃', () => {
    const { dir, file } = tmp();
    try {
      const a = rec({ idempotencyKey: 'k' });
      writeFileSync(file, JSON.stringify(a)); // 完整记录，无结尾换行
      const s = new FileTaskStore(file);
      assert.deepEqual(s.get(a.taskId), a, '完整记录不该被当成残行丢掉');
      assert.ok(readFileSync(file, 'utf8').endsWith('\n'));

      const b = rec();
      s.save(b);
      assert.equal(new FileTaskStore(file).list().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在从空开始；save 自动建目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-fs-'));
    const file = join(dir, 'sub', 'deep', 'tasks.jsonl'); // 父目录不存在
    try {
      const store = new FileTaskStore(file);
      assert.deepEqual(store.list(), []);
      assert.ok(!existsSync(file));

      const a = rec();
      store.save(a);
      assert.ok(existsSync(file), 'append 前 mkdirSync recursive');
      assert.deepEqual(new FileTaskStore(file).get(a.taskId), a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clear 删除磁盘文件；对不存在文件的 clear 不抛错', () => {
    const { dir, file } = tmp();
    try {
      const store = new FileTaskStore(file);
      store.save(rec({ idempotencyKey: 'k' }));
      assert.ok(existsSync(file));
      store.clear();
      assert.ok(!existsSync(file), 'clear 连同磁盘文件一起删');
      assert.equal(store.byIdempotency('k'), undefined);

      // 文件已不存在，再次 clear 不抛错；后续 save 重新建文件
      store.clear();
      const a = rec();
      store.save(a);
      assert.ok(existsSync(file));
      assert.deepEqual(store.get(a.taskId), a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compact()：把 append-only 日志压成「每 task 一行」，语义不变', () => {
    const { dir, file } = tmp();
    try {
      const s1 = new FileTaskStore(file);
      const a = rec({ idempotencyKey: 'k', status: 'running' });
      s1.save(a);
      // 同一 task 反复推进 → 日志线性膨胀
      for (let i = 0; i < 5; i++) s1.save({ ...a, status: i % 2 ? 'running' : 'succeeded' });
      assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 6, 'append-only：6 行');

      s1.compact();
      assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, '压成每 task 一行');

      // 压实不改变语义：新实例读回同一终态
      const s2 = new FileTaskStore(file);
      assert.equal(s2.list().length, 1);
      assert.deepEqual(s2.get(a.taskId), s1.get(a.taskId));
      assert.equal(s2.byIdempotency('k')?.taskId, a.taskId);

      // 压实后继续 save 仍能正常追加
      const b = rec();
      s2.save(b);
      assert.equal(new FileTaskStore(file).list().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
