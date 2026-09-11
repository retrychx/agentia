import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../core/tool.js';

/**
 * OpenAI 兼容端点适配器（R4 多模型）。
 *
 * 把 engine 的 Anthropic 形态请求翻译成 OpenAI chat.completions 请求，
 * 响应再翻译回 Anthropic.Message —— 产出的 ModelClient 可直接喂给
 * executeRun / runAgent 的 client 选项。兼容端点（DeepSeek 等）换 baseURL 即可。
 *
 * 剩余边界（**协议层面无法对齐**，不是没做）：
 * - cache token 恒 0：OpenAI 形态没有 prompt cache 计量字段；
 * - refusal 为近似：finish_reason=content_filter 近似映射为 'refusal'，
 *   语义上接近但不等同 Anthropic 的流式分类器干预。
 *
 * 流式（C3）：默认 `stream: true`，逐 token 触发 `on('text')`；`tool_calls` 的
 * 分片按 `index` 累积后再汇成完整 `tool_use`。带 `stream_options.include_usage`
 * 取 token 计量 —— 个别端点不认这个字段，可设 `stream: false` 退回一次性响应。
 */
export interface OpenAIClientOptions {
  /** 缺省读 env OPENAI_API_KEY */
  apiKey?: string;
  /** 缺省 https://api.openai.com；兼容端点直接替换（如 https://api.deepseek.com） */
  baseURL?: string;
  /**
   * 是否用流式（缺省 true，逐 token 回调）。设 false 退回一次性响应：
   * 兼容端点若不支持 `stream_options` 而报 400，用它兜底。
   */
  stream?: boolean;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
}

