import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, metricsSink, SystemPrompt } from '../../src/index.js';
import type { Span, Trace } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/** 造一条只有根 span 的 trace：durationMs=undefined 表示根未收尾 */
function traceOf(opts: {
  status?: 'ok' | 'error';
  durationMs?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  costEstimate?: number;
}): Trace {
  const rootSpanId = 'root-1';
  const ended = opts.durationMs === undefined;
  return {
    traceId: 't-1',
    rootSpanId,
    status: opts.status ?? 'ok',
    totalUsage: {
      inputTokens: opts.input ?? 0,
      outputTokens: opts.output ?? 0,
      cacheReadTokens: opts.cacheRead ?? 0,
      cacheCreationTokens: opts.cacheCreation ?? 0,
      ...(opts.costEstimate === undefined ? {} : { costEstimate: opts.costEstimate }),
    },
    spans: [
      {
        spanId: rootSpanId,
        traceId: 't-1',
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 1000,
        ...(ended ? {} : { endedAt: 1000 + opts.durationMs! }),
        status: opts.status ?? 'ok',
        attributes: {},
        events: [],
      },
    ],
  };
}

/** 造一条**含单元与模型**的 trace：两次 llm.turn（带 tool.output 事件）+ 一个 subagent unit span */
function richTrace(): Trace {
  const root = 'root-1';
  const spans: Span[] = [
    {
      spanId: root,
      traceId: 't-rich',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 1000,
      endedAt: 1300,
      status: 'ok',
      attributes: {},
      events: [],
    },
    {
      spanId: 'turn-1',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1010,
      endedAt: 1100,
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0, costEstimate: 0.01 },
      attributes: {},
      events: [{ time: 1050, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 42 } }],
    },
    {
      spanId: 'turn-2',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1110,
      endedAt: 1200,
      status: 'ok',
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.002 },
      attributes: {},
      events: [
        { time: 1150, name: 'tool.output', body: { tool: 'search', ok: false, durationMs: 8, errorKind: 'threw' } },
        { time: 1160, name: 'tool.output', body: { tool: 'fetch', ok: true, durationMs: 100 } },
      ],
    },
    {
      spanId: 'unit-1',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'unit',
      name: 'researcher',
      startedAt: 1210,
      endedAt: 1280,
      status: 'ok',
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.012 },
      attributes: { subagent: 'researcher' },
      events: [],
    },
  ];
  return {
    traceId: 't-rich',
    rootSpanId: root,
    status: 'ok',
    totalUsage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      costEstimate: 0.012,
    },
    spans,
  };
}

