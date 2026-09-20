import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DrainGate } from '../../src/transport/drain-gate.js';

/** 排空微任务/宏任务队列（不依赖真时钟） */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('DrainGate —— 优雅停机的等待闸（从 AsyncRunner 抽出）', () => {
  it('空载：进入停机态并立刻返回 true（标志必须先于排空置位）', async () => {
    const gate = new DrainGate();
    assert.equal(gate.isDraining, false);
    assert.equal(await gate.waitForIdle(() => true, 0), true);
    assert.equal(gate.isDraining, true, '即便空载也要先停在停机态：新单立刻 503');
  });

  it('有在飞：挂起；空闲后 signalIdle 才唤醒；非空闲时 signalIdle 是空操作', async () => {
    const gate = new DrainGate();
    let idle = false;
    let result: boolean | undefined;
    const p = gate
      .waitForIdle(() => idle, 0)
      .then((v) => {
        result = v;
      });
    await tick();
    assert.equal(result, undefined, '不空闲就不能返回');
    assert.equal(gate.waiterCount, 1);
    gate.signalIdle(() => idle);
    await tick();
    assert.equal(result, undefined, '非空闲时唤醒必须是空操作');
    assert.equal(gate.waiterCount, 1);
    idle = true;
    gate.signalIdle(() => idle);
    await p;
    assert.equal(result, true);
    assert.equal(gate.waiterCount, 0, '唤醒后等待者出表');
  });

  it('超时：返回 false、停在停机态、等待者按原样留在表里（与抽取前逐字一致）', async () => {
    const gate = new DrainGate();
    const t0 = performance.now();
    const ok = await gate.waitForIdle(() => false, 40);
    assert.equal(ok, false);
    // ⚠️ 两条都别丢：① 用**单调时钟**量（`performance.now()`），别用 `Date.now()`。
    //    定时器按单调时钟到点，而 `Date.now()` 是墙钟、还被截断到整毫秒 —— 实测 3000 次
    //    40ms 定时器里，两个时钟的读数差从 −0.97ms 跑到 **+8.57ms**（墙钟会「丢」测量时间：
    //    截断 + 漂移/回拨）。用它量会把「等满了 40ms」读成偏小十几毫秒。
    //    ② 下界留足余量（预算 40 / 断言 25），别写成「预算 25 / 断言 ≥ 25」：那是 **~1% 随机红**
    //    （实测 4000 次 `await setTimeout(25)` 的墙钟读数有 1.4% 落在 24ms），CI 上真红过一次
    //    （同一个 commit：PR run 绿、main run 红）。这条断言要证的是「等了将近一个预算」。
    assert.ok(performance.now() - t0 >= 25, '必须真的等（约一个预算），而不是立刻返回');
    assert.equal(gate.isDraining, true, '超时也停在停机态 —— drain 不是回滚，是「不再往前推」');
    assert.equal(
      gate.waiterCount,
      1,
      '旧实现超时后不摘除等待者（下次归零会再唤醒一次，结果已被忽略）—— 这是有意保留的原样行为',
    );
  });

  it('多个等待者：一次 signalIdle 全部唤醒', async () => {
    const gate = new DrainGate();
    let idle = false;
    const results: boolean[] = [];
    const ps = [1, 2, 3].map(() =>
      gate
        .waitForIdle(() => idle, 0)
        .then((v) => {
          results.push(v);
        }),
    );
    await tick();
    assert.equal(gate.waiterCount, 3);
    idle = true;
    gate.signalIdle(() => idle);
    await Promise.all(ps);
    assert.deepEqual(results, [true, true, true]);
  });

  it('timeoutMs <= 0 且有人在飞：一直等，不许自己返回', async () => {
    const gate = new DrainGate();
    let idle = false;
    let done = false;
    const p = gate
      .waitForIdle(() => idle, 0)
      .then(() => {
        done = true;
      });
    await tick();
    await tick();
    assert.equal(done, false, 'timeoutMs=0 表示一直等');
    idle = true;
    gate.signalIdle(() => idle);
    await p;
    assert.equal(done, true);
  });

  it('重复 drain（已停机 + 后来的等待者）：各自挂起、一起被唤醒', async () => {
    const gate = new DrainGate();
    let idle = false;
    const r1 = gate.waitForIdle(() => idle, 0);
    await tick();
    const r2 = gate.waitForIdle(() => idle, 0);
    await tick();
    assert.equal(gate.waiterCount, 2);
    idle = true;
    gate.signalIdle(() => idle);
    assert.deepEqual(await Promise.all([r1, r2]), [true, true]);
  });
});
