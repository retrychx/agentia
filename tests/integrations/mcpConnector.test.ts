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
  MCP_CLOSE_GRACE_MS,
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

function stdio(
  mode: string,
  opts: { logFile?: string; pidFile?: string; timeoutMs?: number } = {},
): McpConnector {
  const env: Record<string, string> = { FAKE_MCP_MODE: mode };
  if (opts.logFile) env.FAKE_MCP_LOG_FILE = opts.logFile;
  if (opts.pidFile) env.FAKE_MCP_PID_FILE = opts.pidFile;
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

  it('close() 返回时子进程**已被回收**（连忽略 SIGTERM 的 server 也照杀）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-mcp-'));
    const pidFile = join(dir, 'pid');
    const c = stdio('stubborn', { pidFile });
    await c.listTools(); // 先确认进程真起来了并完成握手
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isFinite(pid) && pid > 0, `没读到 pid：${pidFile}`);

    const started = Date.now();
    await c.close();
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed >= MCP_CLOSE_GRACE_MS,
      `server 忽略了 SIGTERM ⇒ 必须走到 SIGKILL（实测 ${elapsed}ms，宽限期 ${MCP_CLOSE_GRACE_MS}ms）`,
    );
    // 这一条是承重的：在「到点就 resolve、不等 reap」的旧实现下，close() 会在 SIGKILL
    // 刚发出时就返回，此刻子进程还在（未回收）⇒ kill(pid, 0) 不报 ESRCH ⇒ 用例变红。
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH/,
      'close() 返回即代表子进程已终止 —— 不能留下孤儿进程',
    );
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
    /** 固定会话 id（不换、不过期）—— 现有会话相关用例用它 */
    sessionId?: string;
    /** 每个**新**会话可承载的请求数；用完后再带该会话发请求一律 404（逼客户端重新 initialize） */
    sessionExpireAt?: number;
    /** `tools/call` 恒 404（验会话自愈**只重试一次**、不循环） */
    always404Call?: boolean;
    negotiated?: string;
    sse?: boolean;
    isError?: boolean;
    status?: number;
    emptyBody?: boolean;
  } = {},
): { fetchImpl: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  /** 会话是**显式开启**的：没给任何会话相关选项就当作「不支持会话的 server」（不回该头） */
  const useSession =
    opts.sessionId !== undefined ||
    opts.sessionExpireAt !== undefined ||
    opts.always404Call === true;
  /** 当前有效会话（`sessionId` 模式下恒为那个固定值；否则每次 initialize 铸一个新的） */
  let active: string | null = null;
  let minted = 0;
  let served = 0;

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

    if (method === 'initialize' && useSession) {
      active = opts.sessionId ?? `sess-${++minted}`;
      served = 0;
    } else if (active !== null) {
      // 会话校验：带错会话 / 已过期 → 404（MCP 规范语义：这个会话我不认识）
      const carried = i.headers['mcp-session-id'];
      const expired = opts.sessionExpireAt !== undefined && served >= opts.sessionExpireAt;
      if (
        carried !== active ||
        expired ||
        (opts.always404Call === true && method === 'tools/call')
      ) {
        return new Response('session not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      }
      served++;
    }

    const sessionHeader = (): Record<string, string> =>
      method === 'initialize' && active !== null ? { 'mcp-session-id': active } : {};

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202, headers: sessionHeader() });
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
    const headers = sessionHeader();
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

  it('HTTP 404 且**尚无会话**时不当作会话过期（照常抛，不重试）', async () => {
    const { connector, requests } = http({ status: 404 });
    const err = await connector.listTools().then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    const info = classifyError(err);
    assert.equal(info.type, 'api');
    assert.equal(info.retryable, false);
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      1,
      '没有会话可过期 ⇒ 不该触发重握手',
    );
  });

  it('会话过期（404）→ 自动重握手并把**这一次**重试一次（自愈成功）', async () => {
    const expired: number[] = [];
    const { fetchImpl, requests } = fakeServer({ sessionExpireAt: 2 });
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl,
      onSessionExpired: () => expired.push(Date.now()),
    });
    open.push(connector);

    assert.equal((await connector.listTools()).length, 1, '握手恰好占满 2 次会话额度');
    const r = (await connector.callTool('get-time', {})) as { content?: unknown };
    assert.deepEqual(
      r.content,
      [{ type: 'text', text: 'ok' }],
      '过期的那次没被执行（404 = 会话未知），重试应当成功',
    );

    assert.equal(expired.length, 1, 'onSessionExpired 必须被调一次 —— 自愈不能是静默的');
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      2,
      '应当重新 initialize 建新会话',
    );
    assert.deepEqual(
      requests
        .filter((q) => q.msg?.method === 'tools/call')
        .map((q) => q.headers['mcp-session-id']),
      ['sess-1', 'sess-2'],
      '重试必须带**新**会话 id',
    );
  });

  it('会话自愈**只重试一次**：对面一直 404 就直接抛（不循环）', async () => {
    const { fetchImpl, requests } = fakeServer({ always404Call: true });
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', { fetchImpl });
    open.push(connector);

    assert.equal((await connector.listTools()).length, 1);
    const err = await connector.callTool('get-time', {}).then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    assert.equal((err as { status?: unknown }).status, 404);
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      2,
      '只允许初始 1 次 + 自愈 1 次；再多就是重试循环',
    );
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
