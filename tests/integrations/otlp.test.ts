import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createOtlpExporter } from '../../src/integrations/otlp.js';
// 投影**单一真源**在 core/trace.ts：断言用它而不是就地写 `replaceAll().slice(0,16)` ——
// 这样「导出的 span id 就是出站 traceparent 里那个 span id」是被钉住的，改成别的切法立刻红。
import { type Trace, wireSpanId, wireTraceId } from '../../src/core/trace.js';

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
  url?: string | undefined;
  contentType?: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: OTLP/JSON 是外部协议信封，测试逐字段断言 —— 写全类型只是把 envelope 抄一遍，抄错反而更危险
  body: any;
}

async function startCollector(
  statusCode: number,
  responseBody = statusCode === 200 ? '{}' : 'collector exploded',
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
      res.end(responseBody);
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

      // 根 span：hex id（trace 32 位 / span 16 位 —— OTLP 契约的两种宽度）、无 parent、
      // 纳秒时间、OK 状态。内部 id 是 UUID（32 hex），span 侧必须截断。
      const root = spans[0];
      assert.equal(root.traceId, wireTraceId(trace.traceId));
      assert.equal(root.spanId, wireSpanId(trace.spans[0].spanId));
      assert.equal(root.parentSpanId, undefined);
      assert.equal(root.kind, 1);
      assert.equal(root.startTimeUnixNano, String(1000 * 1e6));
      assert.equal(root.endTimeUnixNano, String(2000 * 1e6));
      assert.deepEqual(root.status, { code: 1 });
      assert.deepEqual(root.attributes, [
        { key: 'agent.name', value: { stringValue: 'fake' } },
        { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
        { key: 'gen_ai.agent.name', value: { stringValue: 'run' } },
      ]);

      // 子 span：parent hex、ERROR 状态带 message、usage 展平、events 映射
      const child = spans[1];
      assert.equal(child.parentSpanId, wireSpanId(trace.spans[0].spanId));
      assert.equal(child.name, 'tool:search');
      assert.deepEqual(child.status, { code: 2, message: 'boom' });
      const attrByKey = Object.fromEntries(
        child.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      assert.deepEqual(attrByKey.ok, { boolValue: true });
      assert.deepEqual(attrByKey.score, { doubleValue: 1.5 });
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

  it('GenAI semconv：三类 span 追加 gen_ai.* 键（既有 usage.* 保留），score 事件译为 gen_ai.evaluation.result', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const traceId = randomUUID();
      const rootId = randomUUID();
      const trace: Trace = {
        traceId,
        rootSpanId: rootId,
        status: 'ok',
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        spans: [
          {
            spanId: rootId,
            traceId,
            parentSpanId: null,
            kind: 'run',
            name: 'my-app',
            startedAt: 1000,
            endedAt: 2000,
            status: 'ok',
            attributes: { 'session.id': 'sess-1' },
            events: [
              {
                time: 1900,
                name: 'score',
                body: { name: 'faithfulness', value: 0.75, source: 'eval-x', comment: 'ok' },
              },
              { time: 1901, name: 'score', body: { name: 'pass', value: 1 } }, // 整型分、无 source/comment
              { time: 1902, name: 'compaction', body: { dropped: 3 } }, // 非 score 事件原名转发
            ],
          },
          {
            spanId: randomUUID(),
            traceId,
            parentSpanId: rootId,
            kind: 'llm.turn',
            name: 'claude-opus-5',
            startedAt: 1100,
            endedAt: 1500,
            status: 'ok',
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
            attributes: {},
            events: [],
          },
          {
            spanId: randomUUID(),
            traceId,
            parentSpanId: rootId,
            kind: 'capability',
            // ⚠️ 生产形状：capability span 的 name 是**裸能力名**，类型靠 attributes 区分
            //（toolkit/subagent.ts / skill.ts 就是这么写的）。写成 'skill:search' 会让
            // 「按名字前缀判类型」这种错实现看起来是对的 —— 这个夹具曾经如此。
            name: 'search',
            startedAt: 1500,
            endedAt: 1600,
            status: 'ok',
            attributes: { skill: 'search' },
            events: [],
          },
          {
            spanId: randomUUID(),
            traceId,
            parentSpanId: rootId,
            kind: 'capability',
            name: 'researcher', // 生产形状：裸名 + attributes.subagent
            startedAt: 1600,
            endedAt: 1800,
            status: 'ok',
            attributes: { subagent: 'researcher' },
            events: [],
          },
        ],
      };
      await createOtlpExporter({ endpoint: base }).export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;

      // OTLP 契约：trace id 16 字节（32 hex）、span id 8 字节（16 hex）。
      // 内部是 UUID（32 hex），span 侧必须截到 16 —— 发 32 位给真 collector 会被判
      // invalid span_id（拒收）或按前 16 位截断。
      assert.equal(spans[0].traceId.length, 32, 'trace id 是 32 hex');
      assert.equal(spans[0].spanId.length, 16, 'span id 必须是 16 hex');
      assert.equal(spans[1].parentSpanId.length, 16, '父 span id 同宽');
      const attrByKey = (span: { attributes: Array<{ key: string; value: unknown }> }) =>
        Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );

      // run 根 span：invoke_agent + agent.name + conversation.id（session.id 原样保留）
      const root = attrByKey(spans[0]);
      assert.deepEqual(root['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
      assert.deepEqual(root['gen_ai.agent.name'], { stringValue: 'my-app' });
      assert.deepEqual(root['gen_ai.conversation.id'], { stringValue: 'sess-1' });
      assert.deepEqual(root['session.id'], { stringValue: 'sess-1' });

      // llm.turn：chat + request.model + usage token（int），既有 usage.* 仍在
      const turn = attrByKey(spans[1]);
      assert.deepEqual(turn['gen_ai.operation.name'], { stringValue: 'chat' });
      assert.deepEqual(turn['gen_ai.request.model'], { stringValue: 'claude-opus-5' });
      assert.deepEqual(turn['gen_ai.usage.input_tokens'], { intValue: '10' });
      assert.deepEqual(turn['gen_ai.usage.output_tokens'], { intValue: '5' });
      assert.deepEqual(turn['usage.inputTokens'], { intValue: '10' });
      assert.deepEqual(turn['usage.outputTokens'], { intValue: '5' });

      // capability：skill → execute_tool + tool.name；subagent → invoke_agent + agent.name
      const skill = attrByKey(spans[2]);
      assert.deepEqual(skill['gen_ai.operation.name'], { stringValue: 'execute_tool' });
      assert.deepEqual(skill['gen_ai.tool.name'], { stringValue: 'search' });
      const sub = attrByKey(spans[3]);
      assert.deepEqual(sub['gen_ai.operation.name'], { stringValue: 'invoke_agent' });
      assert.deepEqual(sub['gen_ai.agent.name'], { stringValue: 'researcher' });

      // score 事件 → gen_ai.evaluation.result；非 score 事件名不变
      const events = spans[0].events;
      assert.equal(events[0].name, 'gen_ai.evaluation.result');
      const scoreAttrs = Object.fromEntries(
        events[0].attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      // semconv 无 gen_ai.evaluation.score.name；维度名是 gen_ai.evaluation.name
      assert.deepEqual(scoreAttrs['gen_ai.evaluation.name'], {
        stringValue: 'faithfulness',
      });
      assert.deepEqual(scoreAttrs['gen_ai.evaluation.score.value'], { doubleValue: 0.75 });
      assert.deepEqual(scoreAttrs['agentia.score.source'], { stringValue: 'eval-x' });
      assert.deepEqual(scoreAttrs['agentia.score.comment'], { stringValue: 'ok' });

      // 整型分也发 doubleValue；无 source/comment 时这两个键不出现
      assert.equal(events[1].name, 'gen_ai.evaluation.result');
      const bare = Object.fromEntries(
        events[1].attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
      );
      assert.deepEqual(bare['gen_ai.evaluation.score.value'], { doubleValue: 1 });
      assert.equal('agentia.score.source' in bare, false);
      assert.equal('agentia.score.comment' in bare, false);

      assert.equal(events[2].name, 'compaction');
    } finally {
      await close(server);
    }
  });
  it('span links：上游链路映射成 OTLP links（宽度规则同 parentSpanId），无 link 不发键', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const exporter = createOtlpExporter({ endpoint: base });
      const trace = sampleTrace();
      const upTrace = randomUUID();
      const upSpan = randomUUID();
      // ① 完整 link（trace + span）② 只有 trace 粒度（无 spanId 键）
      trace.spans[0].links = [{ traceId: upTrace, spanId: upSpan }, { traceId: upTrace }];
      await exporter.export(trace);

      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.deepEqual(spans[0].links, [
        {
          traceId: wireTraceId(upTrace),
          spanId: wireSpanId(upSpan),
        },
        { traceId: wireTraceId(upTrace) },
      ]);
      // 空数组会让部分后端把 span 标成「有链路」—— 没 link 的 span 不发这个键
      assert.equal('links' in spans[1], false);
    } finally {
      await close(server);
    }
  });

  it('事件 body 里的显式 undefined 不产出非法 AnyValue（与 span 属性口径一致：跳过）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      const trace = sampleTrace();
      trace.spans[1]!.events.push({
        time: 1300,
        name: 'tool.partial',
        body: { a: undefined, b: 1 },
      });
      await createOtlpExporter({ endpoint: base }).export(trace);

      const ev = captured[0].body.resourceSpans[0].scopeSpans[0].spans[1].events[1];
      assert.equal(ev.name, 'tool.partial');
      // undefined 值被跳过；正常的 b 仍在
      assert.deepEqual(ev.attributes, [{ key: 'b', value: { intValue: '1' } }]);
      // {stringValue: JSON.stringify(undefined)} 会序列化成 {"key":"a","value":{}} —— 非法 AnyValue
      const raw = JSON.stringify(captured[0].body);
      assert.ok(!raw.includes('"key":"a"'), 'undefined 值不得序列化成空 AnyValue');
    } finally {
      await close(server);
    }
  });

  /**
   * OTLP/JSON 的 **enum 必须整数编码**（规范原文：enum 字段用整数值编码，禁止 enum 名）。
   * 这条守的是一个真实缺陷 + 一个假绿机制：status 曾发 `'STATUS_CODE_OK'` 字符串，而本地
   * 假 collector 只做 `JSON.parse` —— 断言跟着写成字符串，于是 CI 一直绿，严格 collector
   * 却会判非法并整批拒收。所以这里**扫整个 payload 的 enum 名**，而不是只比一个字段。
   */
  it('enum 一律整数编码：payload 里不得出现任何 OTLP enum 名（整批拒收那个坑）', async () => {
    const { server, base, captured } = await startCollector(200);
    try {
      await createOtlpExporter({ endpoint: base }).export(sampleTrace());

      const raw = JSON.stringify(captured[0].body);
      const enumNames =
        raw.match(/"(?:STATUS_CODE|SPAN_KIND|SEVERITY_NUMBER|AGGREGATION_TEMPORALITY)_[A-Z_]+"/g) ??
        [];
      assert.deepEqual(
        enumNames,
        [],
        `OTLP/JSON 的 enum 必须整数编码，不得出现 enum 名：${enumNames.join(', ')}`,
      );
      const spans = captured[0].body.resourceSpans[0].scopeSpans[0].spans;
      assert.equal(typeof spans[0].kind, 'number', 'kind 必须是整数');
      assert.equal(typeof spans[0].status.code, 'number', 'status.code 必须是整数');
      assert.equal(spans[0].status.code, 1, '1 = STATUS_CODE_OK');
      assert.equal(spans[1].status.code, 2, '2 = STATUS_CODE_ERROR');
    } finally {
      await close(server);
    }
  });

  /*
   * HTTP 200 **不等于「全部接收」**：规范允许 collector 用 200 + `partialSuccess` 说
   * 「收了一部分」（例如某条 span 属性过大被丢）。原先只查 `res.ok` ⇒ 静默当成完全成功：
   * 看板少数据，而框架说一切正常。
   * 两条判据缺一不可 —— ① 200 + 真拒收 ⇒ 报错；② 200 + `partialSuccess` 在场但零拒收
   * ⇒ **是「全部接收」的另一种写法**（有 collector 恒发这个键），不得当失败。
   */
  it('HTTP 200 + partialSuccess 真拒收 → 按部分接收报错（status 仍带 200）', async () => {
    const { server, base } = await startCollector(
      200,
      JSON.stringify({ partialSuccess: { rejectedSpans: 3, errorMessage: 'attribute too large' } }),
    );
    try {
      await assert.rejects(
        () => createOtlpExporter({ endpoint: base }).export(sampleTrace()),
        (e: unknown) => {
          assert.match((e as Error).message, /部分接收/);
          assert.match((e as Error).message, /rejected_spans=3/);
          assert.match((e as Error).message, /attribute too large/);
          assert.equal(
            (e as { status?: number }).status,
            200,
            'status 带 200：宿主据此区分「collector 拒收了一部分」与「连不上」',
          );
          return true;
        },
      );

      // 给了 onExportError：交回调、不抛（宿主自己决定告警/计数后继续）——
      // 这是 TraceSink 失败缺省被吞掉时**唯一**能收到这条消息的路（见 usage-guide §7）
      const seen: unknown[] = [];
      await createOtlpExporter({
        endpoint: base,
        onExportError: (err) => seen.push(err),
      }).export(sampleTrace());
      assert.equal(seen.length, 1, '给了回调就该收到，而不是抛出去');
      assert.match(String((seen[0] as Error).message), /部分接收/);
    } finally {
      await close(server);
    }
  });

  it('partialSuccess 在场但零拒收 → 是「全部接收」，不得报错（在场 ≠ 拒收）', async () => {
    // int64 走字符串编码 + 空 errorMessage：两种「没有拒收」的写法一次覆盖
    const { server, base } = await startCollector(
      200,
      JSON.stringify({ partialSuccess: { rejectedSpans: '0', errorMessage: '' } }),
    );
    try {
      await createOtlpExporter({ endpoint: base }).export(sampleTrace());
    } finally {
      await close(server);
    }
  });
});
