import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema } from '../../src/index.js';
import type { JsonSchema } from '../../src/index.js';

const person: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    addr: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  required: ['name'],
  additionalProperties: false,
};

describe('validateJsonSchema（运行时输入校验）', () => {
  it('合法输入返回 null', () => {
    assert.equal(validateJsonSchema(person, { name: 'a' }), null);
    assert.equal(
      validateJsonSchema(person, { name: 'a', age: 3, tags: ['x'], addr: { city: 'sh' } }),
      null,
    );
  });

  it('缺必需属性 / 类型不符 / 未声明属性', () => {
    assert.match(validateJsonSchema(person, {})!, /缺少必需属性 "name"/);
    assert.match(validateJsonSchema(person, { name: 1 })!, /\$\.name: 期望 string/);
    assert.match(validateJsonSchema(person, { name: 'a', x: 1 })!, /未声明的属性 "x"/);
    assert.match(validateJsonSchema(person, { name: 'a', age: 1.5 })!, /\$\.age: 期望 integer/);
  });

  it('原型链键不算数：required 的 constructor 不被放行、additionalProperties:false 拦住 toString', () => {
    // `key in obj` 会命中 Object.prototype —— required:['constructor'] 对 {} 恒通过、
    // additionalProperties:false 时自有 toString 键被当成「已声明」放行；必须用 hasOwn。
    const s: JsonSchema = { type: 'object', properties: {}, required: ['constructor'] };
    assert.match(
      validateJsonSchema(s, {})!,
      /缺少必需属性 "constructor"/,
      '原型链上的 constructor 不算「提供了该属性」',
    );
    assert.match(
      validateJsonSchema(person, { name: 'a', toString: 1 })!,
      /未声明的属性 "toString"/,
      '自有 toString 键不得借原型链混入 properties 被放行',
    );
    // 正向：自有的合法属性不受影响
    assert.equal(validateJsonSchema(person, { name: 'a' }), null);
  });

  it('嵌套对象与数组元素给出路径', () => {
    assert.match(
      validateJsonSchema(person, { name: 'a', addr: {} })!,
      /\$\.addr: 缺少必需属性 "city"/,
    );
    assert.match(
      validateJsonSchema(person, { name: 'a', tags: ['x', 1] })!,
      /\$\.tags\[1\]: 期望 string/,
    );
  });

  it('enum 校验（含对象深比较）', () => {
    const s: JsonSchema = { type: 'object', enum: [{ a: 1 }, { b: [2] }] };
    assert.equal(validateJsonSchema(s, { b: [2] }), null);
    assert.match(validateJsonSchema(s, { a: 2 })!, /enum/);
  });

  it('未覆盖的关键字放行（护栏不是完整校验器）', () => {
    assert.equal(validateJsonSchema({ type: 'string', minLength: 100 } as never, 'x'), null);
    assert.equal(validateJsonSchema({ type: 'unknown-type' } as never, 1), null);
  });

  it('null / boolean / number 类型', () => {
    assert.equal(validateJsonSchema({ type: 'null' }, null), null);
    assert.match(validateJsonSchema({ type: 'null' }, 0)!, /期望 null/);
    assert.match(validateJsonSchema({ type: 'boolean' }, 0)!, /期望 boolean/);
    assert.match(validateJsonSchema({ type: 'number' }, Number.NaN)!, /期望 number/);
  });
});
