import Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, JsonSchema, ModelClient, ModelPricing, RecorderBackend, SchemaType, ToolRunContext } from '../core/tool.js';
import { validateJsonSchema } from '../core/schema.js';
import { stringifySafe, truncateWithMark } from '../core/json.js';
import type { SpanError, SpanId } from '../core/trace.js';
import { classifyError, isAbortError } from './errors.js';
import { createBudgetGuard } from './budget.js';
import { mapWithConcurrency, TIMED_OUT, withTimeout } from './concurrency.js';
import { backoffDelay, resolveRetry, sleep } from './retry.js';
import type { RetryOptions } from './retry.js';
import { TraceRecorder } from './tracer.js';
import type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  RunAgentOptions,
  SystemParam,
} from './types.js';
import { isSuccessStopReason } from './types.js';
import { buildPricing, costEstimate, usageFromAnthropic } from './usage.js';

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
 * 也能当子 agent（unit span 为其父，见 toolkit/subagent.ts），llm.turn 与 usage
 * 递归进同一条 trace（spec §9：子 agent = 一个 unit span，内部单元递归成它的子孙）。
 *
 * 工具执行经 ctx: ToolRunContext 把 {client, recorder, parentSpanId: 当前 turn}
 * 交给 tool.run —— 普通工具忽略；子 agent 用它在正确位置开 unit span。
 */

interface AgentLoopArgs<S extends JsonSchema = JsonSchema> {
  client: ModelClient;
  model: string;
  maxTokens: number;
  maxIterations: number;
  system?: SystemParam;
  /** 本轮循环自有消息（内部复制，不改调用方数组） */
  messages: Anthropic.MessageParam[];
  tools: AgentTool[];
  recorder: RecorderBackend;
  /** llm.turn 的父 span（run 根 / 子 agent 的 unit span） */
  parentSpanId: SpanId | null;
  onText?: (delta: string) => void;
  /** 中断信号：中止后不再发起新回合，以 stopReason='aborted' 收尾 */
  signal?: AbortSignal;
  /** 模型请求重试策略（缺省开启；false 关闭）。见 engine/retry.ts */
  retry?: RetryOptions | false;
  /** 上下文预算策略（compaction / context editing），每回合发送前调用 */
  contextPolicy?: ContextPolicy;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（见 RunAgentOptions.resultSchema） */
  resultSchema?: S;
  /**
   * 模型往返计数的外部持有者。抛错路径（请求失败）也要能报出**已发生**的往返次数，
   * 所以用对象就地累加，而不是只靠返回值。
   */
  progress?: { iterations: number };
  /** 成本硬管控（C1）：整条 run 累计 token 上限；记账后判断，超限即停 */
  maxTotalTokens?: number;
  /** 成本硬管控（C1）：累计成本（美元）上限；依赖价格表，见 createBudgetGuard */
  maxCostUsd?: number;
  /** 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run */
  toolTimeoutMs?: number;
  /** 同回合并行工具上限；缺省 Infinity（= 全部并行） */
  maxToolConcurrency?: number;
  /** 价格表覆盖（F1）：覆盖内置单价或给其他 provider 的模型定价 */
  priceOverrides?: Record<string, ModelPricing>;
  /** 未定价模型回调（F2）：本循环作用域内每模型一次 */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
}

export interface AgentLoopResult<T = unknown> {
  stopReason: AgentStopReason;
  finalText: string;
  error?: SpanError;
  /** 本轮循环自己发起的模型往返次数 */
  iterations: number;
  /** submit_result 校验通过的结构化结果；未提交则为 undefined（类型由 resultSchema 推导） */
  typed?: T;
}

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

