import Anthropic from '@anthropic-ai/sdk';
import type { AgentTool, JsonSchema, ModelClient, RecorderBackend, ToolRunContext } from '../core/tool.js';
import { validateJsonSchema } from '../core/schema.js';
import { stringifySafe } from '../core/json.js';
import type { SpanError, SpanId } from '../core/trace.js';
import { classifyError } from './errors.js';
import { TraceRecorder } from './tracer.js';
import type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  RunAgentOptions,
  SystemParam,
} from './types.js';
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

interface AgentLoopArgs {
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
  /** 上下文预算策略（compaction / context editing），每回合发送前调用 */
  contextPolicy?: ContextPolicy;
  /** 结构化结果 schema：存在时追加隐藏 submit_result 工具（见 RunAgentOptions.resultSchema） */
  resultSchema?: JsonSchema;
}

export interface AgentLoopResult {
  stopReason: AgentStopReason;
  finalText: string;
  error?: SpanError;
  /** 本轮循环自己发起的模型往返次数 */
  iterations: number;
  /** submit_result 校验通过的结构化结果；未提交则为 undefined */
  typed?: unknown;
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
async function agentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
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
  let iterations = 0;
  let typed: unknown;
  let submitted = false;

  for (let iteration = 0; iteration < args.maxIterations; iteration++) {
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
      });
      stream.on('text', (delta) => args.onText?.(delta));
      message = await stream.finalMessage();
    } catch (e) {
      recorder.end(turnId, { status: 'error', error: classifyError(e) });
      throw e; // 冒泡：runAgent 或子 agent 运行器负责标记根/unit 与收尾
    }
    iterations++;

    const usage = message.usage ? usageFromAnthropic(message.usage) : undefined;
    if (usage) usage.costEstimate = costEstimate(model, usage);
    recorder.end(turnId, { usage });
    recorder.setAttribute(turnId, 'input_tokens', usage?.inputTokens ?? 0);
    recorder.setAttribute(turnId, 'output_tokens', usage?.outputTokens ?? 0);
    recorder.setAttribute(turnId, 'cache_read_tokens', usage?.cacheReadTokens ?? 0);

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
      finished = true;
      break;
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // 到这里的剩余 stop_reason 不会产生可执行块，防死循环直接停
      stopReason = 'tool_use_no_blocks';
      finished = true;
      break;
    }

    // —— 执行工具：并行；单条 user 消息回全部 tool_result（抑制并行是反模式）——
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use) => {
        const tool = args.tools.find((t) => t.name === use.name);
        recorder.event(turnId, 'tool.input', { tool: use.name, input: limit(use.input, 2000) });

        const ctx: ToolRunContext = { client, recorder, parentSpanId: turnId };
        let ok = true;
        let content: unknown = '';
        if (args.resultSchema && use.name === SUBMIT_RESULT) {
          // 隐藏提交工具：校验通过即携结果收尾（循环在下方 break）；
          // 校验失败回 is_error（含路径，模型可自我修正），同回合其他工具照常执行。
          const invalid = validateJsonSchema(args.resultSchema, use.input);
          if (invalid) {
            ok = false;
            content = `invalid input: ${invalid}`;
          } else {
            content = 'submitted';
            typed = use.input;
            submitted = true;
          }
        } else if (!tool) {
          ok = false;
          content = `unknown tool: ${use.name}`;
        } else {
          // 模型给的 input 先过 schema 校验：不合法直接回 is_error（含路径，
          // 模型可自我修正），不进方法体 —— schema 是方法与模型间的运行时契约。
          const invalid = validateJsonSchema(tool.inputSchema, use.input);
          if (invalid) {
            ok = false;
            content = `invalid input: ${invalid}`;
          } else {
            try {
              content = await tool.run(use.input, ctx);
            } catch (e) {
              ok = false;
              const err = classifyError(e);
              content = `error(${err.type}): ${err.message}`;
            }
          }
        }
        recorder.event(turnId, 'tool.output', { tool: use.name, ok, content: ok ? limit(content, 2000) : limit(content, 1000) });

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

  if (!finished && stopReason === 'end_turn') {
    // 循环因 maxIterations 上限退出而非正常终止
    stopReason = 'max_iterations';
  }

  return { stopReason, finalText, error, iterations, typed };
}

/** 主入口：开 run 根 span，循环跑在其下。返回完整 trace（traceId 即 runId）。 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const recorder = options.recorder ?? new TraceRecorder();
  const rootId = recorder.begin('run', options.runName ?? 'agent.run', null);
  recorder.setAttribute(rootId, 'model', resolveDefaultModel(options.model));

  let result: AgentLoopResult;
  try {
    result = await agentLoop({
      client: options.client ?? new Anthropic(),
      model: resolveDefaultModel(options.model),
      maxTokens: options.maxTokens ?? 64_000,
      maxIterations: options.maxIterations ?? 40,
      system: options.system,
      messages: options.messages,
      tools: options.tools ?? [],
      recorder,
      parentSpanId: rootId,
      onText: options.onText,
      contextPolicy: options.contextPolicy,
      resultSchema: options.resultSchema,
    });
  } catch (e) {
    result = { stopReason: 'error', finalText: '', error: classifyError(e), iterations: 0 };
  }

  const runStatus = result.stopReason === 'end_turn' ? 'ok' : 'error';
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

/** 嵌套单元（子 agent）入口：不自开 run 根，llm.turn 挂在给定 parentSpanId 下的同一条 trace。 */
export async function runAgentScoped(opts: {
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
  contextPolicy?: ContextPolicy;
}): Promise<AgentLoopResult> {
  return agentLoop({
    client: opts.client ?? new Anthropic(),
    model: resolveDefaultModel(opts.model),
    maxTokens: opts.maxTokens ?? 64_000,
    maxIterations: opts.maxIterations ?? 40,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools ?? [],
    recorder: opts.recorder,
    parentSpanId: opts.parentSpanId,
    onText: opts.onText,
    contextPolicy: opts.contextPolicy,
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

/** 截断到上限字符，超长加省略标记 */
function limit(x: unknown, n: number): string {
  const s = stringifySafe(x);
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}
