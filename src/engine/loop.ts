import Anthropic from '@anthropic-ai/sdk';
import type { AgentTool } from '../core/tool.js';
import type { SpanError } from '../core/trace.js';
import { classifyError } from './errors.js';
import { TraceRecorder } from './tracer.js';
import type { AgentRunResult, AgentStopReason, RunAgentOptions } from './types.js';
import { costEstimate, usageFromAnthropic } from './usage.js';

const DEFAULT_MODEL = 'claude-opus-5';

/** 主循环（manual loop，流式）—— spec §5。每次模型往返开一个 llm.turn span 记账。 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 64_000;
  const maxIterations = options.maxIterations ?? 40;

  const messages: Anthropic.MessageParam[] = [...options.messages];
  const agentTools: AgentTool[] = options.tools ?? [];
  const apiTools = agentTools.map(toApiTool);

  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', options.runName ?? 'agent.run', null);
  recorder.setAttribute(rootId, 'model', model);

  let stopReason: AgentStopReason = 'end_turn';
  let error: SpanError | undefined;
  let finalText = '';

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const turnId = recorder.begin('llm.turn', model, rootId);

      let message: Anthropic.Message;
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          ...(options.system ? { system: options.system } : {}),
          ...(apiTools.length ? { tools: apiTools } : {}),
          messages,
        });
        stream.on('text', (delta) => options.onText?.(delta));
        message = await stream.finalMessage();
      } catch (e) {
        const err = classifyError(e);
        recorder.end(turnId, { status: 'error', error: err });
        throw e; // 冒泡到外层统一收尾
      }

      const usage = message.usage ? usageFromAnthropic(message.usage) : undefined;
      if (usage) {
        usage.costEstimate = costEstimate(model, usage);
        recorder.end(turnId, { usage });
      } else {
        recorder.end(turnId);
      }
      recorder.setAttribute(turnId, 'input_tokens', usage?.inputTokens ?? 0);
      recorder.setAttribute(turnId, 'output_tokens', usage?.outputTokens ?? 0);
      recorder.setAttribute(turnId, 'cache_read_tokens', usage?.cacheReadTokens ?? 0);

      messages.push({ role: 'assistant', content: message.content });

      // —— 终止/边界分支 ——
      if (message.stop_reason === 'end_turn') {
        stopReason = 'end_turn';
        finalText = textOf(message);
        break;
      }
      if (message.stop_reason === 'refusal') {
        stopReason = 'refusal';
        finalText = textOf(message);
        error = { type: 'refusal', message: 'model refused the request', retryable: false };
        break;
      }
      if (message.stop_reason === 'max_tokens') {
        stopReason = 'max_tokens';
        finalText = textOf(message);
        break;
      }
      if (message.stop_reason === 'pause_turn') {
        // Turn 0 无 server tools，正常不会到；避免无限循环直接停
        stopReason = 'pause_turn';
        break;
      }

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        if (message.stop_reason === 'tool_use') stopReason = 'tool_use_no_blocks';
        break;
      }

      // —— 执行工具：并行；单条 user 消息回全部 tool_result（抑制并行是反模式）——
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (use) => {
          const tool = agentTools.find((t) => t.name === use.name);
          recorder.event(turnId, 'tool.input', { tool: use.name, input: limit(use.input, 2000) });

          let ok = true;
          let content: unknown = '';
          if (!tool) {
            ok = false;
            content = `unknown tool: ${use.name}`;
            recorder.event(turnId, 'tool.output', { tool: use.name, ok, content });
          } else {
            try {
              content = await tool.run(use.input as never);
            } catch (e) {
              ok = false;
              const err = classifyError(e);
              content = `error: ${err.message}`;
              recorder.event(turnId, 'tool.output', { tool: use.name, ok, content, type: err.type });
            }
            recorder.event(turnId, 'tool.output', { tool: use.name, ok, content: ok ? limit(content, 2000) : content });
          }
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: stringifySafe(content),
            is_error: !ok,
          };
        }),
      );

      messages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    stopReason = 'error';
    error = classifyError(e);
  }

  const runStatus = stopReason === 'end_turn' ? 'ok' : 'error';
  recorder.setAttribute(rootId, 'stop_reason', stopReason);
  recorder.end(rootId, { status: runStatus, ...(error ? { error } : {}) });
  const trace = recorder.snapshot(runStatus);
  return { trace, stopReason, finalText, iterations: trace.spans.length, error };
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

function stringifySafe(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

/** 截断到上限字符，超长加省略标记 */
function limit(x: unknown, n: number): string {
  const s = stringifySafe(x);
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}
