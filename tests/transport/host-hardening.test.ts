import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHttpHandler, HttpException } from '../../src/index.js';
import { AsyncRunner } from '../../src/index.js';
import type { AppCallable, HttpHandler } from '../../src/index.js';
import type { AgentRunResult } from '../../src/index.js';

/**
 * Phase B（宿主硬化）：B1 鉴权缝 + B2 优雅停机 / 健康检查。
 * 设计文档：docs/plans/2026-09-11-agent-service-hardening.md §4
 */

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

function fakeApp(over: Partial<AppCallable> = {}): AppCallable & { seen: number } {
  let count = 0;
  const app: AppCallable & { seen: number } = {
    name: 'fake',
    seen: 0,
    async run() {
      count++;
      app.seen = count;
      return {
        run: { runId: `r-${count}`, status: 'succeeded' as const },
        result: fakeResult('ok'),
      };
    },
    ...over,
  };
  return app;
}

/** 起一个监听随机端口的服务，返回 handler（要测 drain/runner 时用得到） */
async function listen(
  app: AppCallable,
  opts?: Parameters<typeof createHttpHandler>[1],
): Promise<{ server: Server; base: string; handler: HttpHandler }> {
  const handler = createHttpHandler(app, opts);
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, handler };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** 跑一段代码并吞掉 console.error（鉴权钩子抛错会按设计打日志，测试里不需要看） */
async function withSilencedErr<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

