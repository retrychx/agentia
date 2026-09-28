import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema } from '../../src/core/schema.js';
import type { JsonSchema } from '../../src/core/tool.js';

/**
 * **自引用 / 深 schema 的两道护栏**（2026-09-28 外部深评 C6）。
 *
 * 病根：`check()` 按 properties / items 递归 ⇒ 环 + 深值钻到 V8 的
 * `RangeError: Maximum call stack size exceeded`，而那个症状**看不出是 schema 有环**。
 * 两道闸各管一头：
 * ① `assertNoSchemaCycle()`：**前置**抓环，与值深度无关（环 + 浅值也报）——点名路径；
 * ② `MAX_SCHEMA_DEPTH`：兜「合法但深到失控」（手搓几千层才够的那种事故输入）。
 * 本文件的 `it` 里各有一条**不误伤**的阳性对照：60 层合法深度照常校验、共享子树（DAG）不算环。
 */
describe('schema 环 / 深度的两道护栏（C6）', () => {
  it('自引用 schema + **浅值** ⇒ 前置检测报环（点路径），不是等栈溢出', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;

    let caught: unknown;
    try {
      // ⚠️ 值是浅的（只有三层）：靠深度闸抓不到它 —— 递归深度 = min(schema 深度, 值深度)
      validateJsonSchema(cyclic as unknown as JsonSchema, { self: { self: {} } });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, '必须抛出来（不是静默放行）');
    assert.ok(!(caught instanceof RangeError), '不能是栈溢出的 RangeError —— 那正是要替掉的症状');
    assert.match((caught as Error).message, /环|循环引用/, '文案要点名「有环」');
    assert.match(
      (caught as Error).message,
      /\$\.properties\.self/,
      '文案给出路径，便于定位是哪一段自引用',
    );
  });

  it('阳性对照：共享子树（DAG）不是环 —— 同一棵子 schema 被两处引用必须照常通过', () => {
    const shared: JsonSchema = { type: 'string' };
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: shared, b: shared },
      required: ['a', 'b'],
    };
    assert.equal(validateJsonSchema(schema, { a: 'x', b: 'y' }), null, 'DAG 不该被误判成环');
    assert.ok(validateJsonSchema(schema, { a: 1, b: 'y' })?.includes('期望 string'));
  });

  it('阳性对照：合法但深的 schema（60 层）照常校验 —— 护栏不误伤', () => {
    let schema: JsonSchema = { type: 'string' };
    for (let i = 0; i < 60; i++) {
      schema = { type: 'object', properties: { next: schema }, required: ['next'] };
    }
    let value: unknown = 'leaf';
    for (let i = 0; i < 60; i++) value = { next: value };
    assert.equal(validateJsonSchema(schema, value), null, '60 层合法深度必须通过');

    // 同一棵 schema，值错在最深处 ⇒ 错误带完整路径（证明它真的走到底了）
    let inner: unknown = 123;
    for (let i = 0; i < 59; i++) inner = { next: inner };
    const err = validateJsonSchema(schema, inner);
    // 走到第 60 层才撞上类型不符 ⇒ 错误路径必须一路铺到底（才证明护栏走完全程、不是提前放行）
    assert.ok(err !== null, '深层类型不符必须报错');
    assert.ok(
      (err.match(/\.next/g) ?? []).length >= 55,
      `错误路径要铺到底（得到 ${String(err).slice(0, 80)}…）`,
    );
    assert.match(err, /期望 object|期望 string/, '文案仍是常规校验文案（护栏不改变报错口径）');
  });

  it('深度背板：递归超过上限 ⇒ 具名报错（不是 RangeError）', () => {
    // 手搓 300 层（合法、无环）：深度闸在这里兜住，不放到 V8 的栈上去
    let schema: JsonSchema = { type: 'string' };
    for (let i = 0; i < 300; i++) schema = { type: 'object', properties: { next: schema } };
    let value: unknown = 'leaf';
    for (let i = 0; i < 300; i++) value = { next: value };
    let caught: unknown;
    try {
      validateJsonSchema(schema, value);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error && !(caught instanceof RangeError));
    assert.match((caught as Error).message, /递归超过 256 层/, '点名上限');
  });
});
