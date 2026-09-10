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
export function defaultEstimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x3400 && cp <= 0x9fff) || // CJK 统一表意文字（扩展A + 基本区）
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
      (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展B
      (cp >= 0x3000 && cp <= 0x30ff) || // 日文假名 + CJK 标点
      (cp >= 0xff00 && cp <= 0xffef) // 全角字符
    ) {
      cjk++;
    }
  }
  const other = text.length - cjk; // 非 BMP 字符按 UTF-16 长度计，属可接受偏差
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

/** 把消息渲染成可喂给摘要器的纯文本（role: content）。 */
export function renderMessages(messages: Anthropic.MessageParam[]): string {
  return messages.map((m) => `${m.role}: ${contentToText(m.content)}`).join('\n\n');
}

export interface TrimOptions {
  /** 保留最近几对 tool exchange；缺省 1 */
  keepRecent?: number;
}

/**
 * context editing：丢弃旧的 tool_use→tool_result 对（超出 keepRecent 的），
 * 保留最近 N 对以及所有非工具消息。逐对整体移除，保角色交替合法。
 * 返回原数组引用（若无需裁剪）或新数组。
 */
export function trimToolPairs(messages: Anthropic.MessageParam[], opts: TrimOptions = {}): Anthropic.MessageParam[] {
  const keep = Math.max(0, opts.keepRecent ?? 1);
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
  return out.length === messages.length ? messages : out;
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

  if (tail.length === 0) return [{ role: 'user', content: label }];

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