describe('B1 鉴权缝（authenticate）', () => {
  it('通过 → 照常处理；钩子收到原始请求', async () => {
    const app = fakeApp();
    let seenUrl: string | undefined;
    let seenMethod: string | undefined;
    const { server, base } = await listen(app, {
      authenticate: (req) => {
        seenUrl = req.url;
        seenMethod = req.method;
      },
    });
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      });
      assert.equal(res.status, 200);
      assert.equal((await readJson(res)).status, 'succeeded');
      assert.equal(seenUrl, '/run');
      assert.equal(seenMethod, 'POST');
    } finally {
      await close(server);
    }
  });

  it('异步钩子 reject 也算未通过（钩子可以是 Promise）', async () => {
    const app = fakeApp();
    const { server, base } = await listen(app, {
      authenticate: async () => {
        throw new Error('token 过期');
      },
    });
    try {
      await withSilencedErr(async () => {
        const res = await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('hi') });
        assert.equal(res.status, 401);
        assert.equal((await readJson(res)).error, '未通过鉴权');
        assert.equal(app.seen, 0, '未通过鉴权不得进入 run');
      });
    } finally {
      await close(server);
    }
  });

  it('抛普通错误 → 401 通用文案；原文只进日志（不回内部细节）', async () => {
    const app = fakeApp();
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    const { server, base } = await listen(app, {
      authenticate: () => {
        throw new Error('ECONNREFUSED 10.0.0.7:6379');
      },
    });
    try {
      const res = await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('hi') });
      assert.equal(res.status, 401);
      const body = await readJson(res);
      assert.equal(body.error, '未通过鉴权');
      assert.ok(
        !JSON.stringify(body).includes('ECONNREFUSED'),
        '内部拓扑不得回给未鉴权调用方（与 exposeErrors 同策略）',
      );
      assert.equal(logged.length, 1, '细节必须在服务端日志里可见');
    } finally {
      console.error = orig;
      await close(server);
    }
  });

  it('抛 HttpException → 按其 status / body 回（想回 403 就抛 403）', async () => {
    const app = fakeApp();
    const { server, base } = await listen(app, {
      authenticate: () => {
        throw new HttpException(403, { error: '无权访问该租户', tenant: 'acme' });
      },
    });
    try {
      const res = await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('hi') });
      assert.equal(res.status, 403);
      const body = await readJson(res);
      assert.equal(body.error, '无权访问该租户');
      assert.equal(body.tenant, 'acme');
      assert.equal(app.seen, 0);
    } finally {
      await close(server);
    }
  });

  it('HttpException 缺省 body → { error: "HTTP <status>" }', () => {
    const e = new HttpException(401);
    assert.equal(e.status, 401);
    assert.deepEqual(e.body, { error: 'HTTP 401' });
    assert.equal(e.name, 'HttpException');
    assert.ok(e instanceof Error);
  });

  it('鉴权先于读 body：同一超限请求，鉴权失败回 401、通过才回 413', async () => {
    const app = fakeApp();
    const big = JSON.stringify({ prompt: 'x'.repeat(4096) });

    // ① 鉴权失败 → 401（body 一个字节都没收，maxBodyBytes 根本没机会触发）
    const failing = await listen(app, {
      maxBodyBytes: 1024,
      authenticate: () => {
        throw new Error('nope');
      },
    });
    try {
      await withSilencedErr(async () => {
        const res = await fetch(`${failing.base}/run`, { method: 'POST', body: big });
        assert.equal(res.status, 401, '鉴权必须在读 body 之前，否则会先撞 413');
        // 连接不可复用的判定由「拒绝响应」组用假 req/res 确定性覆盖（不依赖分包时序）
      });
    } finally {
      await close(failing.server);
    }

    // ② 鉴权通过 → 才轮到 body 上限（413）
    const passing = await listen(app, { maxBodyBytes: 1024, authenticate: () => true });
    try {
      const res = await fetch(`${passing.base}/run`, { method: 'POST', body: big });
      assert.equal(res.status, 413);
    } finally {
      await close(passing.server);
    }
  });

  it('/healthz 不鉴权 —— 探针带不了凭据，鉴权再严也得回', async () => {
    const app = fakeApp();
    let called = 0;
    const { server, base } = await listen(app, {
      authenticate: () => {
        called++;
        throw new Error('一律拒绝');
      },
    });
    try {
      await withSilencedErr(async () => {
        const res = await fetch(`${base}/healthz`);
        assert.equal(res.status, 200);
        assert.equal((await readJson(res)).ok, true);
        assert.equal(called, 0, '/healthz 不该触发鉴权钩子');
        // 但别的路径照拒
        assert.equal((await fetch(`${base}/tasks/nope`)).status, 401);
      });
    } finally {
      await close(server);
    }
  });

  it('除 /healthz 外所有路径都过鉴权（含 GET /tasks/<id> 与未知路径）', async () => {
    const app = fakeApp();
    const { server, base } = await listen(app, {
      authenticate: () => {
        throw new Error('nope');
      },
    });
    try {
      await withSilencedErr(async () => {
        assert.equal((await fetch(`${base}/tasks/whatever`)).status, 401);
        assert.equal((await fetch(`${base}/nope`)).status, 401, '不暴露路径是否存在');
        assert.equal(
          (await fetch(`${base}/tasks`, { method: 'POST', body: JSON.stringify({ input: 'a' }) })).status,
          401,
        );
      });
    } finally {
      await close(server);
    }
  });

  it('不配 authenticate → 行为完全不变（零破坏）', async () => {
    const app = fakeApp();
    const { server, base } = await listen(app);
    try {
      const res = await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('hi') });
      assert.equal(res.status, 200);
      assert.equal((await fetch(`${base}/nope`)).status, 404);
    } finally {
      await close(server);
    }
  });
});

describe('拒绝响应：body 未消费时标记连接不可复用', () => {
  /**
   * 用假 req/res 直接验判定，不依赖真实 socket 的分包时序。
   * `complete=false`（body 还没收到）= 我们没消费它 → 连接必须关，否则残留字节会被
   * 当成下一个请求（与 413 同理）；`complete=true` 时 Node 会 dump 掉未读 body，连接可复用。
   */
  function fakeReqRes(complete: boolean) {
    const emitter = new EventEmitter();
    Object.assign(emitter, { method: 'POST', url: '/run', complete, headers: {} });
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      writeHead: () => {},
      end: () => {},
    };
    return {
      req: emitter as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      headers,
    };
  }

  it('401（HttpException）', async () => {
    const handler = createHttpHandler(fakeApp(), {
      authenticate: () => {
        throw new HttpException(401, { error: 'no' });
      },
    });
    const incomplete = fakeReqRes(false);
    await handler(incomplete.req, incomplete.res);
    assert.equal(incomplete.headers.connection, 'close', 'body 未消费必须关连接');

    const done = fakeReqRes(true);
    await handler(done.req, done.res);
    assert.equal(done.headers.connection, undefined, 'body 已收全 → Node 会 dump，连接可复用');
  });

  it('503（停机中拒新单）', async () => {
    const { server, handler } = await listen(fakeApp());
    try {
      await handler.drain();
      const incomplete = fakeReqRes(false);
      await handler(incomplete.req, incomplete.res);
      assert.equal(incomplete.headers['retry-after'], '1');
      assert.equal(incomplete.headers.connection, 'close');
    } finally {
      await close(server);
    }
  });
});

