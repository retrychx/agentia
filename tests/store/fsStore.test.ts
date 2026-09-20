import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  appendFileSync,
  mkdirSync,
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

  it('compact() 原子重写：临时文件写失败时原文件完整、不留半截', () => {
    const { dir, file } = tmp();
    const tmpFile = `${file}.compact.tmp`;
    try {
      const store = new FileTaskStore(file);
      const a = rec({ idempotencyKey: 'k' });
      store.save(a);
      store.save({ ...a, status: 'succeeded' });
      const before = readFileSync(file, 'utf8');

      // 注入失败：把临时文件路径预先占成一个目录 → writeFileSync 抛 EISDIR，
      // 等价于「写临时文件中途失败」；此时原文件必须一字节不动
      mkdirSync(tmpFile);
      assert.throws(() => store.compact());
      assert.equal(readFileSync(file, 'utf8'), before, '压实失败不得动原文件');
      rmSync(tmpFile, { recursive: true });

      // 恢复后可正常压实，且 rename 后不留临时文件
      store.compact();
      assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
      assert.ok(!existsSync(tmpFile), 'rename 后不应残留临时文件');
      assert.deepEqual(new FileTaskStore(file).get(a.taskId), store.get(a.taskId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compact() 后重启幂等键赢家不变（内存「最后 save 赢」与 load「行序 last-wins」对齐）', () => {
    const { dir, file } = tmp();
    try {
      const s1 = new FileTaskStore(file);
      // 复现序列：同键两任务 + 重复 save。byKey 每次覆写 ⇒ 内存赢家是最后 save 的 A；
      // 但 Map 插入序是 [A, B]（A 再次 save 不改变首次插入位），若 compact 按插入序
      // 写盘，load 按行序 last-wins 回放后赢家易主为 B。
      const a = rec({ idempotencyKey: 'K', status: 'failed' });
      s1.save(a); // byKey[K] = A
      const b = rec({ idempotencyKey: 'K', status: 'succeeded' });
      s1.save(b); // byKey[K] = B（失败重提的新任务）
      s1.save({ ...a, status: 'succeeded' }); // byKey[K] = A：旧任务又被 save 赢回
      assert.equal(s1.byIdempotency('K')?.taskId, a.taskId, '内存语义：最后 save 赢');

      s1.compact();
      const s2 = new FileTaskStore(file); // 模拟宿主重启
      assert.equal(s2.byIdempotency('K')?.taskId, a.taskId, 'compact + 重启后赢家必须不变');
      assert.deepEqual(s2.get(a.taskId), s1.get(a.taskId));
      assert.deepEqual(s2.get(b.taskId), s1.get(b.taskId));
      assert.equal(s2.list().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('save 落盘失败：内存不得先推进（先落盘、后写内存）', () => {
    // 反向验证：换回「先写内存后落盘」的旧顺序 ⇒ append 抛错时内存已推进，
    // 本用例红在「get 竟然能查到没落盘的记录」—— 内存与磁盘两本账，重启后静默回退。
    const { dir, file } = tmp();
    try {
      const store = new FileTaskStore(file);
      const a = rec({ idempotencyKey: 'k' });
      store.save(a);

      // 让下一次 append 必败：摘掉整个目录（磁盘满 / 目录被摘除的同族形态）
      rmSync(dir, { recursive: true, force: true });
      const b = rec({ idempotencyKey: 'k2' });
      assert.throws(() => store.save(b));
      assert.equal(store.get(b.taskId), undefined, '落盘失败 ⇒ 内存也不得推进');
      assert.equal(store.byIdempotency('k2'), undefined, '幂等键索引同样不得推进');
      assert.equal(store.get(a.taskId)?.taskId, a.taskId, '既有记录不受影响');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('load 读失败：onLoadError 被调一次且按空库启动；缺省回调仍静默降级', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-fs-'));
    try {
      const file = join(dir, 'tasks.jsonl');
      // 目录当文件用：existsSync 为 true、readFileSync 必抛 EISDIR，可靠触发读失败分支
      mkdirSync(file);

      let calls = 0;
      let lastErr: unknown;
      const store = new FileTaskStore(file, (err) => {
        calls++;
        lastErr = err;
      });
      assert.equal(calls, 1, '读失败必须经 onLoadError 上报一次');
      assert.ok(lastErr instanceof Error);
      assert.deepEqual(store.list(), [], '读失败按空宿主启动');

      // 缺省回调：不抛错、照常空库启动（观测不击穿业务）
      const quiet = new FileTaskStore(file);
      assert.deepEqual(quiet.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
