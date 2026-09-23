/**
 * agentia dev 的本地 inspector 服务（node:http，零依赖）。
 *
 * 面板展示每次 run 的调用树：左边 run 列表、右边该 run 的能力执行
 * （tool / skill / prompt / subagent 的入参、出参、耗时、token、cache、错误）。
 *
 * trace 由框架侧的 TraceSink 经 `POST /ingest` 投递 —— 注册那一头在 **dev runner** 里
 * （`dev-runner.ts` 的 `registerTraceSink()`，从**用户项目**解析 `@migor/agentia` 并注册）。
 * ⚠️ 早先那套 `NODE_OPTIONS=--import` + `inspector-preload.ts` 已随「CLI 自己拥有子进程」
 * 一起删掉（理由见 dev.ts 文件头）—— 那个文件**不在仓库里**了，别再按它理解投递路径。
 * 本服务不认识框架类型：入参按结构面（TraceLike）校验，CLI 因此保持零运行时依赖。
 *
 * 服务同时是**面板 → dev 环**的入口（`POST /run`）：具体怎么驱动用户代码由 `dev.ts`
 * 经 `DevHooks` 注入 —— 本文件不认识子进程、不认识 tsx，只做 HTTP 与校验。
 *
 * ## 本文件管什么（2026-09-23 拆分后）
 *
 * **服务**：监听、三道鉴权闸、应答/请求原语（`json` / `text` / `readBody` /
 * `parseRunRequest`）、对外类型（`DevHooks` / `InspectorServer` / `TraceLike` /
 * `RunSummary`）、`HttpError`。**路由表不在这里** —— 已切到 `inspector-routes.ts`
 * （`handleRoutes`），理由与边界见那个文件的头注。
 *
 * ## 鉴权（D0）
 *
 * 两道，都零依赖：
 * 1. **`Origin` 校验**：缺省（同源导航 / 非浏览器客户端）或本机 origin 才放行。
 *    这半条挡的是「开发者访问的任意网页往本地端口发跨源请求」—— 跨源 `fetch`
 *    浏览器**必带** `Origin`。
 * 2. **per-session token**：`dev.ts` 启动时生成随机 token，嵌进面板 URL。校验覆盖
 *    **所有**接口（不只是写接口）—— 读接口（`/api/runs`、trace 内容）同样不该对
 *    本机任意网页开放，而校验成本为零。
 *
 * ⚠️ token 的真正作用**不是补 `Origin` 的漏**，而是挡「本机**其它已沦陷的进程**」——
 * 它们能直接 `curl`，没有 `Origin` 这个约束。写清这一点是为了避免后来者以为
 * 「`Origin` 没挡住，是 token 救的」而做出错误的加固取舍。
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  DevEvent,
  DevState,
  RunAck,
  RunNote,
  RunRequest,
  SessionMessageLike,
  TraceRecordEventLike,
} from './dev-protocol.js';
import {
  handleRoutes,
  type InspectorState,
  TOKEN_COOKIE,
  TOKEN_HEADER,
} from './inspector-routes.js';
import { rememberNote } from './panel-logic.js';

/** 与 @migor/agentia 的 Trace 结构兼容（CLI 不 import 框架包，故 duck-typed） */
export interface TraceLike {
  traceId: string;
  status?: string;
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  spans?: Array<{
    spanId: string;
    parentSpanId: string | null;
    kind: string;
    name: string;
    startedAt: number;
    endedAt?: number;
    status?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    /** run 根 span 上的 `session.id` / `config.*` 等（D6 的 join 键在这里） */
    attributes?: Record<string, unknown>;
  }>;
}

export interface RunSummary {
  traceId: string;
  status: string;
  name: string;
  startedAt: number;
  ms: number;
  tokens: number;
  ok: boolean;
  /**
   * run 根 span 的 `stop_reason`（`end_turn` / `aborted` / `budget_exceeded` / …）；
   * 老 trace 上没有这个 attribute 时为 null。
   *
   * 为什么必须带上它：`ok` **不足以**判失败 —— 引擎的 `abortedResult()` 刻意给已取消的
   * run 带结构化 error（取消不是失败，但原因要可查）⇒ 中止时 `ok === false`。
   * 两个消费方（run 列表的红点、对话视图的红边）都得先看 `stopReason`
   * （判别统一走 `panel-logic` 的 `runIsFailure`，与通知条同一条语义）。
   */
  stopReason: string | null;
  /**
   * run 根 span 的 `session.id`；没开会话的 run 为 null。
   * 这是 D6 那个 join 的**键**：把 run 列表与会话文件对上，才谈得上「失败轮标失败」。
   */
  sessionId: string | null;
  /** CLI 侧记账（只有 dev 环起的 run 才有）；不是 dev 起的 run 为 null */
  note: RunNote | null;
}

/**
 * `dev.ts` 注入的驱动钩子。没有它时本服务退化成**只读面板**（照旧收 trace、看调用树），
 * `POST /run` 回 503、`GET /api/dev` 回 `available: false` —— 面板据此不显示输入条
 * （不做空壳）。
 */
