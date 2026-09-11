import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpanError, Trace } from '../core/trace.js';
import type { AgentRunResult, AgentStopReason } from '../engine/types.js';
import { AsyncRunner } from './async.js';
import type { AppCallable } from './async.js';
import { sseWriter } from './sse.js';
import { normalizeMessages } from '../runtime/spec.js';
import type { RunInvocationOptions } from '../runtime/spec.js';
import type { TaskRecord } from '../store/store.js';
import type { RunStatus } from '../runtime/types.js';

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
 *                    输入无法规整为 messages → 400 { error }；
 *                    并发 run 超 maxConcurrentRuns → 503 + Retry-After（见该选项）。
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
  /** 请求 body 上限（字节），超限回 413；缺省 1 MiB */
  maxBodyBytes?: number;
  /**
   * 同时在执行的 POST /run 上限；缺省 32，超限回 503 + `Retry-After`。
   * 传 `Infinity` 恢复无上限（旧行为）。**行为变更**：旧版本无此闸门。
   * 闸门针对同步 RPC —— 每次请求都会真跑一次 run，不设上限时少量并发请求
   * 就能把宿主压垮（上游模型并发也一起打满）；异步走 POST /tasks（runner 自带上限）。
   */
  maxConcurrentRuns?: number;
  /**
   * 是否把内部异常原文回给调用方；缺省 false。
   * false 时 500 只回通用文案，细节走 `console.error` —— 否则
   * `ECONNREFUSED 10.0.0.7:6379` 这类内部拓扑会回给未鉴权的调用方。
   */
  exposeErrors?: boolean;
}

/** body 上限缺省值：1 MiB —— 本宿主只接 messages JSON，正常远小于此 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** POST /run 并发上限缺省值：32 —— 够单机跑满，又不至于让上游被单宿主打爆 */
const DEFAULT_MAX_CONCURRENT_RUNS = 32;

/** 503 建议重试间隔（秒）：同步 run 通常秒级，给 1s 足够错峰 */
const RETRY_AFTER_SECONDS = '1';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 405 统一响应（方法不符）：文案与其余错误一致用中文，并带 Allow 头。 */
function methodNotAllowed(res: ServerResponse, method: string, allowed: string): void {
  res.setHeader('allow', allowed);
  sendJson(res, 405, { error: `方法 ${method} 不被允许，请用 ${allowed}` });
}

/** 把 app.run 的产物收成 HTTP 响应体（JSON 与 SSE 的 run.end 共用同一形状） */
function toHttpBody(out: {
  run: { runId: string; status: RunStatus };
  result: AgentRunResult;
}): RunHttpResponse {
  return {
    runId: out.run.runId,
    status: out.run.status,
    stopReason: out.result.stopReason,
    finalText: out.result.finalText,
    typed: (out.result as { typed?: unknown }).typed,
    trace: out.result.trace,
    error: out.result.error,
  };
}

type BodyResult = { ok: true; raw: string } | { ok: false; reason: 'too-large' | 'aborted' };

