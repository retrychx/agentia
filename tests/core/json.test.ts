import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stringifySafe, truncateWithMark } from '../../src/core/json.js';

/**
 * core/json.ts 的两个 helper —— 此前**没有任何测试**（审计发现）。
 *
 * 它们是热点路径上的东西：engine/loop 用它把工具出入参写进 trace（`limit()`）、
 * engine/replay 用它渲染回放文本、core/schema 用它拼校验错误消息。两者都**刻意
 * 不进公共导出面**（内部 helper），所以官网 API 页没有它们 —— 但内部 helper 不等于
 * 可以不测，尤其是 `stringifySafe` 存在的意义就是「JSON.stringify 会抛的那些值」。
 */
describe('core/json：stringifySafe', () => {
  it('string 原样返回（不再包一层引号）', () => {
    assert.equal(stringifySafe('abc'), 'abc');
    assert.equal(stringifySafe(''), '');
  });

  it('其余值走 JSON.stringify', () => {
    assert.equal(stringifySafe({ a: 1 }), '{"a":1}');
    assert.equal(stringifySafe([1, 2]), '[1,2]');
    assert.equal(stringifySafe(42), '42');
    assert.equal(stringifySafe(true), 'true');
    assert.equal(stringifySafe(null), 'null');
  });

  it('JSON.stringify 返回 undefined 的值 → 回落 String()', () => {
    // JSON.stringify(undefined) 返回的是 undefined（不是字符串），故走 ?? 兜底
    assert.equal(stringifySafe(undefined), 'undefined');
    // Symbol 同理：JSON.stringify(Symbol) 返回 undefined → 回落 String(Symbol)
    assert.equal(stringifySafe(Symbol('s')), 'Symbol(s)');
    // 函数：只断言「返字符串且不抛」—— 函数源码文本随转译器（tsx/esbuild）而异，写死会脆
    assert.equal(typeof stringifySafe(() => 1), 'string');
  });

  it('循环引用不抛错（这正是它存在的理由）', () => {
    const o: Record<string, unknown> = { name: 'x' };
    o.self = o;
    assert.doesNotThrow(() => stringifySafe(o));
    assert.equal(stringifySafe(o), '[object Object]');
  });

  it('BigInt 不抛错（JSON.stringify 对 BigInt 会 TypeError）', () => {
    assert.doesNotThrow(() => stringifySafe(1n));
    assert.equal(stringifySafe(1n), '1');
  });
});

describe('core/json：truncateWithMark', () => {
  it('未超长原样返回（边界：长度恰好等于上限不算超）', () => {
    assert.equal(truncateWithMark('abc', 3), 'abc');
    assert.equal(truncateWithMark('ab', 3), 'ab');
    assert.equal(truncateWithMark('', 0), '');
  });

  it('超长截断并标注省去的字符数', () => {
    assert.equal(truncateWithMark('abcdef', 3), 'abc…(+3)');
    assert.equal(truncateWithMark('abcd', 3), 'abc…(+1)');
  });

  it('省略标记的格式是「…(+N)」（engine/loop 与 engine/replay 共用同一格式）', () => {
    assert.match(truncateWithMark('x'.repeat(100), 10), /^x{10}…\(\+90\)$/);
  });
});
