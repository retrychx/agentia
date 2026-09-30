/**
 * Trace → ATIF（Agent Trajectory Interchange Format）转换器。
 *
 * ATIF 是 Harbor / Terminal-Bench 的**统一轨迹格式**（RFC-0001，本仓对齐 v1.8）。它的意义是：
 * 不管你跑的是 Claude Code、Codex CLI 还是自己手搓的 scaffold，Harbor 的适配器都把轨迹
 * 收成同一个 JSON 形状 —— 于是「换框架」这件事第一次变得可比对。
 *
 * 为什么 agentia 值得**原生**出 ATIF，而不是像其它适配器那样从日志反推：
 * 别的框架是「跑完之后拿 stdout 猜哪一步调了什么工具」；agentia 的 trace 本来就是
 * 一等公民（spec §9），工具入参 / 出参 / token / 成本在**跑的时候**就已经按 span 记账，
 * 所以这里是**无损直译**，不是重建。同一份 trace 走 `createOtlpExporter()` 就是 OTel。
 *
 * 两个必须知道的取舍（改之前先读）：
 *
 * 1. **assistant 正文只在 `traceContent: 'full'` 时才有真值**。框架缺省不记正文
 *    （`docs/usage-guide.md` §7），没开的话这里 `message` 会是空串 ——
 *    这不是转换丢数据，是 trace 里本来就没有。`run.ts` 已经开了 `'full'`。
 * 2. **工具 I/O 事件名在这里写成字面量**：`TOOL_INPUT_EVENT` / `TOOL_OUTPUT_EVENT`
 *    是跨层契约常量，但 v0.10.0 收窄 exports 之后它们**不在公共出口上**
 *    （`src/index.ts` 只导出了 core 的类型与 attachScore/parseTraceparent），
 *    而本例只能引 `@migor/agentia` 的根出口。⇒ 上游一旦改名，这里会**静默归零**
 *    （过滤器匹配不上 = 「没有工具调用」），所以要改先回源核对 `src/core/trace.ts`。
 */
import type { Span, Trace, Usage } from '@migor/agentia';

/** 与 `src/core/trace.ts` 的常量同值（见文件头第 2 条） */
const TOOL_INPUT = 'tool.input';
const TOOL_OUTPUT = 'tool.output';

/** ATIF 只认这几个字面量；与 Harbor 的 `Trajectory` 模型逐字对齐 */
export const ATIF_SCHEMA_VERSION = 'ATIF-v1.8' as const;

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: 'system' | 'user' | 'agent';
  model_name?: string;
  message: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: Array<{ source_call_id?: string; content?: string }> };
  metrics?: AtifMetrics;
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_SCHEMA_VERSION;
  session_id?: string;
  agent: { name: string; version: string; model_name?: string };
  steps: AtifStep[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_cost_usd?: number;
    total_steps?: number;
  };
}

export interface AtifOptions {
  /** 任务指令，落在 steps[0]（source='user'） */
  instruction: string;
  /** 覆盖 agent.model_name；不给则取第一个 llm.turn span 的名字 */
  modelName?: string;
  /** 覆盖 agent.version；缺省取 `AGENTIA_VERSION` */
  agentVersion?: string;
}

interface ToolInputBody {
  tool?: string;
  tool_use_id?: string;
  /** ⚠️ 是 **JSON 字符串**：`ToolInputPayload.input: string`（`src/engine/tool-events.ts` 的 `limit()` 会先 stringify 再截断） */
  input?: string;
}

interface ToolOutputBody {
  tool?: string;
  tool_use_id?: string;
  ok?: boolean;
  content?: unknown;
}

