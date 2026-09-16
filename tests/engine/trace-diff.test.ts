import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, diffTraces } from '../../src/index.js';
import type { Span, Trace, Usage } from '../../src/index.js';

const U1: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costEstimate: 0.001,
};

interface BuildOpts {
  model?: string;
  usage?: Usage;
  /** 主循环多一个无计量的 llm.turn */
  extraTurn?: boolean;
  /** 根下挂一个 capability（内含一个子 llm.turn），名字形如 skill:a */
  skill?: string;
  /** 第 1 回合追加一条 note 事件，body 为本值 */
  eventBody?: string;
}

/**
 * run（attributes: model / system.version）
 * ├─ llm.turn（model）：tool.input 一条 + 可选 note 一条
 * ├─ （可选）capability「skill:?」└─ llm.turn
 * └─ （可选）llm.turn（无计量）
 */
function buildTrace(opts: BuildOpts = {}): Trace {
  const model = opts.model ?? 'model-a';
  const usage = opts.usage ?? U1;
  const r = new TraceRecorder();
  const root = r.begin('run', 'app', null);
  r.setAttribute(root, 'model', model);
  r.setAttribute(root, 'system.version', '1');

  const t1 = r.begin('llm.turn', model, root);
  r.event(t1, 'tool.input', { tool: 'search', input: '{}' });
  if (opts.eventBody !== undefined) r.event(t1, 'note', opts.eventBody);
  r.end(t1, { usage });

  if (opts.skill) {
    const cap = r.begin('capability', opts.skill, root);
    const tc = r.begin('llm.turn', model, cap);
    r.end(tc, { usage });
    r.end(cap);
  }

  if (opts.extraTurn) {
    const t2 = r.begin('llm.turn', model, root);
    r.end(t2); // 无计量：不让 totalUsage 差异混进用例
  }

  r.end(root);
  return r.snapshot('ok');
}