/** 循环体核心：带父 span 跑一轮 manual loop。请求失败按 error 收掉 turn 后抛出，由外层收尾。 */
async function agentLoop<S extends JsonSchema = JsonSchema>(
  args: AgentLoopArgs<S>,
): Promise<AgentLoopResult<SchemaType<S>>> {
  const { client, model, recorder, parentSpanId } = args;
  const messages: Anthropic.MessageParam[] = [...args.messages];

  // resultSchema 模式：追加隐藏 submit_result 工具 + system 末尾指令。
  // 该工具由 engine 内部注入，不属开发者菜单；菜单已有同名工具视为装配冲突。
  let apiTools = args.tools.map(toApiTool);
  let system = args.system;
  if (args.resultSchema) {
    if (args.tools.some((t) => t.name === SUBMIT_RESULT)) {
      throw new Error(`装配冲突：工具菜单已含 "${SUBMIT_RESULT}"，与 resultSchema 的隐藏提交工具同名`);
    }
    apiTools = [
      ...apiTools,
      {
        name: SUBMIT_RESULT,
        description: '任务完成时调用它提交最终结构化结果（input 必须符合本工具的 input_schema）',
        input_schema: args.resultSchema as unknown as Anthropic.Tool.InputSchema,
      },
    ];
    system = appendResultInstruction(args.system);
  }

  let stopReason: AgentStopReason = 'end_turn';
  let error: SpanError | undefined;
  let finalText = '';
  let finished = false;
  const progress = args.progress ?? { iterations: 0 }; // 就地累加，抛错时调用方仍读得到
  let typed: SchemaType<S> | undefined;
  let submitted = false;

  const signal = args.signal;
  const retryCfg = resolveRetry(args.retry);
  // 价格表（F1）：每次循环解析一次 —— 非法单价在 buildPricing 里立刻抛错（不静默算 NaN）
  const pricing = buildPricing(args.priceOverrides);
  // 未定价模型去重（F2）：本循环作用域内每模型只回调一次
  const unpricedSeen = new Set<string>();

  // 成本硬管控（C1）：从数值选项就地装配（把「超限」记进 run 根 span 的事件）。
  // 只在记账完成后判断 —— 见下面 overBudget 的用法（何时「停」、何时只记事件）。
  const budget =
    args.maxTotalTokens != null || args.maxCostUsd != null
      ? createBudgetGuard({
          maxTotalTokens: args.maxTotalTokens,
          maxCostUsd: args.maxCostUsd,
          onExceed: (snap) => {
            // 观测是辅助动作：记事件失败不得把「超限」这件事变成崩溃
            try {
              if (parentSpanId) recorder.event(parentSpanId, 'budget.exceeded', snap);
            } catch {
              /* ignore */
            }
          },
        })
      : undefined;

  for (let iteration = 0; iteration < args.maxIterations; iteration++) {
    // 调用方已取消：不再发起新回合，直接以 aborted 收尾（不抛异常，语义确定）
    if (signal?.aborted) {
      stopReason = 'aborted';
      error = { type: 'aborted', message: 'run 已被取消', retryable: false };
      finished = true;
      break;
    }
    // 发送前给上下文策略一个机会（编辑/压缩预算超限的历史）
    if (args.contextPolicy) {
      const next = await args.contextPolicy.beforeTurn(messages, { iteration, model });
      if (next && next !== messages) {
        if (parentSpanId) {
          recorder.event(parentSpanId, 'context.budget', {
            from: messages.length,
            to: next.length,
            model,
          });
        }
        replaceMessages(messages, next);
      }
    }

    // —— 一次逻辑回合：可能含多次尝试（重试）；每次尝试开自己的 llm.turn span ——
    let turnId: SpanId = '';
    let message: Anthropic.Message | undefined;
    let aborted = false;
    let emitted = false; // 本回合是否已吐出过文本（吐过就不能重试，否则会重复输出）
    for (let attempt = 1; ; attempt++) {
      turnId = recorder.begin('llm.turn', model, parentSpanId);
      if (attempt > 1) recorder.setAttribute(turnId, 'retry.attempt', attempt);
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: args.maxTokens,
          ...(system ? { system } : {}),
          ...(apiTools.length ? { tools: apiTools } : {}),
          messages,
          ...(signal ? { signal } : {}),
        });
        stream.on('text', (delta) => {
          emitted = true;
          args.onText?.(delta);
        });
        message = await stream.finalMessage();
        break;
      } catch (e) {
        const errInfo = classifyError(e);
        recorder.end(turnId, { status: 'error', error: errInfo });
        // 中断：不冒泡、不重试 —— 以确定语义收尾
        if (isAbortError(e) || signal?.aborted) {
          aborted = true;
          break;
        }
        // 可重试：配置允许 + 次数未尽 + 判定可重试 + 本次尝试未产出任何文本
        const canRetry =
          retryCfg !== null && attempt < retryCfg.maxAttempts && retryCfg.isRetryable(e) && !emitted;
        if (!canRetry) throw e; // 冒泡：runAgent 或子 agent 运行器负责标记根/unit 与收尾
        const delayMs = backoffDelay(attempt, retryCfg);
        recorder.event(turnId, 'llm.retry', { attempt, delayMs, error: errInfo.type });
        retryCfg.onRetry({ attempt, delayMs, error: errInfo });
        try {
          await sleep(delayMs, signal);
        } catch {
          aborted = true; // 退避期间被取消
          break;
        }
      }
    }
    if (aborted || !message) {
      stopReason = 'aborted';
      error = { type: 'aborted', message: 'run 已被取消', retryable: false };
      finished = true;
      break;
    }
    progress.iterations++;

    const usage = message.usage ? usageFromAnthropic(message.usage) : undefined;
    if (usage) {
      const cost = costEstimate(model, usage, pricing);
      usage.costEstimate = cost;
      // 未定价（F2）：模型不在价格表内 → 显式记事件 + 回调，别让 maxCostUsd 静默失效
      if (cost === undefined) {
        recorder.event(turnId, 'usage.unpriced', { model });
        if (!unpricedSeen.has(model)) {
          unpricedSeen.add(model);
          try {
            args.onUnpricedModel?.({ model, spanId: turnId });
          } catch {
            /* 观测是辅助动作：回调抛错不得影响 run */
          }
        }
      }
    }
    recorder.end(turnId, { usage });
    recorder.setAttribute(turnId, 'input_tokens', usage?.inputTokens ?? 0);
    recorder.setAttribute(turnId, 'output_tokens', usage?.outputTokens ?? 0);
    recorder.setAttribute(turnId, 'cache_read_tokens', usage?.cacheReadTokens ?? 0);
    recorder.setAttribute(turnId, 'cache_creation_tokens', usage?.cacheCreationTokens ?? 0);

    // 成本硬管控（C1）：本回合 usage 已落账 → 立刻判一次（超限会触发 onExceed 记事件）。
    // 结果**留到「循环是否还要继续」确定后再用**：
    // - 模型本回合自然收尾 → 不因「最后一回合把额度用超了」把已成功的 run 改判失败
    //   （只留 budget.exceeded 事件，可观测）；
    // - 循环还要继续（模型要求调工具）→ 停在这里，不再发下一个请求 = 不再花钱。
    const overBudget = budget ? budget.check(recorder.snapshot('ok')) : null;

    messages.push({ role: 'assistant', content: message.content });

    // —— 终止/边界分支（每个都置 finished，退出循环不再兜底改判）——
    if (message.stop_reason === 'end_turn') {
      stopReason = 'end_turn';
      finalText = textOf(message);
      finished = true;
      break;
    }
    if (message.stop_reason === 'refusal') {
      stopReason = 'refusal';
      finalText = textOf(message);
      error = { type: 'refusal', message: 'model refused the request', retryable: false };
      finished = true;
      break;
    }
    if (message.stop_reason === 'max_tokens') {
      stopReason = 'max_tokens';
      finalText = textOf(message);
      finished = true;
      break;
    }
    if (message.stop_reason === 'pause_turn') {
      // 无 server tools 时正常不会到；避免无限循环直接停
      stopReason = 'pause_turn';
      finalText = textOf(message);
      finished = true;
      break;
    }
    if (message.stop_reason === 'stop_sequence') {
      // 命中 stop 序列 = 正常收尾（与 end_turn 同类），不是失败
      stopReason = 'stop_sequence';
      finalText = textOf(message);
      finished = true;
      break;
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // 到这里的剩余 stop_reason 不会产生可执行块，防死循环直接停：
      // 'tool_use' 但块为空（畸形响应）与「本框架不认识的 stop_reason」区分开，
      // 后者保留已产出的文本并挂一条可诊断的 error（run 仍按失败收尾）。
      stopReason = message.stop_reason === 'tool_use' ? 'tool_use_no_blocks' : 'unknown_stop_reason';
      finalText = textOf(message);
      if (stopReason === 'unknown_stop_reason') {
        error = {
          type: 'agent_error',
          message: `模型返回了未识别的 stop_reason: ${String(message.stop_reason)}`,
          retryable: false,
        };
      }
      finished = true;
      break;
    }

    // 成本硬管控（C1）：走得到这里说明循环还要继续（模型要求调工具）—— 超限就停，
    // 连带不执行这批工具（避免超预算的 run 继续产生副作用）。已产出的文本保留。
    if (overBudget) {
      stopReason = 'budget_exceeded';
      finalText = textOf(message);
      error = {
        type: 'budget_exceeded',
        message:
          overBudget === 'tokens'
            ? `累计 token 已超过上限 ${args.maxTotalTokens}`
            : `累计成本已超过上限 $${args.maxCostUsd}`,
        retryable: false,
      };
      finished = true;
      break;
    }

    // —— 执行工具：默认全并行，可由 maxToolConcurrency 收窄（C2）；
    //    单条 user 消息回全部 tool_result（抑制并行是反模式）——
    const toolResults: Anthropic.ToolResultBlockParam[] = await mapWithConcurrency(
      toolUses,
      args.maxToolConcurrency ?? Number.POSITIVE_INFINITY,
      async (use) => {
        const tool = args.tools.find((t) => t.name === use.name);
        // 工具级时序（E1）：起点在事件之前 —— durationMs 覆盖「入参校验 + 执行 + 超时等待」
        // 的完整处理时长，是「哪一步慢」的可信基线。并行工具各记各的（tool_use_id 配对）。
        const toolStartedAt = Date.now();
        // tool_use_id 一并记账：同名工具并行时，重放只有靠 id 才能把入参出参正确配对
        recorder.event(turnId, 'tool.input', {
          tool: use.name,
          tool_use_id: use.id,
          input: limit(use.input, 2000),
        });

        const ctx: ToolRunContext = {
          client,
          recorder,
          parentSpanId: turnId,
          ...(signal ? { signal } : {}),
          // 价格覆盖透传给嵌套单元（F1）：否则子 agent 用同一模型会退化成"未定价"
          ...(args.priceOverrides ? { priceOverrides: args.priceOverrides } : {}),
        };
        let ok = true;
        let content: unknown = '';
        // 失败归类（E1）：只记「为什么没成」，不记栈 —— 观测看得清「哪个工具老超时」
        let errorKind: 'invalid_input' | 'timeout' | 'threw' | 'unknown_tool' | undefined;
        if (args.resultSchema && use.name === SUBMIT_RESULT) {
          // 隐藏提交工具：校验通过即携结果收尾（循环在下方 break）；
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
              // 模型提交的 input 已过 resultSchema 校验 → 断言为 SchemaType<S>（信任边界在此）
              typed = use.input as SchemaType<S>;
              submitted = true;
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
                Promise.resolve(tool.run(use.input, ctx)),
                args.toolTimeoutMs ?? 0,
              );
              if (out === TIMED_OUT) {
                ok = false;
                errorKind = 'timeout';
                content = `error(timeout): 工具执行超过 ${args.toolTimeoutMs}ms`;
              } else {
                content = out;
              }
            }
          } catch (e) {
            ok = false;
            errorKind = 'threw';
            const err = classifyError(e);
            content = `error(${err.type}): ${err.message}`;
          }
        }
        recorder.event(turnId, 'tool.output', {
          tool: use.name,
          tool_use_id: use.id,
          ok,
          // 耗时（毫秒）：成功/失败/超时/入参被拒四条路径都记（E1）
          durationMs: Math.max(0, Date.now() - toolStartedAt),
          ...(errorKind ? { errorKind } : {}),
          content: ok ? limit(content, 2000) : limit(content, 1000),
        });

        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: stringifySafe(content),
          is_error: !ok,
        };
      },
    );

    messages.push({ role: 'user', content: toolResults });

    if (submitted) {
      // submit_result 校验通过：结构化结果落定，循环正常收尾（finalText 取该回合文本，可空）
      stopReason = 'end_turn';
      finalText = textOf(message);
      finished = true;
      break;
    }
  }

  if (!finished) {
    // 循环因 maxIterations 上限退出而非正常终止（所有置 stopReason 的分支都已同时置 finished）
    stopReason = 'max_iterations';
  }

  return { stopReason, finalText, error, iterations: progress.iterations, typed };
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
  // 生效配置快照（G3）：本 run 真正用着的旋钮写进 run 根 —— 事后能回答
  // 「这条 run 的 maxCostUsd 设了没 / 重试几次」，换参数前后的对比才有据可查。
  // 只记可序列化标量；函数型选项（summarize / estimateTokens）不记内容。
  for (const [k, v] of Object.entries(runConfigSnapshot(options))) recorder.setAttribute(rootId, k, v);

  const progress = { iterations: 0 };
  let result: AgentLoopResult<SchemaType<S>>;
  try {
    result = await agentLoop<S>({
      client: options.client ?? new Anthropic(),
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
      contextPolicy: options.contextPolicy,
      resultSchema: options.resultSchema,
      progress,
      maxTotalTokens: options.maxTotalTokens,
      maxCostUsd: options.maxCostUsd,
      toolTimeoutMs: options.toolTimeoutMs,
      maxToolConcurrency: options.maxToolConcurrency,
      priceOverrides: options.priceOverrides,
      onUnpricedModel: options.onUnpricedModel,
    });
  } catch (e) {
    // 硬写 0 会把「第 3 回合请求失败」报成「一次模型都没调」——按实际进度报
    result = { stopReason: 'error', finalText: '', error: classifyError(e), iterations: progress.iterations };
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
 * 嵌套单元（子 agent）入口：不自开 run 根，llm.turn 挂在给定 parentSpanId 下的同一条 trace。
 * resultSchema 语义与 runAgent 一致（隐藏 submit_result → AgentLoopResult.typed），
 * 供子 agent 产出结构化结果（见 toolkit/subagent.ts 的交回逻辑）。
 */
export async function runAgentScoped<S extends JsonSchema = JsonSchema>(opts: {
  client?: ModelClient;
  system?: SystemParam;
  messages: Anthropic.MessageParam[];
  tools?: AgentTool[];
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  recorder: RecorderBackend;
  parentSpanId: SpanId;
  onText?: (delta: string) => void;
  /** 中断信号（由发起它的单元从 ToolRunContext.signal 透传，取消能传播到子 agent） */
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
  /** 价格表覆盖（F1）：由发起它的单元从 ToolRunContext.priceOverrides 透传 */
  priceOverrides?: Record<string, ModelPricing>;
  /** 未定价模型回调（F2）：由发起它的单元透传 */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
}): Promise<AgentLoopResult<SchemaType<S>>> {
  return agentLoop<S>({
    client: opts.client ?? new Anthropic(),
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
    contextPolicy: opts.contextPolicy,
    resultSchema: opts.resultSchema,
    toolTimeoutMs: opts.toolTimeoutMs,
    maxToolConcurrency: opts.maxToolConcurrency,
    priceOverrides: opts.priceOverrides,
    onUnpricedModel: opts.onUnpricedModel,
  });
}

function toApiTool(t: AgentTool): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as unknown as Anthropic.Tool.InputSchema,
    ...(t.strict ? { strict: true } : {}),
  };
}

