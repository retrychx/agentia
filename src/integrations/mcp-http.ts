import {
  DEFAULT_CLIENT_INFO,
  DEFAULT_PROTOCOL_VERSION,
  MCP_DEFAULT_TIMEOUT_MS,
  brief,
  isJsonRpcResponse,
  unwrap,
  withDeadline,
} from './mcp.js';
import type { Guard, McpConnector, McpToolInfo } from './mcp.js';

/**
 * MCP **StreamableHTTP 连接器**（内置默认件之一）：一个 endpoint，POST JSON-RPC。
 * 桥与共享 helper 在 `mcp.ts`；本文件只含 HTTP 传输。module 级 export，
 * 公共面仍由 `mcp.ts` re-export（`src/index.ts` 不变）。
 */

export interface StreamableHttpMcpConnectorOptions {
  /** 附加请求头（鉴权等）。会覆盖缺省的 `content-type` / `accept` 同名字段 */
  headers?: Record<string, string>;
  /** 见 {@link DEFAULT_CLIENT_INFO} */
  clientInfo?: { name: string; version: string };
  /** 请求的协议版本，缺省 `'2024-11-05'`；协商结果以 server 回的为准 */
  protocolVersion?: string;
  /** 装配期超时（毫秒）—— 只作用于**握手 + `tools/list`**，语义同 {@link StdioMcpConnectorOptions.timeoutMs} */
  timeoutMs?: number;
  /**
   * 会话过期时被调一次（见 `rpc` 的 404 自愈）。**给可观测用**：默认自愈是静默的，
   * 而「静默恢复」和「静默失效」在监控上看不出区别 —— 要计数 / 告警 / 打日志就挂这个钩子。
   */
  onSessionExpired?: () => void;
  /** 注入 `fetch`（测试用；缺省全局 `fetch`，与 `createOpenAIClient` 同款） */
  fetchImpl?: typeof fetch;
}

/**
 * **StreamableHTTP 连接器**：一个 endpoint，POST JSON-RPC（MCP 2025-03-26 起的
 * Streamable HTTP 传输）。
 *
 * - 两种响应形态**都要接**：`application/json`（整条报文）与 `text/event-stream`
 *   （报文按 SSE 帧下发，server 应在发完响应后关流）；
 * - 会话：`initialize` 响应里的 `Mcp-Session-Id` 会被记住并在后续请求上回带
 *   （后续响应不带该头时**不覆盖**）；`close()` 尽力 `DELETE` 终止会话；
 *   **会话过期自愈**：带会话 id 收到 `404` ⇒ 视为「会话已终止、该请求未被 server 执行」
 *   ⇒ 丢会话 → 重新握手 → 把这一次**重试一次**（只一次，不再循环）。自愈是静默的，
 *   所以给了 `onSessionExpired` 钩子给你计数 / 告警 —— 否则它和「静默失效」没区别。
 * - 协议版本：请求头 `MCP-Protocol-Version` 带**协商到的**版本（2025-06-18 起要求，
 *   老 server 忽略未知头）；
 * - HTTP 层失败**挂数值 `status`** ⇒ `engine/errors.ts::classifyError` 自动分流
 *   （429 → `rate_limit` 可重试 / ≥500 → `server` 可重试 / 其余 4xx → `api` 不可重试）。
 */
