import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TaskWaiters } from '../../src/transport/task-waiters.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('TaskWaiters —— 任务终态等待表（从 AsyncRunner 抽出）', () => {
  it('notify 一次唤醒该任务的所有等待者，并把表清干净', async () => {
    const tw = new TaskWaiters();
    let n = 0;
    const ps = [1, 2, 3].map(() =>
      tw.wait('t1', 1_000).then(() => {
        n += 1;
      }),
    );
    assert.equal(tw.count, 3);
    tw.notify('t1');
    await Promise.all(ps);
    assert.equal(n, 3);
    assert.equal(tw.count, 0, '唤醒后该 taskId 的等待者出表');
  });

  it('wait 到期由兜底定时器唤醒（resolve，不是 reject）；到期后自己也出表', async () => {
    const tw = new TaskWaiters();
    // 量时间一律用**单调时钟**（`performance.now()`），不用 `Date.now()`：定时器按单调时钟
    // 到点，而墙钟会被截断到整毫秒、还会漂移/回拨（实测 3000 次 40ms 定时器里两个时钟的
    // 读数差能到 +8.57ms）。下界再留足余量（预算 40 / 断言 25）——「断言 == 预算」是 ~1% 随机红。
    const t0 = performance.now();
    await tw.wait('t1', 40);
    assert.ok(performance.now() - t0 >= 25, '必须真的等（约一个预算），而不是立刻返回');
    assert.equal(tw.count, 0, '到期与唤醒走同一套收尾，不得留下悬挂的等待者');
  });

  it('通知只影响对应 taskId；未知 taskId 是空操作', async () => {
    const tw = new TaskWaiters();
    let a = false;
    let b = false;
    const pa = tw.wait('a', 1_000).then(() => {
      a = true;
    });
    const pb = tw.wait('b', 1_000).then(() => {
      b = true;
    });
    tw.notify('nope');
    await tick();
    assert.equal(a, false);
    assert.equal(b, false, '未知 id 不得唤醒任何等待者');
    tw.notify('a');
    await pa;
    assert.equal(a, true);
    assert.equal(b, false, '只唤醒 a');
    tw.notify('b'); // 收尾：清掉 b 的定时器，别让测试进程吊着
    await pb;
    assert.equal(b, true);
    assert.equal(tw.count, 0);
  });

  it('二次触发是空操作（settled 守卫）：notify 两次不重复、不报错', async () => {
    const tw = new TaskWaiters();
    let n = 0;
    const p = tw.wait('t', 1_000).then(() => {
      n += 1;
    });
    tw.notify('t');
    tw.notify('t');
    await p;
    await tick();
    assert.equal(n, 1);
    assert.equal(tw.count, 0);
  });

  it('唤醒后可以重新登记（同一 taskId 复用，表不残留旧条目）', async () => {
    const tw = new TaskWaiters();
    const first = tw.wait('t', 1_000);
    tw.notify('t');
    await first;
    assert.equal(tw.count, 0, '唤醒后表清空');
    let again = false;
    const p = tw.wait('t', 1_000).then(() => {
      again = true;
    });
    assert.equal(tw.count, 1, '新登记的等待者只在表里一次');
    tw.notify('t');
    await p;
    assert.equal(again, true);
    assert.equal(tw.count, 0);
  });
});
