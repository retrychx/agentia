import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, JsonSchema, SchemaType } from '../core/tool.js';
import type { SystemParam } from '../engine/types.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';
import { executeRun } from '../runtime/run.js';
import type { RunInvocationOptions } from '../runtime/spec.js';
import type { AgentRunResult } from '../engine/types.js';
import type { TraceSink } from '../core/trace.js';
import { Container } from '../container/container.js';
import type { Provider, Token } from '../container/container.js';
import type { BlackboardKey } from '../runtime/context.js';
import { discoverProviders } from './discover.js';
import { collectTools } from './tool.js';
import { collectSubAgents, subagentToTool } from './subagent.js';
import type { SubAgentUnit } from './subagent.js';
import { collectSkills, skillToTool } from './skill.js';
import type { SkillUnit } from './skill.js';
import { collectPrompts } from './prompt.js';
import { applyMiddleware } from './middleware.js';
import type { UnitMiddleware } from './middleware.js';
import type { ContextPolicy } from '../engine/types.js';

/**
 * Agentia —— 应用装配（spec §4/§6：主 agent + 可调工具菜单）。
 *
 * createApp 组装：DI 容器注册 providers（手动和/或 discover 目录发现）→
 * 从容器实例自动扫描 @Tool / @SubAgent / @Skill / @Prompt 收集成本 app 的工具菜单
 * → agent.run(messages) 带着菜单走 executeRun。装配期统一静态校验（§7）：
 * 菜单查重、tools 引用存在性、toolSources 指向。
 * 主 agent 的 system 可由 SystemPrompt 实例给出（内部 build({cache:true})
 * 打稳定前缀 breakpoint），也接受已拼好的 SystemParam 原样透传。
 */
/**
 * 能力包（roadmap R5）：第三方包把「单元 providers + 中间件」打包成 AgentModule 分发，
 * 应用侧经 AppOptions.modules 一次性装配。模块的 providers 先于应用级 providers 注册
 *（同 token 应用级覆盖模块级）；中间件拼接顺序同样模块在前。
 */
export interface AgentModule {
  /** 模块携带的 DI providers（单元类 / 值 / 工厂） */
  providers: Provider[];
  /** 模块级单元调用中间件（拼在应用级 middleware 之前，即更外层） */
  middleware?: UnitMiddleware[];
}

/** 定义能力包：identity 函数，仅给第三方包一个类型锚点与导出约定 */
export function defineModule(m: AgentModule): AgentModule {
  return m;
}

const defaultSinks: TraceSink[] = [];

/** 注册全局默认 trace sink（观测 / dev 工具用）。createApp 构造期快照合并，已建应用不受后续注册影响。 */
export function registerDefaultTraceSink(sink: TraceSink): void {
  defaultSinks.push(sink);
}

export interface AppOptions {
  /** 应用名；同时作为 run 名写入 trace */
  name?: string;
  /** DI providers：值 / 类 / 工厂；与 discover 可混用（同 token 后者覆盖） */
  providers?: Provider[];
  /** 能力包：providers 并入（在 providers 之前注册）、middleware 拼接（在 middleware 之前） */
  modules?: AgentModule[];
  /**
   * 单元目录发现：units/<name>/ 目录约定（一单元一文件夹，index.ts 入口）。
   * 给目录路径（相对 cwd）即启动期扫描装配；因动态 import，带 discover 的
   * createApp 返回 Promise<AgentApp>。
   */
  discover?: string;
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
  /** 单元调用中间件（洋葱模型，链序 = 注册顺序）；装配期包裹整个菜单 */
  middleware?: UnitMiddleware[];
  /** trace 出口（观测）：每次 run 收尾投递；与全局默认 sink 合并（本字段在前） */
  sinks?: TraceSink[];
}

/** 单次调用参数 = 通用调用参数 + 单次可覆盖 system（spec.ts 的 RunInvocationOptions 为单源） */
export interface RunAppOptions<S extends JsonSchema = JsonSchema> extends RunInvocationOptions {
  /** 单次覆盖 system（volatile 段建议每 run 重建以拾取最新值） */
  system?: SystemPrompt | SystemParam;
  /**
   * 结构化结果 schema（R2）：语义同 `RunAgentOptions.resultSchema`（engine 追加隐藏
   * submit_result 工具，校验通过的结果写入 `result.typed`）。
   * 传 `fromZod<T>(...)` 时 `app.run` 的返回类型自动带上 `typed: T | undefined`。
   */
  resultSchema?: S;
}

