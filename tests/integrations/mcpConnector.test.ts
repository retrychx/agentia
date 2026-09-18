import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStdioMcpConnector,
  createStreamableHttpMcpConnector,
  mcpTools,
} from '../../src/integrations/mcp.js';
import type { McpConnector } from '../../src/integrations/mcp.js';
import { classifyError } from '../../src/engine/errors.js';

/**
 * 两个**内置连接器**的测试（2026-09-18 起连接器内置，见 spec §10 同日条）。
 *
 * 与 `mcp.test.ts` 的分工：那边验**桥**（`mcpTools` 的映射 / 归一化 / 超时裁判权，
 * 用假 client），这里验**连接器自己**。
 *
 * stdio 侧刻意**起真子进程**（`tests/fixtures/mcp/fake-server.mjs`）：连接器要保的三件事
 * —— spawn 的 `'error'` 事件、stdout 分帧、握手顺序 —— 只存在于真子进程世界里，
 * 用假 client 验等于没验。HTTP 侧注入 `fetchImpl`（与 `openai.test.ts` 同款）。
 */

const SERVER = fileURLToPath(new URL('../fixtures/mcp/fake-server.mjs', import.meta.url));

/** 本用例组开过的连接器：afterEach 统一收掉，免得留下孤儿进程 */
const open: McpConnector[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

function stdio(mode: string, opts: { logFile?: string; timeoutMs?: number } = {}): McpConnector {
  const env: Record<string, string> = { FAKE_MCP_MODE: mode };
  if (opts.logFile) env.FAKE_MCP_LOG_FILE = opts.logFile;
  const c = createStdioMcpConnector([process.execPath, SERVER], {
    env,
    stderr: 'ignore',
    // 缺省给个上限：任一处卡住都应在数秒内变成一条超时失败，而不是让整个套件挂够默认的 60s
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  open.push(c);
  return c;
}

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentia-mcp-')), 'calls.log');
}

function callsIn(log: string): string[] {
  return readFileSync(log, 'utf8').trim().split('\n');
}

describe('createStdioMcpConnector —— stdio 连接器', () => {
  it('握手顺序 initialize → notifications/initialized，两次调用只握手一次', async () => {
    const log = logPath();
    const c = stdio('normal', { logFile: log });

    assert.equal((await c.listTools()).length, 2);
    await c.listTools();

    assert.deepEqual(
      callsIn(log),
      ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'],
      'initialize 必须在最前且只发一次；notifications/initialized 在 tools/list 之前',
    );
  });

  it('并发调用共享同一次握手（不重复 initialize）', async () => {
    const log = logPath();
    const c = stdio('normal', { logFile: log });

    const [a, b] = await Promise.all([c.listTools(), c.listTools()]);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.equal(
      callsIn(log).filter((m) => m === 'initialize').length,
      1,
      '两个并发 listTools 只应触发一次握手',
    );
  });

  it('一条报文跨多个 chunk 也能攒齐（stdout 分帧）', async () => {
    const c = stdio('split');
    const tools = await c.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['get-time', 'read.file'],
      '响应被切成两段下发，必须按 \\n 攒包后再解析',
    );
  });

  it('stdout 里混进的非 JSON 日志行被忽略', async () => {
    const c = stdio('logline');
    assert.equal((await c.listTools()).length, 2, '日志行不该让整条响应解析失败');
  });

  it('命令不存在（ENOENT）时给可读错误，且**不把宿主进程带崩**', async () => {
    const c = createStdioMcpConnector(['/definitely/not/a/real/binary-agentia-xyz'], {
      stderr: 'ignore',
    });
    open.push(c);
    // 这一条是「spawn 的 'error' 是**异步事件**、必须有监听器」的承重断言：摘掉那个监听器
    // 再跑，ENOENT 会以**未捕获异常**的形态冒出来（这里由 node:test 兜住、记成失败；
    // 换成真实宿主进程没有人接得住 —— 那是直接崩，不是一条可 catch 的 rejection）。
    await assert.rejects(
      () => c.listTools(),
      (e: Error) => {
        assert.match(e.message, /ENOENT|not found|no such file/i);
        return true;
      },
    );
  });

  it('装配期卡住 → 超时（code=timeout，与引擎同一类账），不让宿主永久挂起', async () => {
    const c = stdio('noinit', { timeoutMs: 60 });
    await assert.rejects(
      () => c.listTools(),
      (e: { code?: unknown }) => {
        assert.equal(e.code, 'timeout', '带上 code 才会被 classifyError 归成 timeout 一类账');
        return true;
      },
    );
  });

  it('server 进程意外退出 → 在途请求被拒绝（不挂死）', async () => {
    const c = stdio('die');
    await assert.rejects(() => c.listTools(), /已退出/);
  });

  it('协议层 isError 转成抛错 —— 否则模型与 trace 都会以为这调用成功了', async () => {
    const c = stdio('iserror');
    await assert.rejects(() => c.callTool('get-time', {}), /isError/);
  });

  it('响应正常时 callTool 原样交回 server 的结果', async () => {
    const c = stdio('normal');
    const r = (await c.callTool('get-time', { tz: 'UTC' })) as { content?: unknown };
    assert.deepEqual(r.content, [{ type: 'text', text: 'called get-time' }]);
  });

  it('tools 不是数组 → 响亮抛错（不静默变成空菜单）', async () => {
    const c = stdio('badtools');
    await assert.rejects(() => c.listTools(), /不是数组/);
  });

  it('close() 幂等；关闭后调用给可读错误（不静默挂死）', async () => {
    const c = stdio('normal');
    await c.listTools();
    await c.close();
    await c.close(); // 幂等
    await assert.rejects(() => c.listTools(), /已 close/);
  });

  it('从未用过的连接器可以安全 close（惰性：构造不 spawn 进程）', async () => {
    const c = stdio('normal');
    await c.close();
    await c.close();
  });

  it('出厂连接器直接接 `mcpTools`（菜单名归一化整条走通）', async () => {
    const c = stdio('normal');
    const tools = await mcpTools(c, { server: 'fake' });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp_fake_get_time', 'mcp_fake_read_file'],
      '这条替代了「桥 + 脚本里一份私有连接器」的旧证明：现在测的就是出货的那份',
    );
  });

  it('cmd 为空在构造期即抛错（不等到 spawn 才炸）', () => {
    assert.throws(() => createStdioMcpConnector([]), /cmd 不能为空/);
  });
});

