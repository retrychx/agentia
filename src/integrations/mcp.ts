import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { TIMED_OUT, TimeoutError, withTimeout } from '../core/timeout.js';
import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import type { AgentTool, JsonSchema, ToolRunContext } from '../core/tool.js';

/**
 * Agentia —— MCP 桥（D1）+ 两个内置连接器（spec §10 决策记录）。
 *
 * **桥**：框架只定义**结构面** —— 不 import `@modelcontextprotocol/sdk`，任何实现了
 * `McpClientLike` 的客户端都能接（同 `RedisLike` 的 duck-typing）。本文件只依赖 core，
 * 符合分层约定（`integrations` → `core`）。
 *
 * **连接器**（2026-09-18 起**内置**，见文件末「连接器」一节与 spec §10 同日条）：
 * `createStdioMcpConnector` / `createStreamableHttpMcpConnector`。二者只用标准库
 * （`node:child_process` + 全局 `fetch`），**不新增任何第三方依赖**。
 *
 * 用法（接入点是 `AppOptions.tools` 这条**裸工具缝**）：
 * ```ts
 * const mcp = createStdioMcpConnector(['uvx', 'mcp-server-time']);
 * createApp({ system: '…', tools: await mcpTools(mcp, { server: 'time' }) });
 * ```
 * ⚠️ **不是** `providers: [{ provide: 'mcp', useFactory: … }]` —— 那条路落地时不成立
 * （菜单只从装饰器注册表收集，`useFactory` 的返回值根本不进菜单；见 spec §10 2026-09-11）。
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
          // 引擎是裁判：它的 toolTimeoutMs 到点会 fire ctx.abandoned —— 连接器据此
          // 清掉这次调用的簿记（stdio 的 pending 条目），不留下等不到回收的残骸。
          return client.callTool(
            original,
            args,
            ctx?.abandoned !== undefined ? { abandoned: ctx.abandoned } : undefined,
          );
        }
        // 桥兜底裁判（脱离引擎单用 / 引擎没设超时）：到点除了放弃等待，还要通知连接器
        // 清理簿记 —— 与引擎路径共用同一个 `abandoned` 缝（`core/abort.ts` 合成）。
        const ac = new AbortController();
        const abandoned =
          ctx?.abandoned !== undefined ? combineSignals(ctx.abandoned, ac.signal) : ac.signal;
        try {
          return await withDeadline(
            client.callTool(original, args, { abandoned }),
            timeoutMs,
            original,
          );
        } finally {
          ac.abort(); // 无论成败都摘掉：成功时条目已被响应清掉，超时/出错时靠这次 abort 清
          releaseCombinedSignal(abandoned); // 摘除挂在 ctx.abandoned 上的监听器
        }
      },
    });
  }

  return tools;
}

/* ═══════════════════════════ 连接器（内置默认件） ═══════════════════════════
 *
 * 2026-09-18 决策（spec §10 同日条）：连接器从「独立可选包 `@migor/mcp`」改为**内置**。
 * 判据是仓库自己的两份先例（`store/` 的三层形状）：
 *
 *   - 只用**标准库**的平台能力 → 直接内置在 `src/`
 *     （`transport/http.ts` 的 `node:http`、`store/sqliteStore.ts` 的 `node:sqlite`、
 *      `runtime/context.ts` 的 `node:async_hooks`、`engine/tracer.ts` 的 `node:crypto`）；
 *   - 需要**第三方客户端** → 只留 duck-typed 缝、框架永不 import
 *     （`store/redisStore.ts` 的 `RedisLike`，以及本文件的 `McpClientLike`）。
 *
 * `spawn`（`node:child_process`）与 `fetch`（Node 18+ 全局）都是标准库 ⇒ 内置**不增加**
 * 任何第三方依赖。「零运行时依赖」那条口径（= 不依赖第三方包，见 `package.json` 三个依赖
 * 字段全空）不受影响 —— 它从来不是「不 import node 内建」的意思，`node:http` 一直在用。
 *
 * 结构面**不变**：`McpClientLike` 仍是最小缝，用户照旧可以接官方 SDK / 远程 server /
 * 自研传输。这里给出的只是**默认件** —— 与 `FileTaskStore` / `SqliteTaskStore` 之于
 * `TaskStore` 完全同构（默认件内置 + 缝保留 + 特殊后端仍由用户带 client）。
 */

