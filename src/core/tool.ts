/**
 * Agentia —— 工具定义。
 * Turn 0：v1 用裸 JSON Schema，不引 zod；装饰器 → schema 在 Turn 2 接入。
 */

/** JSON Schema 对象子集，供工具的 input_schema */
export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface AgentTool<I = unknown, O = unknown> {
  /** 模型可见的唯一名（建议 snake_case） */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 开启严格参数校验（schema 需 additionalProperties:false + required） */
  strict?: boolean;
  /** 执行体。抛错会被包成 is_error 的 tool_result 回给模型，不中断 run */
  run: (input: I) => Promise<O> | O;
}
