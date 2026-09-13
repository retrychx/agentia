import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReport, mergeRunReports, renderRunReport } from '../../src/index.js';
import type { Span, Trace } from '../../src/index.js';

/**
 * G1 调优报告 —— 「哪个单元慢 / 贵 / 爱失败」。
 * 没有它，面对 budgetTokens / keepToolPairs / maxCostUsd 一堆旋钮不知道该拧哪个。
 */

function span(over: Partial<Span> & Pick<Span, 'spanId' | 'kind' | 'name'>): Span {
  return {
    traceId: 't-1',
    parentSpanId: 'root',
    startedAt: 1000,
    endedAt: 1100,
    status: 'ok',
    attributes: {},
    events: [],
    ...over,
  };
}

function traceWith(spans: Span[], over: Partial<Trace> = {}): Trace {
  return {
    traceId: 't-1',
    rootSpanId: 'root',
    status: 'ok',
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [span({ spanId: 'root', kind: 'run', name: 'agent.run', parentSpanId: null, startedAt: 0, endedAt: 500 }), ...spans],
    ...over,
  };
}

describe('G1 buildRunReport', () => {
  it('单元按总耗时降序；错误计数、tokens/cost 各归各位', () => {
    const trace = traceWith([
      span({
        spanId: 'turn-1',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 10,
        endedAt: 110,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.01 },
        events: [
          { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 200 } },
          { time: 60, name: 'tool.output', body: { tool: 'fetch', ok: false, durationMs: 10, errorKind: 'threw' } },
        ],
      }),
      span({
        spanId: 'unit-1',
        kind: 'unit',
        name: 'researcher',
        attributes: { subagent: 'researcher' },
        startedAt: 200,
        endedAt: 400,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.002 },
      }),
    ]);
    const r = buildRunReport(trace);
    assert.equal(r.traceId, 't-1');
    assert.equal(r.status, 'ok');
    assert.equal(r.durationMs, 500, '根 span 起止');
    assert.equal(r.runs, 1);
    assert.deepEqual(
      r.units.map((u) => u.unit),
      ['tool:search', 'subagent:researcher', 'tool:fetch'],
      '按总耗时降序（200 / 100 / 10）',
    );
    const search = r.units[0]!;
    assert.deepEqual(
      { calls: search.calls, errors: search.errors, total: search.durationMs.total, max: search.durationMs.max },
      { calls: 1, errors: 0, total: 200, max: 200 },
    );
    assert.equal(search.tokens, null, '工具没有 token 语义');
    const researcher = r.units[1]!;
    assert.equal(researcher.tokensTotal, 15);
    assert.equal(researcher.costUsd, 0.002);
    assert.equal(r.units[2]!.errors, 1, 'fetch 失败一次');
    assert.equal(r.models[0]!.model, 'claude-opus-5');
    assert.equal(r.models[0]!.turns, 1);
    assert.equal(r.models[0]!.tokensTotal, 120);
    assert.equal(r.models[0]!.costUsd, 0.01);
    assert.deepEqual(r.unpricedModels, []);
  });

  it('未定价模型进 unpricedModels（成本护栏失效的显式信号）', () => {
    const trace = traceWith([
      span({
        spanId: 'turn-1',
        kind: 'llm.turn',
        name: 'deepseek-chat',
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    ]);
    const r = buildRunReport(trace);
    assert.deepEqual(r.unpricedModels, ['deepseek-chat']);
    assert.equal(r.models[0]!.unpricedTurns, 1);
    assert.equal(r.models[0]!.costUsd, null);
  });

  it('空 trace（只有根）→ 空排行，不抛错', () => {
    const r = buildRunReport(traceWith([]));
    assert.deepEqual(r.units, []);
    assert.deepEqual(r.models, []);
    assert.equal(r.durationMs, 500);
  });
});

describe('G1 mergeRunReports', () => {
  it('跨 run 累加 calls/errors/durations，并按新的总耗时重排', () => {
    const a = buildRunReport(
      traceWith([
        span({
          spanId: 't',
          kind: 'llm.turn',
          name: 'm',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          events: [{ time: 1, name: 'tool.output', body: { tool: 'slow', ok: true, durationMs: 300 } }],
        }),
      ]),
    );
    const b = buildRunReport(
      traceWith([
        span({
          spanId: 't',
          kind: 'llm.turn',
          name: 'm',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          events: [
            { time: 1, name: 'tool.output', body: { tool: 'slow', ok: false, durationMs: 50 } },
            { time: 2, name: 'tool.output', body: { tool: 'fast', ok: true, durationMs: 1 } },
          ],
        }),
      ]),
    );
    const merged = mergeRunReports([a, b]);
    assert.equal(merged.runs, 2);
    assert.equal(merged.traceId, 'merged(2 runs)');
    assert.equal(merged.durationMs, 1000, '两条各 500');
    const slow = merged.units.find((u) => u.unit === 'tool:slow')!;
    assert.equal(slow.calls, 2);
    assert.equal(slow.errors, 1);
    assert.equal(slow.durationMs.total, 350);
    assert.equal(slow.durationMs.max, 300);
    assert.equal(merged.units[0]!.unit, 'tool:slow', '总耗时最大的排最前');
    assert.equal(merged.models[0]!.turns, 2);
  });

  it('任一 run 失败 → 合并报告 status=error；未定价模型取并集', () => {
    const ok = buildRunReport(traceWith([]));
    const bad = buildRunReport(traceWith([], { status: 'error' }));
    const unpriced = buildRunReport(
      traceWith([
        span({ spanId: 't', kind: 'llm.turn', name: 'x', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }),
      ]),
    );
    const merged = mergeRunReports([ok, bad, unpriced]);
    assert.equal(merged.status, 'error');
    assert.deepEqual(merged.unpricedModels, ['x']);
  });

  it('空数组 → 空报告（runs=0，不抛错）', () => {
    const merged = mergeRunReports([]);
    assert.equal(merged.runs, 0);
    assert.equal(merged.status, 'ok');
    assert.equal(merged.durationMs, 0);
  });
});

describe('G1 renderRunReport（CLI / 日志用）', () => {
  it('打印排行与未定价告警', () => {
    const trace = traceWith([
      span({
        spanId: 'turn-1',
        kind: 'llm.turn',
        name: 'deepseek-chat',
        startedAt: 10,
        endedAt: 210,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        events: [{ time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 200 } }],
      }),
    ]);
    const text = renderRunReport(buildRunReport(trace));
    assert.match(text, /run {6}t-1 {2}\[ok\]/);
    assert.match(text, /total {4}500ms/);
    assert.match(text, /未定价模型：deepseek-chat/);
    assert.match(text, /deepseek-chat/);
    assert.match(text, /tool:search/);
    assert.match(text, /未定价/, '未定价模型在 cost 列显式标出');
  });

  it('无单元/模型时给出人话说明（不输出空表头）', () => {
    const text = renderRunReport(buildRunReport(traceWith([])));
    assert.match(text, /没有可归因的单元\/模型/);
  });
});
