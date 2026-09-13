import type Anthropic from '@anthropic-ai/sdk';

/**
 * Agentia —— 长上下文策略的纯函数层（spec §5/§6：compaction / context editing 分清）。
 *
 * 三策略不混：
 * - **context editing**（`trimToolPairs`）：清旧 tool_use→tool_result 对，不掉内容、不额外调模型；
 * - **compaction**（`compactMessages`）：把旧消息前缀做**服务端摘要**（摘要器由上层注入，可走模型），
 *   只保留最近 N 条 + 一段摘要 —— 新的消息数组仍保证角色交替合法；
 * - **客户端剪裁** = 子 agent 的独立上下文（见 toolkit/subagent.ts）。
 *
 * 不在此自研 token 计数黑名单：`estimateMessages` 只是预算策略的默认启发式
 * （CJK 感知估算，明确标注为估算），上层可注入真实 count_tokens 结果。
 */

/**
 * 默认估算（仅预算决策用，非精确记账）：CJK 字符按 ~1.5 字/token，
 * 其余（ASCII/拉丁）按 ~4 字符/token。纯字符/4 对中文系统性高估，
 * 会让预算护栏过早触发压缩。
 */
/** BMP 内的 CJK 范围（用正则扫描数，不做逐码点 JS 循环） */
const CJK_BMP_RE = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
/** 增补平面 CJK（扩展 B–G）—— 极少出现，单独按码点计数 */
const CJK_SUPP_RE = /[\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{30000}-\u{3134f}]/gu;
const CJK_SUPP_TEST = /[\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}\u{30000}-\u{3134f}]/u;

export function defaultEstimateTokens(text: string): number {
  // 快路径：把 BMP 内的 CJK 一次性抹掉，用长度差得到 BMP-CJK 字符数。
  // 不用 `for..of` + `codePointAt` 逐码点判区间 —— 那是 JS 层循环，V8 的正则扫描快得多：
  // 300KB 文本上实测 0.44ms → 0.18ms（JSON 工具结果），纯 ASCII 上 2.29ms → ~0ms。
  // 这是框架里单点最大的 CPU 消耗（profile 占约 46%），所以值得走正则。
  const rest = text.replace(CJK_BMP_RE, '').length;
  let cjk = text.length - rest;
  let other = rest; // 未被抹掉的 UTF-16 单元数（含代理对的两个单元）
  // 增补平面：每个字符占 2 个 UTF-16 单元。旧口径把它算成 cjk+1、other 保留多出的 1 个单元，
  // 这里逐字保持（cjk+1、other-1），否则估算值与护栏触发点都会变。
  // 先 test() 再 matchAll：绝大多数文本不含增补平面，省掉一次带分配的全扫。
  if (CJK_SUPP_TEST.test(text)) {
    for (const _m of text.matchAll(CJK_SUPP_RE)) {
      cjk += 1;
      other -= 1;
    }
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

export function isToolResultMessage(msg: Anthropic.MessageParam): boolean {
  if (msg.role !== 'user') return false;
  if (typeof msg.content === 'string') return false;
  return msg.content.length > 0 && msg.content.every((b) => b.type === 'tool_result');
}

function hasToolUse(msg: Anthropic.MessageParam): boolean {
  if (msg.role !== 'assistant') return false;
  if (typeof msg.content === 'string') return false;
  return msg.content.some((b) => b.type === 'tool_use');
}

function contentToText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'tool_use':
          return `${b.name}(${JSON.stringify(b.input)})`;
        case 'tool_result':
          return JSON.stringify(b.content);
        default:
          return JSON.stringify(b);
      }
    })
    .join('\n');
}

function contentTokens(
  content: Anthropic.MessageParam['content'],
  estimate: (text: string) => number,
): number {
  if (typeof content === 'string') return estimate(content);
  let n = 0;
  for (const b of content) {
    n += 1; // block 自身开销
    n += estimate(contentToText([b] as Anthropic.MessageParam['content']));
  }
  return n;
}