/** 手写 trace（可控 startedAt/endedAt），供时长比对用例 */
function timedTrace(durationMs: number): Trace {
  const root: Span = {
    spanId: 'root',
    traceId: 't',
    parentSpanId: null,
    kind: 'run',
    name: 'app',
    startedAt: 1000,
    endedAt: 1000 + durationMs,
    status: 'ok',
    attributes: {},
    events: [],
  };
  return {
    traceId: 't',
    rootSpanId: 'root',
    spans: [root],
    status: 'ok',
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
}

describe('diffTraces（trace diff / A-B 比对）', () => {
  it('同构造两 trace → equal，summary/spans 均无差异（traceId 与墙钟不参与）', () => {
    const d = diffTraces(buildTrace(), buildTrace());
    assert.equal(d.equal, true);
    assert.deepEqual(d.summary, []);
    assert.deepEqual(d.spans, []);
  });

  it('换模型：turn 仍按 kind 配对，差异是 name 字段差 + 根 attributes.model 的 summary 差', () => {
    const d = diffTraces(buildTrace({ model: 'model-a' }), buildTrace({ model: 'model-b' }));
    assert.equal(d.equal, false);

    // run 级：根 attributes.model 第一眼可见
    assert.deepEqual(d.summary, [{ field: 'attributes.model', a: 'model-a', b: 'model-b' }]);

    // turn 配对成功（无缺侧），差异仅为 name 字段；
    // 根 span 自身也参与字段级比对（其 attributes.model 差在 summary 与根 SpanDiff 各出现一次：
    // summary 是「第一眼」run 级视图，spans 是完整的逐节点视图）
    assert.equal(d.spans.length, 2);
    const root = d.spans[0];
    assert.equal(root.path, 'run:app');
    assert.deepEqual(root.fields, [{ field: 'attributes.model', a: 'model-a', b: 'model-b' }]);
    const turn = d.spans[1];
    assert.equal(turn.path, 'run:app/llm.turn#0');
    assert.ok(turn.a && turn.b); // 两侧都在 = 配上了，而不是各报一条缺失
    assert.deepEqual(turn.fields, [{ field: 'name', a: 'model-a', b: 'model-b' }]);
  });

  it('一侧多一个主循环回合 → 缺侧 SpanDiff（fields 为空，path 照给）', () => {
    const d = diffTraces(buildTrace(), buildTrace({ extraTurn: true }));
    assert.equal(d.equal, false);
    assert.deepEqual(d.summary, []); // 多的回合无计量，totalUsage 不受影响

    assert.equal(d.spans.length, 1);
    const missing = d.spans[0];
    assert.equal(missing.path, 'run:app/llm.turn#1');
    assert.equal(missing.a, undefined);
    assert.ok(missing.b);
    assert.deepEqual(missing.fields, []);
  });

  it('usage 不同 → summary totalUsage.* 与 turn usage.* 各记一条', () => {
    const u2: Usage = { ...U1, inputTokens: 20 };
    const d = diffTraces(buildTrace({ usage: U1 }), buildTrace({ usage: u2 }));

    assert.deepEqual(d.summary, [{ field: 'totalUsage.inputTokens', a: 10, b: 20 }]);
    assert.equal(d.spans.length, 1);
    assert.deepEqual(d.spans[0].fields, [{ field: 'usage.inputTokens', a: 10, b: 20 }]);
  });

  it('usage 一侧有一侧无也是差异（undefined 与 0 不同）', () => {
    const a = buildTrace();
    const b = buildTrace();
    const bTurn = b.spans.find((s) => s.kind === 'llm.turn')!;
    delete bTurn.usage;
    b.totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

    const d = diffTraces(a, b);
    assert.ok(
      d.summary.some((e) => e.field === 'totalUsage.inputTokens' && e.a === 10 && e.b === 0),
    );
    assert.ok(
      d.spans[0].fields.some(
        (e) => e.field === 'usage.inputTokens' && e.a === 10 && e.b === undefined,
      ),
    );
    // costEstimate：有 vs 无同样记差
    assert.ok(
      d.spans[0].fields.some(
        (e) => e.field === 'usage.costEstimate' && e.a === 0.001 && e.b === undefined,
      ),
    );
  });

  it('capability 名不同（skill:a vs skill:b）→ 不配对，两侧各一条缺侧', () => {
    const d = diffTraces(buildTrace({ skill: 'skill:a' }), buildTrace({ skill: 'skill:b' }));
    assert.equal(d.equal, false);

    const paths = d.spans.map((s) => s.path).sort();
    assert.deepEqual(paths, ['run:app/capability:skill:a', 'run:app/capability:skill:b']);
    const onlyA = d.spans.find((s) => s.path.endsWith('skill:a'))!;
    const onlyB = d.spans.find((s) => s.path.endsWith('skill:b'))!;
    assert.ok(onlyA.a && !onlyA.b);
    assert.ok(onlyB.b && !onlyB.a);
    assert.deepEqual(onlyA.fields, []);
    assert.deepEqual(onlyB.fields, []);
    // 缺侧子树不下钻：capability 里的子 llm.turn 不单独出现
    assert.equal(d.spans.length, 2);
  });

  it('事件 body 不同 → events[i].body 字段差（name 相同则不多记）', () => {
    const d = diffTraces(buildTrace({ eventBody: 'hello' }), buildTrace({ eventBody: 'world' }));
    assert.equal(d.spans.length, 1);
    assert.deepEqual(d.spans[0].fields, [{ field: 'events[1].body', a: 'hello', b: 'world' }]);
  });

  it('事件计数不等 → 一条 events 计数差', () => {
    const d = diffTraces(buildTrace(), buildTrace({ eventBody: 'extra' }));
    assert.deepEqual(d.spans[0].fields, [{ field: 'events', a: 1, b: 2 }]);
  });

  it('ignoreTiming 缺省 true：时长差不报；false 时报 duration（比时长而非绝对时间戳）', () => {
    const a = timedTrace(100);
    const b = timedTrace(200);

    const ignored = diffTraces(a, b);
    assert.equal(ignored.equal, true);

    const d = diffTraces(a, b, { ignoreTiming: false });
    assert.equal(d.equal, false);
    assert.equal(d.spans.length, 1);
    assert.equal(d.spans[0].path, 'run:app');
    assert.deepEqual(d.spans[0].fields, [{ field: 'duration', a: 100, b: 200 }]);
  });

  it('事件差异超过 20 条：截断并记一条 events 说明', () => {
    const mk = (prefix: string): Trace => {
      const r = new TraceRecorder();
      const root = r.begin('run', 'app', null);
      const t = r.begin('llm.turn', 'model-a', root);
      for (let i = 0; i < 15; i++) r.event(t, `${prefix}-e${i}`, `${prefix}-${i}`);
      r.end(t);
      r.end(root);
      return r.snapshot('ok');
    };
    // 15 个事件 × name+body 全不同 = 30 条差异 > 20 上限
    const d = diffTraces(mk('a'), mk('b'));
    const fields = d.spans[0].fields;
    assert.equal(fields.length, 21);
    assert.equal(fields.filter((e) => e.field === 'events').length, 1);
    assert.ok(String(fields[20].a).includes('另有 10 条未列出'));
  });
});
