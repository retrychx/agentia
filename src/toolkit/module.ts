import type { MessageParam } from '../core/message.js';
import type { AgentTool, JsonSchema, ModelPricing, SchemaType } from '../core/tool.js';
import type { SystemParam } from '../engine/types.js';
import { SystemPrompt } from '../runtime/systemPrompt.js';
import { executeRun } from '../runtime/run.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import type { SessionStore } from '../runtime/session.js';
import type { MemoryStore } from '../runtime/memory.js';
import type { AgentRunResult } from '../engine/types.js';
import type { TraceSink } from '../core/trace.js';
import { Container } from '../container/container.js';
import type { Provider, Token } from '../container/container.js';
import type { BlackboardKey } from '../core/blackboard.js';
import { discoverProviders } from './discover.js';
import { collectTools } from './tool.js';
import { collectSubAgents, subagentToTool } from './subagent.js';
import type { SubAgentCapability } from './subagent.js';
import { collectSkills, skillToTool } from './skill.js';
import type { SkillCapability } from './skill.js';
import { collectPromptEntries } from './prompt.js';
import type { CollectedPrompts } from './prompt.js';
import { applyMiddleware } from './middleware.js';
import type { CapabilityMiddleware } from './middleware.js';
import type { ContextPolicy } from '../engine/types.js';
import type { RetryOptions } from '../engine/retry.js';

/**
 * 能力包（roadmap R5）：第三方包把「能力 providers + 中间件」打包成 AgentModule 分发，
 * 应用侧经 AppOptions.modules 一次性装配。模块的 providers 先于应用级 providers 注册
 *（同 token 应用级覆盖模块级）；中间件拼接顺序同样模块在前。
 */
export interface AgentModule {
  /** 模块携带的 DI providers（能力类 / 值 / 工厂） */
  providers: Provider[];
  /** 模块级能力调用中间件（拼在应用级 middleware 之前，即更外层） */
  middleware?: CapabilityMiddleware[];
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
   * 能力目录发现：`<目录>/<name>/index.ts` 约定（一能力一文件夹）。
   * 给**一个目录**或**一组目录**（数组顺序即装配顺序）——典型布局是四分类目录
   * `src/tools` / `src/skills` / `src/prompts` / `src/subagents`。
   * 启动期扫描装配；因动态 import，带 discover 的 createApp 返回 Promise<AgentApp>。
   */
  discover?: string | string[];
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
  /** 缺省模型请求重试策略（可被单次 run 覆盖）；见 RunAgentOptions.retry */
  retry?: RetryOptions | false;
  /** 缺省成本硬管控：整条 run 累计 token 上限（可被单次 run 覆盖） */
  maxTotalTokens?: number;
  /** 缺省成本硬管控：累计成本（美元）上限（可被单次 run 覆盖） */
  maxCostUsd?: number;
  /**
   * 价格表覆盖/追加（$/1M tokens，可被单次 run 覆盖）；见 `RunAgentOptions.priceOverrides`。
   * 给非 Anthropic 端点（DeepSeek / 自建）定价，否则 `maxCostUsd` 会静默不生效。
   */
  priceOverrides?: Record<string, ModelPricing>;
  /** 未定价模型回调（可被单次 run 覆盖）；见 `RunAgentOptions.onUnpricedModel` */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
  /** 缺省单个工具执行超时（毫秒，可被单次 run 覆盖）；0/不设 = 不限 */
  toolTimeoutMs?: number;
  /** 缺省同回合并行工具上限（可被单次 run 覆盖）；不设 = 不限 */
  maxToolConcurrency?: number;
  /**
   * 缺省 trace 事件正文截断上限（可被单次 run 覆盖）；不设 = 框架缺省
   * （入参/成功出参 2000、失败出参 1000），`false` = 不截断。
   * 调试期在应用级开一次 `false`，不必每个调用点重复传。见 `RunAgentOptions.maxEventChars`。
   */
  maxEventChars?: number | false;
  /** 只收集这些 token 的 provider 上的能力（@Tool / @SubAgent / @Skill / @Prompt 四类同样收窄）；缺省扫全部 providers */
  toolSources?: Token[];
  /**
   * 直接追加到主菜单的**裸工具**（`AgentTool[]`）—— 给「构造期才知道有哪些工具」的场景
   * （典型：MCP 桥 `mcpTools()` 的返回值，见 integrations/mcp.ts）。
   *
   * 与装饰器收集来的能力**完全同等**：同样过中间件链、同样进重名查重、同样受
   * `toolSources` 之外的一切装配规则约束（不受 `toolSources` 收窄影响 —— 这是显式追加）。
   * 不经装饰器、不进 DI 容器（它没有 provider token，也不是任何能力的 tools 引用目标）。
   */
  tools?: AgentTool[];
  /** 能力调用中间件（洋葱模型，链序 = 注册顺序）；装配期包裹整个菜单 */
  middleware?: CapabilityMiddleware[];
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
  /**
   * 会话持久化（C4）：语义同 `ExecuteRunOptions.session` —— run 开始把历史拼在传入
   * messages 之前，成功收尾把本轮消息 + 回复追加回去。与 `blackboard`（键值黑板）正交。
   *
   * 只在程序内直接 `app.run` 时可用（store 实例不可序列化，因此**不在**
   * transport 的 `RunInvocationOptions` 里 —— 异步宿主不会替你传它）。
   */
  session?: { store: SessionStore; id: string };
  /**
   * 跨 run 记忆（R4）：语义同 `ExecuteRunOptions.memory` —— run 开始把
   * `store.load(keys)` 水合进 blackboard（用户种子优先，同名 key 不被覆盖），
   * 收尾（成功/失败两条路径）把这些 key 的当前值写回。
   *
   * 与 `session`（对话历史）正交，可同时用；边界也与它相同：只在程序内直接
   * `app.run` 时可用（store 实例不可序列化，因此**不在** transport 的
   * `RunInvocationOptions` 里 —— 异步宿主不会替你传它）。
   */
  memory?: { store: MemoryStore; keys: string[] };
  /**
   * 未定价模型回调（单次覆盖应用级）；见 `RunAgentOptions.onUnpricedModel`。
   * 是函数，因此**不在** transport 的 `RunInvocationOptions` 里（异步宿主不替你传）。
   */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
}

