import { TIMED_OUT, TimeoutError, withTimeout } from '../core/timeout.js';

/**
 * Agentia —— MCP **协议面**：桥（`mcp.ts`）与两个内置连接器（`mcp-stdio.ts` /
 * `mcp-http.ts`）**共用**的结构类型与 helper。
 *
 * **这个文件为什么存在**（2026-09-28，第 4 件「文件级无环守卫」咬出来的）：在此之前这些
 * 声明住在 `mcp.ts` 里，而 `mcp.ts` 又 re-export 两个连接器（`export { … }` 自
 * `mcp-stdio.ts` / `mcp-http.ts`）—— 于是「桥 → 连接器」（值 re-export）与「连接器 → 桥」
 * （取下面这些 helper 的值）构成一条**真实的值环**（运行期环，靠 ESM 函数提升与调用时机
 * 侥幸无恙）。把它们落到本文件后，依赖成一条**单向**的 DAG：
 *
 *     mcp.ts ──► mcp-protocol.ts ◄── mcp-stdio.ts / mcp-http.ts
 *        └──────────────► mcp-stdio.ts / mcp-http.ts（仅 re-export 连接器）
 *
 * 本文件**只依赖 core**（`core/timeout.js`），不反过来引桥或连接器 —— 那条无环是**构造性**的。
 * 新增「桥与连接器都要用」的东西请加在这里，别再加回 `mcp.ts`（会把环加回来）。
 *
 * ⚠️ 本注释**刻意不写出带引号的相对导入字面量**（如 `from '…/x.js'`）：`tests/architecture`
 * 里的依赖图解析器按正则抓 `from '…'`、不剥注释，写出来会**凭空造一条边**（踩过）。
 *
 * 公共面不变：这些符号仍由 `mcp.ts` re-export（`src/index.ts` 取用点未改）。
 */

/** MCP server 的 `tools/list` 条目（结构面子集：多出来的字段一律忽略） */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** MCP 协议里已是 JSON Schema → 直接当框架的 `inputSchema` 用 */
  inputSchema?: unknown;
}

/**
 * MCP client 的最小结构面：任何实现了 `tools/list` + `tools/call` 的客户端都能接，
 * 无需继承、无需 import 任何 SDK（duck-typed，与 `RedisLike` 同款）。
 *
 * 约定：`callTool` 失败请**抛错**（框架会包成 `is_error` 的 tool_result 回给模型，
 * 不中断 run —— 与本地工具抛错同语义）。MCP 协议层的 `isError: true` 请由连接器
 * 转成抛错，否则模型看不到失败。
 */
