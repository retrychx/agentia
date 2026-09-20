import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    const t0 = Date.now();
    await tw.wait('t1', 40);
    // ⚠️ 下界给足容差：定时器不以毫秒精度触发，Date.now() 又被截断到整毫秒 ——
    //    断言 >= 预算（25）会把一次 24ms 的抖动判成失败（第一版就是这么红的）。
    //    这里要证的是「确实等了将近一个预算」，不是「定时器精确到毫秒」。
    assert.ok(Date.now() - t0 >= 25, '必须真的等（约一个预算），而不是立刻返回');
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
