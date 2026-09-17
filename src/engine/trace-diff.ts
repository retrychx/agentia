import { stringifySafe, truncateWithMark } from '../core/json.js';
import type { Span, SpanError, SpanEvent, Trace, Usage } from '../core/trace.js';

/**
 * Agentia —— trace diff（A/B 比对）。
 *
 * 比对两条 trace（典型场景：同一输入换模型 / 换 prompt 重跑），产出结构化差异：
 * run 级 summary（status / totalUsage / 根 span attributes —— A/B 模型第一眼就看
 * attributes.model）+ 逐 span 的字段级差异。纯函数：不发起请求、不改 trace。
 *
 * 配对算法（结构性配对，字段差异不影响配对）：
 * - 根与根无条件配对（run 名不同记为 name 字段差）；
 * - 子 span 递归配对：父已配对的两侧孩子按「配对键」分组 —— **llm.turn 的配对键
 *   只有 kind（忽略 name）**，因为 name 是模型 id，而「换个模型重跑」正是 A/B 主用例，
 *   按 name 配对会把两侧所有 turn 都报成缺失；模型差异降格为配对 turn 的 name 字段差。
 *   capability span 配对键 = `kind:name`（skill:foo vs skill:bar 是不同能力，不该配上）；
 * - 同键孩子按 startedAt 稳定排序后按下标一一配对；多出的侧记缺侧 SpanDiff
 *   （fields 为空，path 照给），缺侧的整棵子树不再下钻 —— 一条缺侧记录即代表整支。
 *
 * path 段规则：根段 `run:<name>`；llm.turn 段 `llm.turn#<同键内下标>`；capability 段
 * `capability:<name>`（同键重复时加 `#<下标>`）；用 `/` 连接。
 *
 * traceId 是身份不是行为，永不比。墙钟字段（span startedAt/endedAt、event time）
 * 缺省忽略 —— A/B 比对不关心时序；`ignoreTiming: false` 时改比 span 时长
 * （endedAt-startedAt），绝对时间戳永不比。
 */

export interface TraceDiffOptions {
  /** 忽略墙钟字段（span startedAt/endedAt、event time），缺省 true —— A/B 比对不关心时序；
   *  false 时改比 span 时长（endedAt-startedAt，未结束为 undefined），绝对时间戳永不比 */
  ignoreTiming?: boolean;
}

export interface DiffEntry {
  /** 字段路径：'status' / 'name' / 'usage.inputTokens' / 'attributes.<key>' /
   *  'events[2].name' / 'events[2].body' / 'events'（计数不等或截断说明） / 'duration' */
  field: string;
  /** 该侧无此值用 undefined */
  a: unknown;
  b: unknown;
}

export interface SpanDiff {
  /** 从根到该 span 的配对路径（人读 + 稳定锚），规则见文件头 */
  path: string;
  /** 缺侧 = 该侧调用树无此位置（字段在场，值可为 undefined，见 core/run.ts 的说明） */
  a: Span | undefined;
  b: Span | undefined;
  /** 两侧都在时的字段级差异；缺侧时为空数组 */
  fields: DiffEntry[];
}

export interface TraceDiff {
  /** 应用 DiffOptions 后是否无差异（summary 与 spans 全空差异） */
  equal: boolean;
  /** run 级差异：status、totalUsage.* 各字段、根 span attributes.<key>
   *  （model/system.version/prompts.versions/session.id 都在这里 —— A/B 模型第一眼就看它）。
   *  traceId 是身份不是行为，永不比 */
  summary: DiffEntry[];
  /** 逐 span 差异（只收有字段差或缺侧的 span；配平且全同的 span 不出现） */
  spans: SpanDiff[];
}

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costEstimate',
] as const;

/** 每个 span 的事件差异最多报 20 条，超出记一条 `events` 截断说明 */
const EVENT_DIFF_LIMIT = 20;
/** 事件 body 差异值截断上限（body 可能很大，防爆） */
const DIFF_VALUE_CHARS = 200;