/** 整组消息的估算 token（含每条 role 开销）。 */
export function estimateMessages(
  messages: Anthropic.MessageParam[],
  estimate: (text: string) => number = defaultEstimateTokens,
): number {
  let n = 0;
  for (const m of messages) {
    n += estimate(m.role);
    n += contentTokens(m.content, estimate);
  }
  return n;
}

/**
 * 增量 token 计数器（预算策略专用；**不属公共导出面**，故不进 index.ts）。
 *
 * 为什么需要：`estimateMessages` 是 O(消息数 × 块大小)（每个块还要 stringify），
 * 而预算策略的 `beforeTurn` **每回合都要估一次**。历史只追加，若每回合从零重算，
 * 就是 O(回合 × 上下文)。实测：160 回合时估算吃掉 run 全部框架 CPU 的约 88%、
 * 累计 467ms（10→160 回合之间增长 ×103，明显超线性）。
 *
 * 这里缓存「已计过的前缀」，只对**新增消息**计数 —— 追加场景降为 O(上下文)。
 * 数组引用变了、或长度变短（策略裁剪过 / 换了新数组）→ 自动从零重算，所以
 * 在 `messages.splice(...)` 原地替换后也不会读到脏缓存。
 */
export function createTokenCounter(
  estimate: (text: string) => number = defaultEstimateTokens,
): (messages: Anthropic.MessageParam[]) => number {
  let ref: Anthropic.MessageParam[] | null = null;
  let counted = 0;
  let tokens = 0;
  /** 已计入区间**最后一个元素的对象标识** —— 用于发现「同数组、长度不减、内容却被换掉」 */
  let boundary: Anthropic.MessageParam | undefined;
  return function count(messages: Anthropic.MessageParam[]): number {
    const edge = counted > 0 ? messages[counted - 1] : undefined;
    // 三重失效判据：换了数组 / 长度变短（被裁剪） / 边界元素已不是同一个对象
    // （第三种覆盖自定义 contextPolicy 原地覆写同长度内容的情形 —— 只有长度判据会漏）
    if (messages !== ref || messages.length < counted || edge !== boundary) {
      ref = messages;
      counted = 0;
      tokens = 0;
    }
    for (let i = counted; i < messages.length; i++) {
      tokens += estimate(messages[i].role);
      tokens += contentTokens(messages[i].content, estimate);
    }
    counted = messages.length;
    boundary = counted > 0 ? messages[counted - 1] : undefined;
    return tokens;
  };
}

/** 把消息渲染成可喂给摘要器的纯文本（role: content）。 */
export function renderMessages(messages: Anthropic.MessageParam[]): string {
  return messages.map((m) => `${m.role}: ${contentToText(m.content)}`).join('\n\n');
}

export interface TrimOptions {
  /** 保留最近几对 tool exchange（tool_use→tool_result **对数**）；缺省 1 */
  keepToolPairs?: number;
}

/** assistant 消息里的 tool_use id 列表（无则空） */
function toolUseIds(msg: Anthropic.MessageParam): string[] {
  if (msg.role !== 'assistant' || typeof msg.content === 'string') return [];
  return msg.content.filter((b) => b.type === 'tool_use').map((b) => (b as Anthropic.ToolUseBlockParam).id);
}

/** user 消息里的 tool_result 对应 id 列表（无则空） */
function toolResultIds(msg: Anthropic.MessageParam): string[] {
  if (msg.role !== 'user' || typeof msg.content === 'string') return [];
  return msg.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id);
}

/**
 * 历史是否「工具块严格成对」—— 只有这种历史才能安全地整对丢弃。
 *
 * 若历史非严格交替（例如连续两条 assistant 各带 tool_use，结果挤在第三条 user 里），
 * 按「相邻性」配对会只丢掉后一对，把前一条 assistant 的 tool_use 变成**孤立块**
 * → 下一次请求被 API 以 400 拒绝。检测到畸形即整体放弃裁剪，返回原数组更安全。
 */
