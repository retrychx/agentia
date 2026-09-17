import type { MessageParam } from '../core/message.js';
import { createAnthropicClient } from '../integrations/anthropic.js';
import type {
  AgentTool,
  JsonSchema,
  ModelClient,
  ModelPricing,
  RecorderBackend,
  SchemaType,
} from '../core/tool.js';
import type { SpanError, SpanId } from '../core/trace.js';
import { classifyError } from './errors.js';
import { resolveRetry } from './retry.js';
import type { RetryOptions } from './retry.js';
import { TraceRecorder } from './tracer.js';
import {
  abortedError,
  budgetError,
  buildLoopContext,
  checkTurnEntry,
  executeTurnTools,
  recordTurnUsage,
  resolveStopReason,
  streamTurn,
  textOf,
} from './turn.js';
import type { AgentLoopArgs } from './turn.js';
import type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  RunAgentOptions,
  SystemParam,
} from './types.js';
import { isSuccessStopReason } from './types.js';

/**
 * 缺省模型解析：显式传入 > AGENTIA_MODEL env > 'claude-opus-5'。
 * 不把端点私有模型写死在代码里 —— 走 Anthropic 兼容网关（如 DeepSeek 端点）时
 * export AGENTIA_MODEL=deepseek-… 即可全局覆盖，无需逐处传 model。
 */
export function resolveDefaultModel(over?: string): string {
  if (over) return over;
  return process.env.AGENTIA_MODEL?.trim() || 'claude-opus-5';
}

/** 缺省单次 maxTokens / 循环上限：runAgent 与 runAgentScoped 共用，避免两处各写一遍漂移。 */
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_MAX_ITERATIONS = 40;

/**
 * Agentia —— 主循环（manual loop，流式）—— spec §5。
 *
 * 结构：核心是 `agentLoop` —— 不自开 run 根，所有 llm.turn 挂在给定的
 * parentSpanId 下。同一套循环既能当主 agent（run 根为其父，由 runAgent 开），
 * 也能当子 agent（capability span 为其父，见 toolkit/subagent.ts），llm.turn 与 usage
 * 递归进同一条 trace（spec §9：子 agent = 一个 capability span，内部能力递归成它的子孙）。
 *
 * 工具执行经 ctx: ToolRunContext 把 {client, recorder, parentSpanId: 当前 turn}
 * 交给 tool.run —— 普通工具忽略；子 agent 用它在正确位置开 capability span。
 *
 * 文件分工：本文件只留入口（runAgent / runAgentScoped）与 agentLoop 编排骨架 +
 * 缺省旋钮；「一回合执行步骤」的实现机（回合上下文、请求/重试、记账、stop_reason
 * 分流、工具执行）拆在同层 turn.ts，依赖方向单向 loop.ts → turn.ts。
 */

export interface AgentLoopResult<T = unknown> {
  stopReason: AgentStopReason;
  finalText: string;
  error?: SpanError;
  /** 本轮循环自己发起的模型往返次数 */
  iterations: number;
  /** submit_result 校验通过的结构化结果；未提交则为 undefined（类型由 resultSchema 推导） */
  typed?: T;
}

/**
 * 上下文策略按 run 隔离：实现提供 `forRun` 时每条 run 拿一个全新实例 ——
 * 内置 createBudgetPolicy 的滞回计数（lastCompactAt）与增量 token 缓存都是
 * **per-run 状态**，应用级单例（AppOptions.contextPolicy）被多 run 复用时，
 * 不隔离会让「run A 第 39 回合刚压缩过」卡住「run B 前 40 回合永不压缩」，
 * 并发 run 交替调用还会让计数缓存每次从零重算。
 * 未实现 forRun 的自定义策略原样复用（无状态策略本来就不需要隔离）。
 */
function forkPolicyPerRun(policy: ContextPolicy | undefined): ContextPolicy | undefined {
  return policy?.forRun ? policy.forRun() : policy;
}

/**
 * 循环体核心：带父 span 跑一轮 manual loop。请求失败按 error 收掉 turn 后抛出，由外层收尾。
 *
 * 本体只是「一回合执行步骤」的编排骨架，各步骤的实现见 turn.ts 同名小函数：
 *   checkTurnEntry（回合入口检查 + 上下文策略）→ streamTurn（发流式请求，含重试）
 *   → recordTurnUsage（记账关 span）→ resolveStopReason（stop_reason 收尾分流）
 *   → executeTurnTools（tool_use 过滤与并发执行）。
 * 回合间共享的状态收在 LoopContext 一个对象里（不拖长参数列）。
 */
