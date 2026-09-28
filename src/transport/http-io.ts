import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Agentia —— HTTP 宿主的**收发原语**（`transport/http.ts` 拆分第三步的两半之一）。
 *
 * 这一组只做「把请求读进来、把话说回去」的机械动作，与**这是哪条路**
 * （`http-route.ts` 的纯判定）和**走到这条路上做什么**（`http-endpoints.ts` 的端点体）
 * 都无关 —— 三个模块各管一件事，谁越界就是新的乱源。
 *
 * 边界（本模块**不**做的事）：
 * - 不判路由、不选分支：`(pathname, method) → 该走哪条` 是 `http-route.ts` 的事；
 * - 不决定状态码的**语义**：`sendJson(res, 400, …)` 里的 400 由调用方选，这里只负责写；
 * - 不碰 AsyncRunner / store / 引擎：本模块的入参只有 req / res / 一段未知的 body。
 *
 * 依赖方向：本模块只 import `node:http` 的**类型**，零内部依赖 —— 所以
 * `http.ts` 与 `http-endpoints.ts` 都能引它而不可能引成环。`HttpException` **刻意不在这里**
 * （它是宿主契约的一部分，住在 `http.ts`）⇒ `sendUnauthorized` 也随之留在那边：
 * 它是唯一一处 `instanceof HttpException` 的落点，搬过来会让本模块反向依赖宿主。
 *
 * 有两条**踩过坑**的兜底写进了这里，别当成可选装饰（原文见 `readBody` 与 `sendShuttingDown`）：
 * body 上限（未鉴权的大 body 能打满内存）与连接不可复用时的 `connection: close`
 * （残留字节会被当成下一个请求）。
 */

/** 503 建议重试间隔（秒）：同步 run 通常秒级，给 1s 足够错峰 */
export const RETRY_AFTER_SECONDS = '1';

/** 写一个 JSON 响应：带 `content-type` 与 `content-length`（后者用 `Buffer.byteLength`，不是 `.length`） */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 405 统一响应（方法不符）：文案与其余错误一致用中文，并带 Allow 头。 */
export function methodNotAllowed(res: ServerResponse, method: string, allowed: string): void {
  res.setHeader('allow', allowed);
  sendJson(res, 405, { error: `方法 ${method} 不被允许，请用 ${allowed}` });
}

/** Prometheus 文本响应（G4）：抓取端按 text/plain; version=0.0.4 解析 */
export function sendPrometheus(
  res: ServerResponse,
  body: string,
  contentType = 'text/plain; version=0.0.4; charset=utf-8',
): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export type BodyResult = { ok: true; raw: string } | { ok: false; reason: 'too-large' | 'aborted' };

/**
 * 读取 body 全文。两道兜底（原实现两者皆无）：
 * - **maxBytes 上限**：超限立即停止累积并 resolve 成哨兵（调用方回 413）——
 *   否则一个未鉴权的大 body 就能把宿主内存打满；
 * - **close 兜底**：客户端中途断开时既不会有 `end` 也不会有 `error`（Node 发 `aborted`/`close`），
 *   Promise 永不 settle → 每个半截请求漏一个 handler 与一份 buffer。
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
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

/** 把 unknown 异常收成一句人话（`Error` 取 `message`，其余 `String()`） */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 503：停机中不再接单（在读 body 之前就拒，省一次传输） */
export function sendShuttingDown(req: IncomingMessage, res: ServerResponse): void {
  // body 未消费 → 连接不可复用（残留字节会被当成下一个请求，与 413 同理）
  if (!req.complete) res.setHeader('connection', 'close');
  res.setHeader('retry-after', RETRY_AFTER_SECONDS);
  sendJson(res, 503, { error: '服务正在优雅停机，不再接受新任务' });
}

/**
 * 500：内部错误。
 *
 * `exposeErrors` 为假时只回通用文案、细节走 `console.error` —— 否则
 * `ECONNREFUSED 10.0.0.7:6379` 这类内部拓扑会回给未鉴权的调用方。
 * `exposeErrors` 由宿主透传（它是 `HttpHandlerOptions` 的旋钮），本模块不持有策略。
 */
export function sendInternalError(res: ServerResponse, e: unknown, exposeErrors: boolean): void {
  if (exposeErrors) {
    sendJson(res, 500, { error: errMessage(e) });
    return;
  }
  // 细节只进服务端日志，响应里不回内部拓扑
  console.error('[agentia:http] 请求处理异常:', e);
  sendJson(res, 500, { error: '内部错误' });
}

/**
 * 读单个请求头。Node 对重复头给数组（`traceparent` 语义上只该有一个）——
 * 取第一个即可，多余的忽略。
 */
export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** 「body 已自行回过错误响应、调用方直接返回」的哨兵（连接已断时无响应可回，同样走它） */
export const PARSE_FAILED: unique symbol = Symbol('parse-failed');

/** 读取并解析 JSON body；失败时直接回错误响应并返回哨兵（连接已断则无响应可回）。 */
export async function parseJsonBody(
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