export function createStreamableHttpMcpConnector(
  url: string,
  opts: StreamableHttpMcpConnectorOptions = {},
): McpConnector {
  if (typeof url !== 'string' || url === '') {
    throw new Error('createStreamableHttpMcpConnector：url 不能为空');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;
  const requestedVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    // MCP 规定客户端必须同时接受两种响应形态（否则 server 无法按规范回 SSE）
    accept: 'application/json, text/event-stream',
    ...opts.headers,
  };

  let sessionId: string | null = null;
  let negotiated = requestedVersion;
  let closed = false;
  let ready: Promise<void> | null = null;
  let reinit: Promise<void> | null = null;
  let nextId = 1;

  const guard: Guard = (p, label) => withDeadline(p, timeoutMs, label);

  /** HTTP 层失败：带上数值 `status`，让 `classifyError` 能按状态分流 */
  const httpError = (status: number, method: string, body: string): Error => {
    const e = new Error(`MCP ${method} HTTP ${status}${body ? `：${body}` : ''}`);
    (e as { status?: number }).status = status;
    return e;
  };

  const readText = async (res: Response): Promise<string> => {
    try {
      return await res.text();
    } catch {
      return '';
    }
  };

  const post = async (
    payload: unknown,
    o: { withVersion?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> => {
    if (closed) throw new Error('MCP 连接器已 close —— 请重新创建一个');
    const headers: Record<string, string> = { ...baseHeaders };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    if (o.withVersion) headers['mcp-protocol-version'] = negotiated;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      // 裁判（引擎 toolTimeoutMs / 桥兜底）的 abandoned 直达传输层：放弃等待时在飞 fetch
      // 被真掐掉，不留泄漏（HTTP 侧没有 stdio 那样的 pending 簿记，掐连接就是清簿记）。
      // exactOptionalPropertyTypes：无 signal 时不落这个键。
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
    });
    // 会话 id 只在 initialize 响应里出现；后续响应不带时**不能**把它清成 null
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null && sid !== '') sessionId = sid;
    return res;
  };

  /** 非 SSE 报文（单条 JSON-RPC）→ 取 result；SSE 里可能有别的通知帧，只取与 `id` 配对的 */
  const pickResult = (msg: unknown, id: number, method: string): unknown => {
    // id 必须**等值**配对（与 SSE 分支同款）：只验「是带 id 的响应」会把别的请求的
    // 结果当本次的返回（代理串包/通知帧），静默错值比报错难查得多。
    if (!isJsonRpcResponse(msg) || msg.id !== id) {
      throw new Error(`MCP ${method}：响应里没有 id 为 ${id} 的 JSON-RPC 报文`);
    }
    return unwrap(msg, method);
  };

  /**
   * 从响应取结果。SSE 分支一次性读完整个 body 再解析 —— StreamableHTTP 约定 server 发完
   * 响应即关流，读全比手写增量解析器稳（`text/event-stream` 里 `data:` 行按规范可跨多行拼接）。
   */
  const readResult = async (res: Response, id: number, method: string): Promise<unknown> => {
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const text = await readText(res);
    if (ct.includes('text/event-stream')) {
      for (const frame of text.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (data === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        if (isJsonRpcResponse(msg) && msg.id === id) return unwrap(msg, method);
      }
      throw new Error(`MCP ${method}：SSE 响应里没有 id 为 ${id} 的报文`);
    }
    if (text.trim() === '') {
      throw new Error(`MCP ${method}：响应体为空（期望 id 为 ${id} 的 JSON-RPC 报文）`);
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new Error(`MCP ${method}：响应不是合法 JSON：${brief(text)}`);
    }
    return pickResult(msg, id, method);
  };

  /**
   * 会话过期自愈的互斥：并发请求同时吃到 404 时**共享同一次重握手**。
   * 没有这层时，两个并发调用各自执行 `ready = null`（第二个会把第一个刚建的握手
   * Promise 抹掉）⇒ 双 initialize 并发跑、`sessionId` 互相覆盖，重试带着被覆盖的
   * 会话再 404 且不再重试。`onSessionExpired` 仍按 404 逐次记（每个 404 都是事实），
   * 共享的只是「重握手」这个动作。
   */
  const reinitialize = (): Promise<void> => {
    if (reinit) return reinit;
    reinit = (async () => {
      sessionId = null;
      ready = null; // 下一次 ensureReady 会新建会话
      await ensureReady();
    })().finally(() => {
      reinit = null;
    });
    return reinit;
  };

  /**
   * 一次 JSON-RPC 往返，带**会话过期自愈**（2026-09-18；MCP Streamable HTTP 的规范语义）。
   *
   * 带会话 id 收到 `404` 的含义是「这个会话我不认识」⇒ **该请求没有被执行** ——
   * 所以丢掉会话、重新握手、把这一次**重试一次**是安全的（不会重复执行副作用）。
   * 规范也是这么要求的：客户端**必须**新建会话（不带会话 id 重新 `initialize`）。
   *
   * **只重试一次**：第二次再 404 说明对面不是「会话过期」而是别的问题，直接抛（不循环）。
   * 自愈本身是静默的，但可通过 `onSessionExpired` 观测 —— 否则它和「静默失效」没区别。
   */
  const rpc = async (
    method: string,
    params: unknown,
    withVersion: boolean,
    allowReinit = true,
    abandoned?: AbortSignal,
  ): Promise<unknown> => {
    const id = nextId++;
    const res = await post(
      { jsonrpc: '2.0', id, method, params },
      { withVersion, ...(abandoned !== undefined ? { signal: abandoned } : {}) },
    );
    if (res.status === 404 && sessionId !== null && allowReinit) {
      await readText(res); // 排空，别把连接晾着
      opts.onSessionExpired?.();
      await reinitialize();
      // 自愈重试那次同样带上 abandoned —— 裁判放弃时两条在飞 fetch 都要被掐
      return rpc(method, params, withVersion, false, abandoned);
    }
    if (!res.ok) throw httpError(res.status, method, await readText(res));
    // 计时裁判权在调用方（initialize / notifications / tools/list 都在调用点自带
    // guard —— 它们是装配期路径、没有别的裁判）；`tools/call` 不在此起计时器：
    // 它的裁判是引擎的 `toolTimeoutMs`（spec §10 2026-09-17 ① 超时单源化）——
    // 再包一层 guard 就是双计时器，同一事件两本账（stdio 侧就没有这层）。
    return readResult(res, id, method);
  };

  const ensureReady = (): Promise<void> => {
    if (ready) return ready;
    ready = (async () => {
      const init = await guard(
        rpc(
          'initialize',
          { protocolVersion: requestedVersion, capabilities: {}, clientInfo },
          false,
        ),
        'initialize',
      );
      if (typeof init === 'object' && init !== null) {
        const v = (init as { protocolVersion?: unknown }).protocolVersion;
        if (typeof v === 'string' && v !== '') negotiated = v;
      }
      const res = await guard(
        post(
          { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
          { withVersion: true },
        ),
        'notifications/initialized',
      );
      if (!res.ok) {
        throw httpError(res.status, 'notifications/initialized', await readText(res));
      }
      await readText(res); // 排空：202 + 空体是合法应答，但别把连接晾着
    })();
    return ready;
  };

  const listTools = async (): Promise<McpToolInfo[]> => {
    await ensureReady();
    const r = await guard(rpc('tools/list', {}, true), 'tools/list');
    if (typeof r !== 'object' || r === null) {
      throw new Error(`MCP tools/list 返回了非对象：${brief(r)}`);
    }
    const listed = (r as { tools?: unknown }).tools;
    if (listed === undefined) return [];
    if (!Array.isArray(listed)) {
      throw new Error(`MCP tools/list 的 tools 不是数组：${brief(listed)}`);
    }
    return listed as McpToolInfo[];
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    callOpts?: { abandoned?: AbortSignal },
  ): Promise<unknown> => {
    await ensureReady();
    const r = await rpc('tools/call', { name, arguments: args }, true, true, callOpts?.abandoned);
    // 承重同 stdio：协议层 isError 只有连接器看得见
    if (typeof r === 'object' && r !== null && (r as { isError?: unknown }).isError) {
      throw new Error(
        `MCP 工具 ${name} 返回 isError: ${brief((r as { content?: unknown }).content)}`,
      );
    }
    return r;
  };

  return {
    listTools,
    callTool,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const sid = sessionId;
      sessionId = null;
      if (sid === null) return;
      try {
        // 尽力终止会话（MCP 约定的显式关闭）；server 不认这个方法也不该让 close() 抛。
        //
        // ⚠️ **必须过 `guard`**：这里此前直接 `await fetchImpl(...)`。下面的 catch 只兜得住
        // **抛错**，兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
        // `close()` 就永久挂住，而调用方（宿主停机路径）会一直等它。**挂住比失败更糟**，
        // 与「best-effort、不抛错」的承诺相悖。fetch 与排空**一起**进 guard：
        // 只护住响应头、body 照样能卡（`readText` 读的是 body）。
        await guard(
          (async () => {
            const res = await fetchImpl(url, {
              method: 'DELETE',
              headers: {
                ...baseHeaders,
                'mcp-session-id': sid,
                'mcp-protocol-version': negotiated,
              },
            });
            await readText(res);
          })(),
          'close',
        );
      } catch {
        /* 关闭是尽力而为（超时也走这里 —— guard 抛 TimeoutError） */
      }
    },
  };
}
