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
import { readFile } from 'node:fs/promises';
import { type Dirent, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUDGET,
  type DevEvent,
  type DevState,
  type RunAck,
  type RunNote,
  type RunRequest,
  type SessionMessageLike,
  type TraceRecordEventLike,
} from './dev-protocol.js';
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

/** 入站校验：结构不符的 trace 直接拒（400），不让 NaN 之类的坏数据流进面板与 SSE 广播 */
function validateTrace(t: unknown): string | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'trace 必须是对象';
  const trace = t as TraceLike;
  if (typeof trace.traceId !== 'string' || trace.traceId.length === 0) return 'traceId 缺失';
  if (trace.spans !== undefined && !Array.isArray(trace.spans)) return 'spans 必须是数组';
  for (const s of trace.spans ?? []) {
    if (!s || typeof s !== 'object') return 'span 必须是对象';
    if (typeof s.spanId !== 'string' || s.spanId.length === 0) return 'span.spanId 缺失';
    if (typeof s.name !== 'string') return `span ${s.spanId} 缺 name`;
    if (typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)) {
      return `span ${s.spanId} 缺 startedAt（必须是有穷 number）`;
    }
    if (s.endedAt !== undefined && (typeof s.endedAt !== 'number' || !Number.isFinite(s.endedAt))) {
      return `span ${s.spanId} 的 endedAt 非法`;
    }
  }
  return null;
}

/**
 * 入站校验：**增量记账事件**的形状（`POST /ingest-event`，① 实时右栏）。
 *
 * 为什么卡得比 `validateTrace` 还细：面板拿这些字段**直接建树**，而坏帧的报错现场在
 * 浏览器里（最难查的地方）。缺一个 `spanId` 的表现是「树上少一个节点」而不是任何报错 ——
 * 所以宁可在这里响亮拒（400 会被 runner 的 event sink 静默吞掉，但至少不会污染面板）。
 */
function validateTraceEvent(e: unknown): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return '事件必须是对象';
  const ev = e as TraceRecordEventLike;
  if (typeof ev.seq !== 'number' || !Number.isFinite(ev.seq)) return 'seq 必须是有穷 number';
  switch (ev.type) {
    case 'span.begin': {
      const s = ev.span;
      if (!s || typeof s !== 'object') return 'span.begin 缺 span';
      if (typeof s.spanId !== 'string' || s.spanId.length === 0)
        return 'span.begin 的 span.spanId 缺失';
      if (typeof s.traceId !== 'string' || s.traceId.length === 0) {
        return 'span.begin 的 span.traceId 缺失';
      }
      if (typeof s.name !== 'string') return 'span.begin 的 span.name 缺失';
      if (typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)) {
        return 'span.begin 的 span.startedAt 非法';
      }
      return null;
    }
    case 'span.end': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0) return 'span.end 缺 spanId';
      if (typeof ev.endedAt !== 'number' || !Number.isFinite(ev.endedAt))
        return 'span.end 的 endedAt 非法';
      if (typeof ev.status !== 'string') return 'span.end 的 status 缺失';
      return null;
    }
    case 'span.event': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0) return 'span.event 缺 spanId';
      if (!ev.event || typeof ev.event.name !== 'string') return 'span.event 缺 event.name';
      return null;
    }
    case 'span.attribute': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0)
        return 'span.attribute 缺 spanId';
      if (typeof ev.key !== 'string' || ev.key.length === 0) return 'span.attribute 缺 key';
      return null;
    }
    case 'span.link': {
      if (typeof ev.spanId !== 'string' || ev.spanId.length === 0) return 'span.link 缺 spanId';
      return null;
    }
    default:
      return `不认识的事件类型：${String((ev as { type?: unknown }).type)}`;
  }
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
 * 缺省 = 放行：同源导航与**非浏览器客户端**（`curl`、preload 的 `fetch`）都不带
 * `Origin`，把它们拦掉等于把 dev 环弄坏。带 `Origin` 的一定是浏览器跨源/同源请求
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

/** token 的 cookie 名（面板首帧带 `?t=` 拿到它之后，后续请求自动带上） */
const TOKEN_COOKIE = 'agentia_dev_token';
/** token 的自定义头名（非浏览器客户端 / 脚本用；不进 URL、不留痕） */
const TOKEN_HEADER = 'x-agentia-token';

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

/**
 * 目录判定要**解引用软链**：pnpm store / monorepo 里 `src/tools/foo` 常是软链，
 * 它的 `isDirectory()` 为 false —— 直接用会把真目录静默漏掉（discover.ts 同一条教训）。
 */
