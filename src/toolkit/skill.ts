import { assertMethodTarget, scanDecoratedMethods, unitName } from './collect.js';
import type { UnitDecoratorContext } from './collect.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, JsonSchema, ToolRunContext } from '../core/tool.js';
import type { SpanError } from '../core/trace.js';
import type { AgentStopReason } from '../engine/types.js';
import { isSuccessStopReason } from '../engine/types.js';
import { runAgentScoped } from '../engine/loop.js';
import { classifyError } from '../engine/errors.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';

/**
 * Agentia —— Skill 单元（spec §3：指令 + 脚本，受限子运行，回产物/结论）。
 *
 * 与 @SubAgent 的可感知区别：
 * - 子 agent = **模型自主循环**：你只给 role/任务/工具，走几步、何时停由模型决定；
 * - Skill     = **代码控制的流程**：方法体是确定性脚本，把“要不要调模型、调几次、
 *   拿结果怎么算”写死在代码里 —— 模型调用只在你显式 `ctx.llm()` 时发生（受限子运行），
 *   每次都在 skill 自己的 `unit` span 下开 llm.turn 记账，中间结果可继续加工，
 *   方法返回值即产物/结论，以 tool_result 交回主 agent。
 *
 * trace：skill = 主 trace 里一个 `unit` span（attribute `skill`），内部 ctx.llm() 的
 * llm.turn 递归成它的子孙 —— 与 @SubAgent 同款 parentSpanId 传播，不双开 run 根。
 */
export interface SkillSpec {
  /** 菜单名（缺省取被装饰方法名，建议 snake_case） */
  name?: string;
  description: string;
  /** 主 agent 填给 skill 的结构化入参 schema；缺省空对象（无入参） */
  schema?: JsonSchema;
  /** ctx.llm() 缺省模型；不给走 engine 缺省（AGENTIA_MODEL / claude-opus-5） */
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  /** skill 内 ctx.llm() 可调工具：容器 provider token 列表（复用其 @Tool 菜单） */
  tools?: string[];
}

export interface SkillLlmOptions {
  /** 二选一：直接给 prompt（包成单条 user），或给完整 messages */
  prompt?: string;
  messages?: Anthropic.MessageParam[];
  /** 本次受限子运行的系统提示；SystemPrompt 实例自动打缓存 breakpoint */
  system?: string | SystemPrompt;
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
}

export interface SkillLlmResult {
  /** 子运行最终文本 */
  text: string;
  stopReason: AgentStopReason;
}

/** 方法体收到的运行句柄：只暴露“受限模型调用”，其余脚本逻辑由作者代码控制。 */
export interface SkillContext {
  /** 本次 skill 的缺省模型（spec.model 或 undefined → engine 缺省） */
  readonly model?: string;
  /** 受限子运行：每次调用在 skill unit span 下开一轮独立 agent 循环（无工具则纯文本）。 */
  llm(opts: SkillLlmOptions): Promise<SkillLlmResult>;
}

export interface SkillUnit {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  spec: SkillSpec;
  /** 内部：绑定 instance 的方法执行器（装饰时拿到 this，供 skillToTool 调用） */
  invoke: (input: unknown, skillCtx: SkillContext) => unknown | Promise<unknown>;
}

/** 方法函数 → spec（与 @Tool 同款 WeakMap 注册表，零反射） */
const skillSpecs = new WeakMap<Function, SkillSpec>();

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** 方法装饰器：登记 skill spec。被装饰方法体由运行时以 (input, skillCtx) 调用。 */
export function Skill(spec: SkillSpec) {
  return function (value: Function, context: UnitDecoratorContext): void {
    assertMethodTarget(context, '@Skill');
    skillSpecs.set(value, spec);
  };
}

/** 把容器实例上所有 @Skill 方法收集成 SkillUnit[]（沿原型链）。 */
export function collectSkills(instance: object): SkillUnit[] {
  // 动态查表而非捕获 fn：子类「未装饰地 override」时 spec 继承自父类，
  // 实现必须取实例上的（与 @Tool 的 run 同款），否则子类 override 被静默绕过。
  const inst = instance as Record<string | symbol, unknown>;
  return scanDecoratedMethods(instance, skillSpecs).map(({ key, spec }) => ({
    name: unitName(spec, key, '@Skill'),
    description: spec.description,
    inputSchema: spec.schema ?? EMPTY_SCHEMA,
    spec,
    invoke: (input: unknown, skillCtx: SkillContext) =>
      Reflect.apply(inst[key] as Function, instance, [input, skillCtx]),
  }));
}

/**
 * 把 SkillUnit 变成主 agent 菜单里的 AgentTool。
 * run(input, ctx) 需要 ToolRunContext（engine 调用时必有）；手动直调会抛错提示。
 * 开 `unit` span → 构造 SkillContext（llm 闭包挂 unit 下）→ 执行方法体 →
 * 返回值字符串化交回；抛错关 unit error 后重抛（引擎包成 is_error，不中断 run）。
 */
export function skillToTool(
  unit: SkillUnit,
  resolveTools: () => AgentTool[],
): AgentTool {
  const { name, spec } = unit;
  return {
    name,
    description: spec.description,
    inputSchema: unit.inputSchema,
    run: async (input: unknown, ctx?: ToolRunContext): Promise<unknown> => {
      if (!ctx) {
        throw new Error(
          `skill "${name}" 只能在主 agent 运行中被调用（engine 会注入 ToolRunContext）`,
        );
      }
      const recorder = ctx.recorder;
      const unitId = recorder.begin('unit', name, ctx.parentSpanId);
      recorder.setAttribute(unitId, 'skill', name);
      let closed = false;
      const close = (patch: { status: 'ok' | 'error'; error?: SpanError }): void => {
        if (closed) return;
        closed = true;
        recorder.end(unitId, patch);
      };

      const skillCtx: SkillContext = {
        model: spec.model,
        llm: async (opts) => {
          const messages =
            opts.prompt != null
              ? [{ role: 'user' as const, content: opts.prompt }]
              : (opts.messages ?? []);
          if (messages.length === 0) {
            throw new Error(`skill "${name}".llm 需要 prompt 或 messages`);
          }
          const system =
            opts.system instanceof SystemPrompt
              ? opts.system.build({ cache: true })
              : opts.system;
          const loop = await runAgentScoped({
            client: ctx.client,
            model: opts.model ?? spec.model,
            maxTokens: opts.maxTokens ?? spec.maxTokens,
            maxIterations: opts.maxIterations ?? spec.maxIterations,
            system,
            messages,
            tools: spec.tools?.length ? resolveTools() : [],
            recorder,
            parentSpanId: unitId,
            signal: ctx.signal,
          });
          if (!isSuccessStopReason(loop.stopReason)) {
            const report = `skill "${name}".llm ${loop.stopReason}: ${
              (loop.finalText || loop.error?.message || '').slice(0, 2000)
            }`;
            const error: SpanError = loop.error ?? {
              type: 'agent_error',
              message: report,
              retryable: true,
            };
            // 先把丰富错误挂到 unit span（loop.error 的 type/retryable 比新造的
            // Error 信息量大），再抛出走外层 catch 的通用收尾 —— 外层 close 幂等，
            // 不会覆盖这里写的 error（与 subagent.ts 同款）。
            close({ status: 'error', error });
            throw new Error(report);
          }
          return { text: loop.finalText, stopReason: loop.stopReason };
        },
      };

      try {
        const out = await unit.invoke(input ?? {}, skillCtx);
        close({ status: 'ok' });
        return out;
      } catch (e) {
        close({ status: 'error', error: classifyError(e) });
        throw e;
      }
    },
  };
}
