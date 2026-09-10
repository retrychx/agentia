import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpanError, Trace } from '../core/trace.js';
import type { AgentStopReason } from '../engine/types.js';
import { AsyncRunner } from './async.js';
import type { AppCallable } from './async.js';
import { normalizeMessages } from './spec.js';
import type { RunInvocationOptions } from './spec.js';
import type { TaskRecord } from './store.js';
import type { RunStatus } from './types.js';

/**
 * Agentia —— HTTP 宿主（spec §6.6：换宿主不换语义，roadmap R3）。
 *
 * 只产出一个 (req, res) handler，不做 listen —— 交给用户
 * `http.createServer(createHttpHandler(app)).listen(...)`，可挂进任意 Node HTTP 框架。
 *
 * 端点契约（全部 JSON）：
 * - POST /run        同步 RPC。body = RunInput（string / messages / {prompt|text|messages}），
 *                    走 normalizeMessages 规整后同步执行；200 { runId, status, stopReason,
 *                    finalText, typed?, trace, error? }。status=failed 也照返 200
 *                    （rethrow:false 语义：硬失败以 error 字段返回，不用 HTTP 错误码表达）；
 *                    输入无法规整为 messages → 400 { error }。
 * - POST /tasks      异步任务。body { input, idempotencyKey?, options? } →
 *                    AsyncRunner.submit → 202 TaskRecord（queued，幂等键去重照常生效）。
 * - GET  /tasks/<id> 轮询任务记录 → 200 TaskRecord；不存在 → 404。
 *
 * 方法不符 405；路径不符 404；body 非法 JSON 400。runner 缺省内部 new AsyncRunner(app)。
 */

/** POST /run 的响应形态 */
export interface RunHttpResponse {
  runId: string;
  status: RunStatus;
  stopReason: AgentStopReason;
  finalText: string;
  /** 结构化结果（R2 起应用可携带；无则省略） */
  typed?: unknown;
  trace: Trace;
  error?: SpanError;
}

/** POST /tasks 的请求体形态 */
export interface TaskSubmitBody {
  input: unknown;
  idempotencyKey?: string;
  options?: RunInvocationOptions;
}

export interface HttpHandlerOptions {
  /** 异步任务宿主；缺省 new AsyncRunner(app)（InMemoryTaskStore） */
  runner?: AsyncRunner;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createHttpHandler(
  app: AppCallable,
  opts: HttpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const runner = opts.runner ?? new AsyncRunner(app);

  return async (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = (req.url ?? '/').split('?')[0];

    try {
      if (pathname === '/run') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: `method ${method} not allowed, use POST` });
          return;
        }
        const input = await parseJsonBody(req, res);
        if (input === PARSE_FAILED) return;
        let messages;
        try {
          messages = normalizeMessages(input);
        } catch (e) {
          sendJson(res, 400, { error: errMessage(e) });
          return;
        }
        // rethrow:false —— 与 AsyncRunner 对齐：硬失败也以 status/error 字段返回 200
        const out = await app.run(messages, { rethrow: false });
        const body: RunHttpResponse = {
          runId: out.run.runId,
          status: out.run.status,
          stopReason: out.result.stopReason,
          finalText: out.result.finalText,
          typed: (out.result as { typed?: unknown }).typed,
          trace: out.result.trace,
          error: out.result.error,
        };
        sendJson(res, 200, body);
        return;
      }

      if (pathname === '/tasks') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: `method ${method} not allowed, use POST` });
          return;
        }
        const body = await parseJsonBody(req, res);
        if (body === PARSE_FAILED) return;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body 需为 { input, idempotencyKey?, options? }' });
          return;
        }
        const submitBody = body as TaskSubmitBody;
        let rec: TaskRecord;
        try {
          rec = runner.submit(submitBody.input, {
            idempotencyKey: submitBody.idempotencyKey,
            options: submitBody.options,
            source: 'http',
          });
        } catch (e) {
          sendJson(res, 400, { error: errMessage(e) });
          return;
        }
        sendJson(res, 202, rec);
        return;
      }

      if (pathname.startsWith('/tasks/')) {
        if (method !== 'GET') {
          sendJson(res, 405, { error: `method ${method} not allowed, use GET` });
          return;
        }
        const taskId = decodeURIComponent(pathname.slice('/tasks/'.length));
        const rec = runner.poll(taskId);
        if (!rec) {
          sendJson(res, 404, { error: `task 不存在: ${taskId}` });
          return;
        }
        sendJson(res, 200, rec);
        return;
      }

      sendJson(res, 404, { error: `路径不存在: ${pathname}` });
    } catch (e) {
      sendJson(res, 500, { error: errMessage(e) });
    }
  };
}

const PARSE_FAILED = Symbol('parse-failed');

/** 读取并解析 JSON body；失败时直接回 400 并返回哨兵。 */
async function parseJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | typeof PARSE_FAILED> {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    sendJson(res, 400, { error: '请求 body 不是合法 JSON' });
    return PARSE_FAILED;
  }
}
