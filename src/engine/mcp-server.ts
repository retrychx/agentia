import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { stringifySafe } from '../core/json.js';
import { TIMED_OUT, isTimeoutError, withTimeout } from '../core/timeout.js';
import type { AgentTool, ModelClient, ToolRunContext } from '../core/tool.js';
import type { SpanError, TraceSink } from '../core/trace.js';
import { DEFAULT_PROTOCOL_VERSION } from '../integrations/mcp.js';
import { createAnthropicClient } from '../integrations/anthropic.js';
import { classifyError } from './errors.js';
import { buildToolRunContext } from './tool-context.js';
import { toolInputPayload, toolOutputPayload } from './tool-events.js';
import { TraceRecorder } from './tracer.js';

/**
 * Agentia —— **MCP 反向桥**（R8-P5）：把 app 的能力菜单暴露成 MCP server
 * （正向桥 `integrations/mcp.ts` 是把外部 MCP server 的工具接进来，本文件是反方向）。
 *
 * **落点为什么不在 integrations**：它只允许依赖 core（`tests/architecture/layering.test.ts`
 * 的 ALLOWED），装不下本文件 —— server 每次 tools/call 要造一棵 trace，需要 engine 的
 * `TraceRecorder`；engine → integrations 这条边已存在（取默认 ModelClient），反向即成环；
 * transport 则够不到 integrations。engine 是分层图上唯一能同时够到 core 与 integrations
 * 的层，故落在这里。app 入参是**鸭子类型** `{ tools: AgentTool[] }`（toolkit 的 AgentApp
 * 结构满足，`app.tools` 就是装配后、过中间件的那份菜单）—— engine 不能 import toolkit。
 *
 * **协议范围只到 tools**：`initialize` / `notifications/initialized` / `tools/list` /
 * `tools/call`（顺手支持 `ping`）；其余 method 一律 -32601，params 形状坏 → -32602。
 *
 * **trace 叙事不破**：每次 `tools/call` 造一个 `TraceRecorder`：根 span（kind `run`，
 * name `mcp.tools/call`）下挂一个 capability span（kind `capability`、name = 工具名 ——
 * metrics 的 `capabilityKindOf` 把它归为 `capability:<name>` 标签，自动进能力指标），
 * 并按 `tool-events.ts` 的口径记同名 `tool.input` / `tool.output` 事件（账目形状与引擎
 * 一致）；收尾 snapshot 投递 `opts.sinks`（sink 抛错吞掉 + `console.warn`，观测不击穿业务）。
 * `tools/list` / `initialize` 不建 trace。
 *
 * **不做（YAGNI，与正向桥同款清单）**：resources / prompts / sampling（server 反向请求模型）/
 * SSE 推送（server→client 流）/ 会话强制校验（HTTP 侧发 `mcp-session-id` 头但**不校验**：
 * 无状态 server，带了接受、不带也服务 —— 宽容选择，文档写明）。
 */

/** MCP server 的入口应用面（鸭子类型）：`AgentApp` 结构满足（`app.tools` 即装配后的菜单） */
export interface McpServerApp {
  tools: AgentTool[];
}

