import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PARSE_FAILED,
  RETRY_AFTER_SECONDS,
  errMessage,
  headerValue,
  methodNotAllowed,
  parseJsonBody,
  readBody,
  sendInternalError,
  sendJson,
  sendPrometheus,
  sendShuttingDown,
} from '../../src/transport/http-io.js';

/**
 * `transport/http-io.ts` 的**收发原语**直测（2026-09-28）。
 *
 * 为什么单独配一份：这些原语此前只被 146 条 HTTP 用例**顺着真实 server** 路过 ——
 * 状态码是验到了，但原语自己的口径从没被正面钉过：超限**立即**收手并摘监听（不是读完再判）、
 * 空 body **不**算解析失败、`content-length` 按**字节**而非字符、停机拒绝要带 `retry-after`。
 * 按 `http-shapes.test.ts` 的先例配一份口径表。
 *
 * **不追覆盖率**：只补真契约。纯防御分支不在这里凑数 —— 典型是 `readBody` 的
 * `if (done) return`：Promise 二次 resolve 是 no-op，少一行**行为完全一样**，为它写断言
 * 就是「真空变绿」。可观测的那半边（settle 后监听是否摘干净）才在这里钉。
 *
 * 壳：`readBody` 只吃 EventEmitter 面，`ServerResponse` 只用到
 * `writeHead` / `setHeader` / `end` —— 手搓这两个薄壳比拉一个真 server 更贴近「原语」这一层。
 */

interface Rec {
  status: number;
  headers: Record<string, unknown>;
  body: string;
  ended: boolean;
}

function fakeReq(
  over: { complete?: boolean; headers?: Record<string, unknown> } = {},
): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as EventEmitter & {
    complete: boolean;
    headers: Record<string, unknown>;
  };
  req.complete = over.complete ?? true;
  req.headers = over.headers ?? {};
  return req as unknown as IncomingMessage & EventEmitter;
}

function fakeRes(): { res: ServerResponse; rec: Rec } {
  const rec: Rec = { status: 0, headers: {}, body: '', ended: false };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      rec.status = status;
      Object.assign(rec.headers, headers);
      return res;
    },
    setHeader(name: string, value: unknown) {
      rec.headers[name.toLowerCase()] = value;
    },
    end(payload?: string) {
      rec.body = payload ?? '';
      rec.ended = true;
    },
  };
  return { res: res as unknown as ServerResponse, rec };
}

const LISTENED = ['data', 'end', 'error', 'close'] as const;

function assertNoListeners(req: IncomingMessage): void {
  for (const ev of LISTENED) {
    assert.equal(
      req.listenerCount(ev),
      0,
      `settle 后必须摘掉 '${ev}' 监听 —— 否则每个半截请求漏一个 handler（readBody 注释里的两道兜底之一）`,
    );
  }
}

describe('readBody —— 读全文', () => {
  it('多块聚合，按 utf8 还原（中文跨块不被截断）', async () => {
    const req = fakeReq();
    const p = readBody(req, 1024);
    req.emit('data', Buffer.from('你', 'utf8'));
    req.emit('data', Buffer.from('好', 'utf8'));
    req.emit('end');
    assert.deepEqual(await p, { ok: true, raw: '你好' });
    assertNoListeners(req);
  });

  it('超 maxBytes ⇒ 立即 too-large 并摘监听（不是读完再判 —— 未鉴权的大 body 就是这么打满内存的）', async () => {
    const req = fakeReq();
    const p = readBody(req, 4);
    req.emit('data', Buffer.from('12345', 'utf8'));
    assert.deepEqual(await p, { ok: false, reason: 'too-large' });
    assertNoListeners(req);
  });

  it('客户端中途断开（close 先于 end）⇒ aborted —— 否则 Promise 永不 settle', async () => {
    const req = fakeReq();
    const p = readBody(req, 1024);
    req.emit('close');
    assert.deepEqual(await p, { ok: false, reason: 'aborted' });
    assertNoListeners(req);
  });

  it('error 事件 ⇒ 同样走 aborted', async () => {
    const req = fakeReq();
    const p = readBody(req, 1024);
    req.emit('error', new Error('boom'));
    assert.deepEqual(await p, { ok: false, reason: 'aborted' });
  });
});

describe('parseJsonBody —— 读 + 解析；失败时自己回过错误响应', () => {
  it('合法 JSON ⇒ 解析值，且成功路径不写响应', async () => {
    const req = fakeReq();
    const { res, rec } = fakeRes();
    const p = parseJsonBody(req, res, 1024);
    req.emit('data', Buffer.from('{"a":1}', 'utf8'));
    req.emit('end');
    assert.deepEqual(await p, { a: 1 });
    assert.equal(rec.ended, false, '成功路径不该写响应');
  });

  it('空 body ⇒ undefined，且**不**判成「不是合法 JSON」', async () => {
    const req = fakeReq();
    const { res, rec } = fakeRes();
    const p = parseJsonBody(req, res, 1024);
    req.emit('end');
    assert.equal(await p, undefined);
    assert.equal(rec.ended, false, '空 body 回 400 是错的：客户端没给 body ≠ body 非法');
  });

  it('畸形 JSON ⇒ 哨兵 + 400', async () => {
    const req = fakeReq();
    const { res, rec } = fakeRes();
    const p = parseJsonBody(req, res, 1024);
    req.emit('data', Buffer.from('{oops', 'utf8'));
    req.emit('end');
    assert.equal(await p, PARSE_FAILED);
    assert.equal(rec.status, 400);
    assert.deepEqual(JSON.parse(rec.body), { error: '请求 body 不是合法 JSON' });
  });

  it('超限 ⇒ 哨兵 + 413 + connection: close（body 未读完，连接不可复用）', async () => {
    const req = fakeReq();
    const { res, rec } = fakeRes();
    const p = parseJsonBody(req, res, 4);
    req.emit('data', Buffer.from('12345', 'utf8'));
    assert.equal(await p, PARSE_FAILED);
    assert.equal(rec.status, 413);
    assert.equal(rec.headers.connection, 'close');
  });

  it('客户端已走（aborted）⇒ 哨兵，且不写响应（写了也没人收）', async () => {
    const req = fakeReq();
    const { res, rec } = fakeRes();
    const p = parseJsonBody(req, res, 1024);
    req.emit('close');
    assert.equal(await p, PARSE_FAILED);
    assert.equal(rec.ended, false);
  });
});