describe('B2 健康检查（GET /healthz）', () => {
  it('空载：ok / inFlight=0 / uptimeMs / draining=false', async () => {
    const { server, base } = await listen(fakeApp());
    try {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await readJson(res);
      assert.equal(body.ok, true);
      assert.equal(body.inFlight, 0);
      assert.equal(body.draining, false);
      assert.equal(typeof body.uptimeMs, 'number');
      assert.ok(body.uptimeMs >= 0);
    } finally {
      await close(server);
    }
  });

  it('在飞任务计入 inFlight（queued 的也算）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp({
      run: async () => {
        await gate;
        return { run: { runId: 'r-1', status: 'succeeded' as const }, result: fakeResult('ok') };
      },
    });
    const runner = new AsyncRunner(app, { concurrency: 1 });
    const { server, base, handler } = await listen(app, { runner });
    try {
      await fetch(`${base}/tasks`, { method: 'POST', body: JSON.stringify({ input: 'a' }) });
      await fetch(`${base}/tasks`, { method: 'POST', body: JSON.stringify({ input: 'b' }) });
      assert.ok(await waitFor(() => handler.runner.inFlight >= 1));
      const body = await readJson(await fetch(`${base}/healthz`));
      assert.equal(body.inFlight, 2, 'runner 的在飞数应由 /healthz 反映（一个在跑、一个排队）');
      release();
      assert.ok(await waitFor(() => handler.runner.inFlight === 0));
      assert.equal((await readJson(await fetch(`${base}/healthz`))).inFlight, 0);
    } finally {
      release();
      await close(server);
    }
  });

  it('同步在飞 /run 也计入 inFlight（与 drain 的等待范围一致）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const app = fakeApp({
      run: async () => {
        started();
        await gate;
        return { run: { runId: 'r-1', status: 'succeeded' as const }, result: fakeResult('ok') };
      },
    });
    const { server, base } = await listen(app);
    try {
      const p = fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('hi') });
      await begun; // 确定性：run 真开始了再问 healthz
      assert.equal((await readJson(await fetch(`${base}/healthz`))).inFlight, 1);
      release();
      await p;
      assert.equal((await readJson(await fetch(`${base}/healthz`))).inFlight, 0);
    } finally {
      release();
      await close(server);
    }
  });

  it('非 GET → 405（带 Allow）', async () => {
    const { server, base } = await listen(fakeApp());
    try {
      const res = await fetch(`${base}/healthz`, { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET');
    } finally {
      await close(server);
    }
  });
});