describe('metricsSink（D3 基础：run 级）', () => {
  it('export 是 TraceSink 形状：createApp({ sinks }) 即接入，零新出口', async () => {
    const metrics = metricsSink();
    const app = createApp({
      name: 'metric-app',
      system: new SystemPrompt().add('role', 'r'),
      sinks: [metrics],
    });
    const { client } = mockClient([endTurnMsg('a'), endTurnMsg('b')]);
    await app.run([{ role: 'user', content: 'x' }], { client });
    await app.run([{ role: 'user', content: 'y' }], { client });
    const snap = metrics.snapshot();
    assert.equal(snap.runs, 2);
    assert.equal(snap.failed, 0);
    assert.equal(snap.tokens, 30, '两次 run（各 10+5）共 30 token');
  });

  it('token 口径 = 四类之和；costEstimate 缺失时不计成本（而不记 NaN）', () => {
    const m = metricsSink();
    m.export(traceOf({ input: 10, output: 5, cacheRead: 100, cacheCreation: 20 }));
    m.export(traceOf({ input: 1, output: 1, costEstimate: 0.5 }));
    const s = m.snapshot();
    assert.equal(s.tokens, 137, '10+5+100+20 + 1+1');
    assert.equal(s.costUsd, 0.5, '缺 costEstimate 的 run 计 0，不会污染总数');
  });

  it('failed 按 trace.status 计（budget_exceeded / aborted 收尾的 run 都是 error 态）', () => {
    const m = metricsSink();
    m.export(traceOf({ status: 'ok' }));
    m.export(traceOf({ status: 'error' }));
    m.export(traceOf({ status: 'error' }));
    assert.deepEqual([m.snapshot().runs, m.snapshot().failed], [3, 2]);
  });

  it('分位是窗口内精确值（最近 rank 法），根未收尾的 run 不进延迟样本', () => {
    const m = metricsSink();
    for (const d of [10, 20, 30, 40]) m.export(traceOf({ durationMs: d }));
    m.export(traceOf({})); // 根没 endedAt → 不计延迟
    const s = m.snapshot();
    assert.equal(s.latencyP50, 20, '4 个样本 → ceil(0.5·4)=2 → 第 2 个');
    assert.equal(s.latencyP95, 40, 'ceil(0.95·4)=4 → 第 4 个');
  });

  it('windowSize 只约束**分位样本**；histogram 计数是累积的（Prometheus 语义）', () => {
    const m = metricsSink({ windowSize: 3 });
    for (const d of [10, 20, 30, 40]) m.export(traceOf({ durationMs: d }));
    const txt = m.render();
    assert.match(txt, /agentia_run_duration_ms_count 4/, '直方图 count 记全部观测（可跨实例聚合）');
    assert.equal(m.snapshot().latencyP50, 30, '窗口内是 [40,20,30] → 排序 [20,30,40] → 中位 30');
  });

  it('render：Prometheus 文本（HELP/TYPE + label 分项 + 分位 gauge）', () => {
    const m = metricsSink();
    m.export(
      traceOf({ status: 'error', durationMs: 7, input: 3, output: 4, cacheRead: 5, cacheCreation: 6, costEstimate: 0.25 }),
    );
    const txt = m.render();
    assert.match(txt, /# TYPE agentia_runs_total counter/);
    assert.match(txt, /# HELP agentia_runs_total /);
    assert.match(txt, /^agentia_runs_total 1$/m);
    assert.match(txt, /^agentia_runs_failed_total 1$/m);
    assert.match(txt, /^agentia_tokens_total\{kind="input"\} 3$/m);
    assert.match(txt, /^agentia_tokens_total\{kind="cache_creation"\} 6$/m);
    assert.match(txt, /^agentia_cost_usd_total 0.25$/m);
    assert.match(txt, /^agentia_run_duration_ms\{quantile="0.5"\} 7$/m);
    assert.match(txt, /^agentia_run_duration_ms_count 1$/m);
  });

  it('prefix 可换；reset 清空累计（含单元/模型维度）', () => {
    const m = metricsSink({ prefix: 'myapp_' });
    m.export(traceOf({ durationMs: 1, input: 9 }));
    m.export(richTrace());
    assert.match(m.render(), /^myapp_runs_total 2$/m);
    m.reset();
    const s = m.snapshot();
    assert.deepEqual([s.runs, s.failed, s.tokens, s.costUsd], [0, 0, 0, 0]);
    assert.deepEqual(s.units, {});
    assert.deepEqual(s.models, {});
    assert.match(m.render(), /^myapp_run_duration_ms_count 0$/m);
  });

  it('windowSize / maxUnits / buckets 非法 → 构造期抛错', () => {
    assert.throws(() => metricsSink({ windowSize: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ maxUnits: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ buckets: [10, 5] }), /严格升序/);
    assert.throws(() => metricsSink({ export: 'nope' as never }), /只支持/);
  });
});

describe('E4 histogram（可聚合的分位）', () => {
  it('cumulative bucket + sum + count，le 用 +Inf 收口', () => {
    const m = metricsSink({ buckets: [50, 100] });
    for (const d of [10, 60, 500]) m.export(traceOf({ durationMs: d }));
    const txt = m.render();
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="50"\} 1$/m, '≤50 的只有 10');
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="100"\} 2$/m, '≤100：10 与 60');
    assert.match(txt, /^agentia_run_duration_ms_bucket\{le="\+Inf"\} 3$/m, '总和');
    assert.match(txt, /^agentia_run_duration_ms_sum 570$/m);
    assert.match(txt, /^agentia_run_duration_ms_count 3$/m);
  });
});

