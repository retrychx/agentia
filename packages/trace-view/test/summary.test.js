import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrace, renderSummary } from '../src/summary.js';

/** 造一条含 unit span 与 tool.output 事件的 trace（形状与框架一致） */
function trace() {
  return {
    traceId: 't1',
    rootSpanId: 's0',
    status: 'ok',
    spans: [
      { spanId: 's0', parentSpanId: null, kind: 'run', name: 'run', startedAt: 0, endedAt: 500, status: 'ok', attributes: {}, events: [] },
      {
        spanId: 's1',
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 10,
        endedAt: 100,
        status: 'ok',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.01 },
        attributes: {},
        events: [
          { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 200 } },
          { time: 60, name: 'tool.output', body: { tool: 'fetch', ok: false, durationMs: 10 } },
        ],
      },
      {
        spanId: 's2',
        parentSpanId: 's0',
        kind: 'unit',
        name: 'researcher',
        startedAt: 110,
        endedAt: 400,
        status: 'ok',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.002 },
        attributes: { subagent: 'researcher' },
        events: [],
      },
      // skill：另一类 unit
      {
        spanId: 's3',
        parentSpanId: 's0',
        kind: 'unit',
        name: 'summarize',
        startedAt: 410,
        endedAt: 430,
        status: 'error',
        attributes: { skill: 'summarize' },
        events: [],
      },
    ],
  };
}

describe('trace-view summarizeTrace（G2 单元排行）', () => {
  it('工具来自 tool.output 事件；unit span 带 tokens/cost；按总耗时降序', () => {
    const rows = summarizeTrace(trace());
    assert.deepEqual(
      rows.map((r) => r.unit),
      ['subagent:researcher', 'tool:search', 'skill:summarize', 'tool:fetch'],
      '290 / 200 / 20 / 10',
    );
    const search = rows[1];
    assert.deepEqual({ calls: search.calls, errors: search.errors, max: search.maxMs }, { calls: 1, errors: 0, max: 200 });
    assert.equal(search.tokens, null, '工具没有 token 语义');
    assert.equal(search.costUsd, null);
    const researcher = rows[0];
    assert.deepEqual({ calls: researcher.calls, tokens: researcher.tokens, costUsd: researcher.costUsd }, { calls: 1, tokens: 15, costUsd: 0.002 });
    assert.equal(rows[3].errors, 1, 'fetch 失败一次');
    assert.equal(rows[2].errors, 1, 'skill span status=error');
  });

  it('空/畸形输入不抛错', () => {
    assert.deepEqual(summarizeTrace({}), []);
    assert.deepEqual(summarizeTrace(null), []);
    assert.deepEqual(
      summarizeTrace({ spans: [{ kind: 'llm.turn', events: [{ name: 'tool.output', body: null }] }] }),
      [],
      'body 非法的事件被跳过',
    );
  });

  it('renderSummary 出表格；空排行给人话说明；单元名做 HTML 转义', () => {
    const html = renderSummary(summarizeTrace(trace()));
    assert.match(html, /<table class="tv-sum">/);
    assert.match(html, /subagent:researcher/);
    assert.match(html, /tv-sum-err/);
    assert.match(renderSummary([]), /没有可归因的单元/);
    assert.match(renderSummary([{ unit: '<img>', calls: 1, errors: 0, totalMs: 1, maxMs: 1, tokens: null, costUsd: null }]), /&lt;img&gt;/);
  });

  it('无 tokens/cost 的单元渲染为 -（不显示 undefined）', () => {
    const html = renderSummary(summarizeTrace(trace()));
    assert.equal(/undefined/.test(html), false);
  });
});
