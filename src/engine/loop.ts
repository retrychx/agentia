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
import type { AgentLoopResult } from './loop-result.js';
import { abortedResult, failedResult, finishedResult, suspendedResult } from './loop-result.js';
import { tailToolUses, textOfParam } from './resume-input.js';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  resolveDefaultModel,
  runConfigSnapshot,
} from './run-config.js';
import type { RetryOptions } from './retry.js';
import { TraceRecorder } from './tracer.js';
import {
  abortedError,
  budgetError,
  buildLoopContext,
  checkTurnEntry,
  executeTurnTools,
  recordTurnUsage,
  streamTurn,
} from './turn.js';
import { textOf } from './text.js';
import { resolveStopReason } from './stop-reason.js';
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
 * run 根的装配；「一回合执行步骤」的实现机（回合上下文、请求/重试、记账、stop_reason
 * 分流、工具执行）拆在同层 turn.ts，「缺省旋钮解析 + 生效配置快照」拆在同层
 * run-config.ts，「出口的结果形状」拆在同层 loop-result.ts ——
 * 「续跑入口的读取件」拆在同层 resume-input.ts ——
 * 依赖方向单向 loop.ts → { turn.ts, run-config.ts, loop-result.ts, resume-input.ts }。
 */

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

  // 恢复模式（HITL 挂起续跑，也是通用续跑入口）：messages 末尾是含 tool_use 的
  // assistant 消息 ⇒ 这些 tool_use 尚未解决。跳过模型请求，先把它们解决掉再进正常
  // 循环 —— assistant 消息已在历史里，**不重复 push**。决定仍不齐则再次挂起
  // （不发请求、零花费）。
  const resumeUses = tailToolUses(ctx.messages);
  if (resumeUses.length > 0) {
    // 已取消：不执行任何工具（副作用不该在取消后发生），按 aborted 收尾
    if (args.signal?.aborted) {
      return abortedResult();
    }
    // 工具事件记到父 span：被恢复的回合属于挂起段的旧 trace，本段没有对应 llm.turn
    const outcome = await executeTurnTools(ctx, args.parentSpanId ?? '', resumeUses, null);
    if (outcome.kind === 'suspended') {
      return suspendedResult(ctx, outcome.pending);
    }
    if (outcome.results.length > 0) ctx.messages.push({ role: 'user', content: outcome.results });
    if (ctx.submitted) {
      // 恢复的回合里 submit_result 校验通过：直接落定（finalText 取该 assistant 消息的文本块）
      const tail = ctx.messages[ctx.messages.length - 2]; // 刚 push 了 tool_results，前一条是那条 assistant
      // iterations 0：本段没发过模型请求（恢复的工具执行不计往返）
      return finishedResult({
        stopReason: 'end_turn',
        finalText: tail ? textOfParam(tail) : '',
        iterations: 0,
        typed: ctx.typed,
      });
    }
  }

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
    const overBudget = ctx.budget ? ctx.budget.check({ totalUsage: args.recorder.usage() }) : null;

    ctx.messages.push({ role: 'assistant', content: message.content });

    const resolution = resolveStopReason(message, args.maxTokens);
    if (resolution.kind === 'finish') {
      stopReason = resolution.stopReason;
      finalText = resolution.finalText;
      if (resolution.error) error = resolution.error;
      finished = true;
      break;
    }

    const outcome = await executeTurnTools(ctx, turnId, resolution.toolUses, overBudget);
    if (outcome.kind === 'suspended') {
      // HITL 挂起：assistant 消息（含未决 tool_use）已在历史里、**不推任何 tool_result**
      // （全有或全无，见 executeTurnTools 的审批闸）；approval.requested 已记在 turn span 上。
      // error 保持 undefined —— 挂起不是失败。
      stopReason = 'awaiting_approval';
      finalText = textOf(message);
      return suspendedResult(ctx, outcome.pending, finalText);
    }
    if (outcome.results.length > 0) ctx.messages.push({ role: 'user', content: outcome.results });

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

  return finishedResult({
    stopReason,
    finalText,
    iterations: ctx.progress.iterations,
    typed: ctx.typed,
    error,
  });
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
      approvals: options.approvals,
    });
  } catch (e) {
    // 硬写 0 会把「第 3 回合请求失败」报成「一次模型都没调」——按实际进度报
    result = failedResult(e, progress.iterations);
  }

  // awaiting_approval 不是失败：挂起段本身执行无误（「等人」不该被看板算成「失败」），
  // trace 记 ok；它与成功的区分由 stop_reason attribute 承担。
  const runStatus =
    result.stopReason === 'awaiting_approval' || isSuccessStopReason(result.stopReason)
      ? 'ok'
      : 'error';
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
    suspendedMessages: result.suspendedMessages,
    pendingApprovals: result.pendingApprovals,
  };
}

/**
 * 嵌套能力（子 agent）入口：不自开 run 根，llm.turn 挂在给定 parentSpanId 下的同一条 trace。
 * resultSchema 语义与 runAgent 一致（隐藏 submit_result → AgentLoopResult.typed），
 * 供子 agent 产出结构化结果（见 toolkit/subagent.ts 的交回逻辑）。
 */
export async function runAgentScoped<S extends JsonSchema = JsonSchema>(opts: {
  client?: ModelClient | undefined;
  system?: SystemParam | undefined;
  messages: MessageParam[];
  tools?: AgentTool[] | undefined;
  model?: string | undefined;
  maxTokens?: number | undefined;
  maxIterations?: number | undefined;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  onText?: ((delta: string) => void) | undefined;
  /** 中断信号（由发起它的能力从 ToolRunContext.signal 透传，取消能传播到子 agent） */
  signal?: AbortSignal | undefined;
  /** 模型请求重试策略（缺省开启） */
  retry?: RetryOptions | false | undefined;
  contextPolicy?: ContextPolicy | undefined;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（同 RunAgentOptions.resultSchema） */
  resultSchema?: S | undefined;
  /** 单个工具执行超时（毫秒）；同 RunAgentOptions.toolTimeoutMs */
  toolTimeoutMs?: number | undefined;
  /** 同回合并行工具上限；同 RunAgentOptions.maxToolConcurrency */
  maxToolConcurrency?: number | undefined;
  /** 事件正文截断上限；同 RunAgentOptions.maxEventChars */
  maxEventChars?: number | false | undefined;
  /** 价格表覆盖（F1）：由发起它的能力从 ToolRunContext.priceOverrides 透传 */
  priceOverrides?: Record<string, ModelPricing> | undefined;
  /** 未定价模型回调（F2）：由发起它的能力透传 */
  onUnpricedModel?: ((info: { model: string; spanId: string }) => void) | undefined;
  /**
   * 成本硬管控（C1）：由发起它的能力从 ToolRunContext 透传 —— 预算是整条 run 的口径
   * （各级循环共享同一 recorder，按同一份累计账单判断），子循环每回合同样检查；
   * 子循环超限以 stopReason='budget_exceeded' 收尾，由能力层包成 is_error 回主循环，
   * 主循环回合入口的预算检查随即将整条 run 停掉。
   */
  maxTotalTokens?: number | undefined;
  /** 成本硬管控（C1）：累计成本（美元）上限；同 maxTotalTokens */
  maxCostUsd?: number | undefined;
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