export interface McpServerOptions {
  /** 传输：`'stdio'`（CLI 场景，父进程 spawn）或 `'http'`（服务场景，StreamableHTTP） */
  transport: 'stdio' | 'http';
  /** http：监听地址，缺省 `'127.0.0.1'`（MCP server 不该默认暴露到公网） */
  host?: string;
  /** http：监听端口，缺省 `0`（系统分配，读返回值的 `url` 拿实际端口）。自带 `server` 时无效 */
  port?: number;
  /** http：endpoint 路径，缺省 `'/mcp'` */
  path?: string;
  /**
   * http：**挂进既有的 `http.Server`**（框架不替它 listen；`close()` 只摘除本 handler，
   不关 server）。此时非本 `path` 的请求本 handler 直接忽略（交给宿主自己的路由）。
   */
  server?: Server;
  /**
   * `ToolRunContext.client` 是必填字段（子 agent / skill 类工具要它拉子循环）。
   * 缺省**惰性**走 `createAnthropicClient()`（与引擎默认同款）—— 第一次 `tools/call`
   * 才构造，不在 `createMcpServer` 时构造（纯工具菜单的 server 不该要求 API key 在场）。
   */
  client?: ModelClient;
  /** trace 出口：每次 `tools/call` 收尾投递（抛错被吞，观测不击穿业务） */
  sinks?: TraceSink[];
  /**
   * 单次 `tools/call` 的工具执行超时（毫秒），语义与引擎 `toolTimeoutMs` **同款**：
   * 非正数 / 不设 = 不限；超时 = **放弃等待**（abort `abandoned` 通知工具自行收尾，
   * 该次调用回 `isError`，server 不挂）。复用既有语义，故不进 `limits.ts` 真源表。
   */
  toolTimeoutMs?: number;
  /**
   * http 侧鉴权钩子（与 `transport/http.ts` 的 `authenticate` **同纪律**）：框架不实现
   * token / JWT 策略，只留钩子 —— 在**读 body 之前**调用，抛错即 401（原文只进服务端日志）。
   * stdio 侧信任父进程，本项不生效。
   */
  auth?: (req: IncomingMessage) => unknown | Promise<unknown>;
  /** `serverInfo.name`（`initialize` 握手回给客户端），缺省 `'agentia'` */
  name?: string;
}

/** `createMcpServer` 的返回值 */
export interface McpServer {
  /** http 模式的实际 endpoint（如 `http://127.0.0.1:54321/mcp`）；stdio 模式恒为 `undefined` */
  readonly url: string | undefined;
  /** http：listen 完成的承诺（`url` 此时可用）；stdio：立即 resolve */
  readonly ready: Promise<void>;
  /**
   * 关闭（幂等）：中止全部在飞 `tools/call` 的 signal；stdio 侧停读 stdin；
   * http 侧关掉**自有** server（挂进来的既有 server 只摘除本 handler）。
   */
  close(): Promise<void>;
}

/** serverInfo.version 刻意不写真版本字面量（与 DEFAULT_CLIENT_INFO 同纪律，release-surface 按精确版本串计数） */
const SERVER_INFO_VERSION = '0.0.0';

/** http 侧请求 body 上限（固定 1 MiB，与 HTTP 宿主缺省一致；不公开成旋钮） */
const MAX_BODY_BYTES = 1024 * 1024;

type JsonRpcId = number | string | null;

/** 造一条 JSON-RPC 错误应答 */
function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 造一条 JSON-RPC 成功应答 */
function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/**
 * 把 app 的能力菜单暴露成 MCP server。两个传输都只用标准库：
 * - **stdio**：stdin/stdout 换行分隔 JSON-RPC（每行一个完整报文）；日志只去 stderr；
 * - **StreamableHTTP**：POST 收 JSON-RPC，应答 `application/json`（简单应答不上 SSE）；
 *   `initialize` 响应发 `mcp-session-id` 头（生成的 uuid），后续请求带了就接受、不带也服务
 *   （无状态 server，**宽容是有意的**）；GET（server→client 流）→ 405；DELETE → 200；
 *   客户端断连会中止该次工具调用的 `signal`。
 */