// ─────────────────────────── StreamableHTTP ───────────────────────────

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  msg: { id?: number; method?: string } | null;
}

/**
 * 假 endpoint：只认连接器真正会用的那点 HTTP 面（`ok` / `status` / `headers.get` / `text`），
 * 但用的是**真 `Response`** —— 免得「我的假设」和真实 fetch 的返回形状不一致时测不出来。
 */
function fakeServer(
  opts: {
    sessionId?: string;
    negotiated?: string;
    sse?: boolean;
    isError?: boolean;
    status?: number;
    emptyBody?: boolean;
  } = {},
): { fetchImpl: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const sessionHeader = (method: string | undefined): Record<string, string> =>
    // 会话 id **只在 initialize 的响应上**给：后续响应不带它，用来验连接器不会把它清空
    opts.sessionId !== undefined && method === 'initialize'
      ? { 'mcp-session-id': opts.sessionId }
      : {};

  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as { method: string; headers: Record<string, string>; body?: string };
    const msg = i.body === undefined ? null : JSON.parse(i.body);
    requests.push({ url: String(url), method: i.method, headers: i.headers, msg });

    if (i.method === 'DELETE') return new Response(null, { status: 204 });
    if (opts.status !== undefined && opts.status >= 400) {
      return new Response('upstream said no', {
        status: opts.status,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const method = msg?.method;
    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202, headers: sessionHeader(method) });
    }
    if (opts.emptyBody) {
      return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    let result: unknown;
    if (method === 'initialize') {
      result = {
        protocolVersion: opts.negotiated ?? '2024-11-05',
        serverInfo: { name: 'fake', version: '1' },
      };
    } else if (method === 'tools/list') {
      result = { tools: [{ name: 'get-time', inputSchema: { type: 'object' } }] };
    } else {
      result = opts.isError
        ? { isError: true, content: [{ type: 'text', text: 'boom' }] }
        : { content: [{ type: 'text', text: 'ok' }] };
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg?.id, result });
    const headers = sessionHeader(method);
    if (opts.sse) {
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { ...headers, 'content-type': 'text/event-stream' },
      });
    }
    return new Response(payload, {
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function http(opts: Parameters<typeof fakeServer>[0] = {}): {
  connector: McpConnector;
  requests: Recorded[];
} {
  const { fetchImpl, requests } = fakeServer(opts);
  const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', { fetchImpl });
  open.push(connector);
  return { connector, requests };
}

describe('createStreamableHttpMcpConnector —— StreamableHTTP 连接器', () => {
  it('application/json 响应：握手 + tools/list 全链', async () => {
    const { connector, requests } = http();
    assert.deepEqual(
      (await connector.listTools()).map((t) => t.name),
      ['get-time'],
    );
    assert.deepEqual(
      requests.map((r) => r.msg?.method ?? r.method),
      ['initialize', 'notifications/initialized', 'tools/list'],
    );
  });

  it('text/event-stream 响应也能接（SSE 帧解析）', async () => {
    const { connector } = http({ sse: true });
    assert.deepEqual(
      (await connector.listTools()).map((t) => t.name),
      ['get-time'],
      'StreamableHTTP 两种响应形态都必须支持，SSE 是规范允许的那一种',
    );
  });

  it('会话：initialize 带回的 id 在后续请求上回带；后续响应不带也不清空', async () => {
    const { connector, requests } = http({ sessionId: 'sess-1' });
    await connector.listTools();
    assert.equal(requests[0]?.headers['mcp-session-id'], undefined, 'initialize 时尚无会话');
    assert.equal(requests[1]?.headers['mcp-session-id'], 'sess-1');
    assert.equal(
      requests[2]?.headers['mcp-session-id'],
      'sess-1',
      'tools/list 的响应没带该头，但会话 id 必须留着',
    );
  });

  it('协议版本头：initialize 不带；后续带**协商到的**版本', async () => {
    const { connector, requests } = http({ negotiated: '2025-06-18' });
    await connector.listTools();
    assert.equal(requests[0]?.headers['mcp-protocol-version'], undefined);
    assert.equal(
      requests[1]?.headers['mcp-protocol-version'],
      '2025-06-18',
      '必须用 server 回的版本，不是我们请求的那个',
    );
    assert.equal(requests[2]?.headers['mcp-protocol-version'], '2025-06-18');
  });

  it('同时接受两种响应形态的 Accept 头（否则 server 无法按规范回 SSE）', async () => {
    const { connector, requests } = http();
    await connector.listTools();
    assert.match(requests[0]?.headers.accept ?? '', /application\/json/);
    assert.match(requests[0]?.headers.accept ?? '', /text\/event-stream/);
  });

  it('HTTP 429 → 抛错带数值 status ⇒ 被归成可重试的 rate_limit', async () => {
    const { connector } = http({ status: 429 });
    const err = await connector.listTools().then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    assert.equal((err as { status?: unknown }).status, 429);
    const info = classifyError(err);
    assert.equal(info.type, 'rate_limit');
    assert.equal(info.retryable, true);
  });

  it('HTTP 404（会话过期）→ 归成不可重试的 api 错，不自动重握手', async () => {
    const { connector } = http({ status: 404 });
    const err = await connector.listTools().then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    const info = classifyError(err);
    assert.equal(info.type, 'api');
    assert.equal(info.retryable, false);
  });

  it('协议层 isError 转成抛错（与 stdio 同语义）', async () => {
    const { connector } = http({ isError: true });
    await assert.rejects(() => connector.callTool('get-time', {}), /isError/);
  });

  it('响应体为空 → 可读错误（不静默返回 undefined）', async () => {
    const { connector } = http({ emptyBody: true });
    await assert.rejects(() => connector.listTools(), /响应体为空/);
  });

  it('close() 尽力 DELETE 会话，且幂等（第二次不再发）', async () => {
    const { connector, requests } = http({ sessionId: 'sess-1' });
    await connector.listTools();
    await connector.close();
    await connector.close();
    assert.deepEqual(requests.filter((r) => r.method === 'DELETE').length, 1);
    const del = requests.find((r) => r.method === 'DELETE');
    assert.equal(del?.headers['mcp-session-id'], 'sess-1');
  });

  it('没有会话时 close() 不发 DELETE', async () => {
    const { connector, requests } = http();
    await connector.listTools();
    await connector.close();
    assert.equal(requests.filter((r) => r.method === 'DELETE').length, 0);
  });

  it('出厂连接器直接接 `mcpTools`', async () => {
    const { connector } = http();
    const tools = await mcpTools(connector, { server: 'remote' });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp_remote_get_time'],
    );
  });

  it('url 为空在构造期即抛错', () => {
    assert.throws(() => createStreamableHttpMcpConnector(''), /url 不能为空/);
  });
});