/**
 * 连接器公共面：`McpClientLike` + 一个关闭句柄（两个内置连接器都返回它）。
 *
 * 缝的形状没有变化 —— 需要自己的传输（官方 SDK / 远程 server / 复用长连接）时，
 * 实现 `McpClientLike` 两个方法即可，不必碰这里。
 */
export interface McpConnector extends McpClientLike {
  /**
   * 释放底层资源，**幂等**；stdio 侧**保证返回时子进程已终止**：
   * 先 SIGTERM，宽限期（{@link MCP_CLOSE_GRACE_MS}）后 SIGKILL，然后**等真正的 `'exit'`**
   * （2026-09-18 收紧：此前到点即返回、不等 reap，会留下孤儿进程而调用方无从知晓）。
   * HTTP 侧 = 尽力 `DELETE` 终止会话（server 不认也无所谓，失败不抛）。
   *
   * 关闭后再调用 `listTools` / `callTool` 会抛出可读错误（不静默挂死）。
   */
  close(): Promise<void>;
}

/** `close()` 里 SIGTERM → SIGKILL 的宽限期（毫秒） */
export const MCP_CLOSE_GRACE_MS = 2_000;

/**
 * 缺省 `clientInfo`（`initialize` 握手要发，协议要求该字段存在）。
 *
 * **刻意不写框架自身版本**：`integrations` 层不 import 公共面（`AGENTIA_VERSION` 在
 * `src/index.ts`），且 `scripts/release-surface.mjs` 的发版面按**精确版本串**计数 ——
 * 这里多一处版本字面量会让它的 count 断言失配。需要真实版本请自行传 `clientInfo`。
 */
const DEFAULT_CLIENT_INFO: { name: string; version: string } = {
  name: 'agentia',
  version: '0.0.0',
};

/** `initialize` 缺省请求的协议版本（e2e 已验证的版本；要对齐新版 server 请显式传） */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/**
 * 装配期超时的落点：**握手 + `tools/list`**。
 *
 * 为什么不给 `callTool` 也套一个：一次调用只有一个裁判（见 `McpToolsOptions.timeoutMs`）。
 * 走 `mcpTools` 时 `callTool` 由引擎 / 桥判定；而握手与 `tools/list` 发生在**装配期**，
 * 没有任何别的裁判 —— server 卡住会让 `createApp` 永久挂起，必须在这里兜住。
 */
type Guard = <T>(p: Promise<T>, label: string) => Promise<T>;