export interface AgentRunOutput<T = unknown> {
  run: import('../runtime/run.js').Run;
  result: AgentRunResult<T>;
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
  private readonly sinks: TraceSink[];

  constructor(opts: AppOptions) {
    this.name = opts.name ?? 'app';
    const modules = opts.modules ?? [];
    // 同 token 去重（后注册覆盖先注册，与 Container.register 语义一致）——
    // 模块 providers 在前、应用级 providers 在后：应用级可覆盖模块级同 token；
    // providers 与 discover 混用/重复给出同一 token 时不会重复收集菜单。
    const providerList = [
      ...new Map(
        [...modules.flatMap((m) => m.providers), ...(opts.providers ?? [])].map((p) => [
          p.provide,
          p,
        ]),
      ).values(),
    ];
    this.di = new Container().register(...providerList);
    this.system = opts.system;
    // trace 出口：应用级 sinks 在前，全局默认 sink 在后（构造期快照，注册表后续变化不影响本应用）
    this.sinks = [...(opts.sinks ?? []), ...defaultSinks];
    this.base = {
      model: opts.model,
      maxTokens: opts.maxTokens,
      maxIterations: opts.maxIterations,
      contextPolicy: opts.contextPolicy,
    };

    // 先为每个 provider 解析实例并预收集它的 @Tool / @SubAgent / @Skill / @Prompt；
    // 子 agent / skill 的 tools token 在装配期即解析到该 provider 的 @Tool 菜单（静态校验）。
    const plainByToken = new Map<Token, AgentTool[]>();
    const unitsByToken = new Map<Token, SubAgentUnit[]>();
    const skillsByToken = new Map<Token, SkillUnit[]>();
    const promptsByToken = new Map<Token, AgentTool[]>();
    for (const p of providerList) {
      const inst = this.di.resolve<object>(p.provide);
      plainByToken.set(p.provide, collectTools(inst));
      unitsByToken.set(p.provide, collectSubAgents(inst));
      skillsByToken.set(p.provide, collectSkills(inst));
      promptsByToken.set(p.provide, collectPrompts(inst));
    }

    // 单元调用中间件：装配期包裹整个菜单（洋葱模型，对 engine 零侵入）；
    // 模块级中间件在前（更外层），应用级在后。
    const middleware = [...modules.flatMap((m) => m.middleware ?? []), ...(opts.middleware ?? [])];
    const wrap = (tools: AgentTool[]): AgentTool[] =>
      middleware.length ? applyMiddleware(tools, middleware) : tools;

    /**
     * 中间件包装**之后**的每 provider 菜单。
     *
     * 嵌套单元（子 agent / skill）解析自身 tools 引用时必须从这里取 —— 若取
     * 「中间件包装之前的原始菜单」，子 agent 内部调用的每一个工具都会绕过中间件
     * （鉴权 / 限流 / 审计 / 结果缓存全部失效），是 spec §10 记录在案的既知问题。
     * 该 map 在 resolveRefTools 的 thunk 被真正调用（运行时）前已填充完毕。
     */
    const wrappedByToken = new Map<Token, AgentTool[]>();

    // 装配期立即解析 tools 引用（§7 启动期静态校验）：引用未注册 provider 在
    // createApp 即抛错，不延迟到模型调用该单元的运行时。实际取值延迟到运行时
    // （惰性 thunk）—— 那时 wrappedByToken 已就绪。
    const resolveRefTools = (owner: string, refs: string[] | undefined): (() => AgentTool[]) => {
      for (const t of refs ?? []) {
        if (!plainByToken.has(t)) {
          throw new Error(`${owner} tools 引用未注册 provider: "${t}"`);
        }
      }
      return () => (refs ?? []).flatMap((t) => wrappedByToken.get(t) ?? []);
    };

    const buildSlice = (token: Token): AgentTool[] => {
      const plain = plainByToken.get(token) ?? [];
      const subTools = (unitsByToken.get(token) ?? []).map((unit) =>
        subagentToTool(unit, resolveRefTools(`@SubAgent "${unit.name}"`, unit.spec.tools)),
      );
      const skillTools = (skillsByToken.get(token) ?? []).map((unit) =>
        skillToTool(unit, resolveRefTools(`@Skill "${unit.name}"`, unit.spec.tools)),
      );
      const promptTools = promptsByToken.get(token) ?? [];
      return [...plain, ...subTools, ...skillTools, ...promptTools];
    };

    // 全部 provider 都切片并包装：主菜单只取 sources，但被 toolSources 排除的
    // provider 上的单元仍可被其他单元的 tools 引用（引用是作者显式声明，不受收窄影响）——
    // 因此包装必须覆盖全部 provider，否则 ref 解析会拿到未包装（可绕过中间件）的工具。
    for (const p of providerList) {
      wrappedByToken.set(p.provide, wrap(buildSlice(p.provide)));
    }

    // toolSources 是「取哪些 provider 的单元」的白名单，同一 token 写重只该取一次：
    // 不去重则会 flatMap 收两遍该 provider 的单元，最后撞上「菜单单元重名」——
    // 报错指向单元定义（错误来源），而真正的问题是这份清单里重复写了 token。
    const sources = opts.toolSources
      ? [...new Set(opts.toolSources)]
      : providerList.map((p) => p.provide);
    this._tools = sources.flatMap((token) => {
      if (!this.di.has(token)) {
        throw new Error(`toolSources 指向未注册 provider: "${token}"`);
      }
      return wrappedByToken.get(token) ?? [];
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

    // 孤儿单元告警：toolSources 显式收窄时，被排除 provider 上的单元不在主菜单
    // （模型无法直接调用）；但**仍可被其他单元的 tools 引用**（引用是作者显式声明），
    // 所以只是「不在主菜单」而非「不可达」。
    if (opts.toolSources) {
      const included = new Set(opts.toolSources);
      for (const p of providerList) {
        if (included.has(p.provide)) continue;
        const orphanCount =
          (plainByToken.get(p.provide)?.length ?? 0) +
          (unitsByToken.get(p.provide)?.length ?? 0) +
          (skillsByToken.get(p.provide)?.length ?? 0) +
          (promptsByToken.get(p.provide)?.length ?? 0);
        if (orphanCount > 0) {
          console.warn(
            `[agentia] 孤儿单元告警：provider "${p.provide}" 上的 ${orphanCount} 个单元不在 toolSources 内，` +
              `不进主菜单（模型无法直接调用）；若被其他单元的 tools 引用仍可被调用`,
          );
        }
      }
    }
  }

  /** app 已装配好的工具菜单（构建期即从容器解析，静态稳定） */
  get tools(): AgentTool[] {
    return this._tools ?? [];
  }

  /** 容器访问点 */
  get container(): Container {
    return this.di;
  }

  /**
   * 执行一次主 agent run。system 每 run 从 SystemPrompt 重建，保证 volatile 新鲜。
   * 传 `resultSchema: fromZod<T>(...)` 时返回值 `result.typed` 为 `T | undefined`。
   */
  run<S extends JsonSchema = JsonSchema>(
    messages: Anthropic.MessageParam[],
    opts: RunAppOptions<S> = {},
  ): Promise<AgentRunOutput<SchemaType<S>>> {
    const sys = opts.system ?? this.system;
    const system: SystemParam =
      sys instanceof SystemPrompt ? sys.build({ cache: true }) : sys;

    const seed = opts.blackboard;
    return executeRun<S>({
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
      resultSchema: opts.resultSchema,
      rethrow: opts.rethrow,
      sinks: this.sinks,
      contextInit: (ctx) => {
        if (seed) {
          // 种子键是运行期字符串，类型上无从与「用户声明的 Blackboard」对齐 ——
          // 走文档里给用户的同一条逃生口：断言为 BlackboardKey。
          const entries = seed as Record<string, unknown>;
          for (const key of Object.keys(entries)) ctx.set(key as BlackboardKey, entries[key]);
        }
      },
    });
  }
}

/**
 * 装配应用。不带 discover 时同步返回 AgentApp；带 discover（单元目录路径）时
 * 先扫描装配，返回 Promise<AgentApp>（动态 import 决定）。
 */
export function createApp(opts: AppOptions & { discover: string }): Promise<AgentApp>;
export function createApp(opts: AppOptions): AgentApp;
export function createApp(opts: AppOptions): AgentApp | Promise<AgentApp> {
  if (opts.discover) {
    return discoverProviders(opts.discover).then(
      // 显式 providers 放在发现结果**之后**：AppOptions.providers 是应用级显式声明，
      // 同 token 时应覆盖「目录里扫出来的」（后注册覆盖先注册）。反过来会让
      // units/ 下一个同名文件夹悄悄顶掉调用方手写的 provider。
      (found) => new AgentApp({ ...opts, providers: [...found, ...(opts.providers ?? [])] }),
    );
  }
  return new AgentApp(opts);
}