describe('E2 单元级指标', () => {
  it('工具来自 tool.output 事件；skill/subagent 来自 unit span（带 token/成本）', () => {
    const m = metricsSink();
    m.export(richTrace());
    const txt = m.render();
    assert.match(txt, /^agentia_unit_calls_total\{unit="tool:search"\} 2$/m);
    assert.match(txt, /^agentia_unit_errors_total\{unit="tool:search"\} 1$/m);
    assert.match(
      txt,
      /^agentia_unit_duration_ms\{unit="tool:search",quantile="0.5"\} 8$/m,
      '窗口内 [42,8] 排序 [8,42] → ceil(0.5·2)=1 → 8',
    );
    assert.match(txt, /^agentia_unit_duration_ms\{unit="tool:search",quantile="0.95"\} 42$/m);
    assert.match(txt, /^agentia_unit_calls_total\{unit="tool:fetch"\} 1$/m);
    assert.match(txt, /^agentia_unit_calls_total\{unit="subagent:researcher"\} 1$/m);
    assert.match(txt, /^agentia_unit_tokens_total\{unit="subagent:researcher"\} 150$/m, '120+30');
    assert.match(txt, /^agentia_unit_cost_usd_total\{unit="subagent:researcher"\} 0.012$/m);
    // 工具没有 token 语义 → 不产出 token/cost 行
    assert.equal(/agentia_unit_tokens_total\{unit="tool:search"\}/.test(txt), false);
    // 每个单元的调用耗时直方图都在
    assert.match(txt, /^agentia_unit_duration_ms_count\{unit="tool:fetch"\} 1$/m);
  });

  it('snapshot().units 给排序无关的键值视图；工具 tokens/costUsd 为 null', () => {
    const m = metricsSink();
    m.export(richTrace());
    const { units } = m.snapshot();
    assert.deepEqual(Object.keys(units).sort(), ['subagent:researcher', 'tool:fetch', 'tool:search']);
    assert.equal(units['tool:search']!.calls, 2);
    assert.equal(units['tool:search']!.errors, 1);
    assert.equal(units['tool:search']!.tokens, null);
    assert.equal(units['tool:search']!.costUsd, null);
    assert.equal(units['subagent:researcher']!.tokens, 150);
    assert.equal(units['subagent:researcher']!.costUsd, 0.012);
    assert.equal(units['tool:fetch']!.latencyP50, 100, '单样本 → 分位即它自己');
  });

  it('labelMode:"none" 不产出任何单元指标', () => {
    const m = metricsSink({ labelMode: 'none' });
    m.export(richTrace());
    assert.deepEqual(m.snapshot().units, {});
    assert.equal(/agentia_unit_/.test(m.render()), false);
  });

  it('labelMode:"kind" 只按类型打标签（基数极小）', () => {
    const m = metricsSink({ labelMode: 'kind' });
    m.export(richTrace());
    const { units } = m.snapshot();
    assert.deepEqual(Object.keys(units).sort(), ['subagent', 'tool']);
    assert.equal(units['tool']!.calls, 3, '两次 search + 一次 fetch');
    assert.equal(units['subagent']!.calls, 1);
  });

  it('maxUnits 上限：新单元归 __other__，droppedUnits 记被归并的不同单元数', () => {
    const m = metricsSink({ maxUnits: 1 });
    m.export(richTrace());
    const s = m.snapshot();
    assert.equal(s.units['tool:search']!.calls, 2, '首个单元保住自己的标签');
    assert.equal(s.units['__other__']!.calls, 2, 'fetch 与 subagent 被归并');
    assert.equal(s.droppedUnits, 2);
  });
});

