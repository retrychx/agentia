import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTaskStore } from '../../src/index.js';
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

describe('InMemoryTaskStore 内存闸门（maxRecords）', () => {
  it('超限时淘汰最旧的**已终态**记录，在飞（queued/running）记录永不淘汰', () => {
    const store = new InMemoryTaskStore({ maxRecords: 2 });
    const running = rec({ status: 'running' });
    store.save(running);
    const a = rec({ status: 'succeeded', idempotencyKey: 'ka' });
    store.save(a);
    const b = rec({ status: 'succeeded' });
    store.save(b); // size 3 > 2 → 淘汰最旧的已终态（a）

    assert.equal(store.get(a.taskId), undefined, '最旧的已终态被淘汰');
    assert.ok(store.get(running.taskId), '在飞记录保留');
    assert.ok(store.get(b.taskId), '最新记录保留');
    assert.equal(store.list().length, 2);
    assert.equal(store.byIdempotency('ka'), undefined, '被淘汰记录的幂等索引一并清掉');
  });

  it('全是在飞记录时不淘汰（宁可不腾空间也不丢正在跑的任务）', () => {
    const store = new InMemoryTaskStore({ maxRecords: 1 });
    const r1 = rec({ status: 'running' });
    const r2 = rec({ status: 'queued' });
    store.save(r1);
    store.save(r2);
    assert.equal(store.list().length, 2, '在飞记录不得被淘汰');
  });

  it('缺省不限（旧行为）：不淘汰', () => {
    const store = new InMemoryTaskStore();
    for (let i = 0; i < 50; i++) store.save(rec({ status: 'succeeded' }));
    assert.equal(store.list().length, 50);
  });

  it('maxRecords 非法值（0 / 负数）抛错', () => {
    assert.throws(() => new InMemoryTaskStore({ maxRecords: 0 }), /maxRecords/);
    assert.throws(() => new InMemoryTaskStore({ maxRecords: -1 }), /maxRecords/);
  });
});
