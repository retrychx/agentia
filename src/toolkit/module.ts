import type Anthropic from '@anthropic-ai/sdk';
import type { AgentTool } from '../core/tool.js';
import type { SystemParam } from '../engine/types.js';
import { SystemPrompt } from '../run/systemPrompt.js';
import { executeRun } from '../run/run.js';
import type { AgentRunResult } from '../engine/types.js';
import { Container } from '../container/container.js';
import type { Provider, Token } from '../container/container.js';
import { collectTools } from './tool.js';

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
  /** 只扫这些 token 的 provider 上的 @Tool；缺省扫全部 providers */
  toolSources?: Token[];
}

export interface RunAppOptions {
  /** 单次覆盖 system（volatile 段建议每 run 重建以拾取最新值） */
  system?: SystemPrompt | SystemParam;
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  client?: Anthropic;
  onText?: (delta: string) => void;
  /** 预置进本次 RunContext.blackboard 的键值（工具内经 RunContext.current() 读） */
  blackboard?: Record<string, unknown>;
  /** 显式替换工具菜单（缺省用 app 收集到的工具） */
  tools?: AgentTool[];
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
    };

    const sources = opts.toolSources ?? opts.providers.map((p) => p.provide);
    this._tools = sources.flatMap((token) => {
      if (!this.di.has(token)) {
        throw new Error(`toolSources 指向未注册 provider: "${token}"`);
      }
      return collectTools(this.di.resolve(token));
    });
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
