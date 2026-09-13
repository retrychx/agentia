import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, createHttpHandler, metricsSink, SystemPrompt } from '../../src/index.js';

/**
 * G4 —— `GET /metrics` 内建接线。
 * 之前框架内建了 `/healthz` 却不给指标路由，用户得自己在 handler 外层接 ——
 * 健康与指标是同一档运维需求，落点应当一致。
 */

function makeApp() {
  return createApp({ name: 'metrics-svc', system: new SystemPrompt().add('r', 'you are a bot') });
}

async function start(
  opts: Parameters<typeof createHttpHandler>[1] = {},
): Promise<{ server: Server; base: string }> {
  const handler = createHttpHandler(makeApp(), opts);
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

describe('G4 GET /metrics', () => {
  it('提供 metrics → 200 + Prometheus 文本，内容即 render()', async () => {
    const sink = metricsSink({ prefix: 'svc_' });
    sink.export({
      traceId: 't',
      rootSpanId: 'r',
      status: 'ok',
      totalUsage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
      spans: [
        {
          spanId: 'r',
          traceId: 't',
          parentSpanId: null,
          kind: 'run',
          name: 'agent.run',
          startedAt: 0,
          endedAt: 5,
          status: 'ok',
          attributes: {},
          events: [],
        },
      ],
    });
    const { server, base } = await start({ metrics: sink });
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/plain; version=0\.0\.4/);
      const body = await res.text();
      assert.equal(body, sink.render());
      assert.match(body, /svc_runs_total 1/);
    } finally {
      await close(server);
    }
  });

  it('也接受「返回字符串的闭包」（框架只给缝，不知道指标从哪来）', async () => {
    const { server, base } = await start({ metrics: () => '# custom\nfoo 1\n' });
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '# custom\nfoo 1\n');
    } finally {
      await close(server);
    }
  });

  it('不提供 metrics → 该路径 404（不占坑、不假装有指标）', async () => {
    const { server, base } = await start();
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 404);
    } finally {
      await close(server);
    }
  });

  it('方法不符 → 405 带 Allow: GET', async () => {
    const sink = metricsSink();
    const { server, base } = await start({ metrics: sink });
    try {
      const res = await fetch(`${base}/metrics`, { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET');
    } finally {
      await close(server);
    }
  });

  it('与 /healthz 同档：**不鉴权**（鉴权钩子不会被调用）', async () => {
    const seen: string[] = [];
    const sink = metricsSink();
    const { server, base } = await start({
      metrics: sink,
      authenticate: (req) => {
        seen.push(req.url ?? '');
        return true;
      },
    });
    try {
      assert.equal((await fetch(`${base}/metrics`)).status, 200);
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.deepEqual(seen, [], '两个运维端点都不该过鉴权钩子');
    } finally {
      await close(server);
    }
  });

  it('停机中仍可拉（抓取端不该在停机窗口断档）', async () => {
    const sink = metricsSink();
    const handler = createHttpHandler(makeApp(), { metrics: sink });
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await handler.drain({ timeoutMs: 0 });
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(res.status, 200, '与 /healthz 同理：进程活着就能回答');
    } finally {
      await close(server);
    }
  });
});
