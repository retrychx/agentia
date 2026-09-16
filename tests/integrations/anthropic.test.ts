import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicClient } from '../../src/index.js';
import { AnthropicApiError } from '../../src/integrations/anthropic.js';
import { classifyError } from '../../src/index.js';
import { waitFor } from '../helpers.js';

/**
 * `createAnthropicClient` 是默认 ModelClient 的工厂 —— 2026-09-17 起为**手写 fetch + SSE**
 * 实现（不再包装 @anthropic-ai/sdk），所以这里的假端点也用手写 SSE 字节流
 * （不依赖 SDK 的任何行为假设）。
 *
 * 守的「缝」：① 返回值满足 `ModelClient` 结构面（构造期不触网）；
 * ② SSE 分片 → on('text') / finalMessage 的组装语义（text / tool_use / usage / stop_reason）；
 * ③ **signal 真到传输层**（abort 后在飞请求必须断开）；
 * ④ 重试语义与 SDK 缺省对齐（429/5xx 重试、400 不重试、retry-after 被尊重）；
 * ⑤ 上游把错误塞进 200 流（type=error 事件）必须抛出而不是组装成假成功。
 */

/** 把事件列表编成 SSE 字节流（`event:` 行照常写，但实现只认 `data:` payload 的 type） */
function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** 标准文本流：两片 text_delta，usage 含 cache 计量，message_delta 给累计 output */
function textEvents(text1: string, text2: string): Array<Record<string, unknown>> {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text1 } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text2 } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: 'message_stop' },
  ];
}

function writeSse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(sse(events));
}

/** 起本地假端点（零 key、零外网），返回 baseURL 与请求计数 */
async function fakeEndpoint(
  handler: (hits: number, res: ServerResponse) => void,
): Promise<{ baseURL: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    handler(hits, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const BASE_PARAMS = {
  model: 'm',
  max_tokens: 16,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('createAnthropicClient（默认 ModelClient 工厂）', () => {
  it('返回满足 ModelClient 结构面的对象（构造期不触网）', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test' });
    assert.equal(typeof client.messages.stream, 'function', '须提供 messages.stream');
  });

  it('自定义项（apiKey / baseURL / maxRetries / timeout）透传，构造不抛错', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-test',
      baseURL: 'http://localhost:1',
      maxRetries: 0,
      timeout: 1000,
    });
    assert.equal(typeof client.messages.stream, 'function');
  });

  it('请求落在 {baseURL}/v1/messages，带 x-api-key / anthropic-version / stream:true，signal 不进 body', async () => {
    // `as` 防 TS 按初始值把 seen 窄化成 null（赋值发生在闭包里，控制流看不见）
    let seen = null as { url?: string; headers: Record<string, unknown>; body: string } | null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body };
        writeSse(res, textEvents('你', '好'));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const ac = new AbortController();
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
      });
      const s = client.messages.stream({ ...BASE_PARAMS, signal: ac.signal });
      const final = await s.finalMessage();
      assert.ok(seen, '假端点应收到请求');
      assert.equal(seen.url, '/v1/messages');
      assert.equal(seen.headers['x-api-key'], 'sk-test');
      assert.equal(seen.headers['anthropic-version'], '2023-06-01');
      const parsed = JSON.parse(seen.body) as Record<string, unknown>;
      assert.equal(parsed.stream, true, 'body 必须带 stream:true');
      assert.equal('signal' in parsed, false, 'signal 是契约字段，不得进请求体');
      assert.equal(final.stop_reason, 'end_turn');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('SSE 组装：分片 → on(text) 与 finalMessage', () => {
  it("text 分片逐个触发 on('text')，拼接 == finalMessage 文本；usage 含 cache 计量；stop_reason 透传", async () => {
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, textEvents('你好', '，世界')));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const s = client.messages.stream(BASE_PARAMS);
      const deltas: string[] = [];
      s.on('text', (d) => deltas.push(d));
      const final = await s.finalMessage();

      assert.deepEqual(deltas, ['你好', '，世界'], '每个 text_delta 触发一次回调');
      const text = final.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      assert.equal(text, '你好，世界');
      assert.equal(deltas.join(''), text, '分片拼接必须与 finalMessage 文本一致');
      assert.equal(final.stop_reason, 'end_turn');
      assert.equal(final.id, 'msg_1');
      assert.equal(final.usage.input_tokens, 12);
      assert.equal(final.usage.output_tokens, 9, 'message_delta 的累计 output_tokens 覆盖初始值');
      assert.equal(final.usage.cache_creation_input_tokens, 5, 'cache 计量必须透传');
      assert.equal(final.usage.cache_read_input_tokens, 7, 'cache 计量必须透传');
    } finally {
      await ep.close();
    }
  });

  it('tool_use 块从 input_json_delta 分片（跨分片的半截 JSON）正确组装', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      },
      // 工具入参被拆成三片，且切片点落在多字节字符中间之外的任意位置
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":"北' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '京","' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'n":1}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.stop_reason, 'tool_use');
      assert.equal(final.content.length, 1);
      const block = final.content[0] as { type: string; id: string; name: string; input: unknown };
      assert.equal(block.type, 'tool_use');
      assert.equal(block.id, 'toolu_1');
      assert.equal(block.name, 'get_weather');
      assert.deepEqual(block.input, { city: '北京', n: 1 }, '分片拼接后必须 parse 成对象');
    } finally {
      await ep.close();
    }
  });

  it('流走完都没见 message_start = 上游故障：抛出，不组装假成功', async () => {
    const ep = await fakeEndpoint((_hits, res) =>
      writeSse(res, [{ type: 'ping' }, { type: 'message_stop' }]),
    );
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      await assert.rejects(
        client.messages.stream(BASE_PARAMS).finalMessage(),
        /未见 message_start/,
      );
    } finally {
      await ep.close();
    }
  });

  it('上游把错误塞进 200 流（type=error 事件）：抛出 AnthropicApiError 且按类型映射 status', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_3', type: 'message', role: 'assistant', model: 'm', content: [] },
      },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof AnthropicApiError, `应抛 AnthropicApiError，实际：${String(err)}`);
      assert.equal(err.status, 529, 'overloaded_error → 529（classifyError 归为 server/可重试）');
      const span = classifyError(err);
      assert.equal(span.type, 'server');
      assert.equal(span.retryable, true);
    } finally {
      await ep.close();
    }
  });
});

