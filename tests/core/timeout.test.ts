import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTimeoutError, TIMED_OUT, TimeoutError, withTimeout } from '../../src/core/timeout.js';

/**
 * 共享超时原语（2026-09-17 单源化，见 `docs/spec.md` §10 2026-09-17 ①）。
 *
 * 为什么要**直接**单测它：这份原语此前散在两处 —— `engine/concurrency.ts` 与
 * `integrations/mcp.ts` 各写一份，于是「超时是硬的」那次收紧只落进前者，桥那一份
 * 继续用纯竞速判定，把超预算的调用记成成功、并在 trace 里落成 `errorKind=threw`。
 * 单源之后，这里的每一条都是**两个消费者共同**的性质；谁再想「就地改一处」，
 * 改的是别人也在用的东西，跑不过这里的门禁。
 */

describe('core/timeout：共享超时原语（engine 与桥共用）', () => {
  it('哨兵区别于「工具恰好返回了 undefined」', async () => {
    const out = await withTimeout(Promise.resolve(undefined), 50);
    assert.notEqual(out, TIMED_OUT);
    assert.equal(out, undefined);
  });

  it('预算非正数 = 不设超时，原样透传（不新建计时器、不改写结果）', async () => {
    const p = Promise.resolve('ok');
    assert.equal(await withTimeout(p, 0), 'ok');
    assert.equal(await withTimeout(Promise.resolve('ok'), -1), 'ok');
  });

  it('超时错误带 code="timeout"（引擎据此归 errorKind=timeout）', () => {
    const e = new TimeoutError('超了');
    assert.equal(e.code, 'timeout');
    assert.equal(e.name, 'TimeoutError');
    assert.equal(e instanceof Error, true);
  });

  it('isTimeoutError 认鸭子类型（使用者不必 import 这个类）', () => {
    assert.equal(isTimeoutError(new TimeoutError('x')), true);
    assert.equal(isTimeoutError(Object.assign(new Error('x'), { code: 'timeout' })), true);
    // 不得把「别的超时类」也算进来：只认框架约定的那一个 code
    assert.equal(isTimeoutError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
    assert.equal(isTimeoutError(new Error('x')), false);
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError('timeout'), false);
  });
});