export function createOpenAIClient(opts: OpenAIClientOptions = {}): ModelClient {
  const baseURL = (opts.baseURL ?? 'https://api.openai.com').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const useStream = opts.stream ?? true;

  return {
    messages: {
      stream(params) {
        const textCallbacks: Array<(delta: string) => void> = [];
        return {
          on(event: 'text', cb: (delta: string) => void) {
            if (event === 'text') textCallbacks.push(cb);
          },
          async finalMessage(): Promise<Anthropic.Message> {
            const req = toOpenAIRequest(params);
            const res = await fetchImpl(`${baseURL}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
              },
              // signal 必须转发：否则调用方（含 A1 的取消 / 超时）无法中止在飞请求
              ...(params.signal ? { signal: params.signal } : {}),
              body: useStream
                ? JSON.stringify({ ...req, stream: true, stream_options: { include_usage: true } })
                : JSON.stringify(req),
            });
            if (!res.ok) {
              const body = await res.text();
              throw new Error(`OpenAI 请求失败 ${res.status}: ${body.slice(0, 200)}`);
            }

            // 内容协商：**按响应实际形态**决定怎么解析，而不是按我们请求了什么 ——
            // 部分兼容端点会忽略 `stream: true` 直接回一整份 JSON（此时退回 JSON 路径，
            // 行为与旧版本一致，只是没有逐 token 的「打字机」效果）。
            const ctype = res.headers.get('content-type') ?? '';
            const isSse = ctype.includes('event-stream');
            if (!useStream || !isSse) {
              const data = (await res.json()) as OpenAIChatResponse;
              const message = toAnthropicMessage(data, params.model);
              // 非流式：完整文本一次性交给回调（与流式的最终结果一致）
              const full = textOf(message);
              if (full) for (const cb of textCallbacks) cb(full);
              return message;
            }

            if (!res.body) {
              throw new Error('OpenAI 流式响应没有 body（端点声明了 event-stream 却没给流）');
            }
            return await readStream(res.body, params.model, textCallbacks);
          },
        };
      },
    },
  };
}

// —— OpenAI 形态（手写最小子集，零依赖）——

interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 多模态内容分片（C3）：文本块与图片块各自对应一种 part */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChatRequest {
  model: string;
  max_tokens: number;
  messages: OpenAIMessage[];
  tools?: Array<{ type: 'function'; function: OpenAIToolFunction }>;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** 流式分片（`data:` 行的 payload） */
interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  /** 只有带 stream_options.include_usage 时，最后一个 chunk 才带 usage */
  usage?: OpenAIUsage;
}

type StreamParams = {
  model: string;
  max_tokens: number;
  system?: string | Anthropic.TextBlockParam[];
  tools?: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
};

/** Anthropic 请求形态 → OpenAI chat.completions 请求 */
function toOpenAIRequest(params: StreamParams): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  if (params.system) {
    messages.push({
      role: 'system',
      content:
        typeof params.system === 'string'
          ? params.system
          : params.system.map((b) => b.text).join('\n'),
    });
  }

  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'user') {
      // tool_result blocks：每个 block 一条 role=tool 消息；其余合成一条 user
      const blocks = m.content as Anthropic.ContentBlockParam[];
      const toolResults = blocks.filter(
        (b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result',
      );
      const rest = blocks.filter((b) => b.type !== 'tool_result');
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content:
            tr.content === undefined
              ? ''
              : typeof tr.content === 'string'
                ? tr.content
                : JSON.stringify(tr.content),
        });
      }
      if (rest.length > 0) messages.push({ role: 'user', content: renderUserContent(rest) });
    } else {
      // assistant：文本部分进 content（无则 null），tool_use → tool_calls
      const blocks = m.content as Anthropic.ContentBlockParam[];
      const text = blocks
        .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolUses = blocks.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use',
      );
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((tu) => ({
                id: tu.id,
                type: 'function' as const,
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              })),
            }
          : {}),
      });
    }
  }

  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages,
    ...(params.tools && params.tools.length > 0
      ? {
          tools: params.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              parameters: t.input_schema,
            },
          })),
        }
      : {}),
  };
}

/**
 * user 消息的非 tool_result 块 → OpenAI content（C3 多模态）。
 *
 * - 文本块 → `{type:'text'}`；
 * - 图片块 → `{type:'image_url'}`，base64 源编成 data URL，url 源直接透传；
 * - **没有图片时回落成纯字符串** —— 部分兼容端点只接受 string content，
 *   无脑上数组会把原本能跑的通路弄坏（旧行为就是纯字符串）。
 */
function renderUserContent(blocks: Anthropic.ContentBlockParam[]): string | OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  let hasImage = false;
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ type: 'text', text: (b as Anthropic.TextBlockParam).text });
      continue;
    }
    if (b.type === 'image') {
      const url = imageUrlOf(b as Anthropic.ImageBlockParam);
      if (url) {
        parts.push({ type: 'image_url', image_url: { url } });
        hasImage = true;
        continue;
      }
    }
    // 其余块类型 JSON 兜底：宁可把原文交给模型，也不静默丢内容
    parts.push({ type: 'text', text: JSON.stringify(b) });
  }
  if (!hasImage) {
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return parts;
}

/** Anthropic image block → OpenAI 能吃的 URL（base64 编 data URL；url 源透传） */
function imageUrlOf(b: Anthropic.ImageBlockParam): string | null {
  const src = b.source as { type?: string; media_type?: string; data?: string; url?: string };
  if (src.type === 'base64' && src.data) {
    return `data:${src.media_type ?? 'image/png'};base64,${src.data}`;
  }
  if (src.type === 'url' && src.url) return src.url;
  return null;
}

/** 流式累积器：文本拼接 + tool_calls 按 index 分片累积 */
interface StreamAccumulator {
  id?: string;
  model?: string;
  text: string;
  /** index → 半成品（`arguments` 是分片拼接的，这正是「易错」的那一步） */
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finish?: string | null;
  usage?: OpenAIUsage;
}

/**
 * 消费 `text/event-stream` 并组装成 Anthropic.Message。
 *
 * 关键点（每条都有对应单测）：
 * - **`id` / `name` 取首次出现的值**（OpenAI 在第一个分片给全），
 *   **`arguments` 按分片拼接** —— 一次调用的 JSON 参数会被拆成多片；
 * - 多个工具并行调用时**必须按 `index` 归并**，不能按到达顺序新建；
 * - `usage` 在**最后一个 chunk**（choices 为空的那条）才出现；
 * - `[DONE]` 是结束哨兵，之后不再有数据。
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  textCallbacks: Array<(delta: string) => void>,
): Promise<Anthropic.Message> {
  const acc: StreamAccumulator = { text: '', toolCalls: new Map() };
  for await (const line of sseLines(body)) {
    if (!line.startsWith('data:')) continue; // 忽略 event: / id: / 注释 / 空行
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    if (payload === '[DONE]') break;
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk;
    } catch {
      continue; // 半截/畸形分片不该毁掉整个流（后面还有正常数据）
    }
    applyChunk(acc, chunk, textCallbacks);
  }
  return accumulatorToMessage(acc, fallbackModel);
}

/** 把一条流式分片并进累积器 */
function applyChunk(
  acc: StreamAccumulator,
  chunk: OpenAIStreamChunk,
  textCallbacks: Array<(delta: string) => void>,
): void {
  if (chunk.id) acc.id ??= chunk.id;
  if (chunk.model) acc.model ??= chunk.model;
  if (chunk.usage) acc.usage = chunk.usage;

  const choice = chunk.choices?.[0];
  if (!choice) return; // 带 usage 的收尾 chunk 没有 choices
  const delta = choice.delta;
  if (delta?.content) {
    acc.text += delta.content;
    // 逐 token 下发 —— 这就是「打字机」效果的全部来源
    for (const cb of textCallbacks) cb(delta.content);
  }
  for (const tc of delta?.tool_calls ?? []) {
    const index = tc.index ?? 0;
    const entry = acc.toolCalls.get(index) ?? { id: '', name: '', args: '' };
    // id / name 只在首次给全（`??=`）；arguments 必须拼接
    if (tc.id) entry.id ||= tc.id;
    if (tc.function?.name) entry.name ||= tc.function.name;
    if (tc.function?.arguments) entry.args += tc.function.arguments;
    acc.toolCalls.set(index, entry);
  }
  if (choice.finish_reason) acc.finish = choice.finish_reason;
}

/** 累积器 → Anthropic.Message */
function accumulatorToMessage(acc: StreamAccumulator, fallbackModel: string): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (acc.text) content.push({ type: 'text', text: acc.text } as Anthropic.TextBlock);

  // 按 index 升序还原调用顺序（Map 保留插入序，但 index 可能乱序到达）
  const calls = [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  let n = 0;
  for (const [, tc] of calls) {
    n++;
    content.push({
      // 端点没给 id 时补一个：engine 会把它当 tool_use_id 回传，空 id 会让配对失败
      id: tc.id || `call_${n}`,
      type: 'tool_use',
      name: tc.name,
      input: parseToolArgs(tc.args),
    } as Anthropic.ToolUseBlock);
  }

  const hasToolCalls = calls.length > 0;
  return {
    id: acc.id ?? 'chatcmpl-unknown',
    type: 'message',
    role: 'assistant',
    model: acc.model ?? fallbackModel,
    content,
    stop_reason: mapStopReason(acc.finish, hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: acc.usage?.prompt_tokens ?? 0,
      output_tokens: acc.usage?.completion_tokens ?? 0,
      // OpenAI 形态无 cache 计量：恒 0
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

/** tool_call 的 arguments 是模型生成的 JSON 字符串；非法时原样交给下游 schema 校验 */
function parseToolArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 逐行读 SSE（OpenAI 每条事件都是一行 `data:`，不需要处理多行 payload） */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
      }
    }
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    // 提前 break（[DONE]）时释放读锁，否则流不会被回收
    try {
      await reader.cancel();
    } catch {
      /* 已结束/已取消 */
    }
  }
}

/** OpenAI chat.completions 响应 → Anthropic.Message */
function toAnthropicMessage(data: OpenAIChatResponse, model: string): Anthropic.Message {
  const choice = data.choices?.[0];
  if (!choice) {
    // 200 但 choices 为空/缺失：上游故障（兼容端点 bug、被网关截断）。
    // 不得静默映射成「成功」——空文本 + usage 全 0 + end_turn 会把一次上游故障
    // 记成正常收尾，run 结论与真实情况相反。抛出交 engine 按 error 收尾。
    throw new Error(
      `OpenAI 兼容端点返回空 choices（id=${data.id ?? 'unknown'}）；响应无可用补全，按上游故障处理`,
    );
  }
  const msg = choice.message ?? {};

  const content: Anthropic.ContentBlock[] = [];
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content } as Anthropic.TextBlock);
  }
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: parseToolArgs(tc.function.arguments),
    } as Anthropic.ToolUseBlock);
  }

  return {
    id: data.id ?? 'chatcmpl-unknown',
    type: 'message',
    role: 'assistant',
    model: data.model ?? model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason, (msg.tool_calls?.length ?? 0) > 0),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      // OpenAI 形态无 cache 计量：恒 0
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

/** 取消息里的全部文本块（非流式路径一次性回调用） */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * finish_reason → Anthropic stop_reason（content_filter→refusal 为近似映射）。
 *
 * hasToolCalls：**只要响应带 tool_calls 就必须是 tool_use**，不看 finish_reason ——
 * DeepSeek / vLLM / Ollama 等兼容端点在带工具调用时回的是 `stop`；若映射成 end_turn，
 * engine 会在提取工具块之前就收尾（loop 的 end_turn 即终态），工具调用被静默丢弃。
 */
function mapStopReason(finish: string | null | undefined, hasToolCalls: boolean): Anthropic.StopReason {
  if (hasToolCalls) return 'tool_use';
  switch (finish) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    default:
      return 'end_turn';
  }
}