function toolBlocksPaired(messages: Anthropic.MessageParam[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const useIds = toolUseIds(messages[i]);
    if (useIds.length > 0) {
      const next = messages[i + 1];
      if (!next || toolResultIds(next).length === 0) return false; // tool_use 无对应结果消息
      const resultIds = new Set(toolResultIds(next));
      if (!useIds.every((id) => resultIds.has(id))) return false; // 结果未覆盖全部 tool_use
    }
    const resultIds = toolResultIds(messages[i]);
    if (resultIds.length > 0) {
      const prev = messages[i - 1];
      if (!prev || toolUseIds(prev).length === 0) return false; // 孤立的 tool_result
    }
  }
  return true;
}

/**
 * context editing：丢弃旧的 tool_use→tool_result 对（超出 keepToolPairs 的），
 * 保留最近 N 对以及所有非工具消息。逐对整体移除，保角色交替合法。
 * 返回原数组引用（若无需裁剪）或新数组。
 *
 * 前置：历史必须是工具块严格成对的（toolBlocksPaired）。畸形历史直接返回原数组
 * —— 宁可少裁剪，也不能切出孤立 tool_use/tool_result 让后续请求 400。
 */
export function trimToolPairs(messages: Anthropic.MessageParam[], opts: TrimOptions = {}): Anthropic.MessageParam[] {
  const keep = Math.max(0, opts.keepToolPairs ?? 1);
  if (!toolBlocksPaired(messages)) return messages;
  const pairs: Array<[assistant: number, result: number]> = [];
  for (let i = 0; i + 1 < messages.length; i++) {
    if (hasToolUse(messages[i]) && isToolResultMessage(messages[i + 1])) {
      pairs.push([i, i + 1]);
      i += 1;
    }
  }
  if (pairs.length <= keep) return messages; // 无需裁剪（或本就留得下）

  // 丢掉最旧的 (pairs.length - keep) 对，最近的 keep 对与所有非工具消息保留
  const drop = new Set<number>();
  for (let k = 0; k < pairs.length - keep; k++) {
    drop.add(pairs[k][0]);
    drop.add(pairs[k][1]);
  }
  const out = messages.filter((_, i) => !drop.has(i));
  return out;
}

export interface CompactOptions {
  /** 保留的最近消息条数；缺省 20 */
  keepRecent?: number;
  /** 摘要器：输入被弃旧前缀的渲染文本，返回摘要 */
  summarize: (historyText: string) => string | Promise<string>;
}

/**
 * compaction：把 messages 里“除最近 keepRecent 条”的旧前缀做摘要，替换成一段
 * 摘要消息，尾部保留。产出保证：
 * - 不拆散 (assistant tool_use → user tool_result) 对 —— cut 落到对中间时整体后移；
 * - 角色交替合法 —— 尾段首条是普通 user 时摘要并入之；否则摘要以 user 角色放最前。
 */
export async function compactMessages(
  messages: Anthropic.MessageParam[],
  opts: CompactOptions,
): Promise<Anthropic.MessageParam[]> {
  const keepRecent = Math.max(1, opts.keepRecent ?? 20);
  if (messages.length <= keepRecent) return messages;

  let cut = messages.length - keepRecent;
  // cut 若落在一对 tool_result 的开头（前一条是带 tool_use 的 assistant），整对后移进保留段
  while (cut > 1 && cut < messages.length && isToolResultMessage(messages[cut])) {
    cut -= 1;
  }

  const prefix = messages.slice(0, cut);
  const tail = messages.slice(cut);
  const summary = await opts.summarize(renderMessages(prefix));
  const label = `[此前对话摘要]\n${summary}`;

  // tail 必非空：keepRecent ≥ 1 且上面已早返回 messages.length <= keepRecent，
  // 故 cut ∈ [1, messages.length)，slice(cut) 至少一条。
  const [first, ...rest] = tail;
  if (first.role === 'user' && !isToolResultMessage(first)) {
    // 并入首条普通 user 消息，保持 user→assistant 交替
    const merged: Anthropic.MessageParam =
      typeof first.content === 'string'
        ? { ...first, content: `${label}\n\n${first.content}` }
        : { ...first, content: [{ type: 'text', text: label }, ...first.content] };
    return [merged, ...rest];
  }
  // 尾段以 assistant 开头：摘要作首条 user（user→assistant 交替合法）
  return [{ role: 'user', content: label }, ...tail];
}
