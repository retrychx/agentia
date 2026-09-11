import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { sseWriter } from '../../src/transport/sse.js';

/** 记录写入的假 ServerResponse */
function fakeRes(): ServerResponse & { headers: Record<string, unknown>; status: number; out: string; ended: boolean } {
  const rec = {
    status: 0,
    headers: {} as Record<string, unknown>,
    out: '',
    ended: false,
    writeHead(code: number, h?: Record<string, unknown>) {
      rec.status = code;
      Object.assign(rec.headers, h ?? {});
      return rec as unknown as ServerResponse;
    },
    write(chunk: string) {
      rec.out += chunk;
      return true;
    },
    end() {
      rec.ended = true;
    },
  };
  return rec as unknown as ServerResponse & typeof rec;
}

describe('sseWriter（SSE 帧）', () => {
  it('写头：text/event-stream + 关缓冲 + 200', () => {
    const res = fakeRes();
    sseWriter(res);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
  });

  it('event 帧格式：event/data + 空行结尾，data 走 JSON', () => {
    const res = fakeRes();
    const w = sseWriter(res);
    w.event('text.delta', { text: '甲' });
    assert.equal(res.out, 'event: text.delta\ndata: {"text":"甲"}\n\n');
  });

  it('comment 心跳帧', () => {
    const res = fakeRes();
    sseWriter(res).comment('ping');
    assert.equal(res.out, ': ping\n\n');
  });

  it('close 之后 event/comment 是 no-op（不往已结束的响应写）', () => {
    const res = fakeRes();
    const w = sseWriter(res);
    w.event('a', 1);
    w.close();
    assert.equal(res.ended, true);
    assert.equal(w.closed, true);
    w.event('b', 2);
    w.comment('x');
    assert.equal(res.out, 'event: a\ndata: 1\n\n', '关后不得再写');
  });
});