/**
 * 生效配置快照（G3）：把本 run 实际生效的旋钮整理成 run 根的 `config.*` attributes。
 * 只放标量（OTLP/日志/看板都能直接吃）；缺省值也记，这样"没配"与"配了缺省值"可区分于
 * "该项不存在"。函数型选项只记"配没配"，不记函数体。
 */
function runConfigSnapshot(options: RunAgentOptions<JsonSchema>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    'config.model': resolveDefaultModel(options.model),
    'config.maxTokens': options.maxTokens ?? DEFAULT_MAX_TOKENS,
    'config.maxIterations': options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  };
  if (options.maxTotalTokens != null) out['config.maxTotalTokens'] = options.maxTotalTokens;
  if (options.maxCostUsd != null) out['config.maxCostUsd'] = options.maxCostUsd;
  if (options.toolTimeoutMs != null) out['config.toolTimeoutMs'] = options.toolTimeoutMs;
  if (options.maxToolConcurrency != null) out['config.maxToolConcurrency'] = options.maxToolConcurrency;
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

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * 用 `next` 原地替换 `target` 的全部内容（保持数组引用不变 —— 循环各处持同一数组）。
 *
 * **不要**写回 `target.splice(0, target.length, ...next)`：展开传参受 V8 实参个数上限
 * 约束，`next` 超过约 12 万项即抛 `RangeError: Maximum call stack size exceeded`
 * （实测 12 万 ok、30 万抛）。`next` 来自调用方注入的 `contextPolicy`，长度不受框架
 * 控制，所以用循环逐项写，彻底没有这个上限。
 */
export function replaceMessages(
  target: Anthropic.MessageParam[],
  next: readonly Anthropic.MessageParam[],
): void {
  target.length = 0;
  for (const m of next) target.push(m);
}

/** 截断到上限字符，超长加省略标记（格式由 core/json.ts 的 truncateWithMark 单一提供） */
function limit(x: unknown, n: number): string {
  return truncateWithMark(stringifySafe(x), n);
}
