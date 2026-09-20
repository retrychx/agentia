import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY,
  backoffDelay,
  resolveRetry,
  sleep,
  retryAllowed,
} from '../../src/engine/retry.js';
import type { RetryOptions } from '../../src/engine/retry.js';
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

  it('显式 undefined 的字段 → 回落到缺省值（「没给」与「给了个 undefined」不是一回事）', () => {
    // tsconfig 未开 exactOptionalPropertyTypes，所以 `{ maxAttempts: cfg.retries }` 这类
    // spread/透传组装出来的配置能带着 undefined 过类型检查、一路抵达这里。旧写法
    // `{...DEFAULT_RETRY, ...o}` 会让 undefined **覆盖**默认值：
    //  - maxAttempts 变 undefined → `!(undefined >= 1)` 成立 → **重试被静默关闭**，
    //    而 run 根快照记 config.retry.maxAttempts: 0（看着像用户主动关的）；
    //  - baseDelayMs 变 undefined → backoffDelay 每次算出 NaN，退避失效、trace 里
    //    `llm.retry.delayMs` 记 NaN。
    // 注意：`exactOptionalPropertyTypes` 之后这种字面量**已经编译不过**（这正是那个开关
    // 带来的第一道防线）。这里用 cast 模拟第二道：调用方从 JSON / 动态 spread 拼出来的
    // 配置带显式 undefined 时，`definedOnly` 必须仍然兜住（运行时防线不能省）。
    const r = resolveRetry({
      maxAttempts: undefined,
      baseDelayMs: undefined,
      maxDelayMs: undefined,
      jitter: undefined,
    } as unknown as RetryOptions);
    assert.ok(r, '不得被静默关闭');
    assert.equal(r.maxAttempts, DEFAULT_RETRY.maxAttempts);
    assert.equal(r.baseDelayMs, DEFAULT_RETRY.baseDelayMs);
    assert.equal(r.maxDelayMs, DEFAULT_RETRY.maxDelayMs);
    assert.equal(r.jitter, DEFAULT_RETRY.jitter);
    // 退避算得出来（NaN 会从这里冒出来）
    assert.equal(backoffDelay(2, { ...r, jitter: 0 }), DEFAULT_RETRY.baseDelayMs * 2);

    // 混合：显式 undefined 只回落到缺省，不牵连同一对象里的真实值
    const mixed = resolveRetry({
      maxAttempts: undefined,
      baseDelayMs: 10,
    } as unknown as RetryOptions)!;
    assert.equal(mixed.maxAttempts, DEFAULT_RETRY.maxAttempts);
    assert.equal(mixed.baseDelayMs, 10);
  });

  it('缺省 isRetryable 走 classifyError：429 可重试、普通错误不可', () => {
    const r = resolveRetry(undefined)!;
    // 鸭子类型分类：任何带数值 status=429 的错误都可重试（不限于 SDK 错误类）
    assert.equal(r.isRetryable(Object.assign(new Error('x'), { status: 429 })), true);
    assert.equal(r.isRetryable(new Error('boom')), false);
    assert.equal(classifyError(new Error('boom')).retryable, false);
    // 超时可重试（2026-09-17 起走 type:'timeout'，此前走 connection —— retryable 一直是 true）
    assert.equal(r.isRetryable(new DOMException('x', 'TimeoutError')), true);
    assert.equal(r.isRetryable(Object.assign(new Error('x'), { code: 'timeout' })), true);
  });
});

describe('backoffDelay（指数 + 上限 + 抖动）', () => {
  const base = {
    ...DEFAULT_RETRY,
    maxAttempts: 5,
    jitter: 0,
    isRetryable: () => true,
    onRetry: () => {},
  };

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
    await sleep(30);
    // 下界留 10ms 余量（同 drain-gate / task-waiters 的处理）：定时器按单调时钟到点，
    // 而这里用 `Date.now()` 量（整毫秒、截断）——实测 25ms 的定时器有 ~1% 读数落在 24ms。
    assert.ok(Date.now() - t0 >= 20);
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
    await assert.rejects(
      sleep(5000, ac.signal),
      (e: unknown) => (e as Error).name === 'AbortError',
    );
  });
});

describe('retryAllowed —— 重试闸（从 streamTurn 的行内合取抽出）', () => {
  /** 夹具：只需 maxAttempts 与 isRetryable 两个字段，其余（退避配置）不参与本判定 */
  const cfg = { maxAttempts: 3, isRetryable: (e: unknown) => e === 'retryable' } as never;

  it('四项全满足 ⇒ 允许重试', () => {
    assert.equal(retryAllowed(cfg, 1, 'retryable', false), true);
  });

  it('重试关闭（cfg 为 null）⇒ 一律不重试', () => {
    assert.equal(retryAllowed(null, 1, 'retryable', false), false);
  });

  it('次数未尽：attempt 严格小于 maxAttempts（到顶那次不重试）', () => {
    assert.equal(
      retryAllowed(cfg, 2, 'retryable', false),
      true,
      'maxAttempts=3 时第 2 次失败仍可重试',
    );
    assert.equal(retryAllowed(cfg, 3, 'retryable', false), false, '第 3 次失败已到顶');
  });

  it('错误判定为不可重试 ⇒ 不重试（即使次数还有余量）', () => {
    assert.equal(retryAllowed(cfg, 1, 'fatal', false), false);
    assert.equal(retryAllowed(cfg, 1, new Error('x'), false), false);
  });

  it('**已吐出文本 ⇒ 一律不重试**（重复输出护栏：吐出去的字收不回来）', () => {
    assert.equal(retryAllowed(cfg, 1, 'retryable', true), false, '这一条压过其余三项');
  });
});
