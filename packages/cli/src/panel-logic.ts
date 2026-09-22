/**
 * 面板的**纯逻辑**（零 DOM、零依赖、零副作用）—— 从 `inspector-page.html` 的
 * `<script type="module">` 里抽出来，让 CLI 测试套件能真的覆盖它。
 *
 * 为什么必须抽出来：面板是手写无框架 HTML，P1b/P1c 之后长出输入条 / 能力多选 /
 * 文件夹选择器 / 多轮开关 / 对话视图 —— 这是这批工作里**最大的一块**逻辑。
 * 留在 `<script>` 里就等于「本仓唯一没有测试的复杂逻辑」，而本仓的纪律是
 * 「文档承诺可跑就得有守卫」。
 *
 * ⚠️ 约束：本文件**不许碰 DOM**（不出现 `document` / `window` / `EventSource`）——
 * 它要在 Node 里被直接 import 做单测。DOM 接线留在 HTML 里，且只做
 * 「取值 → 调这里 → 写回」，不再自己判断业务规则。
 */
import type {
  SessionMessageLike,
  TraceRecordEventLike,
  TraceSpanLike,
} from './dev-protocol.js';

// ---------- 能力多选（D8） ----------

/**
 * 多选结果 → `AppOptions.toolSources` 的实参。
 *
 * 三条口径（都来自 D8「形态已定 · ①多选」）：
 * - **全选 ⇒ `undefined`**：与「不传即全量」同义，且省掉一次白跑的孤儿能力告警
 *   （`module.ts` 的 `if (opts.toolSources)` 分支）。
 * - **固定顺序**（字典序），不用点击顺序 —— 调试要可复现，否则同一组能力两次跑出
 *   不同菜单序。
 * - **空集也当全量**：`toolSources: []` 会收窄到**空菜单**（每个 provider 都成了孤儿），
 *   是个纯陷阱值；UI 另外禁止「取消最后一个」，这里兜住程序性调用。
 *
 * 不在 `all` 里的名字（能力被删了、面板缓存旧了）**静默丢弃**——它不该让整次 run 失败，
 * 但也**不是**无声的：调用方拿到的是「归一化之后」的数组，面板据此回写选中态。
 */
export function normalizeToolSources(selected: string[], all: string[]): string[] | undefined {
  const known = new Set(all);
  const picked = [...new Set(selected)].filter((s) => known.has(s)).sort();
  if (picked.length === 0 || picked.length === all.length) return undefined;
  return picked;
}

/** 「已选/总数」计数（D7：`3/3` 一眼看出这次是全量还是收窄，不是装饰） */
export function capabilityBadge(selected: string[], all: string[]): string {
  return `${selected.length}/${all.length}`;
}

// ---------- 多轮开关（D8 ②③） ----------

export interface MultiTurnDefault {
  /** 初始值 = 所选能力声明的 **OR** */
  value: boolean;
  /** 声明了多轮、且这次被选中的能力（升序）—— 用于在开关上**标出来源** */
  sources: string[];
}

/**
 * 多轮开关的初始值。
 *
 * 多选之后必然出现「`trip-planner`（多轮）+ `code-review`（单轮）同选」，
 * 此时默认值**有歧义** —— 规则是 **OR**（只要有一个声明多轮就默认多轮），
 * 并把**来源**一并返回，好让面板标出来（`多轮·trip-planner`）。
 *
 * 本仓一贯的偏好：**不要静默行为**。宁可多显示一句来源，也不要让用户面对
 * 一个「为什么这次带了上下文」的谜。
 */
export function multiTurnDefault(selected: string[], declared: string[]): MultiTurnDefault {
  const decl = new Set(declared);
  const sources = [...new Set(selected)].filter((s) => decl.has(s)).sort();
  return { value: sources.length > 0, sources };
}

/**
 * 开关文案。**必须说清「现在是几轮」和「为什么」** —— 混选时默认值有歧义，
 * 而一个没有来源标注的开关会让人面对「为什么这次带了上下文」的谜。
 *
 * - `多轮·trip-planner` —— 开关在默认位上，来源就是声明多轮的那个能力
 * - `单轮（覆盖默认：trip-planner 声明多轮）` —— 用户手动关掉了（调试就是要试开/关）
 * - `多轮（手动开）` —— 没有任何能力声明多轮，用户自己开的
 */
export function multiTurnLabel(value: boolean, sources: string[], isDefault: boolean): string {
  if (value) {
    if (sources.length > 0) return `多轮·${sources.join(',')}`;
    return isDefault ? '多轮' : '多轮（手动开）';
  }
  if (sources.length > 0) return `单轮（覆盖默认：${sources.join(',')} 声明多轮）`;
  return '单轮';
}

