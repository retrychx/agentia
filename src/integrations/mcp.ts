import type { AgentTool, JsonSchema, ToolRunContext } from '../core/tool.js';

/**
 * Agentia —— MCP 桥（D1，spec §10 决策记录）。
 *
 * 设计原则同 `RedisLike`：框架只定义**结构面**，不 import `@modelcontextprotocol/sdk`，
 * 也**不含任何传输实现**（stdio spawn / StreamableHTTP 都在独立可选包 `@migor/mcp`，
 * 或用户自己接 SDK 后实现 `McpClientLike`）。本文件只依赖 core，符合分层约定
 * （`integrations` → `core`）。
 *
 * 用法：在 `createApp({ providers })` 里放一个 provider 即可 ——
 * ```ts
 * createApp({
 *   system: '…',
 *   providers: [{ provide: 'mcp', useFactory: () => mcpTools(client, { server: 'time' }) }],
 * });
 * ```
 * 复用既有装配 / 查重 / 中间件，**零新机制**（MCP 工具与本地 @Tool 同处一个命名空间，
 * 重名由 AgentApp 的装配期查重拦下）。
 *
 * 不做（YAGNI，见 spec §10）：`sampling`（server 反向请求模型）、`resources` / `prompts`
 * 原语（只做 tools）、连接池。
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
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpToolsOptions {
  /**
   * 工具名前缀，避免与本地单元撞名。缺省 `mcp_<server>_`；没给 `server` 时缺省 `mcp_`。
   * 传 `''` 表示不加前缀（此时 MCP 原名直接进菜单，撞名风险自负）。
   */
  prefix?: string;
  /** server 标识，只用于拼缺省前缀（不会发给 server） */
  server?: string;
  /**
   * 单次 `callTool` 超时（毫秒），缺省 60000；非正数 = 不限。
   * 超时**不杀 run**：该条 tool_result 记 `is_error` 回模型（与 engine 的
   * `toolTimeoutMs` 同语义，只是这里由桥自己兜 —— 双保险，谁短谁生效）。
   */
  timeoutMs?: number;
}

/** 缺省超时：MCP server 可能去连外部系统，60s 是「明显卡死」与「慢但正常」的分界 */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 工具名归一化：MCP 名可含 `-` / `.` / `/` / 空格等（对 LLM API 不友好或非法）
 * → 一律转 `_`，并把连续分隔符收成一个（`foo..bar` → `foo_bar`）。
 * 归一化后仍非法（空名 / 超长）直接抛错，**不静默改名** —— 静默截断会得到一个
 * 调用不回去的名字，比启动期报错难查得多。
 */
function normalizeToolName(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned;
}

/** 超时哨兵：区分「超时」与「工具恰好返回了 undefined」（同 engine 的 TIMED_OUT） */
const TIMED_OUT = Symbol('agentia.mcp.timed-out');

/**
 * 给一次 MCP 调用套超时。⚠️ 与 engine 的 `withTimeout` 同样是**放弃等待**而非取消 ——
 * MCP 的 `notifications/cancelled` 属于连接器职责，桥这一层拿不到取消句柄。
 */
async function withDeadline<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!(timeoutMs > 0)) return p;
  let timer: NodeJS.Timeout | undefined;
  try {
    const raced = await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref?.(); // 兜底计时器不该让宿主为它续命
      }),
    ]);
    if (raced === TIMED_OUT) {
      throw new Error(`MCP 工具 "${label}" 调用超时（超过 ${timeoutMs}ms）`);
    }
    return raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把一个 MCP server 的工具映射成框架的 `AgentTool[]`（可直接进 `tools` / providers）。
 *
 * - **名字**：`prefix + 归一化原名`；归一化后同名的两条直接抛错（否则装配期查重只会报
 *   「菜单单元重名」，看不出根因是 MCP 名撞了）；
 * - **原名**：每次调用时写进发起 turn 的 `mcp.tool` attribute（审计 / 回放要还原出
 *   回调 server 用的原名）；
 * - **入参 schema**：MCP 的 `inputSchema` 已是 JSON Schema → 原样透传，由 engine 的
 *   子集校验器在 `callTool` 之前先校验（非法入参根本不会发出，模型自己会改）；
 * - **返回结构**：MCP 的结果对象（`content` 数组等）原样交给 engine 序列化，
 *   不做「把 content 拼成字符串」这类有损加工 —— 需要塑形请自行包一层工具。
 */
export async function mcpTools(
  client: McpClientLike,
  opts: McpToolsOptions = {},
): Promise<AgentTool[]> {
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const prefix =
    opts.prefix ?? (opts.server === undefined ? 'mcp_' : `mcp_${normalizeToolName(opts.server)}_`);

  const listed = await client.listTools();
  const seen = new Map<string, string>(); // 归一化名 → 首个占位的 MCP 原名
  const tools: AgentTool[] = [];

  for (const info of listed) {
    const original = info.name;
    if (typeof original !== 'string' || original.trim() === '') {
      throw new Error(`MCP server 返回了空工具名：${JSON.stringify(info.name)}`);
    }
    const name = `${prefix}${normalizeToolName(original)}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error(
        `MCP 工具名 "${original}" 归一化后为 "${name}"，不满足 ^[A-Za-z0-9_-]{1,64}$` +
          `（前缀 "${prefix}" 过长或原名含过多非法字符）—— 请换个更短的 prefix`,
      );
    }
    const dup = seen.get(name);
    if (dup !== undefined) {
      throw new Error(
        `MCP 工具名归一化后撞名：${JSON.stringify(dup)} 与 ${JSON.stringify(original)} ` +
          `都变成 "${name}" —— 请给其中一个在 server 侧改名，或用 prefix 区分`,
      );
    }
    seen.set(name, original);

    const schema =
      info.inputSchema && typeof info.inputSchema === 'object' && !Array.isArray(info.inputSchema)
        ? (info.inputSchema as JsonSchema)
        : ({ type: 'object' } as JsonSchema);

    tools.push({
      name,
      description: info.description?.trim() || `MCP 工具 ${original}`,
      inputSchema: schema,
      run: async (input: unknown, ctx?: ToolRunContext) => {
        // 原名先落账再调用：连接器抛错/超时时，trace 里仍留得下「本想调谁」
        if (ctx) {
          try {
            ctx.recorder.setAttribute(ctx.parentSpanId, 'mcp.tool', original);
          } catch {
            /* 观测是辅助动作：记账失败不得把一次正常调用变成失败 */
          }
        }
        const args =
          input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        return withDeadline(client.callTool(original, args), timeoutMs, original);
      },
    });
  }

  return tools;
}
