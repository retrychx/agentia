import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageParam, ToolParam } from '../../src/index.js';
import { classifyError, executeRun } from '../../src/index.js';
import type { AgentTool } from '../../src/index.js';
import { OpenAICompatApiError, createOpenAIClient } from '../../src/integrations/openai.js';
import { toolUseMsg, endTurnMsg, mockClient } from '../helpers.js';

/**
 * 构造顺序返回脚本化 OpenAI 响应的 fetchImpl，并记录请求体。
 *
 * 脚本耗尽后**重复最后一步**（不抛错）：客户端现在有内层重试（缺省 2），而许多用例
 * 只关心「单次请求的翻译/映射」，不该被重试的第二次调用打断。要精确断言尝试次数的用例
 * 显式传 `maxRetries: 0` 或给足脚本长度。
 */
function fakeFetch(script: Array<{ status?: number; body: unknown }>) {
  // biome-ignore lint/suspicious/noExplicitAny: 捕获的是客户端**发出去**的报文，字段由被测实现决定 —— 这里要断的正是「未知形态里有没有某字段」，写死类型反而变成抄一遍实现
  const requests: Array<{ url: string; init: RequestInit; json: any }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    requests.push({ url: String(url), init, json: JSON.parse(String(init?.body)) });
    const status = step.status ?? 200;
    return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
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
    } as ToolParam,
  ],
  messages: [
    { role: 'user', content: '天气如何' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '查一下' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } },
      ],
    } as MessageParam,
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '晴' },
        { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: '多云' }] },
        { type: 'text', text: '请总结' },
      ],
    } as MessageParam,
  ] as MessageParam[],
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

    // tools：ToolParam → function 形态
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
    const m1 = await client.messages
      .stream({ model: 'm', max_tokens: 1, messages: [] })
      .finalMessage();
    const m2 = await client.messages
      .stream({ model: 'm', max_tokens: 1, messages: [] })
      .finalMessage();
    assert.equal(m1.stop_reason, 'max_tokens');
    assert.equal(m2.stop_reason, 'refusal');
    assert.deepEqual(m2.content, []);
  });

  it('legacy function_call 形态：响亮失败，不得报成 end_turn 把工具调用丢掉', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [
            {
              finish_reason: 'function_call',
              message: {
                content: '好的，我查一下。',
                function_call: { name: 'get_weather', arguments: '{"city":"上海"}' },
              },
            },
          ],
        }),
      },
    ]);
    // maxRetries: 0 —— 这条是**确定性不兼容**，不该被内层重试洗掉（重试只会重复丢弃同一个调用）
    const client = createOpenAIClient({ fetchImpl, maxRetries: 0 });
    await assert.rejects(
      () => client.messages.stream({ model: 'm', max_tokens: 8, messages: [] }).finalMessage(),
      (e: unknown) => {
        assert.ok(
          e instanceof OpenAICompatApiError,
          `应是 OpenAICompatApiError，实际 ${String(e)}`,
        );
        assert.equal((e as { status?: number }).status, 400);
        assert.match(e.message, /function_call/);
        assert.equal(classifyError(e).type, 'api'); // 不可重试 —— 重试换不了结论
        return true;
      },
    );
  });

  it('未知 finish_reason 且有正文：按 end_turn 收尾（**有意的默认**，别顺手改成抛错）', async () => {
    // eos_token 是真实存在的兼容端点回法（HF TGI）；上游只说「结束了」，正文是完整的 ⇒ 正常收尾。
    // 空正文那条另有守卫（见上面「流式/非流式空响应」用例），不会走到这里变成成功空回复。
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [{ finish_reason: 'eos_token', message: { content: 'hi' } }],
        }),
      },
    ]);
    const client = createOpenAIClient({ fetchImpl });
    const msg = await client.messages
      .stream({ model: 'm', max_tokens: 1, messages: [] })
      .finalMessage();
    assert.equal(msg.stop_reason, 'end_turn');
    assert.deepEqual(msg.content, [{ type: 'text', text: 'hi' }]);
  });

  it('带 tool_calls 但 finish_reason=stop（DeepSeek/vLLM/Ollama）：stop_reason 仍为 tool_use', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [
            {
              finish_reason: 'stop', // 兼容端点的真实回法：有工具调用却报 stop
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'search', arguments: '{"q":"x"}' },
                  },
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
    // 映射成 end_turn 会让 engine 在提取工具块前收尾 → 工具调用被静默丢弃
    assert.equal(msg.stop_reason, 'tool_use');
    assert.equal(msg.content.length, 1);
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
    assert.deepEqual(msg.content, [{ type: 'tool_use', id: 'c1', name: 't', input: 'not-json{' }]);
  });

  it('200 但 choices 为空/缺失：抛错按上游故障处理，不得静默映射成「成功」', async () => {
    const { fetchImpl } = fakeFetch([
      { body: chatResponse({ choices: [] }) },
      { body: { id: 'x', model: 'm' } }, // 连 choices 字段都没有
    ]);
    const client = createOpenAIClient({ fetchImpl });
    await assert.rejects(
      client.messages.stream({ model: 'm', max_tokens: 1, messages: [] }).finalMessage(),
      /空 choices/,
    );
    await assert.rejects(
      client.messages.stream({ model: 'm', max_tokens: 1, messages: [] }).finalMessage(),
      /空 choices/,
    );
  });

  it('非 2xx：抛错含 status 与 body 前 200 字', async () => {
    // maxRetries: 0 —— 本用例只测「错误对象/文案的形状」，不测重试层
    const { fetchImpl } = fakeFetch([{ status: 500, body: 'x'.repeat(300) }]);
    const client = createOpenAIClient({ fetchImpl, maxRetries: 0 });
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

  it('非 2xx 的错误**带数值 status** → classifyError 认得出速率限制 / 服务端故障（重试的前提）', async () => {
    // 修复前一律抛裸 Error（无 status）：classifyError 的鸭子类型读不到数值 status，
    // 所有失败都落 type:'unknown' + retryable:false —— 引擎层那 3 次重试**一次都不发生**，
    // DeepSeek 这类兼容端点吃一个 429 就整轮 run 失败。
    const cases: Array<[number, string, string, boolean]> = [
      [429, 'rate_limit', 'rate_limit', true],
      [503, 'server', 'server', true],
      [400, 'api', 'api', false],
    ];
    for (const [status, label, type, retryable] of cases) {
      const { fetchImpl } = fakeFetch([{ status, body: 'nope' }]);
      // maxRetries: 0 —— 本用例测的是「状态码 → 分类」的映射，不是重试层
      const client = createOpenAIClient({ fetchImpl, maxRetries: 0 });
      const err = await client.messages
        .stream({ model: 'm', max_tokens: 1, messages: [] })
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err, `${label} ${status} 应当抛错`);
      const cls = classifyError(err);
      assert.equal(cls.type, type, `${label}：${status} → ${type}`);
      assert.equal(cls.retryable, retryable, `${label}：${status} 的 retryable`);
      assert.equal((err as { status?: number }).status, status, `${label}：错误对象自身带 status`);
    }
  });

  it('429（带 body 与 retry-after）→ 重试前排空失败响应的 body，第二次成功', async () => {
    // 与 anthropic.ts 的 postWithRetries 对齐：可重试状态码不能只读 retry-after 头就
    // continue —— 失败响应的诊断体必须被消费，否则直接丢在 socket 缓冲区。
    // （实测 undici 会后台丢弃未消费 body、连接复用不受影响；这里守的是「不丢诊断体」。）
    // 反向验证：旧实现从不调失败响应的 text() → firstBodyReads 恒 0。
    let firstBodyReads = 0;
    let calls = 0;
    const fetchImpl = (async (_url: string | URL, _init: RequestInit = {}) => {
      calls += 1;
      if (calls === 1) {
        // `Response.prototype.text` 在本项目的类型环境下是**只读**方法，不能改写，
        // 所以这里不用真 Response，而是给一个「只实现 postWithRetries 真正读到的表面」
        // 的替身：可重试响应恰好只被读 ok / status / headers / text 四项。
        const res = {
          ok: false,
          status: 429,
          headers: new Headers({
            'retry-after': '0',
            'content-type': 'application/json',
          }),
          text: async () => {
            firstBodyReads += 1;
            return JSON.stringify({ error: { message: 'slow down', type: 'rate_limit' } });
          },
        } as unknown as Response;
        return res;
      }
      return new Response(JSON.stringify(chatResponse({})), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = createOpenAIClient({ apiKey: 'k', fetchImpl });
    const msg = await client.messages
      .stream({ model: 'm', max_tokens: 8, messages: [] })
      .finalMessage();
    assert.equal(calls, 2, '第一次 429 后必须重试');
    assert.equal(firstBodyReads, 1, '重试前必须消费第一次（失败）响应的 body');
    assert.equal(msg.stop_reason, 'end_turn');
  });

  it('429 → 引擎重试真的发生（用例闭环：客户端给出的 status 一路传到引擎重试层）', async () => {
    const { fetchImpl, requests } = fakeFetch([
      { status: 429, body: 'slow down' },
      { body: chatResponse({}) }, // 第二次成功
    ]);
    const retries: number[] = [];
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      // maxRetries: 0 —— 隔离出**引擎层**重试：客户端的 status 必须一路传到引擎重试层
      // （客户端内层重试的对称性另由 tests/integrations/adapter-parity.test.ts 对拍）
      client: createOpenAIClient({ fetchImpl, maxRetries: 0 }),
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        onRetry: (i) => retries.push(i.attempt),
      },
    });
    assert.equal(result.stopReason, 'end_turn', '重试后成功收尾');
    assert.equal(requests.length, 2, '第一次 429 被引擎重试');
    assert.deepEqual(retries, [1], '重试计数进 onRetry');
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
      {
        body: chatResponse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }),
      },
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
        (m: { role: string; tool_call_id?: string; content: string }) =>
          m.role === 'tool' && m.tool_call_id === 'tu1' && m.content.includes('pong'),
      ),
      'tool_result 翻译为 role:tool 消息回传',
    );
  });
});