// ---------- prompt 回显（§6 的 (乙)） ----------

/** 回显栈上限（与 shell 的 HISTSIZE 同量级；面板只保证「调得回最近这些条」） */
export const PROMPT_HISTORY_LIMIT = 50;

/**
 * 把一条 prompt 压进回显栈。
 *
 * 口径照 shell 的 `HISTCONTROL=ignoredups`：**只与栈顶比**，连续重复不入栈
 * （按两次回车不该占两格）。空白串直接丢弃。
 *
 * ⚠️ 这是 (乙) **prompt 回显**，不是 (甲) 对话历史：它只是把文字填回输入框，
 * **模型看不见**（模型收到的仍是你最终回车的那句），所以永远可用、零成本 ——
 * 与「多轮开关」无关（§6 的两层读法）。
 */
export function pushPromptHistory(
  history: string[],
  prompt: string,
  limit: number = PROMPT_HISTORY_LIMIT,
): string[] {
  const p = prompt.trim();
  if (p.length === 0) return history;
  if (history[history.length - 1] === p) return history;
  const next = [...history, p];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** 游标停在草稿（当前输入框内容）上 */
export const HISTORY_DRAFT = -1;

/**
 * ↑/↓ 的游标推进。游标语义 = **距栈尾的距离**：`-1` 是草稿、`0` 是最新一条、
 * `n-1` 是最旧一条。`older`（↑）加一、`newer`（↓）减一，两端夹住不绕回
 * —— 绕回会在按过头时把用户送回一个他没想到的位置。
 */
export function historyStep(history: string[], cursor: number, dir: 'older' | 'newer'): number {
  if (history.length === 0) return HISTORY_DRAFT;
  const next = cursor + (dir === 'older' ? 1 : -1);
  if (next < HISTORY_DRAFT) return HISTORY_DRAFT;
  if (next > history.length - 1) return history.length - 1;
  return next;
}

/** 游标处的文本（草稿位返回草稿本身 —— 按 ↓ 回到你还没发出去的那句） */
export function historyText(history: string[], cursor: number, draft: string): string {
  if (cursor === HISTORY_DRAFT || history.length === 0) return draft;
  return history[history.length - 1 - cursor] ?? draft;
}

// ---------- 对话视图（§6 的 (甲)，含 D6 的 join） ----------

export interface ConversationTurn {
  /** 该轮的用户输入（= 面板发出去的 prompt） */
  user: string;
  /** 该轮的回复；失败轮 / 中止轮 / 尚未回写时为 null */
  assistant: string | null;
  /**
   * 按 run 的**实际终态**标失败（D6 的规则）。
   *
   * 为什么需要它：`runtime/run.ts` 只在**成功**轮次回写 session ⇒ 失败的那轮在
   * 会话文件里**根本不存在**，谈不上「标失败」。所以面板必须把 **run 列表**与
   * **会话文件**对上 —— 键是 run 根 span 的 `session.id`。
   * 漏了这个 join 的症状是「显示一份**少了**一轮的对话」，同样是「一份不存在的
   * 对话」，只是方向相反、且更难发现（人天然以为失败那次没跑）。
   *
   * ⚠️ **中止不算失败**（见 `runIsFailure`）：`abortedResult()` 刻意给已取消的 run
   * 带结构化 error，只看 `ok` 会把「我按了中止」记成「这一轮失败了」—— 与通知条
   * （`runDoneNotice`）同一类错，只是它从另一个表面（`ok`）漏出来。
   */
  failed: boolean;
  /** 该轮是**人被中止**的（既不是成功也不是失败）：面板据此换一句文案与一种左边线 */
  aborted: boolean;
  /** 该轮对应的 run（能对上时有值） */
  traceId: string | null;
}

/** 会话文件里的一条消息（形状的单源在 dev-protocol，这里只是给面板侧一个短名字） */
export type { SessionMessageLike };

/** run 列表里与对话有关的那几列（= 面板已知的 RunSummary + CLI 侧记账） */
export interface ConversationRunLike {
  traceId: string;
  ok: boolean;
  /**
   * 收尾原因（`end_turn` / `aborted` / `budget_exceeded` / …），来自 run 根 span 的
   * `stop_reason` attribute。**判别中止的唯一判据**（理由见 `runIsFailure`）。
   */
  stopReason?: string | null;
  /** run 根 span 的 `session.id`；没开会话的 run 没有这个键 */
  sessionId?: string | null;
  /** CLI 侧记账：这次 run 发的 prompt（失败轮靠它才能显示出来） */
  prompt?: string | null;
}

/**
 * 这个 run 算不算**失败**？
 *
 * ⚠️ 这是语义判别，不能在各处直接读 `ok` —— 引擎的 `abortedResult()` 刻意给
 * 「被人中止」的 run 带上结构化 error（取消不是失败，但原因要可查，见 `loop-result.ts`），
 * 于是 `ok === false`。只看 `ok` 的两个表面会一起说谎：
 * - run 列表把它标成红点（用户会以为是自己把工程改坏了）；
 * - 对话视图给这一轮打红边「（这一轮失败了…）」，而同一个 run 的通知条写着「已中止」。
 *
 * 判别顺序（**先 stopReason 后 ok**）与 `runDoneNotice` 是同一条语义，钉在单测里。
 */
export function runIsFailure(r: { ok: boolean; stopReason?: string | null }): boolean {
  if (r.stopReason === 'aborted') return false;
  return !r.ok;
}

/** `MessageParam.content` 可能是 string，也可能是 content block 数组 —— 只取文本块 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * 把「会话文件里的消息」与「run 列表里失败的那些 run」拼成对话流。
 *
 * 合并规则（D6 评审补充落成的形状）：
 *
 * > 对话流的每一轮 = 「会话文件里的一条消息」**∪**
 * > 「run 列表里 `session.id` 相同、但没有回写会话的（失败 / 被中止）run」
 *
 * 失败轮的去重键用 **prompt 文本**：会话文件里已经有同一句 user 消息（说明那轮
 * 其实回写成功了）就不重复追加。这比按序号对更稳 —— 会话文件会被裁剪、也会被
 * 手工改（那正是「面板显示一份不存在的对话」的入口，所以面板**只读**它）。
 *
 * ⚠️ **中止轮也走这条 join**（`failed: false` / `aborted: true`）：框架只在**成功**路径
 * 回写会话，所以被中止的那轮同样「会话文件里没有」；把它排除掉会让面板显示一份
 * **少了一轮**的对话 —— 与「多了一轮」同类的静默不一致，只是更难发现。
 * 但它绝不能像失败轮那样标红（判别走 `runIsFailure`）。
 */
export function mergeConversation(
  messages: SessionMessageLike[],
  runs: ConversationRunLike[],
  sessionId: string,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;

  for (const m of messages) {
    const text = textOfContent(m.content);
    if (m.role === 'user') {
      current = { user: text, assistant: null, failed: false, aborted: false, traceId: null };
      turns.push(current);
      continue;
    }
    if (m.role === 'assistant' && current) {
      current.assistant = current.assistant === null ? text : `${current.assistant}\n${text}`;
    }
    // 其它角色（tool_result 等）不进对话流：它是实现细节，不是「对话」
  }

  // 失败 / 中止轮：同 session、终态非成功、且没在会话文件里出现过的那次输入
  const seen = new Set(turns.map((t) => t.user));
  for (const r of runs) {
    if (r.ok) continue;
    if ((r.sessionId ?? null) !== sessionId) continue;
    const prompt = (r.prompt ?? '').trim();
    if (prompt.length === 0 || seen.has(prompt)) continue;
    seen.add(prompt);
    // 判别顺序（先 stopReason 后 ok）在 runIsFailure 里，与通知条同一条语义
    const failed = runIsFailure(r);
    turns.push({ user: prompt, assistant: null, failed, aborted: !failed, traceId: r.traceId });
  }
  return turns;
}

// ---------- CLI 侧记账（面板发出去的东西，CLI 自己记一笔） ----------

/**
 * 往 notes 表里记一条，并**按插入序**把表压在 `max` 以内。
 *
 * 为什么淘汰必须在这里（而不是只跟着 `runs`）：`noteRun` 记的 traceId 可能
 * **永远进不了** `runs` —— trace 是 run 收尾时经 `POST /ingest` 另一路投递的，
 * sink 失败 / agent 进程被杀就没有那条 trace，这条 note 便无人认领。而 dev 是**长跑**
 * 进程（一次调试会话里反复运行）⇒ 无人认领的 note 只涨不降。
 *
 * ⚠️ 旧实现把淘汰只挂在「traceId 进 `runs`」那一条路上，注释却写着「与 runs 同步淘汰」
 * —— 「注释与事实不符」本身也是本仓在猎的东西，所以这段落到有单测的 panel-logic 里。
 */
export function rememberNote<T>(
  notes: Map<string, T>,
  traceId: string,
  note: T,
  max: number,
): void {
  // 重新 set 同一个 key 不改变插入序（Map 语义）⇒ 不需要先 delete 再 set
  notes.set(traceId, note);
  while (notes.size > max) {
    const oldest = notes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    notes.delete(oldest);
  }
}

// ---------- run 收尾的反馈语 ----------

/**
 * `run-done` → 面板底部那句操作反馈。
 *
 * 为什么这是一条**规则**而不是 HTML 里的三行 if（那份没有单测）：判别顺序是语义。
 * 引擎的 `abortedResult()` **刻意**给已取消的 run 带上结构化 error（取消不是失败，
 * 但原因要可查）⇒ 中止时 `ok` 也是 **false**。所以必须**先**认 `stopReason`：
 * 反过来先看 `ok`，用户按的「中止」就会被显示成一句吓人的「run 失败」。
 * 这个顺序错一次很难在 code review 里看出来，所以钉在单测里。
 */
export function runDoneNotice(ev: { ok: boolean; stopReason: string; error: string | null }): {
  text: string;
  isError: boolean;
} {
  if (ev.stopReason === 'aborted') {
    return { text: 'run 已中止（trace 保住了）', isError: false };
  }
  if (!ev.ok) {
    return { text: `run 失败（${ev.stopReason}）：${ev.error || '未知原因'}`, isError: true };
  }
  return { text: `run 完成（${ev.stopReason}）`, isError: false };
}

// ---------- 路径显示 ----------

/**
 * 把绝对路径压短给面板看（`~/proj/a`）。
 *
 * 只影响**显示**：发给子进程的永远是完整绝对路径（工具按它解析），
 * 所以压短不会让「我以为在 A，其实在 B」发生 —— 那正是 D5 要防的时刻。
 */
export function shortenPath(abs: string, opts: { home?: string; cwd?: string } = {}): string {
  if (abs.length === 0) return '';
  const home = opts.home ?? '';
  const cwd = opts.cwd ?? '';
  if (home && (abs === home || abs.startsWith(`${home}/`))) return `~${abs.slice(home.length)}`;
  if (cwd && (abs === cwd || abs.startsWith(`${cwd}/`))) return `.${abs.slice(cwd.length)}`;
  return abs;
}

// ---------- ① 实时右栏：把增量记账帧折回成一棵树 ----------

/**
 * 面板侧的 trace 累加器：**按 `seq` 把增量记账事件应用到一个一个 span 上**。
 *
 * 为什么在面板侧复刻这条折叠规则、而不是让父进程折好再发：框架已经钉着一条不变量
 * （`tests/engine/trace-events.test.ts`）—— 按 `seq` 升序把同一次 run 的全部事件应用到
 * `span.begin` 建出的 span 上，结果**逐字等于**收尾的 `snapshot()`。照它折回就得到与
 * 收尾一致的树，**不需要**任何「哪些字段重要」的本地判断；父进程插一手只会多一处会漂的口径。
 *
 * 两条纪律（与框架同名出口一致）：
 * - **不保证送达**：宿主自己的流断了就断了。所以折出来的这棵是**临时**的 ——
 *   收尾那份整棵 trace 回来时**覆盖**它（面板据此把累加器丢掉），缺的 span 由那份补齐。
 * - **是观察，不是控制**：丢了不影响 run，也不影响收尾的 trace。
 */
export interface TraceAccumulator {
  /** 已应用的最大 `seq` —— 重复投递 / 乱序靠它丢掉（送达的那些只能应用一次） */
  lastSeq: number;
  /** 从第一个 `span.begin` 上读到的 traceId（还没建出节点时是空串） */
  traceId: string;
  spans: TraceSpanLike[];
}

/** 空累加器：`state.live` 的初值，也是 e2e 折回的起点 */
export function emptyTraceAccumulator(): TraceAccumulator {
  return { lastSeq: 0, traceId: '', spans: [] };
}

/**
 * 应用一条增量记账事件。返回**它有没有被用上**（false = 丢了）。
 *
 * 丢的三种情形都是刻意的、**都不抛**：
 * - `seq` 不前进（重复投递、迟到的旧帧）—— SSE 不保证送达，但送达的只能应用一次；
 * - 指向**没见过的 `spanId`**（面板连上得晚，那个 `span.begin` 没收到）—— 绝不能凭空建
 *   节点：那会造出一棵缺了上半截的假树。收尾那份会补齐；
 * - 形状不认识（框架将来加了新事件类型）—— 静默放过，别让整个右栏停摆。
 */
export function applyTraceEvent(acc: TraceAccumulator, ev: TraceRecordEventLike): boolean {
  // 先卡 seq：它同时挡住「重复投递」与「乱序的旧帧」
  if (!ev || typeof ev.seq !== 'number' || ev.seq <= acc.lastSeq) return false;
  const find = (spanId: string): TraceSpanLike | undefined =>
    acc.spans.find((s) => s.spanId === spanId);
  switch (ev.type) {
    case 'span.begin': {
      const src = ev.span;
      // 拷一份：折回不该持有（更不该改写）协议对象 —— 面板会重画很多次
      const copy: TraceSpanLike = {
        ...src,
        attributes: { ...src.attributes },
        events: (src.events ?? []).map((e) => ({ ...e })),
      };
      const seen = find(src.spanId);
      // 同一个 `spanId` 再来一次 ⇒ **原地刷新**（重放幂等），不再挂一个同 id 的节点
      if (seen) Object.assign(seen, copy);
      else {
        acc.spans.push(copy);
        if (!acc.traceId) acc.traceId = src.traceId;
      }
      break;
    }
    case 'span.end': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.endedAt = ev.endedAt;
      s.status = ev.status;
      if (ev.error) s.error = { ...ev.error };
      if (ev.usage) s.usage = { ...ev.usage };
      break;
    }
    case 'span.event': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.events.push({ ...ev.event });
      break;
    }
    case 'span.attribute': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.attributes = { ...s.attributes, [ev.key]: ev.value };
      break;
    }
    case 'span.link': {
      const s = find(ev.spanId);
      if (!s) return false;
      s.links = [...(s.links ?? []), ev.link];
      break;
    }
    default:
      return false;
  }
  acc.lastSeq = ev.seq;
  return true;
}