/** 把可能很大的值截成可读片段（错误消息要能进日志，不能是一兆的 JSON） */
function brief(value: unknown, max = 200): string {
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
function jsonRpcError(err: unknown): Error {
  if (typeof err === 'object' && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    return new Error(`MCP error ${String(code)}: ${String(message)}`);
  }
  return new Error(`MCP error: ${brief(err)}`);
}

/** server 混进 stdout / SSE 的非 JSON 行 */
function isJsonRpcResponse(msg: unknown): msg is { id: number; result?: unknown; error?: unknown } {
  return (
    typeof msg === 'object' && msg !== null && typeof (msg as { id?: unknown }).id === 'number'
  );
}

/** 从一条已解析的报文里取结果；带 `error` 则抛 */
function unwrap(msg: { result?: unknown; error?: unknown }, method: string): unknown {
  if (msg.error !== undefined) throw jsonRpcError(msg.error);
  if (!('result' in msg)) throw new Error(`MCP ${method}：响应里既没有 result 也没有 error`);
  return msg.result;
}

export interface StdioMcpConnectorOptions {
  /** 追加 / 覆盖的环境变量（缺省继承 `process.env`） */
  env?: Record<string, string>;
  /** 子进程工作目录 */
  cwd?: string;
  /** 子进程 stderr 去向：`'inherit'`（缺省，server 日志直通终端）| `'ignore'` */
  stderr?: 'inherit' | 'ignore';
  /** 见 {@link DEFAULT_CLIENT_INFO} */
  clientInfo?: { name: string; version: string };
  /** 请求的协议版本，缺省 `'2024-11-05'` */
  protocolVersion?: string;
  /**
   * 装配期超时（毫秒）—— 只作用于**握手 + `tools/list`**，缺省
   * {@link MCP_DEFAULT_TIMEOUT_MS}；非正数 = 不限。语义见 {@link Guard}。
   *
   * 超时同样只是一类账（`code='timeout'`）：**不终止子进程**，与仓库其余「等待的终点」
   * 一致（超时 = 放弃等待）。
   */
  timeoutMs?: number;
}

/**
 * **stdio 连接器**：spawn 一个 MCP server 子进程，走换行分隔的 JSON-RPC 2.0
 * （`initialize` → `notifications/initialized` → `tools/list` / `tools/call`）。
 *
 * 进程与握手都是**惰性**的 —— 构造不产生副作用，第一次 `listTools` / `callTool` 才 spawn；
 * 握手只做一次（并发调用共享同一次握手）。
 *
 * 三处非显然的坑，这里都兜住了（此前 `scripts/e2e-mcp.ts` 内联的那 94 行踩过）：
 * 1. spawn **失败**（命令不存在 → `ENOENT`）是异步的 `'error'` 事件，不是抛出 ——
 *    没有监听器就是未捕获异常、直接把宿主进程带崩，所以必须接住并拒绝在途请求；
 * 2. 分帧：一条报文可能跨多个 chunk，必须自己攒 buffer 按 `\n` 切；
 * 3. **协议层 `isError: true` 必须转成抛错** —— 否则模型收到一条「成功」的结果，
 *    trace 也把它记成成功的调用（`McpClientLike` 的约定，见其注释）。
 */
export function createStdioMcpConnector(
  cmd: readonly string[],
  opts: StdioMcpConnectorOptions = {},
): McpConnector {
  const bin = cmd[0];
  if (typeof bin !== 'string' || bin === '') {
    throw new Error('createStdioMcpConnector：cmd 不能为空（需要可执行文件 + 参数）');
  }
  const rest = cmd.slice(1);
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;
  const protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  let proc: ChildProcess | null = null;
  let fatal: Error | null = null;
  let closed = false;
  let exited = false;
  let buf = '';
  let nextId = 1;
  let ready: Promise<void> | null = null;
  let resolveExit: (() => void) | null = null;
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r;
  });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const markExited = (): void => {
    exited = true;
    resolveExit?.();
  };

  /** 进程已死 / 已 close 时一次性拒绝全部在途请求 —— 不留永久挂起的 promise */
  const fail = (err: Error): void => {
    fatal = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const guard: Guard = (p, label) => withDeadline(p, timeoutMs, label);

  const ensureProc = (): ChildProcess => {
    if (closed) throw new Error('MCP 连接器已 close —— 请重新创建一个');
    if (fatal) throw fatal;
    if (proc) return proc;

    const spawnOpts: SpawnOptions = {
      stdio: ['pipe', 'pipe', opts.stderr ?? 'inherit'],
      // exactOptionalPropertyTypes：可选字段不能赋 undefined，只能条件展开
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    const p = spawn(bin, rest, spawnOpts);
    proc = p;

    p.on('error', (err: unknown) => {
      // 见函数头第 1 条：这个监听器不是可选的
      fail(err instanceof Error ? err : new Error(String(err)));
      markExited();
    });
    p.on('exit', (code, signal) => {
      if (!closed) {
        fail(
          new Error(`MCP server 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`),
        );
      }
      markExited();
    });
    // 'exit' 在 spawn 失败时可能不触发，'close' 一定会 —— close() 靠它才不会白等
    p.on('close', markExited);
    // 进程已死时写 stdin 会异步报 EPIPE；真实原因由上面的 'error' / 'exit' 给出
    p.stdin?.on('error', () => {
      /* 吞掉：EPIPE 是「进程没了」的次生现象，不是根因 */
    });

    p.stdout?.setEncoding('utf8');
    p.stdout?.on('data', (chunk: string) => {
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
          continue; // MCP 规定 stdout 只走协议，但 server 混日志进来是常事
        }
        if (!isJsonRpcResponse(msg)) continue; // 通知（无 id）不配对
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        pending.delete(msg.id);
        try {
          waiter.resolve(unwrap(msg, 'response'));
        } catch (e) {
          waiter.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    return p;
  };

  const write = (payload: unknown): void => {
    const p = ensureProc();
    p.stdin?.write(`${JSON.stringify(payload)}\n`);
  };

  const send = (method: string, params: unknown, abandoned?: AbortSignal): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('MCP 连接器已 close —— 请重新创建一个'));
    if (fatal) return Promise.reject(fatal);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      try {
        ensureProc();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      pending.set(id, { resolve, reject });
      // 裁判放弃等待 ≠ 条目自动回收：超时的调用（引擎 toolTimeoutMs 或桥兜底）只是
      // 不再 await，pending 里的 {resolve,reject} 会留到「server 终于回包 / 进程死 /
      // close」—— 对「活着但不回包」的 server 就是无界泄漏。裁判表过态就删条目：
      // 之后回包到了也没人等（:441 的 pending.get 落空即忽略，语义安全）。
      if (abandoned !== undefined) {
        const drop = (): void => {
          pending.delete(id);
        };
        if (abandoned.aborted) drop();
        else abandoned.addEventListener('abort', drop, { once: true });
      }
      write({ jsonrpc: '2.0', id, method, params });
    });
  };

  /** 握手只做一次；失败是**粘性**的（连接器已不可用 → 重建，而不是半初始化态） */
  const ensureReady = (): Promise<void> => {
    if (ready) return ready;
    ready = (async () => {
      const init = await guard(
        send('initialize', { protocolVersion, capabilities: {}, clientInfo }),
        'initialize',
      );
      // 协商结果以 server 回的那个为准（协议允许 server 降级或选自己的版本）
      void init;
      write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    })();
    return ready;
  };

  const request = async (
    method: string,
    params: unknown,
    abandoned?: AbortSignal,
  ): Promise<unknown> => {
    await ensureReady();
    return send(method, params, abandoned);
  };

  const listTools = async (): Promise<McpToolInfo[]> => {
    const r = await guard(request('tools/list', {}), 'tools/list');
    if (typeof r !== 'object' || r === null) {
      throw new Error(`MCP tools/list 返回了非对象：${brief(r)}`);
    }
    const listed = (r as { tools?: unknown }).tools;
    if (listed === undefined) return [];
    if (!Array.isArray(listed)) {
      // 响亮失败：把协议不符吞成空菜单，用户看到的是「一个工具都没有」而不是「server 坏了」
      throw new Error(`MCP tools/list 的 tools 不是数组：${brief(listed)}`);
    }
    return listed as McpToolInfo[];
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    callOpts?: { abandoned?: AbortSignal },
  ): Promise<unknown> => {
    const r = await request('tools/call', { name, arguments: args }, callOpts?.abandoned);
    // 承重：协议层 isError 只有连接器看得见（见函数头第 3 条）
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
      fail(new Error('MCP 连接器已 close —— 请重新创建一个'));
      const p = proc;
      proc = null;
      if (!p) return;
      p.kill('SIGTERM');
      if (exited) return;
      const killTimer = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* 已经死了 */
        }
        // ⚠️ 这里**不** resolve：SIGKILL 不可被捕获，'exit'/'close' 必达 —— 继续等真的退出。
        // 到点即返回是 2026-09-18 之前的行为：调用方以为进程没了，实际还留着一个孤儿。
      }, MCP_CLOSE_GRACE_MS);
      try {
        await exitPromise;
      } finally {
        clearTimeout(killTimer);
      }
    },
  };
}

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
