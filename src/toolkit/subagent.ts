import { assertMethodTarget, scanDecoratedMethods, unitName } from './collect.js';
import type { UnitDecoratorContext } from './collect.js';
import type { AgentTool, JsonSchema, ToolRunContext } from '../core/tool.js';
import type { SpanError } from '../core/trace.js';
import type { SystemParam, SystemTextBlock } from '../engine/types.js';
import { isSuccessStopReason } from '../engine/types.js';
import { runAgentScoped } from '../engine/loop.js';
import { classifyError } from '../engine/errors.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';

/**
 * Agentia —— 子 agent 单元（spec §3/§5：独立 agent 循环 + 裁剪上下文 + 隔离报告）。
 *
 * 语义（spec §5）：
 * - 子 agent = **完整独立循环**：自己的 system（role）、自己的工具、自己的 model；
 * - **裁剪上下文**：它只见「role + 主 agent 塞给它的任务」+ 自己声明的工具，
 *   主 agent 的对话历史完全不可见；
 * - **隔离报告**：它的中间往返全部不进主上下文，唯一回流主 agent 的是
 *   stop_reason=end_turn 的最终文本 —— 以 tool_result 交回（非 end_turn 则抛错 → is_error）。
 *
 * trace：子 agent 是主 trace 里的一个 `unit` span（挂在发起它的 llm.turn 下），
 * 其内部 llm.turn 递归成它的子孙 —— 见 engine/loop.ts 的 runAgentScoped。
 */
export interface SubAgentSpec {
  /** 菜单名（缺省取被装饰方法名，建议 snake_case） */
  name?: string;
  description: string;
  /** 主 agent 填给子 agent 的任务入参 schema */
  schema: JsonSchema;
  /**
   * 子 agent 自己的 system：
   * - string / SystemPrompt 实例 → 追加一行“最终输出即交回主 agent 的报告”提示；
   * - (task) => SystemParam | Promise<SystemParam> → 按任务动态拼，框架不附加（作者全权）。
   * 注意：这是裁剪上下文的源头 —— 只写子 agent 完成该任务所需的角色/约束。
   */
  system: string | SystemPrompt | ((task: Record<string, unknown>) => SystemParam | Promise<SystemParam>);
  /** 子 agent 可调工具：容器 provider token 列表（复用其 @Tool 菜单）；缺省 = 无工具纯文本 */
  tools?: string[];
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  /**
   * 子 agent 的结构化结果 schema（R6）：给出后子 agent 循环追加隐藏 submit_result 工具，
   * 校验通过的结果随最终报告一起交回主 agent —— tool_result 为
   * { report: 最终文本报告, result: 结构化结果 }（模型未提交则退化为纯文本报告，同不设时）。
   */
  resultSchema?: JsonSchema;
}

export interface SubAgentUnit {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  spec: SubAgentSpec;
}

/** 方法函数 → spec（与 @Tool 同款 WeakMap 注册表，零反射） */
const subAgentSpecs = new WeakMap<Function, SubAgentSpec>();

/** 方法装饰器：登记子 agent spec。被装饰方法体不执行 —— 运行时拉起独立循环。 */
export function SubAgent(spec: SubAgentSpec) {
  return function (value: Function, context: UnitDecoratorContext): void {
    assertMethodTarget(context, '@SubAgent');
    subAgentSpecs.set(value, spec);
  };
}

/** 把容器实例上所有 @SubAgent 方法收集成 SubAgentUnit[]（沿原型链）。 */
export function collectSubAgents(instance: object): SubAgentUnit[] {
  return scanDecoratedMethods(instance, subAgentSpecs).map(({ key, spec }) => ({
    name: unitName(spec, key, '@SubAgent'),
    description: spec.description,
    inputSchema: spec.schema,
    spec,
  }));
}

const REPORT_HINT =
  '（运行提示：你运行在独立上下文，全部中间过程不外传；你的最终回复将作为报告原样交回主 agent。）';

