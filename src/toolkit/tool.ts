import type { AgentTool, JsonSchema } from '../core/tool.js';
import { scanDecoratedMethods, unitName } from './collect.js';

/**
 * Agentia —— 声明式工具层（spec §4：标准装饰器 + 显式 DI，无 param 反射）。
 *
 * `@Tool({ description, schema })` 方法装饰器 —— 把类方法变成
 * 主 agent 可调的 AgentTool。方法签名固定为单参数：模型按 input_schema
 * 解析出的结构化入参（JSON Schema 由开发者在 spec 里显式给出，不靠反射猜）。
 * 装饰器只把「方法 → spec」登记到 WeakMap；真正的 AgentTool 由
 * `collectTools(instance)` 对已解析的容器实例扫描生成（此时才拿到 this）。
 *
 * 装饰器不含副作用、不依赖 TS 编译产物细节，用标准 (value, context) 语义，
 * 与 tsgo/esbuild 均兼容。当前 run 作用域经 AsyncLocalStorage 传播，
 * 方法体内可随时 `RunContext.current()` 读 blackboard/runId。
 */
export interface ToolSpec {
  /** 模型可见工具名；缺省取被装饰方法名 */
  name?: string;
  description: string;
  /** input_schema：v1 用裸 JSON Schema（对应 engine/core 的 JsonSchema） */
  schema: JsonSchema;
  /** strict 参数校验：需 additionalProperties:false + required 齐全 */
  strict?: boolean;
}

/** 方法函数 → spec。WeakMap 不阻碍 GC，也不要求 globalThis 注册表。 */
const toolSpecs = new WeakMap<Function, ToolSpec>();

/**
 * 方法装饰器：登记 spec。被装饰方法入参即结构化 tool input，
 * 返回值（或 Promise）即 tool_result。抛错由 engine 包成 is_error，不中断 run。
 *
 * 泛型 <I, O> 可把方法签名与编译期类型绑定（`@Tool<{city:string}, string>({...})`），
 * 挡住签名笔误；缺省 any 保持宽松。schema 与 I 的一致性仍由开发者保证（已知边界）。
 */
export function Tool<I = any, O = any>(spec: ToolSpec) {
  return function (
    value: (input: I) => O | Promise<O>,
    context: { kind: string; name: string | symbol },
  ): void {
    if (context.kind !== 'method') {
      throw new Error(`@Tool 只能修饰类方法，收到 kind=${String(context.kind)}`);
    }
    toolSpecs.set(value, spec);
  };
}

/** 把容器实例上所有 @Tool 方法收集成 AgentTool[]（沿原型链，含继承的父类工具）。 */
export function collectTools(instance: object): AgentTool[] {
  return scanDecoratedMethods(instance, toolSpecs).map(({ key, spec }) =>
    buildTool(instance, key, spec),
  );
}

function buildTool(instance: object, key: string | symbol, spec: ToolSpec): AgentTool {
  return {
    name: unitName(spec, key, '@Tool'),
    description: spec.description,
    inputSchema: spec.schema,
    ...(spec.strict ? { strict: true } : {}),
    run: (input: unknown) =>
      Reflect.apply(
        (instance as Record<string | symbol, (...args: unknown[]) => unknown>)[key],
        instance,
        [input],
      ),
  };
}