describe('重试 parity（SDK 缺省语义：429/5xx/连接错误，尊重 retry-after）', () => {
  it('429（带 retry-after: 0）→ 重试后成功', async () => {
    const ep = await fakeEndpoint((hits, res) => {
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
      } else {
        writeSse(res, textEvents('好', '了'));
      }
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(ep.hits(), 2, '第一次 429 后必须重试一次');
      assert.equal(final.stop_reason, 'end_turn');
    } finally {
      await ep.close();
    }
  });

  it('500 → 重试后成功', async () => {
    const ep = await fakeEndpoint((hits, res) => {
      if (hits === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
      } else {
        writeSse(res, textEvents('恢', '复'));
      }
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(ep.hits(), 2);
      assert.equal(final.stop_reason, 'end_turn');
    } finally {
      await ep.close();
    }
  });

  it('400 → 不重试，直接抛 AnthropicApiError(status=400)（classifyError → api/不可重试）', async () => {
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }));
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof AnthropicApiError);
      assert.equal(err.status, 400);
      assert.equal(ep.hits(), 1, '确定性 4xx 不得重试');
      const span = classifyError(err);
      assert.equal(span.type, 'api');
      assert.equal(span.retryable, false);
    } finally {
      await ep.close();
    }
  });

  it('maxRetries: 0 → 429 也直接抛（重试可关闭）', async () => {
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('{}');
    });
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      await assert.rejects(client.messages.stream(BASE_PARAMS).finalMessage(), (e: unknown) => {
        assert.ok(e instanceof AnthropicApiError);
        assert.equal(e.status, 429);
        return true;
      });
      assert.equal(ep.hits(), 1);
    } finally {
      await ep.close();
    }
  });
});

describe('中止在飞请求（零 key、零外网：本地假端点）', () => {
  it('abort 后请求必须断开（signal 直接进 fetch，不进 body）', async () => {
    // 假端点**故意不响应**：请求就此挂在飞 —— 正是「调用方想中止在飞 run」的场景。
    let hits = 0;
    const server = createServer((_req, _res) => {
      hits += 1; // 收到即可，不写响应、不结束
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
        maxRetries: 0, // 别让重试掩盖「没断」这件事
      });
      const ac = new AbortController();
      const s = client.messages.stream({
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      });
      // 触发点用**假端点真收到请求**，不用 sleep 猜时间（确定性）
      await waitFor(() => hits > 0, '假端点收到请求', 5_000);
      ac.abort();

      const outcome = await Promise.race([
        s.finalMessage().then(
          () => 'resolved',
          (e: unknown) => `rejected:${(e as Error).name}`,
        ),
        new Promise<string>((r) => setTimeout(() => r('hung'), 3_000)),
      ]);
      assert.notEqual(
        outcome,
        'hung',
        'abort 之后 3s 仍未结束 ⇒ signal 没被转发到传输层（在飞 run 无法中止）',
      );
      assert.equal(outcome, 'rejected:AbortError', 'abort 必须以 AbortError 语义收场');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
