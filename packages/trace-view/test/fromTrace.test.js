import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { playTrace } from '../src/fromTrace.js';
import { createTraceView, capabilityTypeOf } from '../src/view.js';

/** 最小 DOM stub：渲染器只用到 createElement / innerHTML / appendChild / addEventListener */
function makeNode() {
  const handlers = Object.create(null);
  return {
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    children: [],
    set innerHTML(_v) {
      this.children = [];
    },
    get innerHTML() {
      return '';
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    // 事件行的展开是挂 click 的（见 view.js）：stub 少了这个，渲染到可展开行就抛
    addEventListener(type, fn) {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(fn);
    },
  };
}

/** 装上 document stub（每条真渲染 DOM 的用例调用） */
function useDom() {
  globalThis.document = { createElement: () => makeNode() };
}

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

/** 手写 fixture：run → llm.turn（发 subagent 调用）→ capability(subagent) → 内部 llm.turn
 *  时间线刻意还原框架真实语义：turn 在模型响应后即收尾，工具调用（含 subagent）发生在其后。 */
function docReviewTrace() {
  return {
    traceId: 't1',
    rootSpanId: 's0',
    status: 'ok',
    totalUsage: { inputTokens: 15, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: 's0',
        traceId: 't1',
        parentSpanId: null,
        kind: 'run',
        name: 'run · demo',
        startedAt: 0,
        endedAt: 1000,
        status: 'ok',
        attributes: {},
        events: [],
      },
      {
        spanId: 's1',
        traceId: 't1',
        parentSpanId: 's0',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 10,
        endedAt: 140,
        status: 'ok',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attributes: {},
        events: [
          {
            time: 150,
            name: 'tool.input',
            body: { tool: 'doc_reviewer', tool_use_id: 'tu1', input: { task: '审查' } },
          },
          {
            time: 500,
            name: 'tool.output',
            body: { tool: 'doc_reviewer', tool_use_id: 'tu1', ok: true, content: '审查完成' },
          },
        ],
      },
      {
        spanId: 's2',
        traceId: 't1',
        parentSpanId: 's1',
        kind: 'capability',
        name: 'doc_reviewer',
        startedAt: 160,
        endedAt: 490,
        status: 'ok',
        attributes: { subagent: 'doc_reviewer' },
        events: [],
      },
      {
        spanId: 's3',
        traceId: 't1',
        parentSpanId: 's2',
        kind: 'llm.turn',
        name: 'claude-opus-5',
        startedAt: 180,
        endedAt: 300,
        status: 'ok',
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
        attributes: {},
        events: [],
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
      ['start', 's2', 'capability', 'subagent:doc_reviewer', 's1'],
      ['start', 's3', 'llm.turn', 'claude-opus-5', 's2'],
      ['end', 's3', 'ok'],
      ['end', 's2', 'ok'],
      ['event', 's1', 'tool.output', 'subagent:doc_reviewer', true],
      ['end', 's0', 'ok'],
      ['finish', 1000, 'ok'],
    ]);
  });

  it('capability span 补类型前缀：裸名 + attributes → 渲染器认得出四类标识符', () => {
    const v = fakeView();
    playTrace(v, docReviewTrace());
    const unitStart = v.calls.find((c) => c[0] === 'start' && c[2] === 'capability');
    assert.equal(unitStart[3], 'subagent:doc_reviewer');
    assert.equal(capabilityTypeOf(unitStart[3]), 'subagent');
  });

  it('事件工具名：兄弟 capability span 反查类型补前缀，无匹配则回落 tool:', () => {
    const v = fakeView();
    playTrace(v, docReviewTrace());
    const input = v.calls.find((c) => c[0] === 'event' && c[2] === 'tool.input');
    assert.equal(input[3], 'subagent:doc_reviewer', 'subagent 调用的事件也标 subagent');

    const plain = {
      spans: [
        {
          spanId: 'r',
          traceId: 'x',
          parentSpanId: null,
          kind: 'run',
          name: 'app',
          startedAt: 0,
          endedAt: 10,
          status: 'ok',
          attributes: {},
          events: [],
        },
        {
          spanId: 't',
          traceId: 'x',
          parentSpanId: 'r',
          kind: 'llm.turn',
          name: 'm',
          startedAt: 1,
          endedAt: 5,
          status: 'ok',
          attributes: {},
          events: [
            { time: 2, name: 'tool.input', body: { tool: 'get_weather', input: { city: '上海' } } },
          ],
        },
      ],
    };
    const v2 = fakeView();
    playTrace(v2, plain);
    const ev = v2.calls.find((c) => c[0] === 'event');
    assert.equal(ev[3], 'tool:get_weather', '无匹配 capability span 的工具按 tool: 算');
    assert.equal(v2.calls[0][1], 'run · app', '根名不带 run 前缀时补 run ·');
  });

  it('usage 计数：只累加 llm.turn，capability span 的聚合 usage 不双算', () => {
    // createTraceView 需要 DOM（见 useDom）
    useDom();

    const t = docReviewTrace();
    // capability span 挂一个聚合 usage：计入就双算
    t.spans[2].usage = {
      inputTokens: 999,
      outputTokens: 999,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    const view = createTraceView(makeNode());
    playTrace(view, t);
    assert.deepEqual(
      { input: view.usage.input, output: view.usage.output },
      { input: 15, output: 8 },
      '10+5 / 5+3；capability span 的 999 不计入',
    );
  });

  it('渲染成 DOM：事件行在所属 turn 下、能力行带 tr-ico 标识符', () => {
    useDom();

    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, docReviewTrace());
    const rows = root.children;
    const cls = rows.map((r) => r.className);
    assert.equal(rows.length, 6, 'run 根 + turn + 2 事件 + capability + 内层 turn');
    assert.ok(cls[0].includes('tr-row'), 'run 根行');
    assert.ok(
      cls.some((c) => c.includes('tr-ev')),
      '有事件行',
    );
    const unitRow = rows.find((r) => r.dataset.kind === 'capability');
    assert.equal(unitRow.dataset.capability, 'subagent');
    // 能力行的标识符节点存在且字形为 ⊕
    assert.ok(unitRow.children.some((c) => c.className === 'tr-ico' && c.textContent === '⊕'));
  });

  /* 回归：面板上 `usage.unpriced` 那几行曾被标成 `tool:?` —— 事件体里没有 tool 字段，
     旧实现一律套前缀，于是把「没有工具」显示成了「名字叫 ? 的工具」。 */
  it('非 tool.* 事件不带工具名：usage.unpriced / llm.retry 不再被标成 tool:?', () => {
    const t = {
      spans: [
        {
          spanId: 'r',
          traceId: 'x',
          parentSpanId: null,
          kind: 'run',
          name: 'app',
          startedAt: 0,
          endedAt: 10,
          status: 'ok',
          attributes: {},
          events: [],
        },
        {
          spanId: 't',
          traceId: 'x',
          parentSpanId: 'r',
          kind: 'llm.turn',
          name: 'deepseek-chat',
          startedAt: 1,
          endedAt: 5,
          status: 'ok',
          attributes: {},
          events: [
            { time: 2, name: 'usage.unpriced', body: { model: 'deepseek-chat' } },
            { time: 3, name: 'llm.retry', body: { attempt: 2, delayMs: 500, error: 'overloaded' } },
            { time: 4, name: 'tool.input', body: { tool: 'get_weather', input: { city: '上海' } } },
          ],
        },
      ],
    };
    const v = fakeView();
    playTrace(v, t);
    const evs = v.calls.filter((c) => c[0] === 'event');
    assert.deepEqual(
      evs.map((c) => [c[2], c[3]]),
      [
        ['usage.unpriced', ''],
        ['llm.retry', ''],
        ['tool.input', 'tool:get_weather'],
      ],
      '只有 tool.* 事件带工具名；其余为空串',
    );
    assert.ok(!evs.some((c) => c[3] === 'tool:?'), '不得再出现 tool:? 这个假工具名');
  });

  it('renderSummary 不受影响：非 tool.* 事件不进能力排行（只有 tool.output 计入）', async () => {
    const { summarizeTrace } = await import('../src/summary.js');
    const rows = summarizeTrace({
      spans: [
        {
          spanId: 't',
          traceId: 'x',
          parentSpanId: 'r',
          kind: 'llm.turn',
          name: 'deepseek-chat',
          startedAt: 1,
          endedAt: 5,
          status: 'ok',
          attributes: {},
          events: [
            { time: 2, name: 'usage.unpriced', body: { model: 'deepseek-chat' } },
            {
              time: 3,
              name: 'tool.output',
              body: { tool: 'get_weather', ok: true, durationMs: 120, content: '晴' },
            },
          ],
        },
      ],
    });
    assert.deepEqual(
      rows.map((r) => r.capability),
      ['tool:get_weather'],
      'usage.unpriced 不该被当成一个能力',
    );
  });

  it('DOM：非 tool.* 事件行不渲染 tr-name 节点，tool.* 事件行照旧渲染', () => {
    useDom();

    const root = makeNode();
    const view = createTraceView(root);
    playTrace(view, {
      spans: [
        {
          spanId: 'r',
          traceId: 'x',
          parentSpanId: null,
          kind: 'run',
          name: 'app',
          startedAt: 0,
          endedAt: 10,
          status: 'ok',
          attributes: {},
          events: [],
        },
        {
          spanId: 't',
          traceId: 'x',
          parentSpanId: 'r',
          kind: 'llm.turn',
          name: 'm',
          startedAt: 1,
          endedAt: 5,
          status: 'ok',
          attributes: {},
          events: [
            { time: 2, name: 'usage.unpriced', body: { model: 'deepseek-chat' } },
            { time: 3, name: 'tool.input', body: { tool: 'get_weather', input: { city: '上海' } } },
          ],
        },
      ],
    });

    const rowsOf = (cls) => root.children.filter((r) => (r.className || '').includes(cls));
    const evRows = rowsOf('tr-ev');
    assert.equal(evRows.length, 2, '两个事件行');
    const usageRow = evRows.find((r) => r.dataset.ev === 'usage.unpriced');
    const toolRow = evRows.find((r) => r.dataset.ev === 'tool.input');
    assert.ok(!usageRow.children.some((c) => c.className === 'tr-name'), 'usage 行没有 tr-name 格');
    assert.ok(
      usageRow.children.some((c) => c.className === 'tr-io'),
      'usage 行仍带 payload 摘要',
    );
    assert.ok(
      toolRow.children.some(
        (c) => c.className === 'tr-name' && c.textContent === 'tool:get_weather',
      ),
      'tool 行照旧',
    );
  });
});
