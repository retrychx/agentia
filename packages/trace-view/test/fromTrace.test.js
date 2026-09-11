import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { playTrace } from '../src/fromTrace.js';
import { createTraceView, unitTypeOf } from '../src/view.js';

/** 记录型假视图：把调用按顺序存下来，供断言归一后的动作序列 */
function fakeView() {
  const calls = [];
  return {
    calls,
    reset: (n) => calls.push(['reset', n]),
    start: (s) => calls.push(['start', s.id, s.kind, s.name, s.parent]),
    event: (id, type, tool, text, ok) => calls.push(['event', id, type, tool, ok]),
    end: (s) => calls.push(['end', s.id, s.status]),
    finish: (ms, status) => calls.push(['finish', ms, status]),
  };
}

/** 手写 fixture：run → llm.turn（发 subagent 调用）→ unit(subagent) → 内部 llm.turn
 *  时间线刻意还原框架真实语义：turn 在模型响应后即收尾，工具调用（含 subagent）发生在其后。 */
function docReviewTrace() {
  return {
    traceId: 't1',
    rootSpanId: 's0',
    status: 'ok',
    totalUsage: { inputTokens: 15, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: 's0', traceId: 't1', parentSpanId: null, kind: 'run', name: 'run · demo',
        startedAt: 0, endedAt: 1000, status: 'ok', attributes: {}, events: [],
      },
      {
        spanId: 's1', traceId: 't1', parentSpanId: 's0', kind: 'llm.turn', name: 'claude-opus-5',
        startedAt: 10, endedAt: 140, status: 'ok',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attributes: {},
        events: [
          { time: 150, name: 'tool.input', body: { tool: 'doc_reviewer', tool_use_id: 'tu1', input: { task: '审查' } } },
          { time: 500, name: 'tool.output', body: { tool: 'doc_reviewer', tool_use_id: 'tu1', ok: true, content: '审查完成' } },
        ],
      },
      {
        spanId: 's2', traceId: 't1', parentSpanId: 's1', kind: 'unit', name: 'doc_reviewer',
        startedAt: 160, endedAt: 490, status: 'ok', attributes: { subagent: 'doc_reviewer' }, events: [],
      },
      {
        spanId: 's3', traceId: 't1', parentSpanId: 's2', kind: 'llm.turn', name: 'claude-opus-5',
        startedAt: 180, endedAt: 300, status: 'ok',
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attributes: {}, events: [],
      },
    ],
  };
}

describe('playTrace · Trace.spans[] → 视图动作序列', () => {
  it('空 trace：不做任何渲染', () => {
    const v = fakeView();
    assert.equal(playTrace(v, { spans: [] }), false);
    assert.equal(playTrace(v, null), false);
    assert.equal(v.calls.length, 0);
  });

  it('动作顺序：父先开、事件与子 span 按发生顺序混排、run 根由 reset 建', () => {
    const v = fakeView();
    assert.equal(playTrace(v, docReviewTrace()), true);
    assert.deepEqual(v.calls, [
      ['reset', 'run · demo'],
      ['start', 's1', 'llm.turn', 'claude-opus-5', 's0'],
      ['end', 's1', 'ok'],
      ['event', 's1', 'tool.input', 'subagent:doc_reviewer', true],
      ['start', 's2', 'unit', 'subagent:doc_reviewer', 's1'],
      ['start', 's3', 'llm.turn', 'claude-opus-5', 's2'],
      ['end', 's3', 'ok'],
      ['end', 's2', 'ok'],
      ['event', 's1', 'tool.output', 'subagent:doc_reviewer', true],
      ['end', 's0', 'ok'],
      ['finish', 1000, 'ok'],
    ]);
  });

  it('unit span 补类型前缀：裸名 + attributes → 渲染器认得出四类标识符', () => {
    const v = fakeView();
    playTrace(v, docReviewTrace());
    const unitStart = v.calls.find((c) => c[0] === 'start' && c[2] === 'unit');
    assert.equal(unitStart[3], 'subagent:doc_reviewer');
    assert.equal(unitTypeOf(unitStart[3]), 'subagent');
  });

  it('事件工具名：兄弟 unit span 反查类型补前缀，无匹配则回落 tool:', () => {
    const v = fakeView();
    playTrace(v, docReviewTrace());
    const input = v.calls.find((c) => c[0] === 'event' && c[2] === 'tool.input');
    assert.equal(input[3], 'subagent:doc_reviewer', 'subagent 调用的事件也标 subagent');

    const plain = {
      spans: [
        { spanId: 'r', traceId: 'x', parentSpanId: null, kind: 'run', name: 'app', startedAt: 0, endedAt: 10, status: 'ok', attributes: {}, events: [] },
        {
          spanId: 't', traceId: 'x', parentSpanId: 'r', kind: 'llm.turn', name: 'm', startedAt: 1, endedAt: 5, status: 'ok', attributes: {},
          events: [{ time: 2, name: 'tool.input', body: { tool: 'get_weather', input: { city: '上海' } } }],
        },
      ],
    };
    const v2 = fakeView();
    playTrace(v2, plain);
    const ev = v2.calls.find((c) => c[0] === 'event');
    assert.equal(ev[3], 'tool:get_weather', '无匹配 unit span 的工具按 tool: 算');
    assert.equal(v2.calls[0][1], 'run · app', '根名不带 run 前缀时补 run ·');
  });

  it('usage 计数：只累加 llm.turn，unit span 的聚合 usage 不双算', () => {
    // createTraceView 需要 DOM：最小 stub 即可（只用到 createElement / innerHTML / appendChild）
    const makeNode = () => ({
      className: '', textContent: '', title: '', dataset: {}, children: [],
      set innerHTML(_v) { this.children = []; },
      get innerHTML() { return ''; },
      appendChild(c) { this.children.push(c); return c; },
    });
    globalThis.document = { createElement: () => makeNode() };

    const t = docReviewTrace();
    // unit span 挂一个聚合 usage：计入就双算
    t.spans[2].usage = { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0 };

    const view = createTraceView(makeNode());
    playTrace(view, t);
    assert.deepEqual(
      { input: view.usage.input, output: view.usage.output },
      { input: 15, output: 8 },
      '10+5 / 5+3；unit span 的 999 不计入',
    );
  });

  it('渲染成 DOM：事件行在所属 turn 下、单元行带 tr-ico 标识符', () => {
    const makeNode = () => ({
      className: '', textContent: '', title: '', dataset: {}, children: [],
      set innerHTML(_v) { this.children = []; },
      get innerHTML() { return ''; },
      appendChild(c) { this.children.push(c); return c; },
    });
    globalThis.document = { createElement: () => makeNode() };

    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, docReviewTrace());
    const rows = root.children;
    const cls = rows.map((r) => r.className);
    assert.equal(rows.length, 6, 'run 根 + turn + 2 事件 + unit + 内层 turn');
    assert.ok(cls[0].includes('tr-row'), 'run 根行');
    assert.ok(cls.some((c) => c.includes('tr-ev')), '有事件行');
    const unitRow = rows.find((r) => r.dataset.kind === 'unit');
    assert.equal(unitRow.dataset.unit, 'subagent');
    // 单元行的标识符节点存在且字形为 ⊕
    assert.ok(unitRow.children.some((c) => c.className === 'tr-ico' && c.textContent === '⊕'));
  });
});
