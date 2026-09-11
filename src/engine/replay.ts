import type Anthropic from '@anthropic-ai/sdk';
import type { Span, SpanId, Trace } from '../core/trace.js';
import { stringifySafe, truncateWithMark } from '../core/json.js';

/**
 * Agentia —— trace 重放基底（spec §9.4 开放问题落地，roadmap R6）。
 *
 * 把一条完成的 trace 还原成可喂回模型的对话（MessageParam[]），用途：
 * 把完成的 run 喂回模型做调试 / 复盘（「这次 run 发生了什么、哪里可以改进」）。
 * 纯函数：不发起请求、不改 trace。
 *
 * 还原规则：
 * - 全部 llm.turn 按 startedAt 时序线性展开（稳定排序，同刻保插入序）——
 *   子 agent 的嵌套回合与主 agent 回合交错进同一序列，每回合以 text 块标注
 *   来源（model / 所属 unit span 名 / spanId）；
 * - 每回合 → 一条 assistant 消息：标注文本 + 各 tool.input 事件还原的 tool_use 块
 *   （id 由重放合成 `replay_tu_<n>`，trace 不记原始 id）；
 * - tool.output 事件 → 紧随其后一条 user 消息里的 tool_result 块，与 tool_use
 *   配对：优先按 tool_use_id 精确匹配（同名工具并行是本框架的常态 —— 完成序 ≠
 *   发起序，只有 id 能把入参出参对上），老 trace 无 id 时回落到「同名最早未配对」，
 *   再兜底「最早未配对」；缺失输出的 tool_use 补一条 is_error 占位 ——
 *   保证 role 交替与配对合法；
 * - 事件负载（工具入参/出参）已是 engine 截断后的字符串；入参尝试 JSON.parse
 *   还原为对象，失败（或非 object）包 `{ _raw }` —— tool_use.input 必须是 object；
 *   所有串按 maxEventChars 再截断（缺省 2000）；
 * - 产出经 normalizeForApi 规整：连续同 role 合并、首尾都确保为 user ——
 *   可直接作为 Messages API 的 messages 喂回模型（末条为 user 是硬要求：
 *   以 assistant 收尾即 prefill，缺省模型上 400）。
 *
 * 注意：trace 不记录 assistant 文本（llm.turn 只记 usage/事件），还原的
 * assistant 消息以标注文本占位，非逐字原文。
 */

export interface ReplayOptions {
  /** 是否还原 tool_use/tool_result 对（缺省 true）；false 时只留每回合的标注文本 */
  includeToolIO?: boolean;
  /** 单段事件负载（工具入参/出参）的最大字符数，超长截断（缺省 2000） */
  maxEventChars?: number;
}

const DEFAULT_MAX_EVENT_CHARS = 2000;

/** tool.input / tool.output 事件体的规整形态（body 为 unknown，宽容读取） */
interface ToolEventIO {
  tool: string;
  /** 原始 tool_use id（engine 记账；老 trace 无此字段 → 回落按名配对） */
  toolUseId?: string;
  input?: string;
  ok?: boolean;
  content?: string;
}

export function traceToMessages(trace: Trace, opts: ReplayOptions = {}): Anthropic.MessageParam[] {
  const includeToolIO = opts.includeToolIO ?? true;
  const maxChars = opts.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;

  const byId = new Map<SpanId, Span>(trace.spans.map((s) => [s.spanId, s]));
  const turns = trace.spans
    .filter((s) => s.kind === 'llm.turn')
    .sort((a, b) => a.startedAt - b.startedAt); // 稳定排序：同刻保 spans 数组插入序

  const messages: Anthropic.MessageParam[] = [];
  let seq = 0;

  turns.forEach((turn, i) => {
    const unit = nearestUnitName(turn, byId);
    const note =
      `[replay turn ${i + 1}/${turns.length}] model=${turn.name} ` +
      `unit=${unit ?? '(主 agent run)'} span=${turn.spanId}`;

    const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: note }];
    const pairs: Array<{ id: string; output?: ToolEventIO }> = [];

    if (includeToolIO) {
      const inputs = eventsOf(turn, 'tool.input');
      const outputs = eventsOf(turn, 'tool.output');
      const used = new Set<number>();
      for (const input of inputs) {
        // 配对优先级：同 id 精确匹配 > 同名最早未配对 > 最早未配对。
        // 同名工具并行时同名的那个回落会把入参出参张冠李戴，id 才是唯一可靠的锚。
        let idx =
          input.toolUseId === undefined
            ? -1
            : outputs.findIndex((o, j) => !used.has(j) && o.toolUseId === input.toolUseId);
        if (idx < 0) idx = outputs.findIndex((o, j) => !used.has(j) && o.tool === input.tool);
        if (idx < 0) idx = outputs.findIndex((_, j) => !used.has(j));
        const output = idx >= 0 ? outputs[idx] : undefined;
        if (idx >= 0) used.add(idx);

        const id = `replay_tu_${++seq}`;
        pairs.push({ id, output });
        content.push({
          type: 'tool_use',
          id,
          name: input.tool,
          input: parseInput(input.input, maxChars),
        });
      }
    }

    messages.push({ role: 'assistant', content });

    if (pairs.length > 0) {
      // tool_use 后必须紧跟含对应 tool_result 的 user 消息（role 交替合法）
      messages.push({
        role: 'user',
        content: pairs.map(({ id, output }) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: output
            ? truncateWithMark(output.content ?? '', maxChars)
            : '[replay] trace 中缺失对应 tool.output 事件',
          is_error: output ? output.ok === false : true,
        })),
      });
    }
  });

  return normalizeForApi(messages);
}