/**
 * C（2026-09-18 第七轮复审）：**非流式**路径的「200 + 空补全」不得记成成功。
 *
 * 流式路径已有同款守卫（`openaiStream.test.ts` 的「流正常结束但什么都没累积到」），
 * 而非流式只有 `!choice` 的守卫 —— `choices[0].message.content = null` + `finish_reason: 'stop'`
 * 会映射成「空文本 + end_turn」记成功。同一个响应在两条路径上结论相反，
 * 且与模块头「上游故障绝不映射成成功」相反。
 */
describe('C：非流式空补全按上游故障处理（与流式路径同结论）', () => {
  it('200 + content:null + finish:stop → 500 且不可静默记成成功', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }],
        }),
      },
    ]);
    const client = createOpenAIClient({ apiKey: 'k', fetchImpl, stream: false, maxRetries: 0 });
    await assert.rejects(
      () =>
        client.messages
          .stream({ model: 'gpt-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
          .finalMessage(),
      (e: unknown) => {
        assert.equal((e as { status?: number }).status, 500);
        assert.equal(classifyError(e).retryable, true);
        assert.match(String((e as Error).message), /空补全/);
        return true;
      },
    );
  });

  it('refusal（content_filter）的空回复**不抛** —— 合法空回复（与流式路径同一例外）', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: chatResponse({
          choices: [
            { finish_reason: 'content_filter', message: { role: 'assistant', content: null } },
          ],
        }),
      },
    ]);
    const client = createOpenAIClient({ apiKey: 'k', fetchImpl, stream: false, maxRetries: 0 });
    const msg = await client.messages
      .stream({ model: 'gpt-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
      .finalMessage();
    assert.equal(msg.stop_reason, 'refusal');
  });
});
