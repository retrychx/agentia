import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { createHttpHandler } from '../../src/run/http.js';
import { AsyncRunner } from '../../src/run/async.js';
import type { AppCallable } from '../../src/run/async.js';
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
      const body = await res.json();
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
      assert.ok((await r1.json()).error);

      const r2 = await fetch(`${base}/run`, { method: 'POST', body: 'not-json{' });
      assert.equal(r2.status, 400);
      assert.ok((await r2.json()).error);
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
      const body = await res.json();
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
      const rec = await submit.json();
      assert.equal(rec.status, 'queued');
      assert.equal(rec.idempotencyKey, 'k1');

      // 轮询到终态
      let polled;
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`${base}/tasks/${rec.taskId}`);
        assert.equal(r.status, 200);
        polled = await r.json();
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
      assert.equal((await again.json()).taskId, rec.taskId);
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
      assert.ok((await res.json()).error);
    } finally {
      await close(server);
    }
  });

  it('404：未知路径 / 未知 task；405：方法不符', async () => {
    const app = fakeApp();
    const { server, base } = await start(app);
    try {
      assert.equal((await fetch(`${base}/tasks/nope`)).status, 404);
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
      const rec = await res.json();
      assert.ok(runner.poll(rec.taskId), '记录应落在注入的 runner store 里');
    } finally {
      await close(server);
    }
  });
});