/** 按 spec.system 解析本轮子 agent 的 system。 */
async function resolveSubSystem(
  spec: SubAgentSpec['system'],
  task: Record<string, unknown>,
): Promise<SystemParam> {
  if (typeof spec === 'function') return spec(task);
  if (spec instanceof SystemPrompt) {
    const blocks = spec.build({ cache: true }) as SystemTextBlock[];
    return [...blocks, { type: 'text', text: REPORT_HINT }];
  }
  return `${spec}\n\n${REPORT_HINT}`;
}

/**
 * 把 SubAgentUnit 变成主 agent 菜单里的 AgentTool。
 * run(input, ctx) 需要 ToolRunContext（engine 调用时必有）；手动直调会抛错提示。
 * tools token 列表 → resolveTools() 由装配层给出（该 token 的 @Tool 菜单）。
 */
export function subagentToTool(
  unit: SubAgentUnit,
  resolveTools: () => AgentTool[],
): AgentTool {
  const { name, spec } = unit;
  return {
    name: unit.name,
    description: unit.description,
    inputSchema: unit.inputSchema,
    run: async (input: unknown, ctx?: ToolRunContext): Promise<unknown> => {
      if (!ctx) {
        throw new Error(
          `subagent "${name}" 只能在主 agent 运行中被调用（engine 会注入 ToolRunContext）`,
        );
      }
      const recorder = ctx.recorder;
      const unitId = recorder.begin('unit', name, ctx.parentSpanId);
      recorder.setAttribute(unitId, 'subagent', name);
      let closed = false;
      const close = (patch: { status: 'ok' | 'error'; error?: SpanError }): void => {
        if (closed) return;
        closed = true;
        recorder.end(unitId, patch);
      };

      try {
        const raw: unknown = input ?? {};
        const task: Record<string, unknown> =
          typeof raw === 'string' ? { task: raw } : (raw as Record<string, unknown>);
        const system = await resolveSubSystem(spec.system, task);
        const tools = spec.tools?.length ? resolveTools() : [];

        const loop = await runAgentScoped({
          client: ctx.client,
          model: spec.model,
          maxTokens: spec.maxTokens,
          maxIterations: spec.maxIterations,
          system,
          messages: [{ role: 'user', content: JSON.stringify(task) }],
          tools,
          recorder,
          parentSpanId: unitId,
          signal: ctx.signal,
          resultSchema: spec.resultSchema,
          // 价格覆盖透传（F1）：子 agent 用同一模型也要能算成本
          priceOverrides: ctx.priceOverrides,
        });
        recorder.setAttribute(unitId, 'stop_reason', loop.stopReason);

        if (isSuccessStopReason(loop.stopReason)) {
          close({ status: 'ok' });
          // 隔离报告：默认只回最终文本。子 agent 提交了结构化结果（resultSchema +
          // submit_result 校验通过）时，连同报告以结构化 tool_result 交回 —— engine 会把
          // 该对象 JSON.stringify 进 tool_result，report 字段在前保持可读性，主 agent
          // 既可读报告也可直接取 result 做后续结构化处理。
          if (loop.typed !== undefined) {
            return { report: loop.finalText, result: loop.typed };
          }
          return loop.finalText;
        }
        // 子 agent 没正常收尾 → 作为可重试语义的失败回主 agent（is_error）
        const report = `subagent(${name}) ${loop.stopReason}: ${
          (loop.finalText || loop.error?.message || '').slice(0, 2000)
        }`;
        const error: SpanError = loop.error ?? {
          type: 'agent_error',
          message: report,
          retryable: true,
        };
        close({ status: 'error', error });
        throw new Error(report);
      } catch (e) {
        // runAgentScoped 抛出的请求级异常（此前 unit 未关）在此兜底标记
        close({ status: 'error', error: classifyError(e) });
        throw e;
      }
    },
  };
}
