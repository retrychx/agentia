import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachScore } from '../../src/index.js';
import {
  formatTraceparent,
  parseTraceparent,
  wireSpanId,
  wireTraceId,
} from '../../src/core/trace.js';
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

/**
 * id 的**线缆形态**（`wireTraceId` / `wireSpanId` / `formatTraceparent`）—— spec §9.2 出站传播。
 *
 * 这一组的价值在于**单一真源**：内部 id 是 UUID（去横线 32-hex），而 W3C 与 OTLP 都要求
 * trace 32-hex / span **16-hex**。OTLP 导出与出站头各写一份投影的后果，是同一次调用在两个
 * 系统里是**两个 span id**。otlp.test.ts 那边断言导出的 span id === `wireSpanId(…)`，
 * 这里断言出站串的 span 位 === `wireSpanId(…)` —— 两条合起来即是「collector 里的 id 与
 * 下游收到的 id 逐字相等」，不需要把两个模块拉进同一个测试。
 */
describe('id 线缆形态（W3C / OTLP 共用投影）', () => {
  const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('trace 去横线即 32-hex；span 必须截到 16-hex（OTLP 的 span id 是 8 字节）', () => {
    assert.equal(wireTraceId(UUID), '3f2504e04f8911d39a0c0305e82c3301');
    assert.equal(wireSpanId(UUID), '3f2504e04f8911d3');
    assert.equal(wireSpanId(UUID).length, 16);
  });

  it('幂等：已经是线缆形态的输入原样通过（上游 span id 被转发时不变形）', () => {
    assert.equal(wireTraceId('a'.repeat(32)), 'a'.repeat(32));
    assert.equal(wireSpanId('b'.repeat(16)), 'b'.repeat(16));
  });

  it('formatTraceparent 与 parseTraceparent 往返（生成 → 解析 === 内部 id 的线缆形态）', () => {
    const tp = formatTraceparent(UUID, UUID);
    assert.equal(tp, `00-3f2504e04f8911d39a0c0305e82c3301-3f2504e04f8911d3-00`);
    assert.deepEqual(parseTraceparent(tp), {
      traceId: wireTraceId(UUID),
      spanId: wireSpanId(UUID),
    });
  });

  it('flags 恒 00 —— 框架不采样，不替下游声明「已采样」', () => {
    assert.ok(formatTraceparent(UUID, UUID).endsWith('-00'));
  });
});
