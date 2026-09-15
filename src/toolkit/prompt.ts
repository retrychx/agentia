import {
  assertMethodTarget,
  scanDecoratedMethods,
  capabilityName,
  isScannableInstance,
} from './collect.js';
import type { CapabilityDecoratorContext } from './collect.js';
import type { AgentTool, JsonSchema } from '../core/tool.js';

/**
 * Agentia —— Prompt 能力（spec §3：纯文本资产 —— 模板/宏/playbook，被选中时注入上下文）。
 *
 * 运行时本质：把 prompt 编译成主 agent 菜单里一个**无副作用拉取型 AgentTool** ——
 * 模型判定“这活儿需要该资产”时调用它，返回文本以 tool_result 进上下文。这是
 * 我们现成唯一的“被选中”机制（capability 本身不跑循环、不调模型）。
 *
 * 声明形态（标准装饰器下字段装饰器拿不到值/类引用，故只支持方法形态，与
 * spec §4 草图的 `static brand = '…'` 用 `static method` 同效表达）：
 * - 实例方法：`@Prompt({ description }) asset()` 返回 string —— 每次调用重新执行 → volatile 资产新鲜；
 * - 静态方法：`@Prompt({ description }) static brand()` 返回常量 string —— 纯静态资产。
 * 方法可带一个入参（spec.schema 声明）做模板化。
 */
export interface PromptSpec {
  /** 菜单名（缺省取被装饰方法名，建议 snake_case） */
  name?: string;
  /** 何时该拉取该资产的指引（模型据此决定调用） */
  description: string;
  /** 模板化入参 schema；缺省空对象（无参资产） */
  schema?: JsonSchema;
}

const promptSpecs = new WeakMap<Function, PromptSpec>();

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** 方法装饰器（实例或 static 均可）：登记 prompt spec。返回值 = 资产文本。 */
export function Prompt(spec: PromptSpec) {
  return (value: Function, context: CapabilityDecoratorContext): void => {
    assertMethodTarget(context, '@Prompt');
    promptSpecs.set(value, spec);
  };
}

/**
 * 收集容器实例（+ 其类上的静态方法）里所有 @Prompt，产出 AgentTool[]。
 * 实例方法沿原型链（含继承）；静态方法同样沿构造函数原型链（含继承的父类静态 @Prompt）。
 */
export function collectPrompts(instance: object): AgentTool[] {
  const tools: AgentTool[] = [];
  // null/undefined/原始值 provider（useValue 合法形态）：无装饰器能力可收，空结果
  if (!isScannableInstance(instance)) return tools;
  // 传 key 而非捕获的 fn：子类「未装饰地 override」时 spec 继承自父类，
  // 但实现必须取**实例/类上**的（否则会绕开子类实现，与 @Tool 语义不一致）。
  const pushTool = (
    name: string,
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    spec: PromptSpec,
  ): void => {
    tools.push({
      name: spec.name ?? name,
      description: spec.description,
      inputSchema: spec.schema ?? EMPTY_SCHEMA,
      run: (input: unknown) => Reflect.apply(target[key] as Function, target, [input]),
    });
  };

  // 实例方法（沿原型链）
  const found = scanDecoratedMethods(instance, promptSpecs);
  const inst = instance as Record<string | symbol, unknown>;
  for (const { key, spec } of found) {
    pushTool(capabilityName(spec, key, '@Prompt'), inst, key, spec);
  }

  // 静态方法：沿构造函数原型链（含父类静态 @Prompt），Reflect.ownKeys 含 symbol key。
  // target 取**最外层**构造函数：子类「未装饰地 override」静态方法时调用走子类实现
  //（与实例侧 override 语义一致）；只看自身属性会把父类静态资产静默丢掉。
  const seen = new Set<string | symbol>(found.map((f) => f.key));
  const root: unknown = (instance as { constructor?: unknown }).constructor;
  let ctor = root;
  while (typeof ctor === 'function' && ctor !== Function.prototype) {
    const rec = ctor as unknown as Record<string | symbol, unknown>;
    for (const key of Reflect.ownKeys(rec)) {
      if (seen.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(rec, key);
      if (!desc || typeof desc.value !== 'function') continue;
      const spec = promptSpecs.get(desc.value as Function);
      if (!spec) continue; // 未装饰的 override 不标 seen，父类静态 spec 继续生效
      seen.add(key);
      pushTool(
        capabilityName(spec, key, '@Prompt'),
        root as Record<string | symbol, unknown>,
        key,
        spec,
      );
    }
    ctor = Object.getPrototypeOf(ctor);
  }
  return tools;
}
