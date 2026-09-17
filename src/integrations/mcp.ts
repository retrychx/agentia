import { TIMED_OUT, TimeoutError, withTimeout } from '../core/timeout.js';
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
   * 工具名前缀，避免与本地能力撞名。缺省 `mcp_<server>_`；没给 `server` 时缺省 `mcp_`。
   * 传 `''` 表示不加前缀（此时 MCP 原名直接进菜单，撞名风险自负）。
   */
  prefix?: string;
  /** server 标识，只用于拼缺省前缀（不会发给 server） */
  server?: string;
  /**
   * **兜底**单次 `callTool` 超时（毫秒），缺省 60000；非正数 = 不限。
   *
   * ⚠️ 语义（见 spec §10 2026-09-17 ①）：**引擎设了 `toolTimeoutMs` 时本项不参与判定** ——
   * 一次调用只有一个裁判，否则同一件事会有两个计时器、两种账。它只在两种情况生效：
   * ① 桥脱离引擎单用（直接 `tool.run(...)`，没有 ctx）；② 引擎没设 `toolTimeoutMs`。
   *
   * 超时**不杀 run**：该条 tool_result 记 `is_error`、`errorKind='timeout'` 回模型。
   * 与 engine 的 `toolTimeoutMs` **同判定、同账目**（共用 `core/timeout.ts` 的实测耗时兜底）。
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
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned;
}

/**
 * 给一次 MCP 调用套超时。⚠️ 与引擎的工具超时同样是**放弃等待**而非取消 ——
 * MCP 的 `notifications/cancelled` 属于连接器职责，桥这一层拿不到取消句柄。
 *
 * 实现是 `core/timeout.ts` 共享原语的**薄封装**（2026-09-17 单源化，见 spec §10 2026-09-17 ①）：
 * 「一次调用只有一个预算判定」在引擎与桥之间只允许有一份实现。此前桥自带一份**纯竞速**
 * 版本，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥继续把**超预算**的调用记成成功。
 *
 * 转导导出（module 级，**不进公共面**）只为可测：`tests/timeoutLiveness.test.ts` 拿它验
 * 「截止计时器不得 unref」—— 那是「被 await 的超时到底会不会触发」的唯一分界点。
 */
export async function withDeadline<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const out = await withTimeout(p, timeoutMs);
  if (out === TIMED_OUT) {
    // 类型化超时（code='timeout'）⇒ 引擎记 errorKind='timeout'，与它自己判的超时同一类账。
    throw new TimeoutError(`MCP 工具 "${label}" 调用超时（超过 ${timeoutMs}ms）`);
  }
  return out;
}

/**
 * 把一个 MCP server 的工具映射成框架的 `AgentTool[]`（可直接进 `tools` / providers）。
 *
 * - **名字**：`prefix + 归一化原名`；归一化后同名的两条直接抛错（否则装配期查重只会报
 *   「菜单能力重名」，看不出根因是 MCP 名撞了）；
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
    const cleaned = normalizeToolName(original);
    if (cleaned === '') {
      // 原名不含任何 ASCII 字母/数字/下划线（如 "🔥🔥"、"获取时间"）时归一化产物为空串 ——
      // 不拦下的话最终名只剩前缀也能注册成功，与「空名直接抛错」的承诺相反。
      // 必须在撞名检查之前抛出（裸前缀名还可能与下一个空名工具撞出误导性报错）。
      throw new Error(
        `MCP 工具名 ${JSON.stringify(original)} 归一化后为空（原名不含任何 ASCII 字母/数字/下划线）—— ` +
          '请在 server 侧改用可辨识的工具名，或检查其 tools/list 实现',
      );
    }
    const name = `${prefix}${cleaned}`;
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

    // 外部 server 的 tools/list 是**外部输入**：description 不是 string（数字/对象）时
    // 直接 `.trim()` 会让整个装配期崩 —— 与上面 name / inputSchema 的类型防御保持一致。
    const description = typeof info.description === 'string' ? info.description.trim() : '';
    tools.push({
      name,
      description: description || `MCP 工具 ${original}`,
      inputSchema: schema,
      run: async (input: unknown, ctx?: ToolRunContext) => {
        // 原名先落账再调用：连接器抛错/超时时，trace 里仍留得下「本想调谁」
        if (ctx) {
          try {
            // 两条键：`mcp.tool` 是「本次 turn 最近一次」的兼容键（既有看板/查询照旧）；
            // `mcp.tool.<菜单名>` 每次调用各写一条 —— 同回合并行调多个 MCP 工具时单值键会被
            // 后者覆盖，审计/回放就拿不回被覆盖那个（按菜单名分键即无此问题）。
            ctx.recorder.setAttribute(ctx.parentSpanId, 'mcp.tool', original);
            ctx.recorder.setAttribute(ctx.parentSpanId, `mcp.tool.${name}`, original);
          } catch {
            /* 观测是辅助动作：记账失败不得把一次正常调用变成失败 */
          }
        }
        const args =
          input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        // 裁判权（2026-09-17，见 spec §10 2026-09-17 ①）：引擎**表过态**时，桥不启动自己的计时器 ——
        // 两个计时器判同一件事，只会得到两种账（桥那份曾被记成 error(unknown)/errorKind=threw），
        // 而且桥的纯竞速还会把超了预算的调用记成成功。`timeoutMs` 退化为兜底（只在脱离引擎单用、
        // 或引擎压根没设 toolTimeoutMs 时生效）。
        //
        // 判据是 `!= null` 而**不是** `> 0`：`toolTimeoutMs: 0` 的文档语义是「引擎不设超时」，
        // 那同样是引擎的表态。用 `> 0` 的话，用户显式写下 0（不限），桥却自作主张判 60s ——
        // 与「一次调用只有一个裁判」相反：说了不限就该不限。
        const engineBudget = ctx?.toolTimeoutMs;
        if (engineBudget != null) {
          return client.callTool(original, args);
        }
        return withDeadline(client.callTool(original, args), timeoutMs, original);
      },
    });
  }

  return tools;
}
