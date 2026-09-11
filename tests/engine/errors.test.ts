import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { classifyError, isAbortError } from '../../src/index.js';

const headers = () => new Headers();

describe('classifyError（异常分类 → SpanError）', () => {
  it('RateLimitError → rate_limit / retryable', () => {
    const e = new Anthropic.RateLimitError(429, undefined, 'slow down', headers());
    const span = classifyError(e);
    assert.equal(span.type, 'rate_limit');
    assert.equal(span.retryable, true);
    assert.equal(span.message, e.message, 'message 原样透传（SDK 会拼入 status 前缀）');
  });

  it('AbortError → aborted / 不可重试（中断不是可重试故障）', () => {
    const dom = new DOMException('The operation was aborted', 'AbortError');
    assert.equal(isAbortError(dom), true);
    assert.deepEqual(classifyError(dom), { type: 'aborted', message: 'run 已被取消', retryable: false });

    const plain = Object.assign(new Error('x'), { name: 'AbortError' });
    assert.equal(isAbortError(plain), true, '普通 Error 靠 name 也能识别');

    assert.equal(isAbortError(new Error('普通错误')), false);
  });

  it('APIConnectionError（含 Timeout 子类）→ connection / retryable', () => {
    const conn = new Anthropic.APIConnectionError({ message: 'conn fail' });
    assert.deepEqual(classifyError(conn), {
      type: 'connection',
      message: 'conn fail',
      retryable: true,
    });

    const timeout = new Anthropic.APIConnectionTimeoutError({ message: 'timed out' });
    const span = classifyError(timeout);
    assert.equal(span.type, 'connection', 'Timeout 子类走同一分支');
    assert.equal(span.retryable, true);
  });

  it('InternalServerError → server / retryable', () => {
    const e = new Anthropic.InternalServerError(500, undefined, 'boom', headers());
    const span = classifyError(e);
    assert.equal(span.type, 'server');
    assert.equal(span.retryable, true);
    assert.equal(span.message, e.message);
  });

  it('通用 APIError：retryable 只看 status（>=500 或 429）', () => {
    const cases: Array<[number | undefined, boolean]> = [
      [400, false],
      [401, false],
      [404, false],
      [429, true],
      [500, true],
      [503, true],
      [undefined, false], // status 缺省按 0 处理
    ];
    for (const [status, retryable] of cases) {
      const e = new Anthropic.APIError(status as never, undefined, `s=${status}`, headers());
      const span = classifyError(e);
      assert.equal(span.type, 'api', `status=${status}`);
      assert.equal(span.retryable, retryable, `status=${status}`);
      assert.equal(span.message, e.message, 'message 透传');
    }
  });

  it('4xx 类型化子类（BadRequest 等）落到通用 api 分支且不可重试', () => {
    const e = new Anthropic.BadRequestError(400, undefined, 'bad', headers());
    const span = classifyError(e);
    assert.equal(span.type, 'api');
    assert.equal(span.retryable, false);
  });

  it('普通 Error → unknown / 不可重试，message 保留', () => {
    assert.deepEqual(classifyError(new Error('plain')), {
      type: 'unknown',
      message: 'plain',
      retryable: false,
    });
    assert.deepEqual(classifyError(new TypeError('bad type')), {
      type: 'unknown',
      message: 'bad type',
      retryable: false,
    });
  });

  it('非 Error 值 → String(e) 兜底', () => {
    assert.deepEqual(classifyError('boom'), {
      type: 'unknown',
      message: 'boom',
      retryable: false,
    });
    assert.equal(classifyError(42).message, '42');
    assert.equal(classifyError(null).message, 'null');
    assert.equal(classifyError(undefined).message, 'undefined');
    assert.equal(classifyError({ a: 1 }).message, '[object Object]');
  });
});