export function diffTraces(a: Trace, b: Trace, opts: TraceDiffOptions = {}): TraceDiff {
  const ignoreTiming = opts.ignoreTiming ?? true;

  const summary: DiffEntry[] = [];
  if (a.status !== b.status) summary.push({ field: 'status', a: a.status, b: b.status });
  pushUsageDiffs(summary, 'totalUsage', a.totalUsage, b.totalUsage);

  const aRoot = a.spans.find((s) => s.spanId === a.rootSpanId);
  const bRoot = b.spans.find((s) => s.spanId === b.rootSpanId);
  if (aRoot && bRoot) pushAttrDiffs(summary, aRoot.attributes, bRoot.attributes);

  const spans: SpanDiff[] = [];
  const ctx: WalkCtx = {
    aChildren: childrenMap(a),
    bChildren: childrenMap(b),
    ignoreTiming,
    out: spans,
  };
  // 根与根无条件配对（一侧连根都没有时记缺侧）
  if (aRoot || bRoot) {
    walk(aRoot, bRoot, `run:${(aRoot ?? bRoot)!.name}`, ctx);
  }

  return { equal: summary.length === 0 && spans.length === 0, summary, spans };
}

interface WalkCtx {
  aChildren: Map<string, Span[]>;
  bChildren: Map<string, Span[]>;
  ignoreTiming: boolean;
  out: SpanDiff[];
}

/** parentSpanId → 直接子 span（保 spans 数组插入序，供稳定排序前的同刻次序） */
function childrenMap(trace: Trace): Map<string, Span[]> {
  const map = new Map<string, Span[]>();
  for (const s of trace.spans) {
    if (s.parentSpanId === null) continue;
    const kids = map.get(s.parentSpanId);
    if (kids) kids.push(s);
    else map.set(s.parentSpanId, [s]);
  }
  return map;
}

function walk(aSpan: Span | undefined, bSpan: Span | undefined, path: string, ctx: WalkCtx): void {
  const fields = aSpan && bSpan ? diffSpanFields(aSpan, bSpan, ctx.ignoreTiming) : [];
  // 只收有差异的节点：字段差，或缺侧（整棵子树缺失，一条记录代表整支，不再下钻）
  if (fields.length > 0 || !aSpan || !bSpan) {
    ctx.out.push({ path, a: aSpan, b: bSpan, fields });
  }
  if (!aSpan || !bSpan) return;

  const aKids = ctx.aChildren.get(aSpan.spanId) ?? [];
  const bKids = ctx.bChildren.get(bSpan.spanId) ?? [];
  for (const pair of pairChildren(aKids, bKids)) {
    walk(pair.a, pair.b, `${path}/${pair.seg}`, ctx);
  }
}

interface ChildPair {
  a?: Span;
  b?: Span;
  seg: string;
}

/**
 * 配对键：llm.turn 只有 kind（忽略 name —— name 是模型 id，「换模型重跑」是 A/B 主用例，
 * 按 name 配对会把两侧 turn 全报成缺失；模型差异降格为配对 turn 的 name 字段差）；
 * 其余 span 按 `kind:name`（skill:foo vs skill:bar 是不同能力，不该配上）。
 */
function pairKey(s: Span): string {
  return s.kind === 'llm.turn' ? 'llm.turn' : `${s.kind}:${s.name}`;
}

function pairChildren(aKids: Span[], bKids: Span[]): ChildPair[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const s of [...aKids, ...bKids]) {
    const k = pairKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }

  const pairs: ChildPair[] = [];
  for (const key of keys) {
    // 同键孩子按 startedAt 稳定排序（同刻保插入序）后按下标一一配对
    const as = aKids.filter((s) => pairKey(s) === key).sort((x, y) => x.startedAt - y.startedAt);
    const bs = bKids.filter((s) => pairKey(s) === key).sort((x, y) => x.startedAt - y.startedAt);
    const n = Math.max(as.length, bs.length);
    for (let i = 0; i < n; i++) {
      const sample = as[i] ?? bs[i]!;
      let seg: string;
      if (sample.kind === 'llm.turn') {
        seg = `llm.turn#${i}`;
      } else {
        seg = `${sample.kind}:${sample.name}`;
        if (n > 1) seg += `#${i}`; // 同键重复时加下标区分
      }
      pairs.push({ a: as[i], b: bs[i], seg });
    }
  }
  return pairs;
}

