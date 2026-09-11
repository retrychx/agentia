import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { createHttpHandler } from '../../src/transport/http.js';
import { AsyncRunner } from '../../src/transport/async.js';
import type { AppCallable } from '../../src/transport/async.js';
import type { AgentRunResult } from '../../src/engine/types.js';

function fakeResult(text: string): AgentRunResult {
  return {
    trace: {
      traceId: 'trace-1',
      rootSpanId: 'span-1',
      spans: [],
      status: 'ok',
      totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    stopReason: 'end_turn',
    finalText: text,
    iterations: 1,
  };
}

function fakeApp(over: Partial<AppCallable> = {}): AppCallable & {
  seen: Anthropic.MessageParam[][];
} {
  const seen: Anthropic.MessageParam[][] = [];
  return {
    name: 'fake',
    seen,
    async run(messages, opts) {
      seen.push(messages);
      assert.equal(opts?.rethrow, false, 'HTTP 宿主调用 app.run 必须带 rethrow:false');
      return { run: { runId: `r-${seen.length}`, status: 'succeeded' }, result: fakeResult('ok') };
    },
    ...over,
  };
}

async function start(app: AppCallable): Promise<{ server: Server; base: string }> {
  const server = createServer(createHttpHandler(app));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

/**
 * 读响应 JSON。宿主回的是运行时数据（端点契约见 http.ts 的 RunHttpResponse /
 * TaskRecord），测试里按 any 取用 —— 否则每个字段访问都要单独断言 unknown。
 */
async function readJson(res: Response): Promise<any> {
  return res.json();
}

describe('createHttpHandler', () => {
  it('POST /run 成功：RunInput 规整后同步执行，200 返回完整 run 结果', async () => {
    const app = fakeApp();
    const { server, base } = await start(app);
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      });
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.runId, 'r-1');
      assert.equal(body.status, 'succeeded');
      assert.equal(body.stopReason, 'end_turn');
      assert.equal(body.finalText, 'ok');
      assert.ok(body.trace);
      assert.deepEqual(app.seen[0], [{ role: 'user', content: 'hi' }]);
    } finally {
      await close(server);
    }
  });

  it('POST /run 输入非法 → 400 {error}；body 非 JSON → 400', async () => {
    const app = fakeApp();
    const { server, base } = await start(app);
    try {
      const r1 = await fetch(`${base}/run`, {
        method: 'POST',
        body: JSON.stringify(123),
      });
      assert.equal(r1.status, 400);
      assert.ok((await readJson(r1)).error);

      const r2 = await fetch(`${base}/run`, { method: 'POST', body: 'not-json{' });
      assert.equal(r2.status, 400);
      assert.ok((await readJson(r2)).error);
    } finally {
      await close(server);
    }
  });

  it('POST /run 应用失败（status failed）仍返 200，body 带 error', async () => {
    const app = fakeApp({
      run: async () => ({
        run: { runId: 'r-x', status: 'failed' as const },
        result: {
          ...fakeResult(''),
          error: { type: 'api', message: 'boom', retryable: false },
        },
      }),
    });
    const { server, base } = await start(app);
    try {
      const res = await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('go') });
      assert.equal(res.status, 200);
      const body = await readJson(res);
      assert.equal(body.status, 'failed');
      assert.equal(body.error.message, 'boom');
    } finally {
      await close(server);
    }
  });

  it('POST /tasks → 202 快照；GET /tasks/<id> 轮询到终态；幂等键去重', async () => {
    const app = fakeApp();
    const { server, base } = await start(app);
    try {
      const submit = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { text: 'hi' }, idempotencyKey: 'k1' }),
      });
      assert.equal(submit.status, 202);
      const rec = await readJson(submit);
      assert.equal(rec.status, 'queued');
      assert.equal(rec.idempotencyKey, 'k1');

      // 轮询到终态
      let polled;
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`${base}/tasks/${rec.taskId}`);
        assert.equal(r.status, 200);
        polled = await readJson(r);
        if (polled.status === 'succeeded' || polled.status === 'failed') break;
        await new Promise((r2) => setTimeout(r2, 5));
      }
      assert.equal(polled.status, 'succeeded');
      assert.equal(polled.result.finalText, 'ok');
      assert.equal(polled.runId, 'r-1');

      // 幂等键去重：同键重提返回既有记录，不重复执行
      const again = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'hi', idempotencyKey: 'k1' }),
      });
      assert.equal(again.status, 202);
      assert.equal((await readJson(again)).taskId, rec.taskId);
      assert.equal(app.seen.length, 1);
    } finally {
      await close(server);
    }
  });

  it('POST /tasks 输入非法 → 400', async () => {
    const app = fakeApp();
    const { server, base } = await start(app);
    try {
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ input: 42 }),
      });
      assert.equal(res.status, 400);
      assert.ok((await readJson(res)).error);
    } finally {
      await close(server);
    }
  });

  it('404：未知路径 / 未知 task；405：方法不符', async () => {
    const app = fakeApp();
    const { server, base } = await start(app);
    try {
      assert.equal((await fetch(`${base}/tasks/nope`)).status, 404);
      // 残缺的 % 转义是调用方的输入问题 → 400，不是服务端 500
      const bad = await fetch(`${base}/tasks/%E0%A4%A`);
      assert.equal(bad.status, 400);
      assert.match((await readJson(bad)).error, /URL 编码/);
      assert.equal((await fetch(`${base}/nope`)).status, 404);
      assert.equal((await fetch(`${base}/run`)).status, 405);
      assert.equal(
        (await fetch(`${base}/tasks/x`, { method: 'DELETE' })).status,
        405,
      );
    } finally {
      await close(server);
    }
  });

  it('body 超限 → 413，且不执行 run', async () => {
    const app = fakeApp();
    const server = createServer(createHttpHandler(app, { maxBodyBytes: 1024 }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'x'.repeat(4096) }),
      });
      assert.equal(res.status, 413);
      assert.match((await readJson(res)).error, /上限/);
      assert.equal(app.seen.length, 0, '超限请求不得进入 run');
      assert.equal(res.headers.get('connection'), 'close');
    } finally {
      await close(server);
    }
  });

  it('请求中途断开（无 end/error）→ handler 不悬挂、不写响应', async () => {
    const app = fakeApp();
    const handler = createHttpHandler(app);
    const emitter = new EventEmitter();
    Object.assign(emitter, { method: 'POST', url: '/run' });
    const req = emitter as unknown as IncomingMessage;
    const got = { status: 0, written: false };
    const res = {
      setHeader: () => {},
      writeHead: (s: number) => {
        got.status = s;
        got.written = true;
      },
      end: () => {},
    } as unknown as ServerResponse;

    const p = handler(req, res);
    emitter.emit('data', Buffer.from('{"prompt":'));
    emitter.emit('close'); // 客户端走了：Node 只发 close，不会有 end
    const settled = await Promise.race([
      p.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
    ]);
    assert.equal(settled, true, '断开后 handler 必须结束（否则 handler 与 buffer 一起泄漏）');
    assert.equal(got.written, false, '连接已断，不该尝试写响应');
    assert.equal(app.seen.length, 0);
  });

  it('POST /run 并发闸门：超上限回 503 + Retry-After，槽位释放后恢复', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const app = fakeApp({
      run: async () => {
        started++;
        await gate;
        return { run: { runId: 'r-1', status: 'succeeded' as const }, result: fakeResult('ok') };
      },
    });
    const server = createServer(createHttpHandler(app, { maxConcurrentRuns: 1 }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const post = () => fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('go') });
    try {
      const first = post(); // 占住唯一槽位（不 await）
      for (let i = 0; i < 100 && started === 0; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(started, 1);

      const second = await post();
      assert.equal(second.status, 503);
      assert.equal(second.headers.get('retry-after'), '1');
      assert.match((await readJson(second)).error, /并发/);
      assert.equal(started, 1, '超限请求不得进入 run');

      release();
      assert.equal((await first).status, 200);
      // finally 里释放槽位：闸门不因一次请求而永久紧闭
      assert.equal((await post()).status, 200);
      assert.equal(started, 2);
    } finally {
      await close(server);
    }
  });

  it('maxConcurrentRuns: Infinity → 无闸门（旧行为）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const app = fakeApp({
      run: async () => {
        started++;
        await gate;
        return { run: { runId: 'r-1', status: 'succeeded' as const }, result: fakeResult('ok') };
      },
    });
    const server = createServer(
      createHttpHandler(app, { maxConcurrentRuns: Number.POSITIVE_INFINITY }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const both = Promise.all([
        fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('a') }),
        fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('b') }),
      ]);
      for (let i = 0; i < 100 && started < 2; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(started, 2, '不限并发时两个请求同时跑');
      release();
      assert.deepEqual((await both).map((r) => r.status), [200, 200]);
    } finally {
      await close(server);
    }
  });

  it('exposeErrors 缺省 false：500 只回通用文案，内部细节走 console.error', async () => {
    const app = fakeApp({
      run: async () => {
        throw new Error('ECONNREFUSED 10.0.0.7:6379');
      },
    });
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    const { server, base } = await start(app);
    try {
      const res = await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('go') });
      assert.equal(res.status, 500);
      const body = await readJson(res);
      assert.equal(body.error, '内部错误');
      assert.ok(
        !JSON.stringify(body).includes('ECONNREFUSED'),
        '内部拓扑不得回给未鉴权调用方',
      );
      assert.equal(logged.length, 1, '细节必须在服务端日志里可见');
      assert.match(String((logged[0][1] as Error).message), /ECONNREFUSED/);
    } finally {
      console.error = orig;
      await close(server);
    }
  });

  it('exposeErrors: true → 500 回异常原文（自托管调试用）', async () => {
    const app = fakeApp({
      run: async () => {
        throw new Error('ECONNREFUSED 10.0.0.7:6379');
      },
    });
    const server = createServer(createHttpHandler(app, { exposeErrors: true }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/run`, {
        method: 'POST',
        body: JSON.stringify('go'),
      });
      assert.equal(res.status, 500);
      assert.match((await readJson(res)).error, /ECONNREFUSED/);
    } finally {
      await close(server);
    }
  });

  it('注入自定义 runner（带 store）时 submit/poll 走该 runner', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const server = createServer(createHttpHandler(app, { runner }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ input: 'hi' }),
      });
      const rec = await readJson(res);
      assert.ok(runner.poll(rec.taskId), '记录应落在注入的 runner store 里');
    } finally {
      await close(server);
    }
  });
});
