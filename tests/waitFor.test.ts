import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';

/**
 * 共用等待助手自己的回归 —— 尤其是**它必须还会咬人**。
 *
 * 背景（spec §10 2026-09-14）：抖动普查发现「把等到某状态写成墙钟预算」是唯一能在满载下失败的构造，
 * 三份测试还各手搓了一份 `waitFor`、超时连等的是什么都不打印。收成共用版后，风险从「预算太紧」
 * 换成「助手自己失效」—— 所以这里第三条用**永不成立**的条件证明：预算耗尽时它真的抛错、
 * 且错误里能读出「等的是什么、预算多少」。
 */
describe('waitFor（共用等待助手）', () => {
  it('条件已成立 → 立刻返回（不空转）', async () => {
    let polls = 0;
    await waitFor(() => {
      polls++;
      return true;
    }, '恒真条件');
    assert.equal(polls, 1, '已成立时不该再轮询');
  });

  it('条件稍后成立 → 等到它成立为止', async () => {
    let n = 0;
    await waitFor(() => ++n >= 3, '第 3 次轮询时应成立');
    assert.equal(n, 3);
  });

  it('条件永不成立 → 预算耗尽即抛错，错误自陈条件与预算（不是静默假绿）', async () => {
    const t0 = Date.now();
    await assert.rejects(
      () => waitFor(() => false, '这个条件故意永不成立', 60),
      (e: unknown) => {
        const msg = (e as Error).message;
        assert.match(msg, /这个条件故意永不成立/, '错误里要能看出等的是什么');
        assert.match(msg, /预算 60ms/, '错误里要能看出预算是多少');
        assert.match(msg, /等了 \d+ms/, '错误里要能看出实际等了多久');
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 1_000, '应在预算附近就放弃（16 倍余量，不是性能断言）');
  });
});