/** 前置 user 说明（API 要求首条为 user；trace 不含 run 的原始输入） */
const REPLAY_HEAD =
  '[replay] 以下是一次已完成 run 的 trace 重放（assistant 文本为标注占位，非逐字原文）。';
/** 收尾 user 请求：末条为 assistant 会被 API 当作 prefill */
const REPLAY_TAIL = '[replay] 以上是全部回合，请分析这次 run 的过程与结果。';

/**
 * 规整为可直接喂回 Messages API 的形态：
 * - 连续同 role 消息合并（无 tool 对的连续 assistant 会合流，交替保持合法；
 *   带 tool_use 的 assistant 之后必有其 tool_result user，配对不受影响）；
 * - 首条确保为 user（API 硬要求）——trace 不含 run 的原始输入，前置一条说明性 user；
 * - **末条也确保为 user**：多数 run 以 `end_turn` 的 assistant 回合收尾，直接喂回就是
 *   assistant prefill —— 缺省模型（claude-opus-5 / claude-sonnet-5）上会 400。
 *   空 trace（无 llm.turn）返回的也是这条前置 user，而非 `[]`（空 messages 同样非法）。
 */
function normalizeForApi(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    } else {
      merged.push({ role: m.role, content: toBlocks(m.content) });
    }
  }
  if (merged[0]?.role !== 'user') merged.unshift({ role: 'user', content: REPLAY_HEAD });
  if (merged[merged.length - 1]!.role !== 'user') {
    merged.push({ role: 'user', content: REPLAY_TAIL });
  }
  return merged;
}

function toBlocks(content: Anthropic.MessageParam['content']): Anthropic.ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
}

/** 向上找最近的 unit span 名（子 agent 嵌套回合的来源标注）；直属 run 根则 null */
function nearestUnitName(span: Span, byId: Map<SpanId, Span>): string | null {
  let cur = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  while (cur) {
    if (cur.kind === 'unit') return cur.name;
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
  }
  return null;
}

/** 取某回合的指定事件并规整为 ToolEventIO（body 是 unknown，宽容读取） */
function eventsOf(turn: Span, name: string): ToolEventIO[] {
  return turn.events
    .filter((e) => e.name === name)
    .map((e) => {
      const b = (e.body ?? {}) as Record<string, unknown>;
      return {
        tool: typeof b.tool === 'string' ? b.tool : 'unknown',
        toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
        input: asString(b.input),
        ok: typeof b.ok === 'boolean' ? b.ok : undefined,
        content: asString(b.content),
      };
    });
}

function asString(x: unknown): string | undefined {
  // 与 core/json.ts 的 stringifySafe 同源；仅额外把 undefined 视作「无值」
  return x === undefined ? undefined : stringifySafe(x);
}

/** 入参还原：截断后尝试 JSON.parse 回对象，失败包 {_raw}（tool_use.input 必须是 object，否则 API 400） */
function parseInput(raw: string | undefined, maxChars: number): unknown {
  const s = truncateWithMark(raw ?? '', maxChars);
  try {
    const parsed = JSON.parse(s) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : { _raw: s };
  } catch {
    return { _raw: s };
  }
}
