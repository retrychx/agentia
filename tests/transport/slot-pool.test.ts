import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SlotPool } from '../../src/transport/slot-pool.js';

/** 排空微任务/宏任务队列，让 acquire 的 resolve 落地（不依赖真时钟，避免负载下抖动） */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SlotPool —— 从 AsyncRunner 抽出的并发槽位原语', () => {
  it('未到上限：acquire 立刻兑现；release 无等待者时归还计数', async () => {
    const pool = new SlotPool(2);
    await pool.acquire();
    await pool.acquire();
    assert.equal(pool.inUse, 2);
    pool.release();
    pool.release();
    assert.equal(pool.inUse, 0, '归还后计数必须回零');
    // 回零后还能再拿到两个 —— 反证计数确实归零
    await pool.acquire();
    await pool.acquire();
    assert.equal(pool.inUse, 2);
  });

  it('到上限：排队 + release 把槽位移交队首（FIFO），移交期间计数不变', async () => {
    const pool = new SlotPool(1);
    const order: string[] = [];
    await pool.acquire();
    void pool.acquire().then(() => order.push('b'));
    void pool.acquire().then(() => order.push('c'));
    await tick();
    assert.deepEqual(order, [], '上限内只有一个槽位，b/c 必须都还在排队');
    assert.equal(pool.inUse, 1);
    pool.release();
    await tick();
    assert.deepEqual(order, ['b'], 'release 只唤醒一个，且必须是先到的 b');
    assert.equal(pool.inUse, 1, '移交语义：槽位转手、占用数不变（不是先减后加）');
    pool.release();
    await tick();
    assert.deepEqual(order, ['b', 'c']);
    assert.equal(pool.inUse, 1);
    pool.release();
    assert.equal(pool.inUse, 0);
  });

  it('limit=1 串行化：第二个 acquire 在第一个 release 之前拿不到槽位', async () => {
    const pool = new SlotPool(1);
    let second = false;
    await pool.acquire();
    void pool.acquire().then(() => {
      second = true;
    });
    await tick();
    await tick();
    assert.equal(second, false);
    pool.release();
    await tick();
    assert.equal(second, true);
  });

  it('上限 Infinity（AsyncRunner 的缺省）：acquire 永不排队', async () => {
    const pool = new SlotPool(Number.POSITIVE_INFINITY);
    await Promise.all(Array.from({ length: 50 }, () => pool.acquire()));
    assert.equal(pool.inUse, 50);
  });
});