/**
 * 读取 body 全文。两道兜底（原实现两者皆无）：
 * - **maxBytes 上限**：超限立即停止累积并 resolve 成哨兵（调用方回 413）——
 *   否则一个未鉴权的大 body 就能把宿主内存打满；
 * - **close 兜底**：客户端中途断开时既不会有 `end` 也不会有 `error`（Node 发 `aborted`/`close`），
 *   Promise 永不 settle → 每个半截请求漏一个 handler 与一份 buffer。
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
    };
    const finish = (r: BodyResult): void => {
      if (done) return; // end 之后仍会来一次 close
      done = true;
      cleanup();
      resolve(r);
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > maxBytes) {
        finish({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') });
    const onAbort = (): void => finish({ ok: false, reason: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
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
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxConcurrentRuns = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const exposeErrors = opts.exposeErrors ?? false;
  let inFlightRuns = 0;

  const sendInternalError = (res: ServerResponse, e: unknown): void => {
    if (exposeErrors) {
      sendJson(res, 500, { error: errMessage(e) });
      return;
    }
    // 细节只进服务端日志，响应里不回内部拓扑
    console.error('[agentia:http] 请求处理异常:', e);
    sendJson(res, 500, { error: '内部错误' });
  };

  return async (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = (req.url ?? '/').split('?')[0];

    try {
      if (pathname === '/run') {
        if (method !== 'POST') {
          methodNotAllowed(res, method, 'POST');
          return;
        }
        const input = await parseJsonBody(req, res, maxBodyBytes);
        if (input === PARSE_FAILED) return;
        let messages;
        try {
          messages = normalizeMessages(input);
        } catch (e) {
          sendJson(res, 400, { error: errMessage(e) });
          return;
        }
        // 并发闸门：body 已读完（连接可复用），只是暂时不给跑 —— 回 503 让调用方退避重试
        if (inFlightRuns >= maxConcurrentRuns) {
          res.setHeader('retry-after', RETRY_AFTER_SECONDS);
          sendJson(res, 503, {
            error: `并发 run 已达上限 ${maxConcurrentRuns}，请稍后重试`,
          });
          return;
        }
        inFlightRuns++;
        // 客户端中途断开 → 中止本次 run（省 token）。res 'close' 正常结束也会触发，
        // 故以 writableEnded 区分：只有响应还没写完才算「断开」。
        const runAc = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) runAc.abort();
        };
        res.once('close', onClose);
        // 内容协商：`Accept: text/event-stream` → SSE 逐帧下发；否则一元 JSON（旧行为逐字不变）
        const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream');
        try {
          if (wantsSse) {
            const sse = sseWriter(res);
            const heartbeat = setInterval(() => sse.comment('ping'), 15_000);
            heartbeat.unref?.();
            try {
              // rethrow:false —— 与 AsyncRunner 对齐：硬失败也以 run.end 下发（status/error 字段）
              const out = await app.run(messages, {
                rethrow: false,
                signal: runAc.signal,
                onText: (delta) => sse.event('text.delta', { text: delta }),
              });
              sse.event('run.end', toHttpBody(out));
            } catch (e) {
              // 流已开（200 与头已发出）→ 只能以 error 事件收尾，不能再改 HTTP 状态码
              sse.event('error', { message: errMessage(e) });
            } finally {
              clearInterval(heartbeat);
              sse.close();
            }
            return;
          }
          // rethrow:false —— 与 AsyncRunner 对齐：硬失败也以 status/error 字段返回 200
          const out = await app.run(messages, { rethrow: false, signal: runAc.signal });
          sendJson(res, 200, toHttpBody(out));
        } finally {
          res.off('close', onClose);
          inFlightRuns--;
        }
        return;
      }

      if (pathname === '/tasks') {
        if (method !== 'POST') {
          methodNotAllowed(res, method, 'POST');
          return;
        }
        const body = await parseJsonBody(req, res, maxBodyBytes);
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
          methodNotAllowed(res, method, 'GET');
          return;
        }
        let taskId: string;
        try {
          taskId = decodeURIComponent(pathname.slice('/tasks/'.length));
        } catch {
          // 残缺的 % 转义会抛 URIError —— 是调用方的输入问题（400），不是服务端 500
          sendJson(res, 400, { error: 'taskId 不是合法的 URL 编码' });
          return;
        }
        const rec = await runner.poll(taskId); // MaybePromise：异步 store 下必须 await
        if (!rec) {
          sendJson(res, 404, { error: `task 不存在: ${taskId}` });
          return;
        }
        sendJson(res, 200, rec);
        return;
      }

      sendJson(res, 404, { error: `路径不存在: ${pathname}` });
    } catch (e) {
      sendInternalError(res, e);
    }
  };
}

const PARSE_FAILED = Symbol('parse-failed');

/** 读取并解析 JSON body；失败时直接回错误响应并返回哨兵（连接已断则无响应可回）。 */
async function parseJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<unknown | typeof PARSE_FAILED> {
  const body = await readBody(req, maxBytes);
  if (!body.ok) {
    if (body.reason === 'too-large') {
      // body 未读完就回响应：连接不能复用，否则残留字节会被当成下一个请求
      res.setHeader('connection', 'close');
      sendJson(res, 413, { error: `请求 body 超过上限 ${maxBytes} 字节` });
    }
    return PARSE_FAILED; // aborted：客户端已走，写了也没人收
  }
  try {
    return body.raw ? JSON.parse(body.raw) : undefined;
  } catch {
    sendJson(res, 400, { error: '请求 body 不是合法 JSON' });
    return PARSE_FAILED;
  }
}
