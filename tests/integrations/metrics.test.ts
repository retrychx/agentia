import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, metricsSink, SystemPrompt } from '../../src/index.js';
import type { Trace } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/** 造一条含根 span 的 trace：durationMs=undefined 表示根未收尾 */
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

describe('metricsSink（D3）', () => {
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

  it('windowSize 是环形窗口：超出的旧样本被丢弃（长跑宿主不会被无界数组拖住）', () => {
    const m = metricsSink({ windowSize: 3 });
    for (const d of [10, 20, 30, 40]) m.export(traceOf({ durationMs: d }));
    const txt = m.render();
    assert.match(txt, /agentia_run_duration_ms_count 3/, '窗口只保留 3 个样本');
    assert.equal(m.snapshot().latencyP50, 30, '窗口内是 [40,20,30] → 排序 [20,30,40] → 中位 30');
  });

  it('render：Prometheus 文本（HELP/TYPE + label 分项 + 分位 gauge）', () => {
    const m = metricsSink();
    m.export(traceOf({ status: 'error', durationMs: 7, input: 3, output: 4, cacheRead: 5, cacheCreation: 6, costEstimate: 0.25 }));
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

  it('prefix 可换；reset 清空累计', () => {
    const m = metricsSink({ prefix: 'myapp_' });
    m.export(traceOf({ durationMs: 1, input: 9 }));
    assert.match(m.render(), /^myapp_runs_total 1$/m);
    m.reset();
    const s = m.snapshot();
    assert.deepEqual([s.runs, s.failed, s.tokens, s.costUsd], [0, 0, 0, 0]);
    assert.match(m.render(), /^myapp_run_duration_ms_count 0$/m);
  });

  it('export:"otlp" 未实现 → 构造期抛错（比返回一份假指标好）', () => {
    assert.throws(() => metricsSink({ export: 'otlp' }), /尚未实现/);
  });

  it('windowSize 非正数 → 构造期抛错', () => {
    assert.throws(() => metricsSink({ windowSize: 0 }), /必须为正数/);
  });
});