/** 事件体是 `unknown`：只按形状取用，取不到就退到安全值（宁可少记，不猜） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 入参还原成对象。
 *
 * 事件里存的是 JSON 字符串，ATIF 的 `arguments` 要的是对象 ⇒ 能 parse 就还原。
 * parse 不了（被 `maxEventChars` 截断过的半截 JSON）就把原文留在 `_raw` ——
 * **不要静默落 `{}`**：空对象在评测里看起来像「这个工具没传参」，
 * 而真相是「传了但被截断了」，这两种失败完全不是一回事。
 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return asRecord(raw);
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** 出参统一成字符串：工具返回对象时给 JSON，返回 undefined 给空串 */
function stringifyContent(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * 一次 llm.turn span → 一个 ATIF step。
 *
 * 配对口径与引擎一致：工具入参 / 出参都挂在这个 span 的 events 上，靠 `tool_use_id`
 * 成对（同名工具并行时也只有靠 id 才配得对 —— 见 `src/engine/turn.ts` 的说明）。
 * ATIF 校验器要求 `observation.results[].source_call_id` 必须命中**同一步**的
 * `tool_calls[].tool_call_id`，所以入参出参必须落在同一个 step 里，不能拆。
 */
function turnToStep(span: Span, stepId: number): AtifStep {
  const inputs = span.events.filter((e) => e.name === TOOL_INPUT);
  const outputs = span.events.filter((e) => e.name === TOOL_OUTPUT);

  const calls: AtifToolCall[] = [];
  const results: Array<{ source_call_id?: string; content?: string }> = [];

  for (const ev of inputs) {
    const body = asRecord(ev.body) as ToolInputBody;
    const id = asString(body.tool_use_id) || `call_${stepId}_${calls.length + 1}`;
    calls.push({
      tool_call_id: id,
      function_name: asString(body.tool) || 'unknown',
      arguments: parseArguments(body.input),
    });
  }

  // 出参按 tool_use_id 反查：有入参就挂 source_call_id（指向上面那条），
  // 没有入参（理论上不该发生）就只给 content —— 校验器只校验「给了 id 就要命中」。
  const known = new Set(calls.map((c) => c.tool_call_id));
  for (const ev of outputs) {
    const body = asRecord(ev.body) as ToolOutputBody;
    const id = asString(body.tool_use_id);
    results.push({
      ...(id && known.has(id) ? { source_call_id: id } : {}),
      content: stringifyContent(body.content),
    });
  }

  const usage: Usage | undefined = span.usage;
  const step: AtifStep = {
    step_id: stepId,
    source: 'agent',
    model_name: span.name,
    message: asString(span.attributes['output.text']),
  };
  if (span.startedAt) step.timestamp = new Date(span.startedAt).toISOString();
  if (calls.length > 0) step.tool_calls = calls;
  if (results.length > 0) step.observation = { results };
  if (usage) {
    step.metrics = {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      cached_tokens: usage.cacheReadTokens,
      ...(usage.costEstimate !== undefined ? { cost_usd: usage.costEstimate } : {}),
    };
  }
  return step;
}

/**
 * agentia 的 `Trace` → ATIF `Trajectory`。
 *
 * 只对 `kind === 'llm.turn'` 的 span 出 step：**一轮模型往返 = 一步**，与 ATIF 的
 * 「step 里带着本轮的 tool_calls + 它们的 observation」是同一个形状。
 * `capability` span（skill / subagent 的聚合）不出 step —— 它的 usage 是子孙的聚合，
 * 出 step 会和 llm.turn 重复计数（框架在 `Trace.totalUsage` 上就是这么防重的）。
 */
export function traceToAtif(trace: Trace, options: AtifOptions): AtifTrajectory {
  const turns = trace.spans
    .filter((s) => s.kind === 'llm.turn')
    .sort((a, b) => a.startedAt - b.startedAt);

  const steps: AtifStep[] = [
    { step_id: 1, source: 'user', message: options.instruction },
    ...turns.map((span, i) => turnToStep(span, i + 2)),
  ];

  const total: Usage = trace.totalUsage;
  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: trace.traceId,
    agent: {
      name: 'agentia',
      version: options.agentVersion ?? '',
      model_name: options.modelName ?? turns[0]?.name,
    },
    steps,
    final_metrics: {
      total_prompt_tokens: total?.inputTokens,
      total_completion_tokens: total?.outputTokens,
      total_cached_tokens: total?.cacheReadTokens,
      ...(total?.costEstimate !== undefined ? { total_cost_usd: total.costEstimate } : {}),
      total_steps: steps.length,
    },
  };
}