/**
 * 当前已知的这棵树（交给 `playTrace` 画）。返回的是**副本** —— 渲染层拿它排序 / 展开，
 * 不该回头改到累加器（下一次重画还要用同一份账）。
 *
 * `status` 只区分**在飞**与**已收尾**：根 span 还没有 `endedAt` 就是「在飞」，渲染层据此
 * **不收尾**（否则根会被画成「已在某一刻完成」，那是个假事实）。收尾后取根自己的状态
 * （`ok` / `error`），与框架口径一致。
 */
export function partialTrace(acc: TraceAccumulator): {
  traceId: string;
  spans: TraceSpanLike[];
  status: string;
} {
  const spans = acc.spans.map((s) => ({
    ...s,
    attributes: { ...s.attributes },
    events: s.events.map((e) => ({ ...e })),
  }));
  const root = spans.find((s) => s.parentSpanId === null);
  const status = root && root.endedAt === undefined ? 'running' : (root?.status ?? 'running');
  return { traceId: acc.traceId, spans, status };
}

// ---------- ② 回复正文的归属 ----------

/**
 * 「`open(id)` 该不该**保留**屏幕上这条回复」。
 *
 * 背景：`run-done` 把回复正文写上去之后，面板会**自动 open 刚跑完的那一轮** ——
 * 而 `open()` 原本无条件清掉回复区，于是那句回复在十几毫秒后被自己擦掉（看起来像「没回复」）。
 *
 * 口径与 `open()` 的原意图对齐：只有「现在打开的就是这条回复的主人」才保留；其余一律清
 * （打开一条历史 run 时若还挂着**别人**的回复，那是张冠李戴 —— 比空白更糟）。
 * `replyFor` 为 null（还没跑过 / 已清）**不等于**「谁都对」：默认清。
 */
