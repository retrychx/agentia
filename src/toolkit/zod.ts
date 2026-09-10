import type { JsonSchema } from '../core/tool.js';

/**
 * Agentia —— zod 可选接入（R2，duck-typed，框架永不 import zod）。
 *
 * zod 是用户的 peer 依赖：开发者自己 `npm i zod`，用 zod 生成 JSON Schema，
 * 再把 zod schema 本体交给 fromZod 挂上运行时校验。框架只认 safeParse 结构面，
 * zod v3/v4 或其他同形校验库（valibot/arktype 适配后）均可用。
 *
 * 用法：
 * ```ts
 * import { z } from 'zod';
 * const Weather = z.object({ city: z.string(), days: z.number().int().min(1).max(7) });
 *
 * class WeatherTools {
 *   @Tool({
 *     description: '查天气',
 *     schema: fromZod(z.toJSONSchema(Weather) as JsonSchema, Weather),
 *   })
 *   get(input: { city: string; days: number }) { ... }
 * }
 * ```
 *
 * @param jsonSchema 由 zod 推导的 JSON Schema（发给模型 / 走 JSON Schema 子集校验）
 * @param zod zod schema 本体（只需带 safeParse），其校验结果优先于 JSON Schema 子集
 */
export function fromZod(jsonSchema: JsonSchema, zod: unknown): JsonSchema {
  const zp = zod as {
    safeParse?: (input: unknown) => {
      success: boolean;
      error?: { issues?: Array<{ path?: PropertyKey[]; message?: string }> };
    };
  };
  if (typeof zp?.safeParse !== 'function') {
    throw new Error('fromZod：第二参需为带 safeParse 的 zod schema（框架不 import zod，靠结构面识别）');
  }
  // 挂到隐藏字段：发给 API 时 JSON 序列化自动丢弃函数，不污染 input_schema
  return {
    ...jsonSchema,
    __zodValidate: (input: unknown): string | null => {
      const r = zp.safeParse!(input);
      if (r.success) return null;
      const issue = r.error?.issues?.[0];
      if (!issue) return 'zod 校验失败';
      const path = (issue.path ?? []).map(String).join('.');
      return path ? `${path}: ${issue.message}` : (issue.message ?? 'zod 校验失败');
    },
  };
}
