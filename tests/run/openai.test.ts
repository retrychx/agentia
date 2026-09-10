import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { executeRun } from '../../src/index.js';
import type { AgentTool } from '../../src/index.js';
import { createOpenAIClient } from '../../src/run/openai.js';
import { toolUseMsg, endTurnMsg, mockClient } from '../helpers.js';

/** 构造顺序返回脚本化 OpenAI 响应的 fetchImpl，并记录请求体 */
function fakeFetch(script: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ url: string; init: RequestInit; json: any }> = [];
  let i = 0;
  const fetchImpl = (async (url: any, init: any) => {
    const step = script[i++];
    if (!step) throw new Error(`fakeFetch 脚本耗尽（第 ${i} 次调用）`);
    requests.push({ url: String(url), init, json: JSON.parse(String(init?.body)) });
    const status = step.status ?? 200;
    return new Response(
      typeof step.body === 'string' ? step.body : JSON.stringify(step.body),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function chatResponse(over: Record<string, unknown>) {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-x',
    choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
    ...over,
  };
}

const BASE_PARAMS = {
  model: 'gpt-x',
  max_tokens: 1024,
  system: '你是助手',
  tools: [
    {
      name: 'get_weather',
      description: '查天气',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    } as Anthropic.Tool,
  ],
  messages: [
    { role: 'user', content: '天气如何' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '查一下' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } },
      ],
    } as Anthropic.MessageParam,
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '晴' },
        { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: '多云' }] },
        { type: 'text', text: '请总结' },
      ],
    } as Anthropic.MessageParam,
  ] as Anthropic.MessageParam[],
};