export function replyBelongsTo(openId: string | null, replyFor: string | null): boolean {
  if (!openId || !replyFor) return false;
  return openId === replyFor;
}

// ---------- ③ 目录浏览 / 选文件 ----------

/**
 * 点「浏览…」时该打开哪个目录：**总是**按输入框的值。
 *
 * 旧实现把它当**开关**（面板开着时再点一次就关掉），于是「在输入框敲了目标路径 → 点浏览…」
 * 这个最自然的动作反而是把面板关掉，用户就以为「选不了别的目录」。空值才回落到缺省工作目录；
 * 首尾空白不该让路径读错。
 */
export function browseTarget(value: string, defaultDir: string): string {
  const v = value.trim();
  return v.length > 0 ? v : defaultDir;
}

/**
 * 点一个**文件**之后的 prompt 该是什么。
 *
 * 口径：**只在 prompt 为空时**填文件名（省一次打字）；用户已经写好的话**一个字都不动** ——
 * 悄悄改写用户输入比少填一次糟得多。`filled` 是给面板回话用的（提示文案不同）。
 * 工作目录的切换（取该文件**所在的**目录）由调用方做，不在这个纯判定里。
 */
export function promptAfterFilePick(
  current: string,
  name: string,
): { prompt: string; filled: boolean } {
  if (current.trim().length > 0) return { prompt: current, filled: false };
  return { prompt: name, filled: true };
}
