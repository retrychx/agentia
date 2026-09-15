import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createOtlpExporter } from '../../src/integrations/otlp.js';
import type { Trace } from '../../src/core/trace.js';

function sampleTrace(): Trace {
  const traceId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  return {
    traceId,
    rootSpanId: rootId,
    status: 'error',
    totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: rootId,
        traceId,
        parentSpanId: null,
        kind: 'run',
        name: 'run',
        startedAt: 1000,
        endedAt: 2000,
        status: 'ok',
        attributes: { 'agent.name': 'fake' },
        events: [],
      },
      {
        spanId: childId,
        traceId,
        parentSpanId: rootId,
        kind: 'capability',
        name: 'tool:search',
        startedAt: 1100,
        endedAt: 1500,
        status: 'error',
        error: { type: 'tool', message: 'boom', retryable: false },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attributes: { ok: true, score: 1.5 },
        events: [{ time: 1200, name: 'tool.input', body: { q: 'hi' } }],
      },
    ],
  };
}

interface Captured {
  url?: string;
  contentType?: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function startCollector(
  statusCode: number,
): Promise<{ server: Server; base: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({
        url: req.url,
        contentType: req.headers['content-type'],
        body: JSON.parse(raw),
      });
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(statusCode === 200 ? '{}' : 'collector exploded');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, captured };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

describe('createOtlpExporter', () => {
  it('POST /v1/traces：Trace → OTLP/JSON 结构正确', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const exporter = createOtlpExporter({
        endpoint: `${base}/`, // 尾部斜杠应被容忍
        serviceName: 'test-svc',
        headers: { 'x-api-key': 'secret' },
      });
      const trace = sampleTrace();
      await exporter.export(trace);

      assert.equal(captured.length, 1);
      const c = captured[0];
      assert.equal(c.url, '/v1/traces');
      assert.match(c.contentType ?? '', /application\/json/);

      const rs = c.body.resourceSpans[0];
      assert.deepEqual(rs.resource.attributes, [
        { key: 'service.name', value: { stringValue: 'test-svc' } },
      ]);

      const spans = rs.scopeSpans[0].spans;
      assert.equal(spans.length, 2);

      // 根 span：hex id、无 parent、纳秒时间、OK 状态
      const root = spans[0];
      assert.equal(root.traceId, trace.traceId.replaceAll('-', ''));
      assert.equal(root.spanId, trace.spans[0].spanId.replaceAll('-', ''));
      assert.equal(root.parentSpanId, undefined);
      assert.equal(root.kind, 1);
      assert.equal(root.startTimeUnixNano, String(1000 * 1e6));
      assert.equal(root.endTimeUnixNano, String(2000 * 1e6));
      assert.deepEqual(root.status, { code: 'STATUS_CODE_OK' });
      assert.deepEqual(root.attributes, [{ key: 'agent.name', value: { stringValue: 'fake' } }]);

      // 子 span：parent hex、ERROR 状态带 message、usage 展平、events 映射
      const child = spans[1];
      assert.equal(child.parentSpanId, trace.spans[0].spanId.replaceAll('-', ''));
      assert.equal(child.name, 'tool:search');
      assert.deepEqual(child.status, { code: 'STATUS_CODE_ERROR', message: 'boom' });
      const attrByKey = Object.fromEntries(
        child.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      assert.deepEqual(attrByKey['ok'], { boolValue: true });
      assert.deepEqual(attrByKey['score'], { doubleValue: 1.5 });
      assert.deepEqual(attrByKey['usage.inputTokens'], { intValue: '10' });
      assert.deepEqual(attrByKey['usage.outputTokens'], { intValue: '5' });

      assert.equal(child.events.length, 1);
      assert.equal(child.events[0].timeUnixNano, String(1200 * 1e6));
      assert.equal(child.events[0].name, 'tool.input');
      assert.deepEqual(child.events[0].attributes, [{ key: 'q', value: { stringValue: 'hi' } }]);
    } finally {
      await close(server);
    }
  });

  it('serviceName 缺省为 agentia', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      await createOtlpExporter({ endpoint: base }).export(sampleTrace());
      assert.deepEqual(captured[0].body.resourceSpans[0].resource.attributes, [
        { key: 'service.name', value: { stringValue: 'agentia' } },
      ]);
    } finally {
      await close(server);
    }
  });

  it('非 2xx 抛错：含状态码与响应片段', async () => {
    const { server, base } = await startCollector(500);
    try {
      const exporter = createOtlpExporter({ endpoint: base });
      await assert.rejects(exporter.export(sampleTrace()), /HTTP 500.*collector exploded/);
    } finally {
      await close(server);
    }
  });

  it('collector 半开（accept 不回包）→ 按 timeoutMs 超时 reject，不永久挂起 run 收尾', async () => {
    // 接受连接却永不写响应 —— 裸 fetch 在这种 collector 上会永远挂起
    const server = createServer(() => {
      /* 故意不回包，模拟半开连接 */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const exporter = createOtlpExporter({
        endpoint: `http://127.0.0.1:${port}`,
        timeoutMs: 100,
      });
      // reject 后由上层 flushSinks 的 catch 吞掉（观测失败不击穿业务）
      await assert.rejects(exporter.export(sampleTrace()), (e: unknown) => {
        assert.equal((e as { name?: string }).name, 'TimeoutError');
        return true;
      });
    } finally {
      // 中止的 fetch 应已断开，但保险起见强制清掉残留连接，否则 close 会等它
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await close(server);
    }
  });

  it('纳秒时间戳走 BigInt：epoch 毫秒 ×1e6 超 2^53，double 直接乘会丢精度', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const exporter = createOtlpExporter({ endpoint: base });
      const trace = sampleTrace();
      const epochMs = 1_757_894_400_123; // 真实 epoch 毫秒量级；×1e6 ≈ 1.76e18 > 2^53
      trace.spans[0]!.startedAt = epochMs;
      trace.spans[0]!.endedAt = epochMs + 5;
      await exporter.export(trace);
      const root = captured[0].body.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(root.startTimeUnixNano, String(BigInt(epochMs) * 1_000_000n));
      assert.equal(root.endTimeUnixNano, String(BigInt(epochMs + 5) * 1_000_000n));
    } finally {
      await close(server);
    }
  });
});
