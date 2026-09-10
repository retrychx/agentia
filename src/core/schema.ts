import type { JsonSchema } from './tool.js';
import { stringifySafe } from './json.js';

/**
 * Agentia —— 最小 JSON Schema 校验子集（v1 裸 JSON Schema；zod 为可选外挂，
 * 见 toolkit/zod.ts —— schema 上挂 __zodValidate 时先走它，core 本身不依赖 zod）。
 *
 * 用途：engine 在执行 tool.run 前校验模型给出的结构化 input；校验失败直接回
 * is_error 的 tool_result（错误信息含路径，模型可自我修正），不进方法体。
 *
 * 覆盖子集：type（object/array/string/number/integer/boolean/null）、
 * properties、required、additionalProperties:false、enum、items。
 * 未覆盖的关键字（format/minimum/oneOf 等）一律放行 —— 护栏不是完整校验器。
 *
 * @returns 人类可读的错误描述（含路径）；合法返回 null。
 */
export function validateJsonSchema(schema: JsonSchema, input: unknown): string | null {
  // zod 可选接入（toolkit/zod.ts 的 fromZod 挂的隐藏字段）：存在则先走 zod 校验，
  // 失败即回「$.: <首条错误>」（含 zod 路径）；通过后再叠加 JSON Schema 子集校验。
  const zv = (schema as Record<string, unknown>).__zodValidate;
  if (typeof zv === 'function') {
    const err = (zv as (input: unknown) => string | null)(input);
    if (err) return `$.: ${err}`;
  }
  return check(schema, input, '$');
}

function check(schema: JsonSchema, value: unknown, path: string): string | null {
  const en = schema.enum;
  if (Array.isArray(en) && !en.some((v) => deepEqual(v, value))) {
    return `${path}: 值不在 enum 允许范围内（得到 ${preview(value)}）`;
  }

  switch (schema.type) {
    case 'object':
      return checkObject(schema, value, path);
    case 'array':
      return checkArray(schema, value, path);
    case 'string':
      return typeof value === 'string' ? null : `${path}: 期望 string，得到 ${typeOf(value)}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${path}: 期望 number，得到 ${typeOf(value)}`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${path}: 期望 integer，得到 ${typeOf(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: 期望 boolean，得到 ${typeOf(value)}`;
    case 'null':
      return value === null ? null : `${path}: 期望 null，得到 ${typeOf(value)}`;
    default:
      return null; // 未声明/未覆盖的 type 放行
  }
}

function checkObject(schema: JsonSchema, value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${path}: 期望 object，得到 ${typeOf(value)}`;
  }
  const obj = value as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (!(key in obj)) return `${path}: 缺少必需属性 "${key}"`;
  }

  const properties = schema.properties ?? {};
  for (const [key, sub] of Object.entries(properties)) {
    if (key in obj) {
      const err = check(sub, obj[key], `${path}.${key}`);
      if (err) return err;
    }
  }

  if (schema.additionalProperties === false) {
    const extra = Object.keys(obj).filter((k) => !(k in properties));
    if (extra.length > 0) {
      return `${path}: 存在 schema 未声明的属性 ${extra.map((k) => `"${k}"`).join(', ')}`;
    }
  }
  return null;
}

function checkArray(schema: JsonSchema, value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path}: 期望 array，得到 ${typeOf(value)}`;
  const items = schema.items;
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    for (let i = 0; i < value.length; i++) {
      const err = check(items as JsonSchema, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function preview(value: unknown): string {
  const s = stringifySafe(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}
