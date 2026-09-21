/**
 * 回合执行机：agentLoop「一回合执行步骤」的全部机制，自 loop.ts 拆出（纯重构，零语义变更）。
 *
 * 分工：loop.ts 留入口与编排骨架（runAgent / runAgentScoped / agentLoop 本体 +
 * 缺省旋钮解析）；本文件装回合内部 —— 回合上下文装配（buildLoopContext）、
 * 回合入口检查（checkTurnEntry）、流式请求与重试（streamTurn）、回合记账
 * （recordTurnUsage）、stop_reason 分流（已外移到 stop-reason.ts）、工具执行
 * （executeTurnTools / executeOneTool）。
 * 依赖方向单向：loop.ts → turn.ts（分层守卫禁环）；两侧共用的类型与 helper
 * （AgentLoopArgs / replaceMessages）在本文件做 module 级 export，供 loop.ts
 * 与测试 import —— 按仓库约定不进 src/index.ts（纯内部实现细节）。textOf 的
 * 规范位置是 text.ts（loop.ts 与 stop-reason.ts 都从那儿取；回本文件取会成环）。
 */

import type {
  Message,
  MessageParam,
  ToolInputSchema,
  ToolParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '../core/message.js';
import type {
  AgentTool,
  ApprovalDecision,
  JsonSchema,
  ModelClient,
  ModelPricing,
  RecorderBackend,
  SchemaType,
} from '../core/tool.js';
import { validateJsonSchema } from '../core/schema.js';
import type { SpanError, SpanId } from '../core/trace.js';
import { isTimeoutError } from '../core/timeout.js';
import { classifyError, isAbortError } from './errors.js';
import { createBudgetGuard } from './budget.js';
import type { BudgetGuard } from './budget.js';
import { mapWithConcurrency, TIMED_OUT, withTimeout } from './concurrency.js';
import { backoffDelay, resolveRetry, retryAllowed, sleep } from './retry.js';
import { buildTurnRequest } from './turn-request.js';
import { buildToolRunContext } from './tool-context.js';
import { toolInputPayload, toolOutputPayload, toolResultBlock } from './tool-events.js';
import type { ToolErrorKind } from './tool-events.js';
import type { ResolvedRetry, RetryOptions } from './retry.js';
import type { AgentStopReason, ContextPolicy, SystemParam } from './types.js';
import { buildPricing, costEstimate, usageFromAnthropic } from './usage.js';

/** 隐藏提交工具名：resultSchema 模式下由 engine 内部追加，不属开发者工具菜单 */
const SUBMIT_RESULT = 'submit_result';

/** resultSchema 模式下追加到 system 末尾的指令 */
const RESULT_INSTRUCTION =
  '本任务要求结构化结果：完成必要的信息收集与工具调用后，必须调用 submit_result 工具提交最终结果' +
  '（input 严格符合该工具的 input_schema）；不要仅以普通文本结束作答。';

/**
 * 把结果提交指令追加到 system 末尾：string 时以空行拼接；SystemTextBlock[] 时
 * 在数组末尾 push 一个无 cache_control 的 text block —— 不污染稳定前缀的缓存 breakpoint。
 */
function appendResultInstruction(system?: SystemParam): SystemParam {
  if (!system) return RESULT_INSTRUCTION;
  if (typeof system === 'string') return `${system}\n\n${RESULT_INSTRUCTION}`;
  return [...system, { type: 'text' as const, text: RESULT_INSTRUCTION }];
}

export interface AgentLoopArgs<S extends JsonSchema = JsonSchema> {
  client: ModelClient;
  model: string;
  maxTokens: number;
  maxIterations: number;
  system?: SystemParam | undefined;
  /** 本轮循环自有消息（内部复制，不改调用方数组） */
  messages: MessageParam[];
  tools: AgentTool[];
  recorder: RecorderBackend;
  /** llm.turn 的父 span（run 根 / 子 agent 的 capability span） */
  parentSpanId: SpanId | null;
  onText?: ((delta: string) => void) | undefined;
  /** 中断信号：中止后不再发起新回合，以 stopReason='aborted' 收尾 */
  signal?: AbortSignal | undefined;
  /** 模型请求重试策略（缺省开启；false 关闭）。见 engine/retry.ts */
  retry?: RetryOptions | false | undefined;
  /** 上下文预算策略（compaction / context editing），每回合发送前调用 */
  contextPolicy?: ContextPolicy | undefined;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（见 RunAgentOptions.resultSchema） */
  resultSchema?: S | undefined;
  /**
   * 模型往返计数的外部持有者。抛错路径（请求失败）也要能报出**已发生**的往返次数，
   * 所以用对象就地累加，而不是只靠返回值。
   */
  progress?: { iterations: number } | undefined;
  /** 成本硬管控（C1）：整条 run 累计 token 上限；记账后判断，超限即停 */
  maxTotalTokens?: number | undefined;
  /** 成本硬管控（C1）：累计成本（美元）上限；依赖价格表，见 createBudgetGuard */
  maxCostUsd?: number | undefined;
  /** 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run */
  toolTimeoutMs?: number | undefined;
  /** 同回合并行工具上限；缺省 Infinity（= 全部并行） */
  maxToolConcurrency?: number | undefined;
  /** 事件正文截断上限；同 RunAgentOptions.maxEventChars（三类事件共用同一个值） */
  maxEventChars?: number | false | undefined;
  /** 价格表覆盖（F1）：覆盖内置单价或给其他 provider 的模型定价 */
  priceOverrides?: Record<string, ModelPricing> | undefined;
  /** 未定价模型回调（F2）：本循环作用域内每模型一次 */
  onUnpricedModel?: ((info: { model: string; spanId: string }) => void) | undefined;
  /** 人工审批决定（HITL）：以 tool_use_id 为键；恢复挂起的 run 时由宿主传入 */
  approvals?: Record<string, ApprovalDecision> | undefined;
}

/**
 * 回合上下文：一次 agentLoop 调用内、跨「一回合执行步骤」共享的全部状态。
 * 可变字段（typed / submitted / progress / messages）由执行步骤就地更新。
 */
export interface LoopContext<S extends JsonSchema = JsonSchema> {
  args: AgentLoopArgs<S>;
  /** 本轮循环自有消息（内部复制，不改调用方数组；各处持同一引用，见 replaceMessages） */
  messages: MessageParam[];
  /** 实际发给 API 的工具表：开发者工具 + resultSchema 模式追加的隐藏 submit_result */
  apiTools: ToolParam[];
  /** resultSchema 模式在末尾追加过提交指令的 system（见 appendResultInstruction） */
  system: SystemParam | undefined;
  retryCfg: ResolvedRetry | null;
  pricing: Record<string, ModelPricing>;
  /** 未定价模型去重（F2）：本循环作用域内每模型只回调一次 */
  unpricedSeen: Set<string>;
  budget: BudgetGuard | undefined;
  progress: { iterations: number };
  /** submit_result 校验通过的结构化结果（先到先得，见 executeOneTool） */
  typed: SchemaType<S> | undefined;
  submitted: boolean;
}

/**
 * 装配回合上下文：resultSchema 模式（隐藏提交工具 + system 指令）、重试配置、
 * 价格表、预算护栏。全是循环开始前的**一次性**准备；
 * 装配冲突（同名 submit_result）与非法单价在这里抛错。
 */
export function buildLoopContext<S extends JsonSchema>(args: AgentLoopArgs<S>): LoopContext<S> {
  // resultSchema 模式：追加隐藏 submit_result 工具 + system 末尾指令。
  // 该工具由 engine 内部注入，不属开发者菜单；菜单已有同名工具视为装配冲突。
  let apiTools = args.tools.map(toApiTool);
  let system = args.system;
  if (args.resultSchema) {
    if (args.tools.some((t) => t.name === SUBMIT_RESULT)) {
      throw new Error(
        `装配冲突：工具菜单已含 "${SUBMIT_RESULT}"，与 resultSchema 的隐藏提交工具同名`,
      );
    }
    apiTools = [
      ...apiTools,
      {
        name: SUBMIT_RESULT,
        description: '任务完成时调用它提交最终结构化结果（input 必须符合本工具的 input_schema）',
        input_schema: args.resultSchema as unknown as ToolInputSchema,
      },
    ];
    system = appendResultInstruction(args.system);
  }

  const retryCfg = resolveRetry(args.retry);
  // 价格表（F1）：每次循环解析一次 —— 非法单价在 buildPricing 里立刻抛错（不静默算 NaN）
  const pricing = buildPricing(args.priceOverrides);

  // 成本硬管控（C1）：从数值选项就地装配（把「超限」记进 run 根 span 的事件）。
  // 只在记账完成后判断 —— 见 agentLoop 里 overBudget 的用法（何时「停」、何时只记事件）。
  const budget =
    args.maxTotalTokens != null || args.maxCostUsd != null
      ? createBudgetGuard({
          maxTotalTokens: args.maxTotalTokens,
          maxCostUsd: args.maxCostUsd,
          onExceed: (snap) => {
            // 观测是辅助动作：记事件失败不得把「超限」这件事变成崩溃
            try {
              if (args.parentSpanId)
                args.recorder.event(args.parentSpanId, 'budget.exceeded', snap);
            } catch {
              /* ignore */
            }
          },
        })
      : undefined;

  return {
    args,
    messages: [...args.messages],
    apiTools,
    system,
    retryCfg,
    pricing,
    unpricedSeen: new Set<string>(),
    budget,
    progress: args.progress ?? { iterations: 0 }, // 就地累加，抛错时调用方仍读得到
    typed: undefined,
    submitted: false,
  };
}

/** 超限收尾的结构化 error：与 refusal / max_tokens 同口径（非正常收尾都带「为什么」） */
export function budgetError<S extends JsonSchema>(
  args: AgentLoopArgs<S>,
  over: 'tokens' | 'cost',
): SpanError {
  return {
    type: 'budget_exceeded',
    message:
      over === 'tokens'
        ? `累计 token 已超过上限 ${args.maxTotalTokens}`
        : `累计成本已超过上限 $${args.maxCostUsd}`,
    retryable: false,
  };
}

/** 中止收尾的结构化 error（回合入口检查与回合中途两处共用，文案一致） */
export function abortedError(): SpanError {
  return { type: 'aborted', message: 'run 已被取消', retryable: false };
}

/** 回合入口的终止结论：已取消或预算已在回合间被推超（都带结构化 error） */
export interface EntryHalt {
  stopReason: AgentStopReason;
  error: SpanError;
}

/**
 * 回合入口检查：已取消 / 预算已被上一回合的工具执行推超 → 给出终止结论；
 * 否则给上下文策略一个机会（编辑/压缩预算超限的历史），返回 null 继续本回合。
 */
export async function checkTurnEntry<S extends JsonSchema>(
  ctx: LoopContext<S>,
  iteration: number,
): Promise<EntryHalt | null> {
  const { args, messages } = ctx;
  // 调用方已取消：不再发起新回合，直接以 aborted 收尾（不抛异常，语义确定）
  if (args.signal?.aborted) {
    return { stopReason: 'aborted', error: abortedError() };
  }
  // 成本硬管控（C1）回合入口再判一次：上一回合的**工具执行**（子 agent 循环等嵌套能力）
  // 可能已把整条 run 的累计用量推过上限（回合末的那次判断当时还没超）—— 在发起新
  // 请求前拦住：不再发请求 = 不再花钱。与「模型自然收尾不改判」不冲突：自然收尾在
  // 上一回合就 break 了，走不到这里。
  if (ctx.budget) {
    const over = ctx.budget.check({ totalUsage: args.recorder.usage() });
    if (over) {
      return { stopReason: 'budget_exceeded', error: budgetError(args, over) };
    }
  }
  // 发送前给上下文策略一个机会（编辑/压缩预算超限的历史）
  if (args.contextPolicy) {
    const next = await args.contextPolicy.beforeTurn(messages, {
      iteration,
      model: args.model,
    });
    if (next && next !== messages) {
      if (args.parentSpanId) {
        args.recorder.event(args.parentSpanId, 'context.budget', {
          from: messages.length,
          to: next.length,
          model: args.model,
        });
      }
      replaceMessages(messages, next);
    }
  }
  return null;
}

/** 一回合的模型请求结果：turn span id + 成功时的 finalMessage；aborted 表示中途被取消 */
export interface TurnOutcome {
  turnId: SpanId;
  /** 模型响应；请求失败/中断时为 undefined（字段在场，见 core/run.ts 的说明） */
  message: Message | undefined;
  aborted: boolean;
}

/**
 * —— 一次逻辑回合：可能含多次尝试（重试）；每次尝试开自己的 llm.turn span ——
 * 可重试失败按 retryCfg 退避后重试（已吐出文本的尝试不重试，否则会重复输出）；
 * 不可重试的失败原样抛出，由外层（runAgent / 子 agent 运行器）标记根/capability 并收尾。
 */
export async function streamTurn<S extends JsonSchema>(ctx: LoopContext<S>): Promise<TurnOutcome> {
  const { args } = ctx;
  const signal = args.signal;
  const retryCfg = ctx.retryCfg;
  let turnId: SpanId = '';
  let message: Message | undefined;
  let aborted = false;
  let emitted = false; // 本回合是否已吐出过文本（吐过就不能重试，否则会重复输出）
  for (let attempt = 1; ; attempt++) {
    turnId = args.recorder.begin('llm.turn', args.model, args.parentSpanId);
    if (attempt > 1) args.recorder.setAttribute(turnId, 'retry.attempt', attempt);
    try {
      // 请求装配外移到 turn-request.ts（三个条件展开的「键在场与否」是语义，单测钉住）
      const stream = args.client.messages.stream(
        buildTurnRequest({
          model: args.model,
          maxTokens: args.maxTokens,
          system: ctx.system,
          apiTools: ctx.apiTools,
          messages: ctx.messages,
          signal,
        }),
      );
      stream.on('text', (delta) => {
        emitted = true;
        try {
          args.onText?.(delta);
        } catch {
          /* 观测是辅助动作：回调抛错不得影响 run（与 onUnpricedModel 同口径） */
        }
      });
      message = await stream.finalMessage();
      break;
    } catch (e) {
      const errInfo = classifyError(e);
      args.recorder.end(turnId, { status: 'error', error: errInfo });
      // 中断：不冒泡、不重试 —— 以确定语义收尾
      if (isAbortError(e) || signal?.aborted) {
        aborted = true;
        break;
      }
      // 可重试：配置允许 + 次数未尽 + 判定可重试 + 本次尝试未产出任何文本
      const canRetry = retryAllowed(retryCfg, attempt, e, emitted);
      // 后半句只为让 TS 收窄：canRetry 为真时 retryCfg 必然非 null（合取的第一项），但**收窄不会
      // 穿过变量**，而下面几行要用 retryCfg 的字段（backoffDelay / onRetry）。语义与抽取前一致。
      if (!canRetry || retryCfg === null) throw e; // 冒泡：runAgent 或子 agent 运行器负责收尾
      const delayMs = backoffDelay(attempt, retryCfg);
      args.recorder.event(turnId, 'llm.retry', { attempt, delayMs, error: errInfo.type });
      try {
        retryCfg.onRetry({ attempt, delayMs, error: errInfo });
      } catch {
        /* 观测是辅助动作：回调抛错不得影响 run（与 onUnpricedModel 同口径） */
      }
      try {
        await sleep(delayMs, signal);
      } catch {
        aborted = true; // 退避期间被取消
        break;
      }
    }
  }
  return { turnId, message, aborted };
}

/**
 * 回合记账：usage 换算 + 成本估算（未定价记事件 + 回调）+ 关 llm.turn span + token 属性。
 * 预算护栏依赖「记账完成后」的 usage 累计，所以本函数必须先于任何 budget.check 调用。
 */
export function recordTurnUsage<S extends JsonSchema>(
  ctx: LoopContext<S>,
  turnId: SpanId,
  message: Message,
): void {
  const { args } = ctx;
  const usage = message.usage ? usageFromAnthropic(message.usage) : undefined;
  if (usage) {
    const cost = costEstimate(args.model, usage, ctx.pricing);
    usage.costEstimate = cost;
    // 未定价（F2）：模型不在价格表内 → 显式记事件 + 回调，别让 maxCostUsd 静默失效
    if (cost === undefined) {
      args.recorder.event(turnId, 'usage.unpriced', { model: args.model });
      if (!ctx.unpricedSeen.has(args.model)) {
        ctx.unpricedSeen.add(args.model);
        try {
          args.onUnpricedModel?.({ model: args.model, spanId: turnId });
        } catch {
          /* 观测是辅助动作：回调抛错不得影响 run */
        }
      }
    }
  }
  args.recorder.end(turnId, { usage });
  args.recorder.setAttribute(turnId, 'input_tokens', usage?.inputTokens ?? 0);
  args.recorder.setAttribute(turnId, 'output_tokens', usage?.outputTokens ?? 0);
  args.recorder.setAttribute(turnId, 'cache_read_tokens', usage?.cacheReadTokens ?? 0);
  args.recorder.setAttribute(turnId, 'cache_creation_tokens', usage?.cacheCreationTokens ?? 0);
}

/** 回合收尾分流：finish = 终止/边界分支（带 stopReason 与收尾文本）；tools = 还有工具要执行 */
/**
 * 回合工具执行的结果：
 * - `executed`：全部执行完（results 与输入一一对应，顺序保持）；
 * - `suspended`：有需审批的 tool_use 还没有决定 ⇒ **整回合一个工具都没执行**
 *   （全有或全无，见下），`pending` 是缺决定的 tool_use_id 列表，由 loop 收尾为挂起。
 */
export type TurnToolsOutcome =
  | { kind: 'executed'; results: ToolResultBlockParam[] }
  | { kind: 'suspended'; pending: string[] };

/**
 * —— 执行工具：默认全并行，可由 maxToolConcurrency 收窄（C2）；
 *    单条 user 消息回全部 tool_result（抑制并行是反模式）——
 * submit_result 校验通过会就地更新 ctx.typed / ctx.submitted（先到先得，见 executeOneTool）。
 *
 * 审批闸（HITL，**回合级全有或全无**）：任何一个标了 `approval: 'required'` 的
 * tool_use 在 `args.approvals` 里没有决定 ⇒ 整回合**一个工具都不执行**、不推任何
 * tool_result（Anthropic 协议要求每个 tool_use 都有配对 tool_result —— 部分执行 +
 * 部分挂起会产出协议上残缺的历史），记 `approval.requested` 事件后交 loop 挂起。
 * 两类例外不参与审批：隐藏的 submit_result（不在 args.tools 里，是纯内部提交、
 * 永不需审批）与未知工具（走既有 unknown_tool 路径）。
 */
export async function executeTurnTools<S extends JsonSchema>(
  ctx: LoopContext<S>,
  turnId: SpanId,
  toolUses: ToolUseBlock[],
  overBudget: 'tokens' | 'cost' | null,
): Promise<TurnToolsOutcome> {
  const { args } = ctx;
  if (!overBudget) {
    const pending = toolUses.filter((use) => {
      const tool = args.tools.find((t) => t.name === use.name);
      return tool?.approval === 'required' && args.approvals?.[use.id] === undefined;
    });
    if (pending.length > 0) {
      args.recorder.event(turnId, 'approval.requested', {
        tool_use_ids: pending.map((u) => u.id),
        tools: pending.map((u) => u.name),
      });
      return { kind: 'suspended', pending: pending.map((u) => u.id) };
    }
  }
  // 成本硬管控（C1）：走得到这里说明循环还要继续（模型要求调工具）—— 超限就停，
  // 连带不执行这批工具（避免超预算的 run 继续产生副作用）。已产出的文本保留。
  // 例外：submit_result 是纯内部的结构化提交（零副作用、不触外部系统），超预算也照常
  // 处理本回合的它 —— 模型已经把最终结果交出来了，连同回合一起丢弃等于白烧这一回合
  // （与「自然收尾不因超预算改判失败」同口径）。
  const runnable = overBudget
    ? toolUses.filter((u) => args.resultSchema !== undefined && u.name === SUBMIT_RESULT)
    : toolUses;

  const results = await mapWithConcurrency(
    runnable,
    args.maxToolConcurrency ?? Number.POSITIVE_INFINITY,
    (use) => executeOneTool(ctx, turnId, use),
  );
  return { kind: 'executed', results };
}

/**
 * 执行单个工具调用（含隐藏 submit_result 分支），产出该条的 tool_result 块。
 * 工具的 tool.input / tool.output 事件都记在本回合的 turn span 上（tool_use_id 配对）。
 */
async function executeOneTool<S extends JsonSchema>(
  ctx: LoopContext<S>,
  turnId: SpanId,
  use: ToolUseBlock,
): Promise<ToolResultBlockParam> {
  const { args } = ctx;
  const tool = args.tools.find((t) => t.name === use.name);
  // HITL：需审批工具的决定（到达这里说明决定已在 —— 未决的整回合在
  // executeTurnTools 的审批闸被拦下，不会走到单工具执行）。
  const decision = tool?.approval === 'required' ? args.approvals?.[use.id] : undefined;
  // 工具级时序（E1）：起点在事件之前 —— durationMs 覆盖「入参校验 + 执行 + 超时等待」
  // 的完整处理时长，是「哪一步慢」的可信基线。并行工具各记各的（tool_use_id 配对）。
  const toolStartedAt = Date.now();
  // tool_use_id 一并记账：同名工具并行时，重放只有靠 id 才能把入参出参正确配对
  args.recorder.event(turnId, 'tool.input', toolInputPayload(use, args.maxEventChars));
  // 审批决定的审计账（HITL）：谁、什么时候、以什么理由批/拒，等审批等了多久。
  // waitedMs 需要 requestedAt（挂起时刻，由宿主在挂起时回填）—— 手工直传
  // approvals 而没有 requestedAt 时不记 waitedMs（不编造）。
  if (decision) {
    args.recorder.event(turnId, 'approval.decided', {
      tool: use.name,
      tool_use_id: use.id,
      approved: decision.approved,
      ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(decision.decidedAt !== undefined && decision.requestedAt !== undefined
        ? { waitedMs: Math.max(0, decision.decidedAt - decision.requestedAt) }
        : {}),
    });
  }

  // 超时「放弃等待」时的通知信号（见 ToolRunContext.abandoned）：控制器随本次
  // 调用创建、随调用消亡，只在 withTimeout 判超时的分支里 abort。
  const abandonAc = new AbortController();
  // 上下文装配外移到 tool-context.ts：八处条件展开各自对应一个「漏了就静默降级」的守卫
  const toolCtx = buildToolRunContext({
    client: args.client,
    recorder: args.recorder,
    parentSpanId: turnId,
    abandoned: abandonAc.signal,
    signal: args.signal,
    priceOverrides: args.priceOverrides,
    onUnpricedModel: args.onUnpricedModel,
    maxEventChars: args.maxEventChars,
    maxTotalTokens: args.maxTotalTokens,
    maxCostUsd: args.maxCostUsd,
    toolTimeoutMs: args.toolTimeoutMs,
    approval: decision,
  });
  let ok = true;
  let content: unknown = '';
  // 失败归类（E1）：只记「为什么没成」，不记栈 —— 观测看得清「哪个工具老超时」。
  // 'denied'（HITL）：审批被拒绝 —— 不是工具故障，是**人**的决定，单列一类账。
  let errorKind: ToolErrorKind | undefined;
  if (args.resultSchema && use.name === SUBMIT_RESULT) {
    // 隐藏提交工具：校验通过即携结果收尾（循环在 agentLoop 下方 break）；
    // 校验失败回 is_error（含路径，模型可自我修正），同回合其他工具照常执行。
    // 校验本身也在 try 内：畸形 resultSchema（$ref 成环等）只该废掉这一次提交，
    // 不该让整次 run 以 error 收场（否则 trace 把该回合记成 ok，与 run 结论矛盾）。
    try {
      const invalid = validateJsonSchema(args.resultSchema, use.input);
      if (invalid) {
        ok = false;
        errorKind = 'invalid_input';
        content = `invalid input: ${invalid}`;
      } else {
        content = 'submitted';
        // 同回合并行多个 submit_result：**先到先得**（首个校验通过的生效，后续忽略）——
        // 不 guarded 赋值的话 typed 由并发完成顺序竞态决定，同输入可能产出不同结果
        if (!ctx.submitted) {
          // 模型提交的 input 已过 resultSchema 校验 → 断言为 SchemaType<S>（信任边界在此）
          ctx.typed = use.input as SchemaType<S>;
          ctx.submitted = true;
        }
      }
    } catch (e) {
      ok = false;
      errorKind = 'threw';
      const err = classifyError(e);
      content = `error(${err.type}): ${err.message}`;
    }
  } else if (!tool) {
    ok = false;
    errorKind = 'unknown_tool';
    content = `unknown tool: ${use.name}`;
  } else if (decision && !decision.approved) {
    // HITL 拒绝：不执行（副作用不发生），理由写进 tool_result 回给模型 ——
    // 模型看得到「为什么被拒」，可自行换路（与「工具抛错不中断 run」同语义）。
    ok = false;
    errorKind = 'denied';
    content = `审批被拒绝：${decision.reason ?? '未给出理由'}`;
  } else {
    // 模型给的 input 先过 schema 校验：不合法直接回 is_error（含路径，
    // 模型可自我修正），不进方法体 —— schema 是方法与模型间的运行时契约。
    // 校验本身也在 try 内：畸形 schema（$ref 成环等）只该废掉这一个调用，
    // 不该让整次 run 以 error 收场。
    try {
      const invalid = validateJsonSchema(tool.inputSchema, use.input);
      if (invalid) {
        ok = false;
        errorKind = 'invalid_input';
        content = `invalid input: ${invalid}`;
      } else {
        // 工具级超时（C2）：超时 = **放弃等待**（AgentTool.run 没有 signal 参数，
        // 工具内部可能还在跑、副作用可能已发生），该条 tool_result 记 is_error 回模型
        // —— 与「工具抛错不中断 run」同语义，模型可自行换路。
        const out = await withTimeout(
          Promise.resolve(tool.run(use.input, toolCtx)),
          args.toolTimeoutMs ?? 0,
        );
        if (out === TIMED_OUT) {
          // 放弃等待 ≠ 取消：通知工具「没人等结果了」（@SubAgent/@Skill 靠它中止
          // 子循环、立刻收尾 capability span；见 ToolRunContext.abandoned）
          abandonAc.abort();
          ok = false;
          errorKind = 'timeout';
          content = `error(timeout): 工具执行超过 ${args.toolTimeoutMs}ms`;
        } else {
          content = out;
        }
      }
    } catch (e) {
      ok = false;
      if (isTimeoutError(e)) {
        // 工具**自判**的超时（`code='timeout'`，如 MCP 桥的兜底路径）与引擎判的超时归同一类账：
        // 同一个物理事件不该因为「谁先到」而变成两种 errorKind（此前是 threw + error(unknown)）。
        errorKind = 'timeout';
        content = `error(timeout): ${e instanceof Error ? e.message : String(e)}`;
      } else {
        errorKind = 'threw';
        const err = classifyError(e);
        content = `error(${err.type}): ${err.message}`;
      }
    }
  }
  // 记账面外移到 tool-events.ts：截断上限不对称（失败更短）、耗时四路径都记且非负、errorKind 有值才在场
  args.recorder.event(
    turnId,
    'tool.output',
    toolOutputPayload({
      use,
      ok,
      errorKind,
      startedAt: toolStartedAt,
      now: Date.now(),
      content,
      maxEventChars: args.maxEventChars,
    }),
  );

  return toolResultBlock(use, ok, content);
}

function toApiTool(t: AgentTool): ToolParam {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as unknown as ToolInputSchema,
    ...(t.strict ? { strict: true } : {}),
  };
}

/**
 * 用 `next` 原地替换 `target` 的全部内容（保持数组引用不变 —— 循环各处持同一数组）。
 *
 * **不要**写回 `target.splice(0, target.length, ...next)`：展开传参受 V8 实参个数上限
 * 约束，`next` 超过约 12 万项即抛 `RangeError: Maximum call stack size exceeded`
 * （实测 12 万 ok、30 万抛）。`next` 来自调用方注入的 `contextPolicy`，长度不受框架
 * 控制，所以用循环逐项写，彻底没有这个上限。
 */
export function replaceMessages(target: MessageParam[], next: readonly MessageParam[]): void {
  target.length = 0;
  for (const m of next) target.push(m);
}
