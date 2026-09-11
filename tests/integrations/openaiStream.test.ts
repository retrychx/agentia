import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { createOpenAIClient } from '../../src/integrations/openai.js';

/** 把事件数组编成 SSE 报文（`[DONE]` 原样写） */
function sseBody(events: Array<Record<string, unknown> | '[DONE]'>, eol = '\n'): string {
  return (
    events
      .map((e) => `data: ${e === '[DONE]' ? '[DONE]' : JSON.stringify(e)}${eol}${eol}`)
      .join('')
  );
}

/** 返回 SSE 报文的 fetchImpl；也可指定 content-type 与 status */
function sseFetch(
  body: string,
  opts: { contentType?: string; status?: number } = {},
): { fetchImpl: typeof fetch; requests: Array<{ json: any; init: RequestInit }> } {
  const requests: Array<{ json: any; init: RequestInit }> = [];
  const fetchImpl = (async (_url: any, init: any) => {
    requests.push({ json: JSON.parse(String(init?.body)), init });
    return new Response(body, {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const BASE: { model: string; max_tokens: number; messages: Anthropic.MessageParam[] } = {
  model: 'gpt-x',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenAI 适配器：真流式（C3）', () => {
  it('逐 token 触发回调（不是攒完一次性给），最终文本拼接正确', async () => {
    const body = sseBody([
      { id: 'c1', model: 'gpt-x', choices: [{ delta: { content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: { content: '呀' } }] },
      { choices: [{ finish_reason: 'stop', delta: {} }] },
      '[DONE]',
    ]);
    const { fetchImpl } = sseFetch(body);
    const client = createOpenAIClient({ fetchImpl });
    const deltas: string[] = [];
    const stream = client.messages.stream(BASE);
    stream.on('text', (d) => deltas.push(d));
    const msg = await stream.finalMessage();

    assert.deepEqual(deltas, ['你', '好', '呀'], '必须是三次增量（打字机的全部来源）');
    assert.deepEqual(msg.content, [{ type: 'text', text: '你好呀' }]);
    assert.equal(msg.stop_reason, 'end_turn');
  });

  it('请求带 stream:true 与 stream_options.include_usage', async () => {
    const { fetchImpl, requests } = sseFetch(sseBody(['[DONE]']));
    await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.equal(requests[0].json.stream, true);
    assert.deepEqual(requests[0].json.stream_options, { include_usage: true });
  });

  it('usage 取自**最后一个** chunk（choices 为空的那条）', async () => {
    const body = sseBody([
      { id: 'c1', choices: [{ delta: { content: 'x' } }] },
      { choices: [{ finish_reason: 'stop', delta: {} }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
      '[DONE]',
    ]);
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.equal(msg.usage.input_tokens, 11);
    assert.equal(msg.usage.output_tokens, 7);
    assert.equal(msg.usage.cache_read_input_tokens, 0);
  });

  it('tool_calls 分片按 index 累积（设计点名的易错点）', async () => {
    const body = sseBody([
      {
        id: 'c1',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '' } }],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"北' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '京"}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      '[DONE]',
    ]);
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.deepEqual(msg.content, [
      { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { city: '北京' } },
    ]);
    assert.equal(msg.stop_reason, 'tool_use');
  });

  it('并行多个工具调用：按 index 归并，乱序到达也不串味', async () => {
    // 两条调用交错下发（index 0 与 1 交替），这是「按到达顺序新建」必错的场景
    const body = sseBody([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'f_a', arguments: '{"a":' } },
                { index: 1, id: 'call_b', function: { name: 'f_b', arguments: '{"b":' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      '[DONE]',
    ]);
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.deepEqual(msg.content, [
      { type: 'tool_use', id: 'call_a', name: 'f_a', input: { a: 1 } },
      { type: 'tool_use', id: 'call_b', name: 'f_b', input: { b: 2 } },
    ]);
  });

  it('id / name 只取首次出现（分片里重复下发不会拼成 "f_af_a"）', async () => {
    const body = sseBody([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_a', function: { name: 'f_a', arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              // 有些端点每个分片都重发 id/name —— 必须取首次，不能拼接
              tool_calls: [{ index: 0, id: 'call_a', function: { name: 'f_a', arguments: '{}' } }],
            },
          },
        ],
      },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      '[DONE]',
    ]);
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.deepEqual(msg.content, [{ type: 'tool_use', id: 'call_a', name: 'f_a', input: {} }]);
  });

  it('端点没给 tool_call id → 补一个（空 id 会让 tool_result 配对失败）', async () => {
    const body = sseBody([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      '[DONE]',
    ]);
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.equal((msg.content[0] as Anthropic.ToolUseBlock).id, 'call_1');
  });

  it('[DONE] 之后的残留数据不再处理；CRLF 行尾也能解析', async () => {
    const body = sseBody(
      [
        { choices: [{ delta: { content: 'A' } }] },
        '[DONE]',
        { choices: [{ delta: { content: '不该出现' } }] },
      ],
      '\r\n',
    );
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.deepEqual(msg.content, [{ type: 'text', text: 'A' }]);
  });

  it('畸形分片被跳过，不毁掉后续正常数据', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' +
      'data: {这不是 JSON\n\n' +
      'data: {"choices":[{"delta":{"content":"的"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { fetchImpl } = sseFetch(body);
    const msg = await createOpenAIClient({ fetchImpl })
      .messages.stream(BASE)
      .finalMessage();
    assert.deepEqual(msg.content, [{ type: 'text', text: '好的' }]);
  });

  it('signal 被转发给 fetch（否则取消/超时中止不了在飞请求）', async () => {
    const { fetchImpl, requests } = sseFetch(sseBody(['[DONE]']));
    const ac = new AbortController();
    await createOpenAIClient({ fetchImpl })
      .messages.stream({ ...BASE, signal: ac.signal })
      .finalMessage();
    assert.equal(requests[0].init.signal, ac.signal);
  });

  it('stream:false → 请求体不带 stream 字段', async () => {
    const json = JSON.stringify({
      id: 'c1',
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const { fetchImpl, requests } = sseFetch(json, { contentType: 'application/json' });
    await createOpenAIClient({ fetchImpl, stream: false })
      .messages.stream(BASE)
      .finalMessage();
    assert.equal('stream' in requests[0].json, false);
    assert.equal('stream_options' in requests[0].json, false);
  });

  it('端点忽略 stream:true 直接回 JSON → 自动退回 JSON 路径（不炸）', async () => {
    const json = JSON.stringify({
      id: 'c1',
      choices: [{ finish_reason: 'stop', message: { content: '整段回的' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const { fetchImpl } = sseFetch(json, { contentType: 'application/json' });
    const deltas: string[] = [];
    const stream = createOpenAIClient({ fetchImpl }).messages.stream(BASE);
    stream.on('text', (d) => deltas.push(d));
    const msg = await stream.finalMessage();
    assert.deepEqual(msg.content, [{ type: 'text', text: '整段回的' }]);
    assert.deepEqual(deltas, ['整段回的'], '没有流就只能一次性给');
  });
});

describe('OpenAI 适配器：多模态块（C3）', () => {
  const imageBlock = (): Anthropic.ImageBlockParam =>
    ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBB' },
    }) as Anthropic.ImageBlockParam;

  it('base64 图片 → image_url 的 data URL；文本一起进 parts', async () => {
    const { fetchImpl, requests } = sseFetch(sseBody(['[DONE]']));
    await createOpenAIClient({ fetchImpl })
      .messages.stream({
        model: 'gpt-x',
        max_tokens: 8,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '这是什么' }, imageBlock()],
          } as Anthropic.MessageParam,
        ],
      })
      .finalMessage();
    assert.deepEqual(requests[0].json.messages[0].content, [
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBB' } },
    ]);
  });

  it('url 源的图片直接透传（不再包一层 data URL）', async () => {
    const { fetchImpl, requests } = sseFetch(sseBody(['[DONE]']));
    await createOpenAIClient({ fetchImpl })
      .messages.stream({
        model: 'gpt-x',
        max_tokens: 8,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
            ],
          } as Anthropic.MessageParam,
        ],
      })
      .finalMessage();
    assert.deepEqual(requests[0].json.messages[0].content, [
      { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
    ]);
  });

  it('没有图片时回落成纯字符串（兼容只吃 string 的端点 —— 旧行为）', async () => {
    const { fetchImpl, requests } = sseFetch(sseBody(['[DONE]']));
    await createOpenAIClient({ fetchImpl })
      .messages.stream({
        model: 'gpt-x',
        max_tokens: 8,
        messages: [{ role: 'user', content: [{ type: 'text', text: '只有文本' }] } as Anthropic.MessageParam],
      })
      .finalMessage();
    assert.equal(requests[0].json.messages[0].content, '只有文本');
  });
});