function isDirLikeEntry(full: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/** 环形缓冲上限：面板只保证「回看最近 N 条」，不做历史归档 */
const MAX_RUNS = 50;
/**
 * CLI 侧记账的上限。与 `MAX_RUNS` 同量级但**独立**：note 可能永远等不到它的 trace
 * （见 `rememberNote`），所以它有自己的一条淘汰线。
 */
const MAX_NOTES = MAX_RUNS;
/**
 * `GET /api/fs` 一次最多回多少个**文件**名（目录不设限：一个位置要列几百个目录，本身就
 * 说明位置选错了）。超限回 `filesTruncated: true` —— 截断必须**明示**，不许静默少给。
 */
const FILE_LIMIT = 200;
/** 静态资源目录（构建期由 scripts/copy-assets.mjs 就位） */
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, 'inspector');
const PAGE = join(HERE, 'inspector-page.html');
/**
 * 静态资源白名单：**只有这里列出的名字**能被读出来。
 *
 * `panel-logic.js` 是 CLI 自己编译出来的模块（面板纯逻辑，单测直接 import 它），
 * 落在 dist 根而不是 dist/inspector/ —— 与 `inspector-page.html` 同处一层。
 */
const STATIC = new Map<string, string>([
  ['index.js', join(ASSETS, 'index.js')],
  ['view.js', join(ASSETS, 'view.js')],
  ['fromTrace.js', join(ASSETS, 'fromTrace.js')],
  ['summary.js', join(ASSETS, 'summary.js')],
  ['trace-view.css', join(ASSETS, 'trace-view.css')],
  ['panel-logic.js', join(HERE, 'panel-logic.js')],
  // 面板的 Markdown 解析器（零依赖、按构造不产生 HTML —— 见 src/markdown.ts 的头注）。
  // 与 panel-logic.js 同处 dist 根：两个都是 CLI 自己编译出来的模块，单测直接 import 它们。
  ['markdown.js', join(HERE, 'markdown.js')],
]);

/** 没有 dev 钩子时的状态（面板据此隐藏输入条） */
function unavailableDevState(): DevState {
  return {
    available: false,
    projectRoot: '',
    home: '',
    capabilities: [],
    multiTurn: [],
    warning: null,
    defaultWorkdir: '',
    budget: { ...DEFAULT_BUDGET },
    running: false,
    lastError: null,
    // 没有 dev 环 ⇒ 没有会话可谈（面板只在 available 时才读它）
    sessionId: '',
  };
}