async function agentLoop<S extends JsonSchema = JsonSchema>(
  args: AgentLoopArgs<S>,
): Promise<AgentLoopResult<SchemaType<S>>> {
  const ctx = buildLoopContext(args);

  let stopReason: AgentStopReason = 'end_turn';
  let error: SpanError | undefined;
  let finalText = '';
  let finished = false;

  for (let iteration = 0; iteration < args.maxIterations; iteration++) {
    const halt = await checkTurnEntry(ctx, iteration);
    if (halt) {
      stopReason = halt.stopReason;
      error = halt.error;
      finished = true;
      break;
    }

    const { turnId, message, aborted } = await streamTurn(ctx);
    if (aborted || !message) {
      stopReason = 'aborted';
      error = abortedError();
      finished = true;
      break;
    }
    ctx.progress.iterations++;

    recordTurnUsage(ctx, turnId, message);

    // 成本硬管控（C1）：本回合 usage 已落账 → 立刻判一次（超限会触发 onExceed 记事件）。
    // 结果**留到「循环是否还要继续」确定后再用**：
    // - 模型本回合自然收尾 → 不因「最后一回合把额度用超了」把已成功的 run 改判失败
    //   （只留 budget.exceeded 事件，可观测）；
    // - 循环还要继续（模型要求调工具）→ 停在这里，不再发下一个请求 = 不再花钱。
    const overBudget = ctx.budget ? ctx.budget.check(args.recorder.snapshot('ok')) : null;

    ctx.messages.push({ role: 'assistant', content: message.content });

    const resolution = resolveStopReason(message, args.maxTokens);
    if (resolution.kind === 'finish') {
      stopReason = resolution.stopReason;
      finalText = resolution.finalText;
      if (resolution.error) error = resolution.error;
      finished = true;
      break;
    }

    const toolResults = await executeTurnTools(ctx, turnId, resolution.toolUses, overBudget);
    if (toolResults.length > 0) ctx.messages.push({ role: 'user', content: toolResults });

    if (ctx.submitted) {
      // submit_result 校验通过：结构化结果落定，循环正常收尾（finalText 取该回合文本，可空）
      stopReason = 'end_turn';
      finalText = textOf(message);
      finished = true;
      break;
    }

    // 超预算且本回合未落定结构化结果：不再发起下一回合，以 budget_exceeded 收尾
    if (overBudget) {
      stopReason = 'budget_exceeded';
      finalText = textOf(message);
      error = budgetError(args, overBudget);
      finished = true;
      break;
    }
  }

  if (!finished) {
    // 循环因 maxIterations 上限退出而非正常终止（所有置 stopReason 的分支都已同时置 finished）。
    // 与 budget_exceeded / refusal 同口径：非正常收尾都带结构化 error（进 run 根 span）。
    stopReason = 'max_iterations';
    error = {
      type: 'max_iterations',
      message: `达到循环上限（maxIterations=${args.maxIterations}）仍未收尾`,
      retryable: false,
    };
  }

  return { stopReason, finalText, error, iterations: ctx.progress.iterations, typed: ctx.typed };
}

