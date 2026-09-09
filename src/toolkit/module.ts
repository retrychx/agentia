import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool } from '../core/tool.js';
import type { SystemParam } from '../engine/types.js';
import { SystemPrompt } from '../run/systemPrompt.js';
import { executeRun } from '../run/run.js';
import type { RunInvocationOptions } from '../run/spec.js';
import type { AgentRunResult } from '../engine/types.js';
import { Container } from '../container/container.js';
import type { Provider, Token } from '../container/container.js';
import { collectTools } from './tool.js';
import { collectSubAgents, subagentToTool } from './subagent.js';
import type { SubAgentUnit } from './subagent.js';
import { collectSkills, skillToTool } from './skill.js';
import type { SkillUnit } from './skill.js';
import { collectPrompts } from './prompt.js';
import type { ContextPolicy } from '../engine/types.js';

/**
 * Agentia —— 应用装配（spec §4/§6：主 agent + 可调工具菜单）。
 *
 * createApp 组装：DI 容器注册 providers → 从容器实例自动扫描 @Tool 方法
 * 收集成本 app 的工具菜单 → agent.run(messages) 带着菜单走 executeRun。
 * 主 agent 的 system 可由 SystemPrompt 实例给出（内部 build({cache:true})
 * 打稳定前缀 breakpoint），也接受已拼好的 SystemParam 原样透传。
 *
 * 后续 Turn 会在此挂上 subagent/skill 工具项与 trace 拦截器；现阶段
 * “主 agent 路由” 即模型从工具菜单中自主选择（engine 的 manual loop）。
 */
export interface AppOptions {
  /** 应用名；同时作为 run 名写入 trace */
  name?: string;
  /** DI providers：值 / 类 / 工厂 */
  providers: Provider[];
  /** 主 agent system：SystemPrompt 实例（自动打缓存）或拼好的 SystemParam */
  system: SystemPrompt | SystemParam;
  /** 缺省模型；不给则走 engine 默认（claude-opus-5） */
  model?: string;
  /** 缺省 maxTokens（流式给足避免中途截断） */
  maxTokens?: number;
  /** 缺省循环上限 */
  maxIterations?: number;
  /** 缺省上下文预算策略（compaction / context editing） */
  contextPolicy?: ContextPolicy;
  /** 只扫这些 token 的 provider 上的 @Tool；缺省扫全部 providers */
  toolSources?: Token[];
}

/** 单次调用参数 = 通用调用参数 + 单次可覆盖 system（spec.ts 的 RunInvocationOptions 为单源） */
export interface RunAppOptions extends RunInvocationOptions {
  /** 单次覆盖 system（volatile 段建议每 run 重建以拾取最新值） */
  system?: SystemPrompt | SystemParam;
}

export interface AgentRunOutput {
  run: import('../run/run.js').Run;
  result: AgentRunResult;
}

export class AgentApp {
  readonly name: string;
  private readonly di: Container;
  private readonly system: SystemPrompt | SystemParam;
  private readonly base: {
    model?: string;
    maxTokens?: number;
    maxIterations?: number;
    contextPolicy?: ContextPolicy;
  };
  private _tools?: AgentTool[];

  constructor(opts: AppOptions) {
    this.name = opts.name ?? 'app';
    this.di = new Container().register(...opts.providers);
    this.system = opts.system;
    this.base = {
      model: opts.model,
      maxTokens: opts.maxTokens,
      maxIterations: opts.maxIterations,
      contextPolicy: opts.contextPolicy,
    };

    // 先为每个 provider 解析实例并预收集它的 @Tool / @SubAgent / @Skill / @Prompt；
    // 子 agent / skill 的 tools token 之后惰性解析到该 provider 的 @Tool 菜单。
    const plainByToken = new Map<Token, AgentTool[]>();
    const unitsByToken = new Map<Token, SubAgentUnit[]>();
    const skillsByToken = new Map<Token, SkillUnit[]>();
    const promptsByToken = new Map<Token, AgentTool[]>();
    for (const p of opts.providers) {
      const inst = this.di.resolve<object>(p.provide);
      plainByToken.set(p.provide, collectTools(inst));
      unitsByToken.set(p.provide, collectSubAgents(inst));
      skillsByToken.set(p.provide, collectSkills(inst));
      promptsByToken.set(p.provide, collectPrompts(inst));
    }

    const resolveRefTools =
      (owner: string, refs: string[] | undefined) => (): AgentTool[] =>
        (refs ?? []).flatMap((t) => {
          const inner = plainByToken.get(t);
          if (!inner) {
            throw new Error(`${owner} tools 引用未注册 provider: "${t}"`);
          }
          return inner;
        });

    const sources = opts.toolSources ?? opts.providers.map((p) => p.provide);
    this._tools = sources.flatMap((token) => {
      if (!this.di.has(token)) {
        throw new Error(`toolSources 指向未注册 provider: "${token}"`);
      }
      const plain = plainByToken.get(token) ?? [];
      const subTools = (unitsByToken.get(token) ?? []).map((unit) =>
        subagentToTool(unit, resolveRefTools(`@SubAgent "${unit.name}"`, unit.spec.tools)),
      );
      const skillTools = (skillsByToken.get(token) ?? []).map((unit) =>
        skillToTool(unit, resolveRefTools(`@Skill "${unit.name}"`, unit.spec.tools)),
      );
      const promptTools = promptsByToken.get(token) ?? [];
      return [...plain, ...subTools, ...skillTools, ...promptTools];
    });

    // §7 静态校验（最小落地）：菜单统一查重 —— 重名会让模型在歧义菜单里猜，直接报错。
    const dup = new Map<string, number>();
    for (const t of this._tools) dup.set(t.name, (dup.get(t.name) ?? 0) + 1);
    const dupNames = [...dup.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    if (dupNames.length > 0) {
      throw new Error(
        `菜单单元重名（tool/skill/subagent/prompt 共用命名空间）: ${dupNames.join(', ')}`,
      );
    }
  }

  /** app 已装配好的工具菜单（构建期即从容器解析，静态稳定） */
  get tools(): AgentTool[] {
    return this._tools ?? [];
  }

  /** 容器访问点（后续 trace 拦截器/生命周期回调可用） */
  get container(): Container {
    return this.di;
  }

  /** 执行一次主 agent run。system 每 run 从 SystemPrompt 重建，保证 volatile 新鲜。 */
  run(messages: Anthropic.MessageParam[], opts: RunAppOptions = {}): Promise<AgentRunOutput> {
    const sys = opts.system ?? this.system;
    const system: SystemParam =
      sys instanceof SystemPrompt ? sys.build({ cache: true }) : sys;

    const seed = opts.blackboard;
    return executeRun({
      system,
      messages,
      tools: opts.tools ?? this._tools,
      model: opts.model ?? this.base.model,
      maxTokens: opts.maxTokens ?? this.base.maxTokens,
      maxIterations: opts.maxIterations ?? this.base.maxIterations,
      client: opts.client,
      onText: opts.onText,
      runName: this.name,
      idempotencyKey: opts.idempotencyKey,
      contextPolicy: opts.contextPolicy ?? this.base.contextPolicy,
      rethrow: opts.rethrow,
      contextInit: (ctx) => {
        if (seed) {
          for (const key of Object.keys(seed)) ctx.set(key, seed[key]);
        }
      },
    });
  }
}

export function createApp(opts: AppOptions): AgentApp {
  return new AgentApp(opts);
}