function summarize(t: TraceLike, note: RunNote | null): RunSummary {
  const spans = t.spans || [];
  const root = spans.find((s) => s.kind === 'run') || spans[0];
  const startedAt = root ? root.startedAt : 0;
  const endedAt = root && root.endedAt != null ? root.endedAt : startedAt;
  const u = t.totalUsage || {};
  const status = t.status || root?.status || 'ok';
  const sid = root?.attributes?.['session.id'];
  // 收尾原因由引擎写在 run 根 span 的 `stop_reason` 上（`engine/loop.ts` 的
  // `recorder.setAttribute(rootId, 'stop_reason', …)`）—— 面板判中止**必须**看它，
  // 因为 `aborted` 的 `ok` 也是 false（见 `RunSummary.stopReason`）
  const sr = root?.attributes?.stop_reason;
  return {
    traceId: t.traceId,
    status,
    name: root ? root.name : 'run',
    startedAt,
    ms: endedAt - startedAt,
    tokens: (u.inputTokens || 0) + (u.outputTokens || 0),
    ok: status !== 'error',
    stopReason: typeof sr === 'string' && sr.length > 0 ? sr : null,
    sessionId: typeof sid === 'string' && sid.length > 0 ? sid : null,
    note,
  };
}

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
  const runs = new Map<string, TraceLike>();
  const order: string[] = []; // 到达顺序，用于淘汰与列表排序
  const notes = new Map<string, RunNote>(); // CLI 侧记账（**有自己的上限**，见 rememberNote）
  const clients = new Set<ServerResponse>(); // SSE 订阅者
  const token = opts.token;

  const broadcast = (s: RunSummary): void => {
    const chunk = `data: ${JSON.stringify(s)}\n\n`;
    for (const c of clients) c.write(chunk);
  };

  /** 命名事件 `dev`：run 生命周期与 runner 状态 —— 面板靠它显示「在跑 / 失败 / 重启」 */
  const emitDev = (ev: DevEvent): void => {
    const chunk = `event: dev\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(chunk);
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

  /** 校验 `RunRequest`：形状不对就 400，且说清是哪一项 —— 面板据此把原因显示给用户 */
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

      if (req.method === 'POST' && path === '/ingest') {
        const body = await readBody(req); // 超 413 走外层 catch
        let trace: unknown;
        try {
          trace = JSON.parse(body);
        } catch {
          json(res, 400, { error: 'body 不是合法 JSON' });
          return;
        }
        const problem = validateTrace(trace);
        if (problem) {
          json(res, 400, { error: problem });
          return;
        }
        const valid = trace as TraceLike;
        if (!runs.has(valid.traceId)) {
          order.push(valid.traceId);
          if (order.length > MAX_RUNS) {
            const evicted = order.shift() as string;
            runs.delete(evicted);
            notes.delete(evicted);
          }
        }
        runs.set(valid.traceId, valid);
        broadcast(summarize(valid, notes.get(valid.traceId) ?? null));
        json(res, 200, { ok: true });
        return;
      }

      /**
       * **在飞 run 的增量记账事件**（① 实时右栏）：`POST /ingest-event`。
       *
       * 与 `POST /ingest` 的分工是刻意的两条缝（框架侧同名区分）：
       * - 这条 = **此刻看到**：高频、逐笔、不落库、**不保证送达**；
       * - 那条 = **最终账**：收尾一次、进 run 列表、被 `/api/runs` 读。
       *
       * 所以这里**只广播**、不建 run 记录：面板拿它把树「长」出来，收尾那份整棵 trace
       * 回来时覆盖（`open()` 的渲染永远以收尾那份为准）。
       *
       * 202 而不是 200：已经广播出去了，但面板收没收到不归这里管（SSE 是单向流）。
       * 没有 dev 钩子时回 503 —— 与 `/run` / `/run/abort` 同一口径（没有面板消费它）。
       */
      if (req.method === 'POST' && path === '/ingest-event') {
        if (!opts.dev) {
          json(res, 503, { error: '这个 inspector 不是 agentia dev 起的（没有 runner）' });
          return;
        }
        const body = await readBody(req);
        let ev: unknown;
        try {
          ev = JSON.parse(body);
        } catch {
          json(res, 400, { error: 'body 不是合法 JSON' });
          return;
        }
        const problem = validateTraceEvent(ev);
        if (problem) {
          json(res, 400, { error: problem });
          return;
        }
        opts.dev.traceEvent(ev as TraceRecordEventLike);
        json(res, 202, { ok: true });
        return;
      }

      if (req.method === 'GET' && path === '/api/runs') {
        json(
          res,
          200,
          order
            .slice()
            .reverse()
            .map((id) => summarize(runs.get(id) as TraceLike, notes.get(id) ?? null)),
        );
        return;
      }

      if (req.method === 'GET' && path.startsWith('/api/runs/')) {
        const id = decodeURIComponent(path.slice('/api/runs/'.length));
        const t = runs.get(id);
        if (!t) {
          json(res, 404, { error: 'run 不存在（可能已被淘汰）' });
          return;
        }
        json(res, 200, t);
        return;
      }

      if (req.method === 'GET' && path === '/api/dev') {
        json(res, 200, opts.dev ? opts.dev.state() : unavailableDevState());
        return;
      }

      /**
       * 目录浏览器：`GET /api/fs?path=<绝对路径>` →
       * `{ path, parent, dirs, dotDirs, files, filesTruncated }`。
       *
       * 为什么需要它：浏览器**拿不到**用户选的文件夹的绝对路径 —— `<input webkitdirectory>`
       * 只给相对路径，File System Access API 只给 handle.name。而 dev 环要的是绝对路径
       * （工具按它解析）。⇒ 要么让用户手打路径，要么服务端列目录。后者才是「工作目录是
       * 主控件」（D3/D7）该有的手感。
       *
       * 三条口径（2026-09-22 复核后改，前两条是实测出来的缺口）：
       * - **文件也列**（`files`，只给名字、不读内容）：面板据此提供「选这个文件」——
       *   工作目录取它所在目录、prompt 空时填文件名。只列目录时，「让 agent 看某个文件」
       *   只能靠用户自己把文件名打进 prompt。
       * - **隐藏目录单列**（`dotDirs`，不在 `dirs` 里）：以前一批过滤掉，于是
       *   `~/xxx/.yyy` 这类目录**根本点不进去**（`..` 只能退到它上面，进不去）。
       *   单列是为了不把 `.git` / `.cache` 混进正常浏览，同时保证**可达**。
       * - `files` 有上限（`FILE_LIMIT`）并回 `filesTruncated`：一次列几千个文件的名
       *   没有意义，但**必须明示**截断（本仓纪律：不许静默少给）。
       *
       * 只列名字、**不读文件内容**；且只在 dev 钩子在场时开放（只读面板不暴露文件树）。
       * 越界不是威胁（本机 dev 工具，token 已经挡住了其它进程），但**不存在 / 不是目录**
       * 要响亮报错 —— 静默回退到项目根会让 agent 对着错的目录乱写（D5）。
       */
      if (req.method === 'GET' && path === '/api/fs') {
        if (!opts.dev) {
          json(res, 403, { error: '这个 inspector 不是 agentia dev 起的，不提供目录浏览' });
          return;
        }
        const target = url.searchParams.get('path');
        if (!target) {
          json(res, 400, { error: '缺少 path 参数' });
          return;
        }
        const abs = resolve(target);
        let entries: Dirent[];
        try {
          if (!statSync(abs).isDirectory()) {
            json(res, 400, { error: `不是文件夹：${abs}` });
            return;
          }
          entries = readdirSync(abs, { withFileTypes: true });
        } catch (e) {
          json(res, 400, { error: `读不了这个目录：${(e as Error).message}` });
          return;
        }
        const dirs: string[] = [];
        const dotDirs: string[] = [];
        const files: string[] = [];
        for (const e of entries) {
          if (isDirLikeEntry(join(abs, e.name), e)) {
            (e.name.startsWith('.') ? dotDirs : dirs).push(e.name);
            continue;
          }
          // 读不了内容的条目（管道 / socket / 权限）也当文件列出来 —— 列名字不需要读它
          if (!e.name.startsWith('.')) files.push(e.name);
        }
        json(res, 200, {
          path: abs,
          parent: dirname(abs),
          dirs: dirs.sort(),
          dotDirs: dotDirs.sort(),
          files: files.sort().slice(0, FILE_LIMIT),
          filesTruncated: files.length > FILE_LIMIT,
        });
        return;
      }

      if (req.method === 'POST' && path === '/run') {
        if (!opts.dev) {
          json(res, 503, {
            error: '这个 inspector 不是 agentia dev 起的（没有 runner），不能驱动 run',
          });
          return;
        }
        const body = await readBody(req);
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          json(res, 400, { error: 'body 不是合法 JSON' });
          return;
        }
        const ack = await opts.dev.run(parseRunRequest(raw));
        json(res, 202, ack);
        return;
      }

      if (req.method === 'POST' && path === '/run/abort') {
        if (!opts.dev) {
          json(res, 503, { error: '这个 inspector 不是 agentia dev 起的（没有 runner）' });
          return;
        }
        // 202 而不是 200：中止是**请求已受理**，run 真正收尾要走 SSE 的 `run-done`
        // （优雅路径要在回合边界才生效，不是同步的）。
        json(res, 202, await opts.dev.abort());
        return;
      }

      if (req.method === 'POST' && path === '/session/clear') {
        if (!opts.dev) {
          json(res, 503, { error: '这个 inspector 不是 agentia dev 起的（没有 runner）' });
          return;
        }
        json(res, 200, await opts.dev.clearSession());
        return;
      }

      if (req.method === 'GET' && path === '/api/session') {
        if (!opts.dev) {
          json(res, 200, { session: null });
          return;
        }
        json(res, 200, { session: await opts.dev.session() });
        return;
      }

      if (req.method === 'GET' && path === '/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        // 首帧带了合法 token ⇒ 种进 cookie（SameSite=Strict + HttpOnly）：
        // 之后面板自己的 fetch / EventSource 自动带上，token 不进 URL 历史、不进截图。
        const headers: Record<string, string> =
          token !== undefined && queryToken !== null
            ? { 'set-cookie': `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` }
            : {};
        text(res, 200, 'text/html; charset=utf-8', await readFile(PAGE, 'utf8'), headers);
        return;
      }

      if (req.method === 'GET' && STATIC.has(path.slice(1))) {
        const name = path.slice(1);
        const type = name.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/javascript; charset=utf-8';
        text(res, 200, type, await readFile(STATIC.get(name) as string, 'utf8'));
        return;
      }

      json(res, 404, { error: 'not found' });
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
          rememberNote(notes, traceId, note, MAX_NOTES);
        },
        close: () =>
          new Promise<void>((done) => {
            for (const c of clients) c.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