describe('E3 模型级指标', () => {
  it('按 llm.turn 的 span.name（模型 id）归因 token/成本/延迟/turn 数', () => {
    const m = metricsSink();
    m.export(richTrace());
    const txt = m.render();
    assert.match(txt, /^agentia_model_turns_total\{model="claude-opus-5"\} 2$/m);
    assert.match(txt, /^agentia_model_tokens_total\{model="claude-opus-5"\} 155$/m, '100+20+5 + 20+10');
    assert.match(txt, /^agentia_model_cost_usd_total\{model="claude-opus-5"\} 0.012$/m, '0.01+0.002');
    assert.match(txt, /^agentia_model_duration_ms_count\{model="claude-opus-5"\} 2$/m);
    const s = m.snapshot();
    assert.equal(s.models['claude-opus-5']!.unpricedTurns, 0);
    assert.equal(s.models['claude-opus-5']!.latencyP50, 90);
  });

  it('未定价 turn 计入 unpricedTurns（成本护栏失效的显式信号）', () => {
    const t = richTrace();
    delete (t.spans[1]!.usage as { costEstimate?: number }).costEstimate;
    const m = metricsSink();
    m.export(t);
    const txt = m.render();
    assert.match(txt, /^agentia_model_unpriced_turns_total\{model="claude-opus-5"\} 1$/m);
    assert.equal(m.snapshot().models['claude-opus-5']!.unpricedTurns, 1);
    assert.equal(m.snapshot().models['claude-opus-5']!.costUsd, 0.002);
  });
});

describe('E5 OTLP/JSON 指标导出', () => {
  async function startCollector(statusCode: number): Promise<{ server: Server; base: string; bodies: any[] }> {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push({ url: req.url, contentType: req.headers['content-type'], body: JSON.parse(raw) });
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(statusCode === 200 ? '{}' : 'collector exploded');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { server, base: `http://127.0.0.1:${port}`, bodies };
  }
  const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

  it('export:"otlp" 必须给 endpoint（不给就构造期抛错，不静默不导出）', () => {
    assert.throws(() => metricsSink({ export: 'otlp' }), /必须给 endpoint/);
  });

  it('flush 真发 POST /v1/metrics，结构是合法 OTLP（resourceMetrics→scopeMetrics→metrics）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({ export: 'otlp', endpoint: `${base}/`, intervalMs: 0, serviceName: 'svc-x' });
      await m.export(richTrace());
      m.stop();
      assert.equal(bodies.length, 1, 'intervalMs:0 → 每次 export 立即导出');
      assert.equal(bodies[0].url, '/v1/metrics');
      assert.match(bodies[0].contentType ?? '', /application\/json/);

      const rm = bodies[0].body.resourceMetrics[0];
      assert.deepEqual(rm.resource.attributes, [
        { key: 'service.name', value: { stringValue: 'svc-x' } },
      ]);
      const metrics = rm.scopeMetrics[0].metrics as Array<Record<string, any>>;
      const byName = (n: string) => metrics.filter((x) => x.name === n);
      assert.equal(byName('agentia_runs_total')[0].sum.dataPoints[0].asInt, '1');
      assert.equal(byName('agentia_runs_total')[0].sum.aggregationTemporality, 2);
      const hist = byName('agentia_run_duration_ms')[0].histogram.dataPoints[0];
      assert.equal(hist.count, 1);
      assert.equal(hist.sum, 300);
      assert.equal(hist.explicitBounds.length, hist.bucketCounts.length - 1);
      // 单元维度带 attributes
      const unitCalls = byName('agentia_unit_calls_total').find(
        (x) => x.sum.dataPoints[0].attributes[0].value.stringValue === 'tool:search',
      );
      assert.equal(unitCalls!.sum.dataPoints[0].asInt, '2');
    } finally {
      await close(server);
    }
  });

  it('导出失败被吞并走 onExportError（观测不得击穿业务）', async () => {
    const { server, base } = await startCollector(500);
    try {
      const errs: unknown[] = [];
      const m = metricsSink({ export: 'otlp', endpoint: base, intervalMs: 0, onExportError: (e) => errs.push(e) });
      await m.export(richTrace()); // 不应抛出
      m.stop();
      assert.equal(errs.length, 1);
      assert.match(String(errs[0]), /HTTP 500/);
    } finally {
      await close(server);
    }
  });

  it('prometheus 模式下 flush 是空操作（拉取式，无主动导出）', async () => {
    const m = metricsSink();
    await m.flush();
    m.stop();
    assert.match(m.render(), /agentia_runs_total 0/);
  });
});