export interface AgentRunOutput<T = unknown> {
  run: import('../runtime/run.js').Run;
  result: AgentRunResult<T>;
}

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
export class AgentApp {
  readonly name: string;
  private readonly di: Container;
  private readonly system: SystemPrompt | SystemParam;
  private readonly base: {
    model?: string;
    maxTokens?: number;
    maxIterations?: number;
    contextPolicy?: ContextPolicy;
    retry?: RetryOptions | false;
    maxTotalTokens?: number;
    maxCostUsd?: number;
    priceOverrides?: Record<string, ModelPricing>;
    onUnpricedModel?: (info: { model: string; spanId: string }) => void;
    toolTimeoutMs?: number;
    maxToolConcurrency?: number;
    maxEventChars?: number | false;
  };
  private _tools: AgentTool[] = [];
  /**
   * 装配期收集的 @Prompt 资产版本表（{ 最终菜单名: 版本 }，R7 质量闭环）：
   * 与 this._tools 同一条收集路径（toolSources 收窄同样生效）；run() 固定传给
   * engine 落 run 根 span 的 `prompts.versions`。菜单里没有任何带版本的 @Prompt 时为 undefined。
   */
  private readonly promptVersions: Record<string, string> | undefined;
  private readonly sinks: TraceSink[];
  /** 装配期那条中间件链的包裹函数：主菜单构造期已包好；per-run tools 覆盖在 run() 里现包 */
  private readonly wrapTools: (tools: AgentTool[]) => AgentTool[];

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
      retry: opts.retry,
      maxTotalTokens: opts.maxTotalTokens,
      maxCostUsd: opts.maxCostUsd,
      priceOverrides: opts.priceOverrides,
      onUnpricedModel: opts.onUnpricedModel,
      toolTimeoutMs: opts.toolTimeoutMs,
      maxToolConcurrency: opts.maxToolConcurrency,
      maxEventChars: opts.maxEventChars,
    };

    // 先为每个 provider 解析实例并预收集它的 @Tool / @SubAgent / @Skill / @Prompt；
    // 子 agent / skill 的 tools token 在装配期即解析到该 provider 的 @Tool 菜单（静态校验）。
    const plainByToken = new Map<Token, AgentTool[]>();
    const capabilitiesByToken = new Map<Token, SubAgentCapability[]>();
    const skillsByToken = new Map<Token, SkillCapability[]>();
    const promptsByToken = new Map<Token, CollectedPrompts>();
    for (const p of providerList) {
      const inst = this.di.resolve<object>(p.provide);
      plainByToken.set(p.provide, collectTools(inst));
      capabilitiesByToken.set(p.provide, collectSubAgents(inst));
      skillsByToken.set(p.provide, collectSkills(inst));
      promptsByToken.set(p.provide, collectPromptEntries(inst));
    }

    // 能力调用中间件：装配期包裹整个菜单（洋葱模型，对 engine 零侵入）；
    // 模块级中间件在前（更外层），应用级在后。
    const middleware = [...modules.flatMap((m) => m.middleware ?? []), ...(opts.middleware ?? [])];
    const wrap = (tools: AgentTool[]): AgentTool[] =>
      middleware.length ? applyMiddleware(tools, middleware) : tools;
    this.wrapTools = wrap;

    /**
     * 中间件包装**之后**的每 provider 菜单。
     *
     * 嵌套能力（子 agent / skill）解析自身 tools 引用时必须从这里取 —— 若取
     * 「中间件包装之前的原始菜单」，子 agent 内部调用的每一个工具都会绕过中间件
     * （鉴权 / 限流 / 审计 / 结果缓存全部失效），是 spec §10 记录在案的既知问题。
     * 该 map 在 resolveRefTools 的 thunk 被真正调用（运行时）前已填充完毕。
     */
    const wrappedByToken = new Map<Token, AgentTool[]>();

    // 装配期立即解析 tools 引用（§7 启动期静态校验）：引用未注册 provider 在
    // createApp 即抛错，不延迟到模型调用该能力的运行时。实际取值延迟到运行时
    // （惰性 thunk）—— 那时 wrappedByToken 已就绪。
    //
    // 引用有两种形态，混写合法：
    // - `'token'`：整片引用该 provider 的菜单（@Tool + 它的 subagent/skill/prompt 工具）；
    // - `'token/能力名'`：能力级路径，只引菜单里的单个能力。按第一个 '/' 切分
    //   （能力名经 collect 校验不含 '/'，右段必然干净；token 含 '/' 查不到，
    //   按「未注册 provider」报错即可，不特殊处理）。
    const resolveRefTools = (owner: string, refs: string[] | undefined): (() => AgentTool[]) => {
      const parsed = (refs ?? []).map((ref) => {
        const slash = ref.indexOf('/');
        return slash === -1
          ? { token: ref, name: undefined as string | undefined }
          : { token: ref.slice(0, slash), name: ref.slice(slash + 1) };
      });
      for (const { token, name } of parsed) {
        if (!plainByToken.has(token)) {
          throw new Error(`${owner} tools 引用未注册 provider: "${token}"`);
        }
        if (name !== undefined) {
          // 可用名单 = 该 provider 收集菜单全量（@Tool 与它的 subagent/skill/prompt
          // 工具名），按名排序给出，方便作者对照改正。
          const available = [
            ...(plainByToken.get(token) ?? []),
            ...(capabilitiesByToken.get(token) ?? []),
            ...(skillsByToken.get(token) ?? []),
            ...(promptsByToken.get(token)?.tools ?? []),
          ]
            .map((t) => t.name)
            .sort();
          if (!available.includes(name)) {
            throw new Error(
              `${owner} tools 引用 "${token}" 中不存在的能力: "${name}"（可用: ${available.join(', ')}）`,
            );
          }
        }
      }
      return () =>
        parsed.flatMap(({ token, name }) => {
          const wrapped = wrappedByToken.get(token) ?? [];
          // 能力级引用按名从**包装后**的菜单 filter（见上方 wrappedByToken 记档的教训）
          // —— 中间件不得被绕过。
          return name === undefined ? wrapped : wrapped.filter((t) => t.name === name);
        });
    };

    const buildSlice = (token: Token): AgentTool[] => {
      const plain = plainByToken.get(token) ?? [];
      const subTools = (capabilitiesByToken.get(token) ?? []).map((capability) =>
        subagentToTool(
          capability,
          resolveRefTools(`@SubAgent "${capability.name}"`, capability.spec.tools),
        ),
      );
      const skillTools = (skillsByToken.get(token) ?? []).map((capability) =>
        skillToTool(
          capability,
          resolveRefTools(`@Skill "${capability.name}"`, capability.spec.tools),
        ),
      );
      const promptTools = promptsByToken.get(token)?.tools ?? [];
      return [...plain, ...subTools, ...skillTools, ...promptTools];
    };

    // 全部 provider 都切片并包装：主菜单只取 sources，但被 toolSources 排除的
    // provider 上的能力仍可被其他能力的 tools 引用（引用是作者显式声明，不受收窄影响）——
    // 因此包装必须覆盖全部 provider，否则 ref 解析会拿到未包装（可绕过中间件）的工具。
    for (const p of providerList) {
      wrappedByToken.set(p.provide, wrap(buildSlice(p.provide)));
    }

    // toolSources 是「取哪些 provider 的能力」的白名单，同一 token 写重只该取一次：
    // 不去重则会 flatMap 收两遍该 provider 的能力，最后撞上「菜单能力重名」——
    // 报错指向能力定义（错误来源），而真正的问题是这份清单里重复写了 token。
    const sources = opts.toolSources
      ? [...new Set(opts.toolSources)]
      : providerList.map((p) => p.provide);
    // @Prompt 资产版本表（R7）：沿主菜单同一条收集路径（sources 口径，toolSources
    // 收窄同样生效）汇总各 @Prompt 的 最终菜单名→version；run() 固定传给 engine。
    const promptVersions: Record<string, string> = {};
    for (const token of sources) {
      Object.assign(promptVersions, promptsByToken.get(token)?.versions);
    }
    this.promptVersions = Object.keys(promptVersions).length > 0 ? promptVersions : undefined;
    this._tools = [
      ...sources.flatMap((token) => {
        if (!this.di.has(token)) {
          throw new Error(`toolSources 指向未注册 provider: "${token}"`);
        }
        return wrappedByToken.get(token) ?? [];
      }),
      // 裸工具（AppOptions.tools）：与装饰器收集来的能力同等 —— 一样过中间件、
      // 一样进下面的重名查重。**不是旁路**（旁路会绕过鉴权/限流/审计）。
      ...wrap(opts.tools ?? []),
    ];

    // §7 静态校验（最小落地）：菜单统一查重 —— 重名会让模型在歧义菜单里猜，直接报错。
    const dup = new Map<string, number>();
    for (const t of this._tools) dup.set(t.name, (dup.get(t.name) ?? 0) + 1);
    const dupNames = [...dup.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    if (dupNames.length > 0) {
      throw new Error(
        `菜单能力重名（tool/skill/subagent/prompt 共用命名空间）: ${dupNames.join(', ')}`,
      );
    }

    // 孤儿能力告警：toolSources 显式收窄时，被排除 provider 上的能力不在主菜单
    // （模型无法直接调用）；但**仍可被其他能力的 tools 引用**（引用是作者显式声明），
    // 所以只是「不在主菜单」而非「不可达」。
    if (opts.toolSources) {
      const included = new Set(opts.toolSources);
      for (const p of providerList) {
        if (included.has(p.provide)) continue;
        const orphanCount =
          (plainByToken.get(p.provide)?.length ?? 0) +
          (capabilitiesByToken.get(p.provide)?.length ?? 0) +
          (skillsByToken.get(p.provide)?.length ?? 0) +
          (promptsByToken.get(p.provide)?.tools.length ?? 0);
        if (orphanCount > 0) {
          console.warn(
            `[agentia] 孤儿能力告警：provider "${p.provide}" 上的 ${orphanCount} 个能力不在 toolSources 内，` +
              `不进主菜单（模型无法直接调用）；若被其他能力的 tools 引用仍可被调用`,
          );
        }
      }
    }
  }

  /** app 已装配好的工具菜单（构建期即从容器解析，静态稳定） */
  get tools(): AgentTool[] {
    return this._tools;
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
    messages: MessageParam[],
    opts: RunAppOptions<S> = {},
  ): Promise<AgentRunOutput<SchemaType<S>>> {
    const sys = opts.system ?? this.system;
    const system: SystemParam = sys instanceof SystemPrompt ? sys.build({ cache: true }) : sys;

    const seed = opts.blackboard;
    return executeRun<S>({
      system,
      messages,
      // per-run tools 覆盖与 AppOptions.tools 同语义：同样过装配期那条中间件链，**不是旁路**
      //（否则 per-run 覆盖就绕开了鉴权/限流/审计）。this._tools 构造期已包裹好（直接复用，
      // 不二次包裹）；opts.tools 是调用方给的裸菜单，此处现包一次 —— applyMiddleware 产出
      // 新数组新对象（不改写入参），与装配期结果无共享，不会双重包裹。
      tools: opts.tools ? this.wrapTools(opts.tools) : this._tools,
      model: opts.model ?? this.base.model,
      maxTokens: opts.maxTokens ?? this.base.maxTokens,
      maxIterations: opts.maxIterations ?? this.base.maxIterations,
      client: opts.client,
      onText: opts.onText,
      runName: this.name,
      idempotencyKey: opts.idempotencyKey,
      contextPolicy: opts.contextPolicy ?? this.base.contextPolicy,
      retry: opts.retry ?? this.base.retry,
      maxTotalTokens: opts.maxTotalTokens ?? this.base.maxTotalTokens,
      maxCostUsd: opts.maxCostUsd ?? this.base.maxCostUsd,
      priceOverrides: opts.priceOverrides ?? this.base.priceOverrides,
      onUnpricedModel: opts.onUnpricedModel ?? this.base.onUnpricedModel,
      toolTimeoutMs: opts.toolTimeoutMs ?? this.base.toolTimeoutMs,
      maxToolConcurrency: opts.maxToolConcurrency ?? this.base.maxToolConcurrency,
      maxEventChars: opts.maxEventChars ?? this.base.maxEventChars,
      resultSchema: opts.resultSchema,
      // 提示词版本化（D4）：system 是 SystemPrompt 实例时自动带上它的 version
      // （run 根 attribute `system.version`）；传已拼好的 SystemParam 则无版本可记。
      systemVersion: sys instanceof SystemPrompt ? sys.version : undefined,
      // @Prompt 资产版本表（R7）：固定来自装配期收集（per-run opts 无此字段）；
      // 无版本表的 app 传 undefined，engine 空表不记。
      promptVersions: this.promptVersions,
      session: opts.session,
      memory: opts.memory,
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
 * 装配应用。不带 discover 时同步返回 AgentApp；带 discover（能力目录路径，一个或一组）时
 * 先扫描装配，返回 Promise<AgentApp>（动态 import 决定）。
 */
export function createApp(opts: AppOptions & { discover: string | string[] }): Promise<AgentApp>;
export function createApp(opts: AppOptions): AgentApp;
export function createApp(opts: AppOptions): AgentApp | Promise<AgentApp> {
  if (opts.discover) {
    return discoverProviders(opts.discover).then(
      // 显式 providers 放在发现结果**之后**：AppOptions.providers 是应用级显式声明，
      // 同 token 时应覆盖「目录里扫出来的」（后注册覆盖先注册）。反过来会让
      // capabilities/ 下一个同名文件夹悄悄顶掉调用方手写的 provider。
      (found) => new AgentApp({ ...opts, providers: [...found, ...(opts.providers ?? [])] }),
    );
  }
  return new AgentApp(opts);
}