/** 主入口：开 run 根 span，循环跑在其下。返回完整 trace（traceId 即 runId）。 */
export async function runAgent<S extends JsonSchema = JsonSchema>(
  options: RunAgentOptions<S>,
): Promise<AgentRunResult<SchemaType<S>>> {
  const recorder = options.recorder ?? new TraceRecorder();
  const rootId = recorder.begin('run', options.runName ?? 'agent.run', null);
  recorder.setAttribute(rootId, 'model', resolveDefaultModel(options.model));
  // 提示词版本化（D4）：版本号落 run 根，便于按版本筛 trace
  if (options.systemVersion) recorder.setAttribute(rootId, 'system.version', options.systemVersion);
  // @Prompt 资产版本（R7）：菜单里各 prompt 的版本表落 run 根 —— 质量回归能定位到具体资产版本
  if (options.promptVersions) {
    const joined = Object.entries(options.promptVersions)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([n, v]) => `${n}@${v}`)
      .join(',');
    if (joined) recorder.setAttribute(rootId, 'prompts.versions', joined);
  }
  // 会话标识（R7 thread 维度）：多轮 run 按 session 聚合；OTLP 侧映射 gen_ai.conversation.id
  if (options.sessionId) recorder.setAttribute(rootId, 'session.id', options.sessionId);
  // 入站链路（spec §9.2 跨进程关联）：把「谁触发了这次 run」记成 run 根的一条 link。
  // 与 `traceId == runId` 共存 —— 上游是被**链接**而不是被继承成父 span，所以本 run
  // 的树永远自洽（上游采样掉/已结束都不影响），因果关系仍然可查。见 core/trace.ts。
  if (options.traceContext) {
    recorder.addLink(rootId, {
      traceId: options.traceContext.traceId,
      ...(options.traceContext.spanId ? { spanId: options.traceContext.spanId } : {}),
    });
  }
  // 生效配置快照（G3）：本 run 真正用着的旋钮写进 run 根 —— 事后能回答
  // 「这条 run 的 maxCostUsd 设了没 / 重试几次」，换参数前后的对比才有据可查。
  // 只记可序列化标量；函数型选项（summarize / estimateTokens）不记内容。
  for (const [k, v] of Object.entries(runConfigSnapshot(options)))
    recorder.setAttribute(rootId, k, v);

  const progress = { iterations: 0 };
  let result: AgentLoopResult<SchemaType<S>>;
  try {
    result = await agentLoop<S>({
      client: options.client ?? createAnthropicClient(),
      model: resolveDefaultModel(options.model),
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      system: options.system,
      messages: options.messages,
      tools: options.tools ?? [],
      recorder,
      parentSpanId: rootId,
      onText: options.onText,
      signal: options.signal,
      retry: options.retry,
      // 按 run 分叉策略实例：per-run 状态（滞回/计数缓存）不跨 run 泄漏
      contextPolicy: forkPolicyPerRun(options.contextPolicy),
      resultSchema: options.resultSchema,
      progress,
      maxTotalTokens: options.maxTotalTokens,
      maxCostUsd: options.maxCostUsd,
      toolTimeoutMs: options.toolTimeoutMs,
      maxToolConcurrency: options.maxToolConcurrency,
      maxEventChars: options.maxEventChars,
      priceOverrides: options.priceOverrides,
      onUnpricedModel: options.onUnpricedModel,
    });
  } catch (e) {
    // 硬写 0 会把「第 3 回合请求失败」报成「一次模型都没调」——按实际进度报
    result = {
      stopReason: 'error',
      finalText: '',
      error: classifyError(e),
      iterations: progress.iterations,
    };
  }

  const runStatus = isSuccessStopReason(result.stopReason) ? 'ok' : 'error';
  recorder.setAttribute(rootId, 'stop_reason', result.stopReason);
  recorder.end(rootId, { status: runStatus, ...(result.error ? { error: result.error } : {}) });
  const trace = recorder.snapshot(runStatus);
  return {
    trace,
    stopReason: result.stopReason,
    finalText: result.finalText,
    iterations: result.iterations,
    error: result.error,
    typed: result.typed,
  };
}

/**
 * 嵌套能力（子 agent）入口：不自开 run 根，llm.turn 挂在给定 parentSpanId 下的同一条 trace。
 * resultSchema 语义与 runAgent 一致（隐藏 submit_result → AgentLoopResult.typed），
 * 供子 agent 产出结构化结果（见 toolkit/subagent.ts 的交回逻辑）。
 */
