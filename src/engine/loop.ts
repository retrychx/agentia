import Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, JsonSchema, ModelClient, RecorderBackend, SchemaType, ToolRunContext } from '../core/tool.js';
import { validateJsonSchema } from '../core/schema.js';
import { stringifySafe, truncateWithMark } from '../core/json.js';
import type { SpanError, SpanId } from '../core/trace.js';
import { classifyError, isAbortError } from './errors.js';
import { TraceRecorder } from './tracer.js';
import type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  RunAgentOptions,
  SystemParam,
} from './types.js';
import { isSuccessStopReason } from './types.js';
import { costEstimate, usageFromAnthropic } from './usage.js';

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
  /** 上下文预算策略（compaction / context editing），每回合发送前调用 */
  contextPolicy?: ContextPolicy;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（见 RunAgentOptions.resultSchema） */
  resultSchema?: S;
  /**
   * 模型往返计数的外部持有者。抛错路径（请求失败）也要能报出**已发生**的往返次数，
   * 所以用对象就地累加，而不是只靠返回值。
   */
  progress?: { iterations: number };
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
        messages.splice(0, messages.length, ...next);
      }
    }

    const turnId = recorder.begin('llm.turn', model, parentSpanId);

    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream({
        model,
        max_tokens: args.maxTokens,
        ...(system ? { system } : {}),
        ...(apiTools.length ? { tools: apiTools } : {}),
        messages,
        ...(signal ? { signal } : {}),
      });
      stream.on('text', (delta) => args.onText?.(delta));
      message = await stream.finalMessage();
    } catch (e) {
      recorder.end(turnId, { status: 'error', error: classifyError(e) });
      // 中断不作异常冒泡：以确定的 stopReason 收尾，调用方能区分「取消」与「故障」
      if (isAbortError(e) || signal?.aborted) {
        stopReason = 'aborted';
        error = { type: 'aborted', message: 'run 已被取消', retryable: false };
        finished = true;
        break;
      }
      throw e; // 冒泡：runAgent 或子 agent 运行器负责标记根/unit 与收尾
    }
    progress.iterations++;

    const usage = message.usage ? usageFromAnthropic(message.usage) : undefined;
    if (usage) usage.costEstimate = costEstimate(model, usage);
    recorder.end(turnId, { usage });
    recorder.setAttribute(turnId, 'input_tokens', usage?.inputTokens ?? 0);
    recorder.setAttribute(turnId, 'output_tokens', usage?.outputTokens ?? 0);
    recorder.setAttribute(turnId, 'cache_read_tokens', usage?.cacheReadTokens ?? 0);
    recorder.setAttribute(turnId, 'cache_creation_tokens', usage?.cacheCreationTokens ?? 0);

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

    // —— 执行工具：并行；单条 user 消息回全部 tool_result（抑制并行是反模式）——
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use) => {
        const tool = args.tools.find((t) => t.name === use.name);
        // tool_use_id 一并记账：同名工具并行时，重放只有靠 id 才能把入参出参正确配对
        recorder.event(turnId, 'tool.input', {
          tool: use.name,
          tool_use_id: use.id,
          input: limit(use.input, 2000),
        });

        const ctx: ToolRunContext = { client, recorder, parentSpanId: turnId, ...(signal ? { signal } : {}) };
        let ok = true;
        let content: unknown = '';
        if (args.resultSchema && use.name === SUBMIT_RESULT) {
          // 隐藏提交工具：校验通过即携结果收尾（循环在下方 break）；
          // 校验失败回 is_error（含路径，模型可自我修正），同回合其他工具照常执行。
          // 校验本身也在 try 内：畸形 resultSchema（$ref 成环等）只该废掉这一次提交，
          // 不该让整次 run 以 error 收场（否则 trace 把该回合记成 ok，与 run 结论矛盾）。
          try {
            const invalid = validateJsonSchema(args.resultSchema, use.input);
            if (invalid) {
              ok = false;
              content = `invalid input: ${invalid}`;
            } else {
              content = 'submitted';
              // 模型提交的 input 已过 resultSchema 校验 → 断言为 SchemaType<S>（信任边界在此）
              typed = use.input as SchemaType<S>;
              submitted = true;
            }
          } catch (e) {
            ok = false;
            const err = classifyError(e);
            content = `error(${err.type}): ${err.message}`;
          }
        } else if (!tool) {
          ok = false;
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
              content = `invalid input: ${invalid}`;
            } else {
              content = await tool.run(use.input, ctx);
            }
          } catch (e) {
            ok = false;
            const err = classifyError(e);
            content = `error(${err.type}): ${err.message}`;
          }
        }
        recorder.event(turnId, 'tool.output', {
          tool: use.name,
          tool_use_id: use.id,
          ok,
          content: ok ? limit(content, 2000) : limit(content, 1000),
        });

        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: stringifySafe(content),
          is_error: !ok,
        };
      }),
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
      contextPolicy: options.contextPolicy,
      resultSchema: options.resultSchema,
      progress,
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
  contextPolicy?: ContextPolicy;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（同 RunAgentOptions.resultSchema） */
  resultSchema?: S;
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
    contextPolicy: opts.contextPolicy,
    resultSchema: opts.resultSchema,
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

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** 截断到上限字符，超长加省略标记（格式由 core/json.ts 的 truncateWithMark 单一提供） */
function limit(x: unknown, n: number): string {
  return truncateWithMark(stringifySafe(x), n);
}