export function createMcpServer(app: McpServerApp, opts: McpServerOptions): McpServer {
  if (typeof app !== 'object' || app === null || !Array.isArray(app.tools)) {
    throw new TypeError(
      'createMcpServer：app 必须是鸭子类型 { tools: AgentTool[] }（如 AgentApp）',
    );
  }
  if (opts.transport !== 'stdio' && opts.transport !== 'http') {
    throw new TypeError(
      `createMcpServer：transport 只认 'stdio' | 'http'，收到 ${String(opts.transport)}`,
    );
  }
  const tools = app.tools;
  const serverInfo = { name: opts.name ?? 'agentia', version: SERVER_INFO_VERSION };
  const toolTimeoutMs = opts.toolTimeoutMs;
  const sinks = opts.sinks ?? [];

  /** 在飞 tools/call 的中止句柄 —— close() 中止它们（服务器关闭 = 调用方没了） */
  const inFlight = new Set<AbortController>();
  /** client 惰性构造（见 McpServerOptions.client）：第一次 tools/call 才建 */
  let cachedClient: ModelClient | undefined;
  const clientOf = (): ModelClient => {
    cachedClient ??= opts.client ?? createAnthropicClient();
    return cachedClient;
  };

  /**
   * 执行一次 `tools/call`：造一棵 trace（run 根 + capability span + tool.input/tool.output
   * 事件），收尾投递 sinks，然后把结果映射成 MCP 形状。
   */
  const callTool = async (
    tool: AgentTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const recorder = new TraceRecorder();
    const rootId = recorder.begin('run', 'mcp.tools/call', null);
    const capId = recorder.begin('capability', tool.name, rootId);
    // tool_use_id 与引擎同义（同名工具并行时靠 id 配对入参/出参事件）
    const use = { type: 'tool_use' as const, id: randomUUID(), name: tool.name, input: args };
    const startedAt = Date.now();
    recorder.event(capId, 'tool.input', toolInputPayload(use));
    // 超时「放弃等待」的通知信号（与引擎 executeOneTool 同款：判超时分支里 abort）
    const abandonAc = new AbortController();
    const toolCtx: ToolRunContext = buildToolRunContext({
      client: clientOf(),
      recorder,
      parentSpanId: capId,
      abandoned: abandonAc.signal,
      signal,
      toolTimeoutMs,
    });

    let ok = true;
    let content: unknown = '';
    let errorKind: 'timeout' | 'threw' | undefined;
    let spanError: SpanError | undefined;
    try {
      // 与引擎同一判定原语（core/timeout.ts，实测耗时兜底）：超时 = 放弃等待，不杀 server
      const out = await withTimeout(Promise.resolve(tool.run(args, toolCtx)), toolTimeoutMs ?? 0);
      if (out === TIMED_OUT) {
        abandonAc.abort(); // 通知工具「没人等结果了」（@SubAgent/@Skill 靠它自中止）
        ok = false;
        errorKind = 'timeout';
        content = `error(timeout): 工具执行超过 ${toolTimeoutMs}ms`;
        spanError = { type: 'timeout', message: String(content), retryable: true };
      } else {
        content = out;
      }
    } catch (e) {
      ok = false;
      if (isTimeoutError(e)) {
        // 工具自判的超时与引擎判的归同一类账（与 turn.ts 同口径）
        errorKind = 'timeout';
        content = `error(timeout): ${e instanceof Error ? e.message : String(e)}`;
        spanError = { type: 'timeout', message: String(content), retryable: true };
      } else {
        errorKind = 'threw';
        const err = classifyError(e);
        content = `error(${err.type}): ${err.message}`;
        spanError = err;
      }
    }
    recorder.event(
      capId,
      'tool.output',
      toolOutputPayload({ use, ok, errorKind, startedAt, now: Date.now(), content }),
    );
    recorder.end(
      capId,
      ok
        ? {}
        : {
            status: 'error',
            // exactOptionalPropertyTypes：显式 undefined 不是合法的 `error?: SpanError`
            ...(spanError !== undefined ? { error: spanError } : {}),
          },
    );
    recorder.end(
      rootId,
      ok
        ? {}
        : {
            status: 'error',
            ...(spanError !== undefined ? { error: spanError } : {}),
          },
    );
    const trace = recorder.snapshot(ok ? 'ok' : 'error');
    // 观测不击穿业务：sink 抛错吞掉 + console.warn（与 runtime 的 flushSinks 同款文案）
    for (const sink of sinks) {
      try {
        await sink.export(trace);
      } catch (e) {
        console.warn('[agentia] trace sink 投递失败:', e instanceof Error ? e.message : e);
      }
    }

    // 结果映射：抛错 → 协议层成功 + isError（MCP 惯例；正向桥那头正好把 isError 转回抛错，
    // 方向对称）；string 原样进 text；其他 JSON 化进 text
    if (!ok) return { content: [{ type: 'text', text: String(content) }], isError: true };
    const text = typeof content === 'string' ? content : stringifySafe(content);
    return { content: [{ type: 'text', text }] };
  };

  /**
   * 报文分派（两个传输共用）。返回 `null` = 通知，不应答。
   * 协议范围只到 tools（见文件头）；其余 method 一律 -32601，params 形状坏 → -32602。
   */
  const dispatch = async (
    msg: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> => {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return rpcError(null, -32600, '报文不是 JSON-RPC 对象');
    }
    const m = msg as { id?: unknown; method?: unknown; params?: unknown };
    const id: JsonRpcId =
      typeof m.id === 'number' || typeof m.id === 'string' || m.id === null ? m.id : null;
    if (typeof m.method !== 'string') {
      return m.id === undefined ? null : rpcError(id, -32600, '报文缺 method 字段');
    }
    const method = m.method;
    // 通知（含 notifications/initialized）一律不应答；无 id 的非通知报文不是请求
    if (method.startsWith('notifications/') || m.id === undefined) return null;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        // 不建 trace（见文件头）：菜单查询不是一次「能力调用」
        return rpcResult(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const params = m.params;
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
          return rpcError(id, -32602, 'tools/call 的 params 必须是对象（{ name, arguments? }）');
        }
        const name = (params as { name?: unknown }).name;
        if (typeof name !== 'string' || name === '') {
          return rpcError(id, -32602, 'tools/call 的 params.name 必须是非空字符串');
        }
        const rawArgs = (params as { arguments?: unknown }).arguments;
        if (
          rawArgs !== undefined &&
          (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))
        ) {
          return rpcError(id, -32602, 'tools/call 的 params.arguments 必须是对象');
        }
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return rpcError(id, -32602, `未知工具: ${name}`);
        }
        return rpcResult(
          id,
          await callTool(tool, (rawArgs ?? {}) as Record<string, unknown>, signal),
        );
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  };

  /** 为一次请求登记中止句柄（close() / 传输侧断连时中止它），返回其 signal */
  const trackCall = (ac: AbortController): AbortSignal => {
    inFlight.add(ac);
    return ac.signal;
  };
  const untrackCall = (ac: AbortController): void => {
    inFlight.delete(ac);
  };
  const abortAll = (): void => {
    for (const ac of inFlight) ac.abort();
    inFlight.clear();
  };

  if (opts.transport === 'stdio') {
    // stdio：换行分隔 JSON-RPC（每行一个完整报文）；日志只能去 stderr（stdout 是协议面）
    let buf = '';
    let closed = false;
    const onData = (chunk: string): void => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stdout.write(`${JSON.stringify(rpcError(null, -32700, '行不是合法 JSON'))}\n`);
          continue;
        }
        const ac = new AbortController();
        const signal = trackCall(ac);
        void dispatch(msg, signal)
          .then((resp) => {
            if (resp !== null && !closed) {
              process.stdout.write(`${JSON.stringify(resp)}\n`);
            }
          })
          .catch(() => {
            /* 分派自身不该抛（callTool 内部已兜住）；真抛了也不许把 server 带崩 */
          })
          .finally(() => untrackCall(ac));
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    return {
      url: undefined,
      ready: Promise.resolve(),
      close: () => {
        if (closed) return Promise.resolve();
        closed = true;
        abortAll();
        process.stdin.off('data', onData);
        process.stdin.pause(); // 摘掉读端，宿主进程的事件循环不再被我们吊住
        return Promise.resolve();
      },
    };
  }

  // ── StreamableHTTP ──
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const shared = opts.server !== undefined;
  const server: Server = opts.server ?? createServer();
  /** initialize 响应发的会话 id（生成的 uuid；无状态 server 只发不校验 —— 宽容是有意的） */
  const sessionId = randomUUID();

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    if (res.writableEnded || res.destroyed) return; // 客户端已走：写了也没人收
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const readBody = (req: IncomingMessage): Promise<string | null> =>
    new Promise((resolvePromise) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        resolvePromise(v);
      };
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          finish(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(null));
      req.on('close', () => finish(null));
    });

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) {
      // 挂进既有 server 时，别的路径交给宿主自己的路由（本 handler 不管）；
      // 自有 server 上就是 404
      if (shared) return;
      sendJson(res, 404, { error: `路径不存在: ${pathname}` });
      return;
    }
    const method = req.method ?? 'GET';
    if (method === 'DELETE') {
      // 尽力终止会话（MCP 约定）：无状态 server 没有可终止的会话，200 收口
      res.writeHead(200);
      res.end();
      return;
    }
    if (method !== 'POST') {
      // GET（server→client 流）不做（YAGNI，见文件头）→ 405
      res.setHeader('allow', 'POST, DELETE');
      sendJson(res, 405, { error: `方法 ${method} 不被允许，请用 POST` });
      return;
    }

    // 鉴权缝：与 HTTP 宿主同纪律 —— 在读 body 之前，抛错即 401，原文只进服务端日志
    if (opts.auth) {
      try {
        await opts.auth(req);
      } catch (e) {
        console.error('[agentia:mcp-server] 鉴权钩子异常:', e);
        if (!req.complete) res.setHeader('connection', 'close'); // body 未消费 ⇒ 连接不可复用
        sendJson(res, 401, { error: '未通过鉴权' });
        return;
      }
    }

    const raw = await readBody(req);
    if (raw === null) {
      if (!req.complete) res.setHeader('connection', 'close');
      sendJson(res, 413, { error: `请求 body 超过上限 ${MAX_BODY_BYTES} 字节或连接中断` });
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: '请求 body 不是合法 JSON' });
      return;
    }

    // 客户端断连 ⇒ 中止该次工具调用的 signal（协作式；与 HTTP 宿主同款 onClose 守卫）
    const ac = new AbortController();
    const signal = trackCall(ac);
    const onClose = (): void => {
      if (!res.writableEnded) ac.abort();
    };
    res.once('close', onClose);
    try {
      const resp = await dispatch(msg, signal);
      if (resp === null) {
        // 通知（含 notifications/initialized）：202 + 空体
        res.writeHead(202);
        res.end();
        return;
      }
      if (res.writableEnded || res.destroyed) return;
      const payload = JSON.stringify(resp);
      const headers: Record<string, string | number> = {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      };
      // initialize 响应发 mcp-session-id（生成的 uuid）；后续请求带了就接受、不带也服务
      if ((msg as { method?: unknown }).method === 'initialize') {
        headers['mcp-session-id'] = sessionId;
      }
      res.writeHead(200, headers);
      res.end(payload);
    } finally {
      res.off('close', onClose);
      untrackCall(ac);
    }
  };
  server.on('request', onRequest);

  let url: string | undefined;
  const ready = shared
    ? Promise.resolve()
    : new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(opts.port ?? 0, host, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === 'object') {
            url = `http://${host}:${addr.port}${path}`;
          }
          resolvePromise();
        });
      });

  let closed = false;
  return {
    get url() {
      return url;
    },
    ready,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      abortAll();
      if (shared) {
        // 挂进来的既有 server 由宿主自己管：只摘除本 handler
        server.off('request', onRequest);
        return Promise.resolve();
      }
      return new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        // 仍在飞的连接会吊住 close 的回调（Node ≥ 18.2 有 closeAllConnections；旧版没有则
        // 靠 abortAll 之后工具自行收尾 —— 读 signal 的工具会退出，连接随之结束）
        server.closeAllConnections?.();
      });
    },
  };
}