describe('B2 优雅停机（drain）', () => {
  it('无在飞 → 立即 true', async () => {
    const { server, handler } = await listen(fakeApp());
    try {
      assert.equal(await handler.drain(), true);
    } finally {
      await close(server);
    }
  });

  it('有在飞任务 → 等它收尾再返回 true；之后拒新单、但仍可轮询结果', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp({
      run: async () => {
        await gate;
        return { run: { runId: 'r-1', status: 'succeeded' as const }, result: fakeResult('ok') };
      },
    });
    const { server, base, handler } = await listen(app);
    try {
      const submit = await fetch(`${base}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ input: 'a' }),
      });
      const rec = await readJson(submit);
      assert.ok(await waitFor(() => handler.runner.inFlight === 1));

      // drain 未完成前不该 resolve
      let drained: boolean | undefined;
      const p = handler.drain({ timeoutMs: 2000 }).then((v) => {
        drained = v;
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(drained, undefined, 'drain 必须等在飞任务，不能立刻返回');

      // 先验「已进停机」：新单立刻 503（drain 里 draining=true 在最前）
      const rejected = await fetch(`${base}/tasks`, { method: 'POST', body: JSON.stringify({ input: 'b' }) });
      assert.equal(rejected.status, 503);
      assert.equal(rejected.headers.get('retry-after'), '1');
      assert.equal(
        (await fetch(`${base}/run`, { method: 'POST', body: JSON.stringify('x') })).status,
        503,
      );

      release();
      await p;
      assert.equal(drained, true, '任务收尾后 drain 应返回 true');
      assert.equal(handler.runner.inFlight, 0);

      // 停机中仍能轮询到结果（否则调用方拿不到在飞任务的结果）
      const poll = await fetch(`${base}/tasks/${rec.taskId}`);
      assert.equal(poll.status, 200);
      assert.equal((await readJson(poll)).status, 'succeeded');
      // /healthz 仍在、并报告 draining
      const health = await readJson(await fetch(`${base}/healthz`));
      assert.equal(health.ok, true);
      assert.equal(health.draining, true);
    } finally {
      release();
      await close(server);
    }
  });

  it('超时 → false（任务留在 store 里，等下次 resumePending 续跑）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = fakeApp({
      run: async () => {
        await gate;
        return { run: { runId: 'r-1', status: 'succeeded' as const }, result: fakeResult('ok') };
      },
    });
    const { server, base, handler } = await listen(app);
    try {
      await fetch(`${base}/tasks`, { method: 'POST', body: JSON.stringify({ input: 'a' }) });
      assert.ok(await waitFor(() => handler.runner.inFlight === 1));
      assert.equal(await handler.drain({ timeoutMs: 30 }), false, '超时应返回 false');
      const recs = await handler.runner.list();
      assert.equal(recs.length, 1, '未完成的任务仍在 store 里（不是丢弃）');
      release();
    } finally {
      release();
      await close(server);
    }
  });

  it('收口长连 SSE：drain 会关掉仍挂着的流', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const app: AppCallable = {
      name: 'streamer',
      async run(_messages, opts) {
        opts?.onText?.('片段');
        started();
        // 挂住：只有被 abort（res close）才返回
        await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => resolve()));
        return { run: { runId: 'r-sse', status: 'failed' }, result: fakeResult('片段') };
      },
    };
    const { server, base, handler } = await listen(app);
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 200);
      const textPromise = res.text(); // 服务端关掉流之后才 resolve
      await begun; // 确定性：run 真开始了再 drain

      // 流不会自己结束 → drain 等满超时后强制收口，返回 false（没排空干净）
      assert.equal(await handler.drain({ timeoutMs: 50 }), false);
      const text = await textPromise;
      assert.ok(text.includes('片段'), '关流前已下发的增量还在');
    } finally {
      await close(server);
    }
  });
});

describe('AsyncRunner.drain（B2 的 runner 侧）', () => {
  it('停机后 submit 抛错；queued 任务也会被等到', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app: AppCallable = {
      name: 'fake',
      async run() {
        await gate;
        return { run: { runId: 'r', status: 'succeeded' }, result: {} as AgentRunResult };
      },
    };
    const runner = new AsyncRunner(app, { concurrency: 1 });
    runner.submit('a');
    runner.submit('b'); // 排队（concurrency=1）
    assert.equal(runner.inFlight, 2);

    const p = runner.drain();
    assert.equal(runner.isDraining, true);
    assert.throws(() => runner.submit('c'), /停机/);

    release();
    assert.equal(await p, true);
    assert.equal(runner.inFlight, 0);
  });

  it('刚 submit 就被 drain 也不漏（计数在同步段自增）', async () => {
    const app: AppCallable = {
      name: 'fake',
      async run() {
        await new Promise((r) => setTimeout(r, 10));
        return { run: { runId: 'r', status: 'succeeded' }, result: {} as AgentRunResult };
      },
    };
    const runner = new AsyncRunner(app);
    runner.submit('a');
    // 同步段：submit 返回时任务已计入 inFlight
    assert.equal(runner.inFlight, 1);
    assert.equal(await runner.drain({ timeoutMs: 1000 }), true);
  });
});