export interface DevHooks {
  state(): DevState;
  run(req: RunRequest): Promise<RunAck>;
  /** 读会话文件（对话视图）。`null` = 这个工程没配 session（面板不显示对话页签） */
  session(): Promise<{ messages: SessionMessageLike[] } | null>;
  /** 中止在飞 run（§6 待定 5 的 kill 按钮）。没有在飞的 run 时抛 409 */
  abort(): Promise<{ accepted: boolean; escalated: boolean }>;
  /** 清空对话 = 换 sessionId（§6 待定 3）。返回换到的那个 id */
  clearSession(): Promise<{ sessionId: string }>;
  /**
   * 拉起 OS 原生文件夹选择框（工作目录控件的「用系统选择器…」）。
   *
   * 选中回绝对路径、取消回 `null`；平台不支持 / 命令缺失抛 **501**、已有一个在等抛 **409**
   * （串行化在钩子里做）。没有面板侧超时 —— 用户可能慢慢选；进程退出由 dev.ts 收编子进程。
   */
  pickFolder(): Promise<string | null>;
  /**
   * 收掉在飞的原生选择框（客户端断开时由 `/api/fs/pick` 路由调用 —— 用户在等待期间
   * 刷新 / 关了标签页，选择框还挂在桌面上，不收掉的话之后每次点都 409）。
   */
  cancelPick?(): void;
  /**
   * 一条**在飞** run 的增量记账事件（① 实时右栏）：`POST /ingest-event` 收下就转给它。
   *
   * 同步、无返回值：框架派发事件本身就是同步的（不 await 订阅者），这里也只做「广播给 SSE」。
   * 与 `run` / `abort` 那些「面板让它做事」的钩子不同，这条是**观察**的回程。
   */
  traceEvent(e: TraceRecordEventLike): void;
}

export interface InspectorServer {
  port: number;
  close(): Promise<void>;
  /** dev 环事件广播（SSE **命名事件** `dev`，与 run 摘要的默认事件互不干扰） */
  emitDev(ev: DevEvent): void;
  /**
   * 给某条 run 记一笔 **CLI 侧记账**（目标目录 / 能力组合 / prompt）。
   *
   * 为什么不进 trace：`toolSources` 是数组、`workdir` 走 DI，两个都上不了
   * `runConfigSnapshot` 的标量表。而它们本来就是面板自己发出去的 ⇒ CLI 记一笔即可。
   * 记账按 `traceId` 存，可能与 trace 到达**乱序**（两条路都经进程内调用）⇒
   * 读的时候（`/api/runs`）再合并，不做顺序假设。
   */
  noteRun(traceId: string, note: RunNote): void;
}

/** 防 DNS rebinding：面板只服务本机，Host 不是 localhost/127.0.0.1/[::1] 的一律拒 */
function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/**
 * `Origin` 校验（D0 的第一道）。
 *
 * 缺省 = 放行：同源导航与**非浏览器客户端**（`curl`、runner 里 trace sink 的 `fetch`）
 * 都不带 `Origin`，把它们拦掉等于把 dev 环弄坏。带 `Origin` 的一定是浏览器跨源/同源请求
 * —— 那时只放行本机 origin。
 *
 * 注意 `Origin: null`（sandboxed iframe / file:// 页面）**不是**「缺省」：它是浏览器
 * 明确告诉我们「这是个不该被信任的上下文」，一律拒。
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** 定长比较：长度不同直接否（`timingSafeEqual` 对不等长会抛） */
function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** 环形缓冲上限：面板只保证「回看最近 N 条」，不做历史归档 */
const MAX_RUNS = 50;
/**
 * CLI 侧记账的上限。与 `MAX_RUNS` 同量级但**独立**：note 可能永远等不到它的 trace
 * （见 `rememberNote`），所以它有自己的一条淘汰线。
 */
const MAX_NOTES = MAX_RUNS;

/** 带 statusCode 的错误：让 handler 的 catch 回对应的码而不是一律 500 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 起 inspector 服务。缺省监听 127.0.0.1 的随机空闲端口（port 0），
 * 便于 dev 命令并发多开互不打架；实际端口经 resolve 的 port 返回。
 *
 * ⚠️ `token` 缺省 = **不校验 token**（`Origin` 那道仍然生效）。这条留给
 * 「程序内自用 / 测试」；`agentia dev` **一律传** —— 它是唯一会把这个端口
 * 印给用户、并让面板能驱动真 agent 的路径。别在 dev 那条路上省这个参数。
 */