describe('errMessage —— unknown 收成一句人话', () => {
  it('Error ⇒ message', () => {
    assert.equal(errMessage(new Error('boom')), 'boom');
  });

  it('非 Error ⇒ String()', () => {
    assert.equal(errMessage('boom'), 'boom');
    assert.equal(errMessage(42), '42');
    assert.equal(errMessage(undefined), 'undefined');
  });
});

describe('headerValue —— 重复头取第一个', () => {
  it('单值 / 数组（Node 对重复头给数组）/ 缺席', () => {
    assert.equal(headerValue(fakeReq({ headers: { traceparent: 'a' } }), 'traceparent'), 'a');
    assert.equal(
      headerValue(fakeReq({ headers: { traceparent: ['a', 'b'] } }), 'traceparent'),
      'a',
    );
    assert.equal(headerValue(fakeReq({ headers: {} }), 'traceparent'), undefined);
  });
});

describe('sendJson —— content-length 按字节', () => {
  it('多字节字符：用 .length 会写小 ⇒ 客户端按 content-length 截断', () => {
    const { res, rec } = fakeRes();
    const payload = JSON.stringify({ t: '你好' });
    sendJson(res, 200, { t: '你好' });
    assert.equal(rec.status, 200);
    assert.equal(rec.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(rec.headers['content-length'], Buffer.byteLength(payload));
    assert.notEqual(rec.headers['content-length'], payload.length, '别用 .length');
    assert.equal(rec.body, payload);
  });
});

describe('methodNotAllowed —— 405 带 Allow', () => {
  it('状态码、Allow 头与文案一致', () => {
    const { res, rec } = fakeRes();
    methodNotAllowed(res, 'GET', 'POST');
    assert.equal(rec.status, 405);
    assert.equal(rec.headers.allow, 'POST');
    assert.deepEqual(JSON.parse(rec.body), { error: '方法 GET 不被允许，请用 POST' });
  });
});

describe('sendPrometheus —— 抓取端按 text/plain 解析', () => {
  it('200 + text/plain + no-store', () => {
    const { res, rec } = fakeRes();
    sendPrometheus(res, 'a 1\n');
    assert.equal(rec.status, 200);
    assert.match(String(rec.headers['content-type']), /^text\/plain/);
    assert.equal(rec.headers['cache-control'], 'no-store');
    assert.equal(rec.body, 'a 1\n');
  });
});

describe('sendShuttingDown —— 停机中不再接单', () => {
  it('503 + retry-after；body 未消费时要求连接不复用', () => {
    const { res, rec } = fakeRes();
    sendShuttingDown(fakeReq({ complete: false }), res);
    assert.equal(rec.status, 503);
    assert.equal(rec.headers['retry-after'], RETRY_AFTER_SECONDS);
    assert.equal(rec.headers.connection, 'close');
  });

  it('body 已读完 ⇒ 不写 close（连接可复用）', () => {
    const { res, rec } = fakeRes();
    sendShuttingDown(fakeReq({ complete: true }), res);
    assert.equal(rec.status, 503);
    assert.equal(rec.headers.connection, undefined);
  });
});

describe('sendInternalError —— 500', () => {
  it('exposeErrors ⇒ 细节出门', () => {
    const { res, rec } = fakeRes();
    sendInternalError(res, new Error('ECONNREFUSED 10.0.0.7:6379'), true);
    assert.equal(rec.status, 500);
    assert.deepEqual(JSON.parse(rec.body), { error: 'ECONNREFUSED 10.0.0.7:6379' });
  });

  it('不出门 ⇒ 只回通用文案，内部拓扑**绝不**进响应体（细节只进服务端日志）', () => {
    const { res, rec } = fakeRes();
    const orig = console.error;
    const logged: unknown[] = [];
    console.error = (...a: unknown[]): void => {
      logged.push(a);
    };
    try {
      sendInternalError(res, new Error('ECONNREFUSED 10.0.0.7:6379'), false);
    } finally {
      console.error = orig;
    }
    assert.equal(rec.status, 500);
    assert.deepEqual(JSON.parse(rec.body), { error: '内部错误' });
    assert.equal(rec.body.includes('ECONNREFUSED'), false, '内部拓扑不得进响应体');
    assert.equal(logged.length, 1, '细节必须落到服务端日志（否则排障时两头都看不到）');
  });
});
