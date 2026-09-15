import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachScore } from '../../src/index.js';
import type { Trace } from '../../src/index.js';

/** 最小合法 trace：只有根 span */
function traceOf(): Trace {
  return {
    traceId: 't-1',
    rootSpanId: 'root-1',
    status: 'ok',
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: 'root-1',
        traceId: 't-1',
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 1000,
        endedAt: 1010,
        status: 'ok',
        attributes: {},
        events: [],
      },
    ],
  };
}

describe('attachScore（R7 质量闭环：score 是 trace 一等公民）', () => {
  it('评分挂到根 span 的 score 事件，body 即 Score', () => {
    const trace = traceOf();
    attachScore(trace, { name: 'faithfulness', value: 0.87, source: 'judge-x', comment: 'ok' });
    const ev = trace.spans[0]!.events[0]!;
    assert.equal(ev.name, 'score');
    assert.deepEqual(ev.body, {
      name: 'faithfulness',
      value: 0.87,
      source: 'judge-x',
      comment: 'ok',
    });
    assert.equal(typeof ev.time, 'number');
  });

  it('多次调用 = 多条事件（不同维度各记各的），且只挂根 span', () => {
    const trace = traceOf();
    trace.spans.push({
      spanId: 'turn-1',
      traceId: 't-1',
      parentSpanId: 'root-1',
      kind: 'llm.turn',
      name: 'm',
      startedAt: 1001,
      status: 'ok',
      attributes: {},
      events: [],
    });
    attachScore(trace, { name: 'a', value: 1 });
    attachScore(trace, { name: 'b', value: 0 });
    assert.equal(trace.spans[0]!.events.length, 2);
    assert.equal(trace.spans[1]!.events.length, 0, '子 span 不该被挂评分');
  });

  it('找不到根 span 时静默忽略（观测不击穿业务）', () => {
    const trace = traceOf();
    trace.rootSpanId = 'missing';
    assert.doesNotThrow(() => attachScore(trace, { name: 'a', value: 1 }));
    assert.equal(trace.spans[0]!.events.length, 0);
  });
});
