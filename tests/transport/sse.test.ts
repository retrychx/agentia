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

/** 模拟背压的假 res：write() 恒返回 false，writableLength 随写入增长（等价于「下游不消费」） */
function stalledRes(): ServerResponse & {
  out: string;
  ended: boolean;
  writableLength: number;
} {
  const rec = {
    out: '',
    ended: false,
    writableLength: 0,
    writeHead() {
      return rec as unknown as ServerResponse;
    },
    write(chunk: string) {
      rec.out += chunk;
      rec.writableLength += chunk.length;
      return false; // 关键：一直回报「没消费完」
    },
    end() {
      rec.ended = true;
    },
  };
  return rec as unknown as ServerResponse & typeof rec;
}

describe('sseWriter 背压（下游连得上但不读）', () => {
  it('积压超过上限即收口：不再无限缓冲，并回调 onBackpressure', () => {
    const res = stalledRes();
    const seen: Array<{ bufferedBytes: number; limitBytes: number }> = [];
    const w = sseWriter(res, { maxBufferedBytes: 1000, onBackpressure: (i) => seen.push(i) });
    for (let i = 0; i < 500; i++) w.event('text.delta', { text: 'x'.repeat(30) });
    assert.equal(w.closed, true, '超限必须收口');
    assert.equal(res.ended, true, '收口要结束响应');
    assert.equal(seen.length, 1, '回调只该触发一次');
    assert.ok(seen[0].bufferedBytes > 1000, `回报的积压该已超限，实际 ${seen[0].bufferedBytes}`);
    assert.ok(res.out.length < 4000, `收口后不该再堆积，实际写入了 ${res.out.length} 字节`);
  });

  it('未超限时照常逐帧下发（不误伤正常的慢速客户端）', () => {
    const res = stalledRes();
    const w = sseWriter(res, { maxBufferedBytes: 1_000_000 });
    for (let i = 0; i < 100; i++) w.event('n', i);
    assert.equal(w.closed, false);
    assert.equal(res.ended, false);
    assert.equal(res.out.split('\n\n').length - 1, 100, '100 帧都要写出去');
  });

  it('onBackpressure 抛错不影响收口（通知是副作用，不该把收口变崩溃）', () => {
    const res = stalledRes();
    const w = sseWriter(res, {
      maxBufferedBytes: 10,
      onBackpressure: () => {
        throw new Error('boom');
      },
    });
    w.event('a', 1); // 写入后积压 > 10
    w.event('b', 2); // 这次先检查 → 收口
    assert.equal(w.closed, true);
    assert.equal(res.ended, true);
  });
});