export function startInspector(
  opts: { port?: number; host?: string; token?: string; dev?: DevHooks } = {},
): Promise<InspectorServer> {
  const host = opts.host ?? '127.0.0.1';
  // 环形缓冲 + SSE 订阅者。整体一个对象是为了**原样**交给路由层（`RouteCtx.state`），
  // 路由拿到的就是这里的引用 —— 两边看到的是同一份，不存在「路由改了服务不知道」。
  const state: InspectorState = {
    runs: new Map<string, TraceLike>(),
    order: [], // 到达顺序，用于淘汰与列表排序
    notes: new Map<string, RunNote>(), // CLI 侧记账（**有自己的上限**，见 rememberNote）
    clients: new Set<ServerResponse>(), // SSE 订阅者
  };
  const token = opts.token;

  const broadcast = (s: RunSummary): void => {
    const chunk = `data: ${JSON.stringify(s)}\n\n`;
    for (const c of state.clients) c.write(chunk);
  };

  /** 命名事件 `dev`：run 生命周期与 runner 状态 —— 面板靠它显示「在跑 / 失败 / 重启」 */
  const emitDev = (ev: DevEvent): void => {
    const chunk = `event: dev\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of state.clients) c.write(chunk);
  };

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  const text = (
    res: ServerResponse,
    code: number,
    type: string,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(code, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  };

  const readBody = (req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          const err = new HttpError(413, `请求 body 过大（上限 ${maxBytes} 字节）`);
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  /**
   * 校验 `RunRequest`：形状不对就 400，且说清是哪一项 —— 面板据此把原因显示给用户。
   *
   * 为什么留在本文件而不是随路由搬走：它要构造 `HttpError`，而 `HttpError` 定义在这里
   * （`dev.ts` 也从 `dist/inspector.js` 取它）。把它搬去 `inspector-routes.ts` 会让两个
   * 模块**互相 import 值** ⇒ 运行期成环。这条边界比「按职责归类」更重要。
   */
  const parseRunRequest = (raw: unknown): RunRequest => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'body 必须是对象');
    }
    const b = raw as Record<string, unknown>;
    if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
      throw new HttpError(400, 'prompt 必须是非空字符串');
    }
    if (b.workdir !== undefined && typeof b.workdir !== 'string') {
      throw new HttpError(400, 'workdir 必须是字符串');
    }
    if (b.multiTurn !== undefined && typeof b.multiTurn !== 'boolean') {
      throw new HttpError(400, 'multiTurn 必须是布尔值');
    }
    let toolSources: string[] | undefined;
    if (b.toolSources !== undefined) {
      if (!Array.isArray(b.toolSources) || b.toolSources.some((s) => typeof s !== 'string')) {
        throw new HttpError(400, 'toolSources 必须是字符串数组');
      }
      toolSources = b.toolSources as string[];
    }
    return {
      prompt: b.prompt,
      ...(b.workdir === undefined ? {} : { workdir: b.workdir as string }),
      ...(toolSources === undefined ? {} : { toolSources }),
      ...(b.multiTurn === undefined ? {} : { multiTurn: b.multiTurn as boolean }),
    };
  };

  // **每服务**一份的路由依赖（路由拿到的是这些引用本身）；每请求只叠 req/res/url/path/queryToken。
  const baseCtx = {
    dev: opts.dev,
    state,
    maxRuns: MAX_RUNS,
    token,
    json,
    text,
    readBody,
    parseRunRequest,
    broadcast,
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url || '/', `http://${host}`);
    const path = url.pathname;
    try {
      if (!isLocalHostHeader(req.headers.host)) {
        json(res, 403, { error: '仅允许本机访问（Host 须为 localhost / 127.0.0.1 / [::1]）' });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, {
          error: `Origin「${req.headers.origin}」不被允许（只接受本机 origin 或缺省）`,
        });
        return;
      }
      // token：URL query / 自定义头 / cookie 三选一（覆盖「面板首帧」与「脚本直连」两种用法）
      const queryToken = url.searchParams.get('t');
      const presented =
        queryToken ??
        (typeof req.headers[TOKEN_HEADER] === 'string' ? req.headers[TOKEN_HEADER] : null) ??
        cookieValue(req.headers.cookie, TOKEN_COOKIE);
      if (token !== undefined && (presented === null || !tokenEquals(presented, token))) {
        json(res, 403, {
          error:
            '缺少或错误的 dev token。请用 `agentia dev` 打印的带 ?t= 的完整 URL 打开面板' +
            '（token 会种进 cookie，之后刷新不带也行）',
        });
        return;
      }

      // 闸已过 ⇒ 交给路由表（它假定自己只在已放行的请求上被调用）
      await handleRoutes({ ...baseCtx, req, res, url, path, queryToken });
    } catch (e) {
      const status =
        e instanceof HttpError ? e.statusCode : ((e as { statusCode?: number }).statusCode ?? 500);
      json(res, status, { error: (e as Error).message });
    }
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  return new Promise<InspectorServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : (opts.port ?? 0);
      resolve({
        port,
        emitDev,
        noteRun: (traceId: string, note: RunNote) => {
          rememberNote(state.notes, traceId, note, MAX_NOTES);
        },
        close: () =>
          new Promise<void>((done) => {
            for (const c of state.clients) c.end();
            state.clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