/** 两侧都在时的字段级差异（顺序：status / name / error / usage.* / attributes.* / duration / events） */
function diffSpanFields(a: Span, b: Span, ignoreTiming: boolean): DiffEntry[] {
  const fields: DiffEntry[] = [];
  if (a.status !== b.status) fields.push({ field: 'status', a: a.status, b: b.status });
  if (a.name !== b.name) fields.push({ field: 'name', a: a.name, b: b.name });
  if (!errorEqual(a.error, b.error)) fields.push({ field: 'error', a: a.error, b: b.error });
  pushUsageDiffs(fields, 'usage', a.usage, b.usage);
  pushAttrDiffs(fields, a.attributes, b.attributes);
  if (!ignoreTiming) {
    // 比时长而非绝对时间戳（未结束为 undefined，与已结束也是差异）
    const da = a.endedAt === undefined ? undefined : a.endedAt - a.startedAt;
    const db = b.endedAt === undefined ? undefined : b.endedAt - b.startedAt;
    if (da !== db) fields.push({ field: 'duration', a: da, b: db });
  }
  pushEventDiffs(fields, a.events, b.events);
  return fields;
}

/** error 比 type + message + retryable 三元组 */
function errorEqual(x: SpanError | undefined, y: SpanError | undefined): boolean {
  if (!x || !y) return x === y;
  return x.type === y.type && x.message === y.message && x.retryable === y.retryable;
}

/** usage 逐字段比；缺省（undefined）与 0 是不同语义 —— 一侧有一侧无也是差异 */
function pushUsageDiffs(
  out: DiffEntry[],
  prefix: string,
  x: Usage | undefined,
  y: Usage | undefined,
): void {
  for (const f of USAGE_FIELDS) {
    const xv = x?.[f];
    const yv = y?.[f];
    if (xv !== yv) out.push({ field: `${prefix}.${f}`, a: xv, b: yv });
  }
}

/** attributes 并集逐键比（键序排序，输出确定） */
function pushAttrDiffs(out: DiffEntry[], x: Span['attributes'], y: Span['attributes']): void {
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  for (const k of keys) {
    if (x[k] !== y[k]) out.push({ field: `attributes.${k}`, a: x[k], b: y[k] });
  }
}

/**
 * events 序列比：长度不等记一条 `events` 计数差；逐下标比 name 与 body
 * （body 用 stringifySafe 序列化后比字符串，差异值截断到 200 字符防爆）。
 * 每个 span 最多报 EVENT_DIFF_LIMIT 条，超出记一条 `events` 截断说明。
 * event.time 是墙钟字段，永不比。
 */
function pushEventDiffs(out: DiffEntry[], x: SpanEvent[], y: SpanEvent[]): void {
  let budget = EVENT_DIFF_LIMIT;
  let omitted = 0;
  const push = (entry: DiffEntry): void => {
    if (budget > 0) {
      out.push(entry);
      budget--;
    } else {
      omitted++;
    }
  };

  if (x.length !== y.length) push({ field: 'events', a: x.length, b: y.length });

  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i].name !== y[i].name) {
      push({ field: `events[${i}].name`, a: x[i].name, b: y[i].name });
    }
    const bx = stringifySafe(x[i].body);
    const by = stringifySafe(y[i].body);
    if (bx !== by) {
      push({
        field: `events[${i}].body`,
        a: truncateWithMark(bx, DIFF_VALUE_CHARS),
        b: truncateWithMark(by, DIFF_VALUE_CHARS),
      });
    }
  }

  if (omitted > 0) {
    const note = `（事件差异超过 ${EVENT_DIFF_LIMIT} 条，另有 ${omitted} 条未列出）`;
    out.push({ field: 'events', a: note, b: note });
  }
}
