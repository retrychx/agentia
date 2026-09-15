import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachScore, createApp, metricsSink, SystemPrompt } from '../../src/index.js';
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

/** 造一条**含能力与模型**的 trace：两次 llm.turn（带 tool.output 事件）+ 一个 subagent capability span */
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
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        costEstimate: 0.01,
      },
      attributes: {},
      events: [
        { time: 1050, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 42 } },
      ],
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
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.002,
      },
      attributes: {},
      events: [
        {
          time: 1150,
          name: 'tool.output',
          body: { tool: 'search', ok: false, durationMs: 8, errorKind: 'threw' },
        },
        { time: 1160, name: 'tool.output', body: { tool: 'fetch', ok: true, durationMs: 100 } },
      ],
    },
    {
      spanId: 'capability-1',
      traceId: 't-rich',
      parentSpanId: root,
      kind: 'capability',
      name: 'researcher',
      startedAt: 1210,
      endedAt: 1280,
      status: 'ok',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.012,
      },
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
      traceOf({
        status: 'error',
        durationMs: 7,
        input: 3,
        output: 4,
        cacheRead: 5,
        cacheCreation: 6,
        costEstimate: 0.25,
      }),
    );
    const txt = m.render();
    assert.match(txt, /# TYPE agentia_runs_total counter/);
    assert.match(txt, /# HELP agentia_runs_total /);
    assert.match(txt, /^agentia_runs_total 1$/m);
    assert.match(txt, /^agentia_runs_failed_total 1$/m);
    assert.match(txt, /^agentia_tokens_total\{kind="input"\} 3$/m);
    assert.match(txt, /^agentia_tokens_total\{kind="cache_creation"\} 6$/m);
    assert.match(txt, /^agentia_cost_usd_total 0.25$/m);
    assert.match(txt, /^agentia_run_duration_ms_last\{quantile="0.5"\} 7$/m);
    assert.match(txt, /^agentia_run_duration_ms_count 1$/m);
  });

  it('prefix 可换；reset 清空累计（含能力/模型维度）', () => {
    const m = metricsSink({ prefix: 'myapp_' });
    m.export(traceOf({ durationMs: 1, input: 9 }));
    m.export(richTrace());
    assert.match(m.render(), /^myapp_runs_total 2$/m);
    m.reset();
    const s = m.snapshot();
    assert.deepEqual([s.runs, s.failed, s.tokens, s.costUsd], [0, 0, 0, 0]);
    assert.deepEqual(s.capabilities, {});
    assert.deepEqual(s.models, {});
    assert.match(m.render(), /^myapp_run_duration_ms_count 0$/m);
  });

  it('windowSize / maxCapabilities / buckets 非法 → 构造期抛错', () => {
    assert.throws(() => metricsSink({ windowSize: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ maxCapabilities: 0 }), /必须为正数/);
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

describe('Prometheus 文本合法性（expfmt 硬约束）', () => {
  it('每个指标名至多一条 HELP、一条 TYPE，且同名不混用类型（第二条 HELP/TYPE 会让整次 scrape 失败）', () => {
    const m = metricsSink();
    m.export(traceOf({ durationMs: 7, input: 3, costEstimate: 0.25 }));
    m.export(richTrace()); // 带上能力/模型维度，让所有家族都出现
    const txt = m.render();

    const helpCount = new Map<string, number>();
    const typeOf = new Map<string, string>();
    for (const raw of txt.split('\n')) {
      const help = /^# HELP (\S+) /.exec(raw);
      if (help) helpCount.set(help[1]!, (helpCount.get(help[1]!) ?? 0) + 1);
      const type = /^# TYPE (\S+) (\S+)$/.exec(raw);
      if (type) {
        const prev = typeOf.get(type[1]!);
        assert.equal(
          prev,
          undefined,
          `指标 ${type[1]} 出现第二条 TYPE（${prev} 之后又见 ${type[2]}）—— expfmt 硬错误`,
        );
        typeOf.set(type[1]!, type[2]!);
      }
    }
    assert.ok(helpCount.size > 0, '应当至少有一个指标家族');
    for (const [name, count] of helpCount) {
      assert.equal(count, 1, `指标 ${name} 的 HELP 出现了 ${count} 次`);
    }
    for (const name of helpCount.keys()) {
      assert.ok(typeOf.has(name), `${name} 有 HELP 无 TYPE`);
    }
    for (const name of typeOf.keys()) {
      assert.ok(helpCount.has(name), `${name} 有 TYPE 无 HELP`);
    }
    // tokens_total 有 4 条样本但家族头只发一次
    assert.equal(typeOf.get('agentia_tokens_total'), 'counter');
    // 时长的两种口径拆成两个名字：histogram 与 gauge 不得同名
    assert.equal(typeOf.get('agentia_run_duration_ms'), 'histogram');
    assert.equal(typeOf.get('agentia_run_duration_ms_last'), 'gauge');
    assert.equal(typeOf.get('agentia_capability_duration_ms'), 'histogram');
    assert.equal(typeOf.get('agentia_capability_duration_ms_last'), 'gauge');
    assert.equal(typeOf.get('agentia_model_duration_ms'), 'histogram');
    assert.equal(typeOf.get('agentia_model_duration_ms_last'), 'gauge');
  });

  it('label 值转义：含引号/反斜杠/换行的能力名与模型名不得损坏 exposition', () => {
    const m = metricsSink();
    const evil = richTrace();
    evil.spans[3]!.name = 'a"b\\c\nd'; // capability span
    evil.spans[1]!.name = 'm"x'; // llm.turn → model label
    m.export(evil);
    const txt = m.render();
    // 原始引号/换行不得原样出现在 label 里（那会把一行样本劈成两行/提前闭合引号）
    assert.ok(!txt.includes('capability="a"b'), '未转义的引号会破坏 label');
    assert.match(txt, /capability="subagent:a\\"b\\\\c\\nd"/);
    assert.match(txt, /model="m\\"x"/);
    // 转义后每个 label 仍落在单行内（剥掉 \" 转义后引号成对）
    for (const line of txt.split('\n')) {
      if (line.includes('capability=')) {
        assert.equal((line.replace(/\\"/g, '').match(/"/g) ?? []).length % 2, 0);
      }
    }
  });
});

describe('E2 能力级指标', () => {
  it('工具来自 tool.output 事件；skill/subagent 来自 capability span（带 token/成本）', () => {
    const m = metricsSink();
    m.export(richTrace());
    const txt = m.render();
    assert.match(txt, /^agentia_capability_calls_total\{capability="tool:search"\} 2$/m);
    assert.match(txt, /^agentia_capability_errors_total\{capability="tool:search"\} 1$/m);
    assert.match(
      txt,
      /^agentia_capability_duration_ms_last\{capability="tool:search",quantile="0.5"\} 8$/m,
      '窗口内 [42,8] 排序 [8,42] → ceil(0.5·2)=1 → 8',
    );
    assert.match(
      txt,
      /^agentia_capability_duration_ms_last\{capability="tool:search",quantile="0.95"\} 42$/m,
    );
    assert.match(txt, /^agentia_capability_calls_total\{capability="tool:fetch"\} 1$/m);
    assert.match(txt, /^agentia_capability_calls_total\{capability="subagent:researcher"\} 1$/m);
    assert.match(
      txt,
      /^agentia_capability_tokens_total\{capability="subagent:researcher"\} 150$/m,
      '120+30',
    );
    assert.match(
      txt,
      /^agentia_capability_cost_usd_total\{capability="subagent:researcher"\} 0.012$/m,
    );
    // 工具没有 token 语义 → 不产出 token/cost 行
    assert.equal(/agentia_capability_tokens_total\{capability="tool:search"\}/.test(txt), false);
    // 每个能力的调用耗时直方图都在
    assert.match(txt, /^agentia_capability_duration_ms_count\{capability="tool:fetch"\} 1$/m);
  });

  it('snapshot().capabilities 给排序无关的键值视图；工具 tokens/costUsd 为 null', () => {
    const m = metricsSink();
    m.export(richTrace());
    const { capabilities } = m.snapshot();
    assert.deepEqual(Object.keys(capabilities).sort(), [
      'subagent:researcher',
      'tool:fetch',
      'tool:search',
    ]);
    assert.equal(capabilities['tool:search']!.calls, 2);
    assert.equal(capabilities['tool:search']!.errors, 1);
    assert.equal(capabilities['tool:search']!.tokens, null);
    assert.equal(capabilities['tool:search']!.costUsd, null);
    assert.equal(capabilities['subagent:researcher']!.tokens, 150);
    assert.equal(capabilities['subagent:researcher']!.costUsd, 0.012);
    assert.equal(capabilities['tool:fetch']!.latencyP50, 100, '单样本 → 分位即它自己');
  });

  it('labelMode:"none" 不产出任何能力指标', () => {
    const m = metricsSink({ labelMode: 'none' });
    m.export(richTrace());
    assert.deepEqual(m.snapshot().capabilities, {});
    assert.equal(/agentia_unit_/.test(m.render()), false);
  });

  it('labelMode:"kind" 只按类型打标签（基数极小）', () => {
    const m = metricsSink({ labelMode: 'kind' });
    m.export(richTrace());
    const { capabilities } = m.snapshot();
    assert.deepEqual(Object.keys(capabilities).sort(), ['subagent', 'tool']);
    assert.equal(capabilities['tool']!.calls, 3, '两次 search + 一次 fetch');
    assert.equal(capabilities['subagent']!.calls, 1);
  });

  it('maxCapabilities 上限：新能力归 __other__，droppedCapabilities 记被归并的不同能力数', () => {
    const m = metricsSink({ maxCapabilities: 1 });
    m.export(richTrace());
    const s = m.snapshot();
    assert.equal(s.capabilities['tool:search']!.calls, 2, '首个能力保住自己的标签');
    assert.equal(s.capabilities['__other__']!.calls, 2, 'fetch 与 subagent 被归并');
    assert.equal(s.droppedCapabilities, 2);
  });
});

describe('E3 模型级指标', () => {
  it('按 llm.turn 的 span.name（模型 id）归因 token/成本/延迟/turn 数', () => {
    const m = metricsSink();
    m.export(richTrace());
    const txt = m.render();
    assert.match(txt, /^agentia_model_turns_total\{model="claude-opus-5"\} 2$/m);
    assert.match(
      txt,
      /^agentia_model_tokens_total\{model="claude-opus-5"\} 155$/m,
      '100+20+5 + 20+10',
    );
    assert.match(
      txt,
      /^agentia_model_cost_usd_total\{model="claude-opus-5"\} 0.012$/m,
      '0.01+0.002',
    );
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
  async function startCollector(
    statusCode: number,
  ): Promise<{ server: Server; base: string; bodies: any[] }> {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push({
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
    return { server, base: `http://127.0.0.1:${port}`, bodies };
  }
  const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

  it('export:"otlp" 必须给 endpoint（不给就构造期抛错，不静默不导出）', () => {
    assert.throws(() => metricsSink({ export: 'otlp' }), /必须给 endpoint/);
  });

  it('collector 半开连接（accept 不回包）时 flush 受 timeoutMs 兜底，不挂死', async () => {
    // 永不回包的假 collector
    const server = createServer(() => {
      /* 故意不响应 */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const errors: unknown[] = [];
      const m = metricsSink({
        export: 'otlp',
        endpoint: `http://127.0.0.1:${port}`,
        intervalMs: 0,
        timeoutMs: 100,
        onExportError: (e) => errors.push(e),
      });
      await m.export(traceOf({ durationMs: 5 })); // intervalMs:0 → flush 被 await，不得卡住
      m.stop();
      assert.equal(errors.length, 1);
      assert.equal((errors[0] as Error).name, 'TimeoutError');
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it('flush 真发 POST /v1/metrics，结构是合法 OTLP（resourceMetrics→scopeMetrics→metrics）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({
        export: 'otlp',
        endpoint: `${base}/`,
        intervalMs: 0,
        serviceName: 'svc-x',
      });
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
      // 能力维度带 attributes
      const capabilityCalls = byName('agentia_capability_calls_total').find(
        (x) => x.sum.dataPoints[0].attributes[0].value.stringValue === 'tool:search',
      );
      assert.equal(capabilityCalls!.sum.dataPoints[0].asInt, '2');
    } finally {
      await close(server);
    }
  });

  it('OTLP payload 结构：浮点走 asDouble、histogram 的 bucketCounts 是每桶非累积计数、纳秒时间戳不丢精度', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({
        export: 'otlp',
        endpoint: base,
        intervalMs: 0,
        buckets: [50, 100],
      });
      await m.export(traceOf({ durationMs: 60, costEstimate: 0.25 }));
      m.stop();
      const metrics = bodies[0].body.resourceMetrics[0].scopeMetrics[0].metrics as Array<
        Record<string, any>
      >;
      const byName = (n: string) => metrics.find((x) => x.name === n)!;

      // 成本是浮点：OTLP 的 asInt 是 string 编码 int64，塞浮点 collector 会拒收
      const cost = byName('agentia_cost_usd_total').sum.dataPoints[0];
      assert.equal(cost.asDouble, 0.25);
      assert.equal('asInt' in cost, false, '浮点指标不得走 asInt');
      // 整型计数仍走 asInt
      assert.equal(byName('agentia_runs_total').sum.dataPoints[0].asInt, '1');

      // duration=60、buckets=[50,100]：非累积 = [0,1,0]（累积语义会是 [0,1,1]）
      const hist = byName('agentia_run_duration_ms').histogram.dataPoints[0];
      assert.deepEqual(hist.bucketCounts, [0, 1, 0], 'OTLP bucketCounts 是每桶非累积计数');
      assert.equal(hist.count, 1);

      // epoch 毫秒 ×1e6 超 2^53：纳秒时间戳必须是 1e6 的整数倍（BigInt 计算的结果必然满足，
      // double 直接乘的结果几乎必然不满足 —— 低精度位被舍掉）
      const dp = byName('agentia_runs_total').sum.dataPoints[0];
      assert.equal(BigInt(dp.startTimeUnixNano) % 1_000_000n, 0n);
      assert.equal(BigInt(dp.timeUnixNano) % 1_000_000n, 0n);
    } finally {
      await close(server);
    }
  });

  it('导出失败被吞并走 onExportError（观测不得击穿业务）', async () => {
    const { server, base } = await startCollector(500);
    try {
      const errs: unknown[] = [];
      const m = metricsSink({
        export: 'otlp',
        endpoint: base,
        intervalMs: 0,
        onExportError: (e) => errs.push(e),
      });
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

  it('OTLP payload 带 score gauge（asDouble）与 score_total counter（asInt）', async () => {
    const { server, base, bodies } = await startCollector(200);
    try {
      const m = metricsSink({ export: 'otlp', endpoint: base, intervalMs: 0 });
      const t = traceOf({});
      attachScore(t, { name: 'faithfulness', value: 0.8, source: 'eval-x' });
      attachScore(t, { name: 'faithfulness', value: 0.6, source: 'eval-x' });
      await m.export(t);
      m.stop();

      const metrics = bodies[0].body.resourceMetrics[0].scopeMetrics[0].metrics as Array<
        Record<string, any>
      >;
      const byName = (n: string) => metrics.find((x) => x.name === n)!;

      const gauge = byName('agentia_score').gauge.dataPoints[0];
      assert.equal(gauge.asDouble, 0.6);
      assert.deepEqual(gauge.attributes, [
        { key: 'name', value: { stringValue: 'faithfulness' } },
        { key: 'source', value: { stringValue: 'eval-x' } },
      ]);

      const counter = byName('agentia_score_total').sum.dataPoints[0];
      assert.equal(counter.asInt, '2');
      assert.equal(byName('agentia_score_total').sum.aggregationTemporality, 2);
    } finally {
      await close(server);
    }
  });
});

describe('R7 评分（score 事件）聚合', () => {
  it('gauge 记最近一次值、counter 记条数；snapshot 暴露 scores 汇总', () => {
    const m = metricsSink();
    const t = traceOf({ durationMs: 5 });
    attachScore(t, { name: 'faithfulness', value: 0.8, source: 'eval-x' });
    attachScore(t, { name: 'faithfulness', value: 0.6, source: 'eval-x' });
    attachScore(t, { name: 'helpfulness', value: 1 });
    m.export(t);

    const txt = m.render();
    assert.match(txt, /# TYPE agentia_score gauge/);
    assert.match(txt, /# TYPE agentia_score_total counter/);
    assert.match(
      txt,
      /^agentia_score\{name="faithfulness",source="eval-x"\} 0.6$/m,
      'gauge = 最近一次值（0.8 被 0.6 覆盖）',
    );
    assert.match(txt, /^agentia_score_total\{name="faithfulness",source="eval-x"\} 2$/m);
    assert.match(txt, /^agentia_score\{name="helpfulness",source=""\} 1$/m, 'source 缺省为空串');
    assert.match(txt, /^agentia_score_total\{name="helpfulness",source=""\} 1$/m);

    const { scores } = m.snapshot();
    assert.deepEqual(scores['faithfulness@eval-x'], { value: 0.6, count: 2, sum: 1.4 });
    assert.deepEqual(scores['helpfulness'], { value: 1, count: 1, sum: 1 });
  });

  it('无 score 事件的 trace 不产出 score 家族；畸形 body 跳过', () => {
    const m = metricsSink();
    m.export(traceOf({}));
    m.export(richTrace());
    let txt = m.render();
    assert.equal(/agentia_score/.test(txt), false);
    assert.deepEqual(m.snapshot().scores, {});

    // 畸形 body：缺 value / value 非 number / body 不是对象 —— 全部跳过
    const t = traceOf({});
    t.spans[0]!.events.push(
      { time: 1, name: 'score', body: { name: 'x' } },
      { time: 2, name: 'score', body: { name: 'y', value: 'high' } },
      { time: 3, name: 'score', body: 'junk' },
    );
    m.export(t);
    txt = m.render();
    assert.equal(/agentia_score/.test(txt), false, '三条畸形 score 都不计入');
    assert.deepEqual(m.snapshot().scores, {});
  });

  it('评分名带引号走 escLabel 转义；reset 清空评分', () => {
    const m = metricsSink();
    const t = traceOf({});
    attachScore(t, { name: 'a"b', value: 0.5, source: 'eval' });
    m.export(t);
    assert.match(m.render(), /agentia_score\{name="a\\"b",source="eval"\} 0.5/);

    m.reset();
    assert.deepEqual(m.snapshot().scores, {});
    assert.equal(/agentia_score/.test(m.render()), false);
  });
});