export async function runAgentScoped<S extends JsonSchema = JsonSchema>(opts: {
  client?: ModelClient;
  system?: SystemParam;
  messages: MessageParam[];
  tools?: AgentTool[];
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  onText?: (delta: string) => void;
  /** 中断信号（由发起它的能力从 ToolRunContext.signal 透传，取消能传播到子 agent） */
  signal?: AbortSignal;
  /** 模型请求重试策略（缺省开启） */
  retry?: RetryOptions | false;
  contextPolicy?: ContextPolicy;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（同 RunAgentOptions.resultSchema） */
  resultSchema?: S;
  /** 单个工具执行超时（毫秒）；同 RunAgentOptions.toolTimeoutMs */
  toolTimeoutMs?: number;
  /** 同回合并行工具上限；同 RunAgentOptions.maxToolConcurrency */
  maxToolConcurrency?: number;
  /** 事件正文截断上限；同 RunAgentOptions.maxEventChars */
  maxEventChars?: number | false;
  /** 价格表覆盖（F1）：由发起它的能力从 ToolRunContext.priceOverrides 透传 */
  priceOverrides?: Record<string, ModelPricing>;
  /** 未定价模型回调（F2）：由发起它的能力透传 */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
  /**
   * 成本硬管控（C1）：由发起它的能力从 ToolRunContext 透传 —— 预算是整条 run 的口径
   * （各级循环共享同一 recorder，按同一份累计账单判断），子循环每回合同样检查；
   * 子循环超限以 stopReason='budget_exceeded' 收尾，由能力层包成 is_error 回主循环，
   * 主循环回合入口的预算检查随即将整条 run 停掉。
   */
  maxTotalTokens?: number;
  /** 成本硬管控（C1）：累计成本（美元）上限；同 maxTotalTokens */
  maxCostUsd?: number;
}): Promise<AgentLoopResult<SchemaType<S>>> {
  return agentLoop<S>({
    client: opts.client ?? createAnthropicClient(),
    model: resolveDefaultModel(opts.model),
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools ?? [],
    recorder: opts.recorder,
    parentSpanId: opts.parentSpanId,
    onText: opts.onText,
    signal: opts.signal,
    retry: opts.retry,
    contextPolicy: forkPolicyPerRun(opts.contextPolicy),
    resultSchema: opts.resultSchema,
    toolTimeoutMs: opts.toolTimeoutMs,
    maxToolConcurrency: opts.maxToolConcurrency,
    maxEventChars: opts.maxEventChars,
    priceOverrides: opts.priceOverrides,
    onUnpricedModel: opts.onUnpricedModel,
    maxTotalTokens: opts.maxTotalTokens,
    maxCostUsd: opts.maxCostUsd,
  });
}

/**
 * 生效配置快照（G3）：把本 run 实际生效的旋钮整理成 run 根的 `config.*` attributes。
 * 只放标量（OTLP/日志/看板都能直接吃）；缺省值也记，这样"没配"与"配了缺省值"可区分于
 * "该项不存在"。函数型选项只记"配没配"，不记函数体。
 */
function runConfigSnapshot(
  options: RunAgentOptions<JsonSchema>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    'config.model': resolveDefaultModel(options.model),
    'config.maxTokens': options.maxTokens ?? DEFAULT_MAX_TOKENS,
    'config.maxIterations': options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
  if (options.maxTotalTokens != null) out['config.maxTotalTokens'] = options.maxTotalTokens;
  if (options.maxCostUsd != null) out['config.maxCostUsd'] = options.maxCostUsd;
  if (options.toolTimeoutMs != null) out['config.toolTimeoutMs'] = options.toolTimeoutMs;
  if (options.maxToolConcurrency != null)
    out['config.maxToolConcurrency'] = options.maxToolConcurrency;
  // 事件截断关掉时记 'off' 而不是 false：`maxEventChars: false` 在日志/看板里
  // 容易被读成「上限为 0」，'off' 一句话说清是**没有上限**
  if (options.maxEventChars != null)
    out['config.maxEventChars'] = options.maxEventChars === false ? 'off' : options.maxEventChars;
  // 重试：记生效的 maxAttempts（0 = 关闭）—— 比记 "custom/default" 更有信息量
  const retryCfg = resolveRetry(options.retry);
  out['config.retry.maxAttempts'] = retryCfg ? retryCfg.maxAttempts : 0;
  const policy: ContextPolicy | undefined = options.contextPolicy;
  if (policy) {
    out['config.contextPolicy'] = true;
    if (policy.budgetTokens != null) out['config.contextPolicy.budgetTokens'] = policy.budgetTokens;
  } else {
    out['config.contextPolicy'] = false;
  }
  // 价格覆盖：只记覆盖了哪几个模型（不记单价 —— 单价在价格表里，重复记会漂移）
  const overridden = options.priceOverrides ? Object.keys(options.priceOverrides) : [];
  if (overridden.length > 0) out['config.priceOverrides'] = overridden.sort().join(',');
  if (options.resultSchema) out['config.resultSchema'] = true;
  return out;
}