export interface McpClientLike {
  listTools(): Promise<McpToolInfo[]>;
  /**
   * `opts.abandoned`：裁判（引擎 `toolTimeoutMs` / 桥兜底超时）**放弃等待**的通知信号。
   * 放弃 ≠ 取消 —— 但连接器应借此清掉这次调用的簿记（stdio 的 pending 条目、
   * HTTP 的在飞 fetch），否则「server 活着但不回包」时每超时一次就泄漏一条。
   * 只实现两个参数的旧客户端依然兼容（可选参数，鸭子类型）。
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { abandoned?: AbortSignal },
  ): Promise<unknown>;
}

/**
 * 连接器公共面：`McpClientLike` + 一个关闭句柄（两个内置连接器都返回它）。
 *
 * 缝的形状没有变化 —— 需要自己的传输（官方 SDK / 远程 server / 复用长连接）时，
 * 实现 `McpClientLike` 两个方法即可，不必碰这里。
 */
export interface McpConnector extends McpClientLike {
  /**
   * 释放底层资源，**幂等**；stdio 侧**保证返回时子进程已终止**：
   * 先 SIGTERM，宽限期（`MCP_CLOSE_GRACE_MS`，见 `mcp-stdio.ts`）后 SIGKILL，然后**等真正的
   * `'exit'`**（2026-09-18 收紧：此前到点即返回、不等 reap，会留下孤儿进程而调用方无从知晓）。
   * HTTP 侧 = 尽力 `DELETE` 终止会话（server 不认也无所谓，失败不抛）。
   *
   * 关闭后再调用 `listTools` / `callTool` 会抛出可读错误（不静默挂死）。
   */
  close(): Promise<void>;
}

/**
 * 装配期超时的落点：**握手 + `tools/list`**。
 *
 * 为什么不给 `callTool` 也套一个：一次调用只有一个裁判（见 `McpToolsOptions.timeoutMs`）。
 * 走 `mcpTools` 时 `callTool` 由引擎 / 桥判定；而握手与 `tools/list` 发生在**装配期**，
 * 没有任何别的裁判 —— server 卡住会让 `createApp` 永久挂起，必须在这里兜住。
 */
export type Guard = <T>(p: Promise<T>, label: string) => Promise<T>;

/** 缺省超时：MCP server 可能去连外部系统，60s 是「明显卡死」与「慢但正常」的分界 */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 缺省 `clientInfo`（`initialize` 握手要发，协议要求该字段存在）。
 *
 * **刻意不写框架自身版本**：`integrations` 层不 import 公共面（`AGENTIA_VERSION` 在
 * `src/index.ts`），且 `scripts/release-surface.mjs` 的发版面按**精确版本串**计数 ——
 * 这里多一处版本字面量会让它的 count 断言失配。需要真实版本请自行传 `clientInfo`。
 */
export const DEFAULT_CLIENT_INFO: { name: string; version: string } = {
  name: 'agentia',
  version: '0.0.0',
};

/** `initialize` 缺省请求的协议版本（e2e 已验证的版本；要对齐新版 server 请显式传） */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/**
 * 给一次 MCP 调用套超时。⚠️ 与引擎的工具超时同样是**放弃等待**而非取消 ——
 * MCP 的 `notifications/cancelled` 属于连接器职责，桥这一层拿不到取消句柄。
 *
 * 实现是 `core/timeout.ts` 共享原语的**薄封装**（2026-09-17 单源化，见 spec §10 2026-09-17 ①）：
 * 「一次调用只有一个预算判定」在引擎与桥之间只允许有一份实现。此前桥自带一份**纯竞速**
 * 版本，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥继续把**超预算**的调用记成成功。
 *
 * 转导导出（module 级，**不进公共面**）只为可测：`tests/fixtures/timeoutLivenessProbe.ts`
 * 拿它验「截止计时器不得 unref」—— 那是「被 await 的超时到底会不会触发」的唯一分界点。
 */
export async function withDeadline<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const out = await withTimeout(p, timeoutMs);
  if (out === TIMED_OUT) {
    // 类型化超时（code='timeout'）⇒ 引擎记 errorKind='timeout'，与它自己判的超时同一类账。
    throw new TimeoutError(`MCP 工具 "${label}" 调用超时（超过 ${timeoutMs}ms）`);
  }
  return out;
}

/** 把可能很大的值截成可读片段（错误消息要能进日志，不能是一兆的 JSON） */
export function brief(value: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== 'string') s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** JSON-RPC 错误对象 → `Error`（`code` 进文案：`classifyError` 只认数值 `status`，这里不冒充它） */
export function jsonRpcError(err: unknown): Error {
  if (typeof err === 'object' && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    return new Error(`MCP error ${String(code)}: ${String(message)}`);
  }
  return new Error(`MCP error: ${brief(err)}`);
}

/** server 混进 stdout / SSE 的非 JSON 行 */
export function isJsonRpcResponse(msg: unknown): msg is {
  id: number;
  result?: unknown;
  error?: unknown;
} {
  return (
    typeof msg === 'object' && msg !== null && typeof (msg as { id?: unknown }).id === 'number'
  );
}

/** 从一条已解析的报文里取结果；带 `error` 则抛 */
export function unwrap(msg: { result?: unknown; error?: unknown }, method: string): unknown {
  if (msg.error !== undefined) throw jsonRpcError(msg.error);
  if (!('result' in msg)) throw new Error(`MCP ${method}：响应里既没有 result 也没有 error`);
  return msg.result;
}
