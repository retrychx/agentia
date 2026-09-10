import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RedisTaskStore } from '../../src/run/redisStore.js';
import type { RedisLike } from '../../src/run/redisStore.js';
import type { TaskRecord, TaskStore } from '../../src/run/store.js';
import { AsyncRunner } from '../../src/run/async.js';
import type { AppCallable } from '../../src/run/async.js';
import type { AgentRunResult } from '../../src/engine/types.js';

/** 内存版 RedisLike：Map 实现 get/set/del/keys/scanIterator，驱动全部用例 */
class InMemoryRedisFake implements RedisLike {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async set(key: string, value: string): Promise<string> {
    this.map.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.map.delete(key) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.map.keys()].filter((k) => re.test(k));
  }
  async *scanIterator(opts?: { MATCH?: string }): AsyncIterable<string> {
    for (const k of await this.keys(opts?.MATCH ?? '*')) yield k;
  }
}

/** redis glob（只用 *）→ RegExp */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`));
  return new RegExp(`^${escaped}$`);
}

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

describe('RedisTaskStore（InMemoryRedisFake 驱动）', () => {
  it('save/get/byIdempotency/list/clear 全语义（默认走 scanIterator）', async () => {
    const store = new RedisTaskStore(new InMemoryRedisFake());
    assert.equal(await store.get('nope'), undefined);
    assert.equal(await store.byIdempotency('k'), undefined);
    assert.deepEqual(await store.list(), []);

    // 含嵌套 result/trace 的整行记录 JSON 往返
    const a = rec({
      idempotencyKey: 'k',
      result: { stopReason: 'end_turn', finalText: 'done', iterations: 1, trace: { spans: [] } } as never,
    });
    const b = rec();
    await store.save(a);
    await store.save(b);
    assert.deepEqual(await store.get(a.taskId), a);
    assert.deepEqual(await store.byIdempotency('k'), a);
    assert.equal((await store.list()).length, 2);

    // save 覆写（last-wins）：同 taskId 推进状态
    const a2 = { ...a, status: 'succeeded' as const };
    await store.save(a2);
    assert.equal((await store.get(a.taskId))?.status, 'succeeded');
    assert.equal((await store.list()).length, 2);

    await store.clear();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get(a.taskId), undefined);
    assert.equal(await store.byIdempotency('k'), undefined);
  });

  it('byIdempotency last-wins：失败重提的新任务覆盖旧记录', async () => {
    const store = new RedisTaskStore(new InMemoryRedisFake());
    const failed = rec({ idempotencyKey: 'k', status: 'failed' });
    await store.save(failed);
    const retried = rec({ idempotencyKey: 'k' });
    await store.save(retried);
    assert.equal((await store.byIdempotency('k'))?.taskId, retried.taskId);
  });

  it('list 序：按 createdAt（同刻按 taskId）稳定排序', async () => {
    const store = new RedisTaskStore(new InMemoryRedisFake());
    const late = rec({ createdAt: 3000 });
    const early = rec({ createdAt: 1000 });
    const sameA = rec({ taskId: 'task_a', createdAt: 2000 });
    const sameB = rec({ taskId: 'task_b', createdAt: 2000 });
    for (const r of [late, early, sameB, sameA]) await store.save(r); // 乱序写入
    assert.deepEqual(
      (await store.list()).map((r) => r.taskId),
      [early.taskId, 'task_a', 'task_b', late.taskId],
    );
  });

  it('keys 兜底：client 无 scanIterator 时 list/clear 走 keys(pattern)', async () => {
    const fake = new InMemoryRedisFake();
    const keysOnly: RedisLike = {
      get: fake.get.bind(fake),
      set: fake.set.bind(fake),
      del: fake.del.bind(fake),
      keys: fake.keys.bind(fake),
    };
    const store = new RedisTaskStore(keysOnly);
    await store.save(rec({ idempotencyKey: 'k' }));
    await store.save(rec());
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.byIdempotency('k'))?.idempotencyKey, 'k');
    await store.clear();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.byIdempotency('k'), undefined);
  });

  it('prefix 隔离：同库两个 store 互不可见；clear 只清本前缀', async () => {
    const fake = new InMemoryRedisFake();
    const s1 = new RedisTaskStore(fake, { prefix: 'app1:' });
    const s2 = new RedisTaskStore(fake, { prefix: 'app2:' });
    const r1 = rec({ idempotencyKey: 'k' });
    const r2 = rec({ idempotencyKey: 'k' });
    await s1.save(r1);
    await s2.save(r2);

    assert.equal((await s1.get(r1.taskId))?.taskId, r1.taskId);
    assert.equal(await s1.get(r2.taskId), undefined);
    assert.equal((await s1.byIdempotency('k'))?.taskId, r1.taskId);
    assert.equal((await s2.byIdempotency('k'))?.taskId, r2.taskId);

    await s1.clear();
    assert.deepEqual(await s1.list(), []);
    assert.equal((await s2.list()).length, 1); // app2: 不受影响
  });

  it('损坏记录按缺失处理（不整库崩）；无 scanIterator/keys 构造抛错', async () => {
    const fake = new InMemoryRedisFake();
    const store = new RedisTaskStore(fake);
    const good = rec();
    await store.save(good);
    fake.map.set('agentia:task:broken', '{not json');
    assert.equal(await store.get('broken'), undefined);
    assert.deepEqual((await store.list()).map((r) => r.taskId), [good.taskId]);

    const noEnum: RedisLike = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 0,
    };
    assert.throws(() => new RedisTaskStore(noEnum), /scanIterator 或 keys/);
  });

  it('满足 TaskStore 接口（MaybePromise）：await 化后与同步 store 用法一致', async () => {
    const store: TaskStore = new RedisTaskStore(new InMemoryRedisFake());
    const a = rec({ idempotencyKey: 'k' });
    await store.save(a);
    assert.deepEqual(await store.get(a.taskId), a);
    assert.equal((await store.byIdempotency('k'))?.taskId, a.taskId);
    assert.equal((await store.list()).length, 1);
    await store.clear();
    assert.deepEqual(await store.list(), []);
  });

  it('接入 AsyncRunner：异步 store 全链路执行 + 执行前去重（采纳 succeeded 结果）', async () => {
    const app: AppCallable & { calls: number } = {
      name: 'fake',
      calls: 0,
      async run() {
        app.calls++;
        return {
          run: { runId: `r-${app.calls}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { store: new RedisTaskStore(new InMemoryRedisFake()) });

    // submit 同步门面返回新建任务快照；后台经异步 store 推进到终态
    const t1 = runner.submit('a', { idempotencyKey: 'k' });
    assert.equal(t1.status, 'queued');
    const done1 = await runner.awaitTask(t1.taskId);
    assert.equal(done1.status, 'succeeded');
    assert.equal(done1.runId, 'r-1');

    // 同键重提：submit 无法即时去重（Promise），新建任务在执行前采纳上一 succeeded 结果
    const t2 = runner.submit('a', { idempotencyKey: 'k' });
    assert.notEqual(t2.taskId, t1.taskId); // 与同步 store 的即时去重（返回同 taskId）形态不同
    const done2 = await runner.awaitTask(t2.taskId);
    assert.equal(done2.status, 'succeeded');
    assert.equal(done2.runId, 'r-1'); // 采纳既有结果
    assert.equal(app.calls, 1); // 未重复执行

    // poll/list 在异步 store 下返回 Promise，调用方 await
    assert.equal((await runner.poll(t1.taskId))?.status, 'succeeded');
    assert.equal((await runner.list()).length, 2);
    assert.equal(await runner.resumePending(), 0); // 无 queued/running 残留
  });
});
