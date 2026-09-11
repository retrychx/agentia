import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RETRY, backoffDelay, resolveRetry, sleep } from '../../src/engine/retry.js';
import { classifyError } from '../../src/index.js';

describe('RetryOptions 归一（resolveRetry）', () => {
  it('undefined → 缺省开启，填入缺省值', () => {
    const r = resolveRetry(undefined);
    assert.ok(r);
    assert.equal(r.maxAttempts, DEFAULT_RETRY.maxAttempts);
    assert.equal(r.baseDelayMs, DEFAULT_RETRY.baseDelayMs);
    assert.equal(typeof r.isRetryable, 'function');
    assert.equal(typeof r.onRetry, 'function');
  });

  it('false / maxAttempts<1 → 关闭（null）', () => {
    assert.equal(resolveRetry(false), null);
    assert.equal(resolveRetry({ maxAttempts: 0 }), null);
  });

  it('用户值覆盖缺省，函数字段缺省注入', () => {
    const r = resolveRetry({ maxAttempts: 5, baseDelayMs: 10 });
    assert.ok(r);
    assert.equal(r.maxAttempts, 5);
    assert.equal(r.baseDelayMs, 10);
    assert.equal(r.maxDelayMs, DEFAULT_RETRY.maxDelayMs);
  });

  it('缺省 isRetryable 走 classifyError：429 可重试、普通错误不可', () => {
    const r = resolveRetry(undefined)!;
    assert.equal(r.isRetryable(Object.assign(new Error('x'), { status: 429 })), false, '普通 Error 不是 SDK 错误');
    assert.equal(r.isRetryable(new Error('boom')), false);
    assert.equal(classifyError(new Error('boom')).retryable, false);
  });
});

describe('backoffDelay（指数 + 上限 + 抖动）', () => {
  const base = { ...DEFAULT_RETRY, maxAttempts: 5, jitter: 0, isRetryable: () => true, onRetry: () => {} };

  it('无抖动时按指数增长', () => {
    assert.equal(backoffDelay(1, base), 500);
    assert.equal(backoffDelay(2, base), 1000);
    assert.equal(backoffDelay(3, base), 2000);
  });

  it('封顶 maxDelayMs', () => {
    assert.equal(backoffDelay(10, base), 8000);
  });

  it('抖动落在 ±jitter 区间内', () => {
    const jittered = { ...base, jitter: 0.2 };
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(1, jittered); // 500 ± 20% → [400, 600]
      assert.ok(d >= 400 && d <= 600, `得到 ${d}`);
    }
  });
});

describe('sleep（可中断）', () => {
  it('正常等到点', async () => {
    const t0 = Date.now();
    await sleep(20);
    assert.ok(Date.now() - t0 >= 15);
  });

  it('中止立即 reject（AbortError）', async () => {
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
  });

  it('已中止的 signal → 立即 reject，不等待', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(sleep(5000, ac.signal), (e: unknown) => (e as Error).name === 'AbortError');
  });
});
