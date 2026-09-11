import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../core/tool.js';

/**
 * OpenAI 兼容端点适配器（R4 多模型）。
 *
 * 把 engine 的 Anthropic 形态请求翻译成 OpenAI chat.completions 请求，
 * 响应再翻译回 Anthropic.Message —— 产出的 ModelClient 可直接喂给
 * executeRun / runAgent 的 client 选项。兼容端点（DeepSeek 等）换 baseURL 即可。
 *
 * 边界（近似映射，头部声明）：
 * - 非流式模拟：底层一次性 POST（stream:false），on('text') 回调在
 *   finalMessage() 完成后收到一次完整文本，而非逐 token 增量；
 * - cache token 恒 0：OpenAI 形态无 prompt cache 计量字段；
 * - refusal 为近似：finish_reason=content_filter 映射为 'refusal'，
 *   语义上接近但不等同 Anthropic 的流式分类器干预。
 */
export interface OpenAIClientOptions {
  /** 缺省读 env OPENAI_API_KEY */
  apiKey?: string;
  /** 缺省 https://api.openai.com；兼容端点直接替换（如 https://api.deepseek.com） */
  baseURL?: string;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
}

export function createOpenAIClient(opts: OpenAIClientOptions = {}): ModelClient {
  const baseURL = (opts.baseURL ?? 'https://api.openai.com').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;

  return {
    messages: {
      stream(params) {
        const textCallbacks: Array<(delta: string) => void> = [];
        return {
          on(event: 'text', cb: (delta: string) => void) {
            if (event === 'text') textCallbacks.push(cb);
          },
          async finalMessage(): Promise<Anthropic.Message> {
            const res = await fetchImpl(`${baseURL}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
              },
              body: JSON.stringify(toOpenAIRequest(params)),
            });
            if (!res.ok) {
              const body = await res.text();
              throw new Error(`OpenAI 请求失败 ${res.status}: ${body.slice(0, 200)}`);
            }
            const data = (await res.json()) as OpenAIChatResponse;
            const message = toAnthropicMessage(data, params.model);
            // 非流式模拟：完整文本一次性发给 text 回调
            const fullText = message.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('');
            if (fullText) for (const cb of textCallbacks) cb(fullText);
            return message;
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

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

type StreamParams = {
  model: string;
  max_tokens: number;
  system?: string | Anthropic.TextBlockParam[];
  tools?: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
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
      if (rest.length > 0) messages.push({ role: 'user', content: renderBlocks(rest) });
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

/** user 消息中非 tool_result 的 blocks 合成一段文本（text 取文本，其余 JSON 兜底） */
function renderBlocks(blocks: Anthropic.ContentBlockParam[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? (b as Anthropic.TextBlockParam).text : JSON.stringify(b)))
    .join('\n');
}

/** OpenAI chat.completions 响应 → Anthropic.Message */
function toAnthropicMessage(data: OpenAIChatResponse, model: string): Anthropic.Message {
  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};

  const content: Anthropic.ContentBlock[] = [];
  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content } as Anthropic.TextBlock);
  }
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      // arguments 非法 JSON：原样字符串兜底，交给下游 schema 校验报 is_error
      input = tc.function.arguments;
    }
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input,
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