describe('createOpenAIClient', () => {
  it('请求翻译：system/tools/messages/tool_result 形态正确', async () => {
    const { fetchImpl, requests } = fakeFetch([{ body: chatResponse({}) }]);
    const client = createOpenAIClient({ apiKey: 'k', baseURL: 'https://ds.example/', fetchImpl });
    const stream = client.messages.stream(BASE_PARAMS);
    await stream.finalMessage();

    assert.equal(requests.length, 1);
    const { url, init, json } = requests[0];
    assert.equal(url, 'https://ds.example/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer k');

    // tools：Anthropic.Tool → function 形态
    assert.deepEqual(json.tools, [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: BASE_PARAMS.tools[0].input_schema,
        },
      },
    ]);

    // messages：system 开头；assistant tool_use → tool_calls；tool_result → role:tool
    assert.deepEqual(json.messages, [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '天气如何' },
      {
        role: 'assistant',
        content: '查一下',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"北京"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' },
      // 非 string 的 tool_result content 走 JSON.stringify
      { role: 'tool', tool_call_id: 'call_2', content: '[{"type":"text","text":"多云"}]' },
      { role: 'user', content: '请总结' },
    ]);
    assert.equal(json.model, 'gpt-x');
    assert.equal(json.max_tokens, 1024);
  });

  it('system 为 TextBlockParam[] 时拼接 text', async () => {
    const { fetchImpl, requests } = fakeFetch([{ body: chatResponse({}) }]);
    const client = createOpenAIClient({ fetchImpl });
    await client.messages
      .stream({
        model: 'm',
        max_tokens: 1,
        system: [
          { type: 'text', text: '甲' },
          { type: 'text', text: '乙' },
        ],
        messages: [{ role: 'user', content: 'x' }],
      })
      .finalMessage();
    assert.deepEqual(requests[0].json.messages[0], { role: 'system', content: '甲\n乙' });
  });

  it('响应映射：text/tool_use blocks、stop_reason、usage', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '稍等',
                tool_calls: [
                  {
                    id: 'call_9',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"上海"}' },
                  },
                ],
              },
            },
          ],
        }),
      },
    ]);
    const client = createOpenAIClient({ fetchImpl });
    let streamed = '';
    const stream = client.messages.stream({ model: 'm', max_tokens: 1, messages: [] });
    stream.on('text', (d) => (streamed += d));
    const msg = await stream.finalMessage();

    assert.equal(msg.stop_reason, 'tool_use');
    assert.deepEqual(msg.content, [
      { type: 'text', text: '稍等' },
      { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: '上海' } },
    ]);
    assert.deepEqual(
      {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheRead: msg.usage.cache_read_input_tokens,
        cacheCreation: msg.usage.cache_creation_input_tokens,
      },
      { input: 11, output: 7, cacheRead: 0, cacheCreation: 0 },
    );
    // 非流式模拟：onText 一次性收到完整文本
    assert.equal(streamed, '稍等');
  });

  it('finish_reason 映射：length→max_tokens、content_filter→refusal', async () => {
    const { fetchImpl } = fakeFetch([
      { body: chatResponse({ choices: [{ finish_reason: 'length', message: { content: 'a' } }] }) },
      {
        body: chatResponse({
          choices: [{ finish_reason: 'content_filter', message: { content: null } }],
        }),
      },
    ]);
    const client = createOpenAIClient({ fetchImpl });
    const m1 = await client.messages.stream({ model: 'm', max_tokens: 1, messages: [] }).finalMessage();
    const m2 = await client.messages.stream({ model: 'm', max_tokens: 1, messages: [] }).finalMessage();
    assert.equal(m1.stop_reason, 'max_tokens');
    assert.equal(m2.stop_reason, 'refusal');
    assert.deepEqual(m2.content, []);
  });

  it('tool_calls arguments 非法 JSON：原样字符串兜底', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 't', arguments: 'not-json{' } },
                ],
              },
            },
          ],
        }),
      },
    ]);
    const client = createOpenAIClient({ fetchImpl });
    const msg = await client.messages
      .stream({ model: 'm', max_tokens: 1, messages: [] })
      .finalMessage();
    assert.deepEqual(msg.content, [
      { type: 'tool_use', id: 'c1', name: 't', input: 'not-json{' },
    ]);
  });

  it('非 2xx：抛错含 status 与 body 前 200 字', async () => {
    const { fetchImpl } = fakeFetch([{ status: 500, body: 'x'.repeat(300) }]);
    const client = createOpenAIClient({ fetchImpl });
    await assert.rejects(
      client.messages.stream({ model: 'm', max_tokens: 1, messages: [] }).finalMessage(),
      (e: Error) => {
        assert.match(e.message, /^OpenAI 请求失败 500: /);
        assert.ok(e.message.includes('x'.repeat(200)));
        assert.ok(!e.message.includes('x'.repeat(201)), 'body 截断到 200 字');
        return true;
      },
    );
  });

  it('与 mockClient 同脚本对比：可直接喂给 executeRun 跑通一轮工具调用', async () => {
    const probe: AgentTool = {
      name: 'probe',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () => 'pong',
    };

    // 参照组：mockClient 跑 Anthropic 脚本
    const mock = mockClient([toolUseMsg('probe', {}), endTurnMsg('done')]);
    const ref = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [probe],
      client: mock.client,
    });
    assert.equal(ref.result.stopReason, 'end_turn');
    assert.equal(ref.result.finalText, 'done');

    // 被测组：同一脚本翻译成 OpenAI 响应形态，经 createOpenAIClient 跑 executeRun
    const { fetchImpl, requests } = fakeFetch([
      {
        body: chatResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'tu1',
                    type: 'function',
                    function: { name: 'probe', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      },
      { body: chatResponse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }) },
    ]);
    const client = createOpenAIClient({ fetchImpl });
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [probe],
      client,
    });

    assert.equal(run.status, 'succeeded');
    assert.equal(result.stopReason, ref.result.stopReason);
    assert.equal(result.finalText, ref.result.finalText);
    assert.equal(result.iterations, ref.result.iterations);

    // 第二回合请求里应带 role:tool 的工具结果回传
    const second = requests[1].json;
    assert.ok(
      second.messages.some(
        (m: any) => m.role === 'tool' && m.tool_call_id === 'tu1' && m.content.includes('pong'),
      ),
      'tool_result 翻译为 role:tool 消息回传',
    );
  });
});
