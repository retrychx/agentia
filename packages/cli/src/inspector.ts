/**
 * agentia dev 的本地 inspector 服务（node:http，零依赖）。
 *
 * 面板展示每次 run 的调用树：左边 run 列表、右边该 run 的单元执行
 * （tool / skill / prompt / subagent 的入参、出参、耗时、token、cache、错误）。
 *
 * trace 由框架侧的 TraceSink 经 `POST /ingest` 投递 —— 注入方式见 dev.ts
 * （NODE_OPTIONS=--import 拉起 inspector-preload，preload 从用户项目解析框架并注册 sink）。
 * 本服务不认识框架类型：入参按结构面（TraceLike）校验，CLI 因此保持零运行时依赖。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

export interface InspectorServer {
  port: number;
  close(): Promise<void>;
}

/** 环形缓冲上限：面板只保证「回看最近 N 条」，不做历史归档 */
const MAX_RUNS = 50;
/** 静态资源目录（构建期由 scripts/copy-assets.mjs 就位） */
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'inspector');
const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'inspector-page.html');
const STATIC = new Set(['index.js', 'view.js', 'fromTrace.js', 'trace-view.css']);

function summarize(t: TraceLike): RunSummary {
  const spans = t.spans || [];
  const root = spans.find((s) => s.kind === 'run') || spans[0];
  const startedAt = root ? root.startedAt : 0;
  const endedAt = root && root.endedAt != null ? root.endedAt : startedAt;
  const u = t.totalUsage || {};
  const status = t.status || (root && root.status) || 'ok';
  return {
    traceId: t.traceId,
    status,
    name: root ? root.name : 'run',
    startedAt,
    ms: endedAt - startedAt,
    tokens: (u.inputTokens || 0) + (u.outputTokens || 0),
    ok: status !== 'error',
  };
}

/**
 * 起 inspector 服务。缺省监听 127.0.0.1 的随机空闲端口（port 0），
 * 便于 dev 命令并发多开互不打架；实际端口经 resolve 的 port 返回。
 */
export function startInspector(opts: { port?: number; host?: string } = {}): Promise<InspectorServer> {
  const host = opts.host ?? '127.0.0.1';
  const runs = new Map<string, TraceLike>();
  const order: string[] = []; // 到达顺序，用于淘汰与列表排序
  const clients = new Set<ServerResponse>(); // SSE 订阅者

  const broadcast = (s: RunSummary): void => {
    const chunk = `data: ${JSON.stringify(s)}\n\n`;
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

  const text = (res: ServerResponse, code: number, type: string, body: string): void => {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const readBody = (req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          const err = new Error(`请求 body 过大（上限 ${maxBytes} 字节）`) as Error & { statusCode?: number };
          err.statusCode = 413; // 让 handler 的 catch 回 413 而非 500
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url || '/', `http://${host}`).pathname;
    try {
      if (req.method === 'POST' && path === '/ingest') {
        const trace = JSON.parse(await readBody(req)) as TraceLike;
        if (!trace || typeof trace.traceId !== 'string') {
          json(res, 400, { error: 'traceId 缺失' });
          return;
        }
        if (!runs.has(trace.traceId)) {
          order.push(trace.traceId);
          if (order.length > MAX_RUNS) runs.delete(order.shift() as string);
        }
        runs.set(trace.traceId, trace);
        broadcast(summarize(trace));
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && path === '/api/runs') {
        json(res, 200, order.slice().reverse().map((id) => summarize(runs.get(id) as TraceLike)));
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
        text(res, 200, 'text/html; charset=utf-8', await readFile(PAGE, 'utf8'));
        return;
      }

      if (req.method === 'GET' && STATIC.has(path.slice(1))) {
        const name = path.slice(1);
        const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        text(res, 200, type, await readFile(join(ASSETS, name), 'utf8'));
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
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
