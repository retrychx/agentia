import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder } from '../../src/index.js';
import type { Usage } from '../../src/index.js';

/**
 * 单元 usage 聚合 —— `core/trace.ts` 从第一天就声明了「unit.usage = 其子孙 llm.turn 的聚合，
 * 仅供展示、不计入 totalUsage」，但实现里**从未写入过**这个字段。
 *
 * 后果：指标/报告拿不到「某个子 agent 花了多少」。这里把已声明的语义补成事实，并钉住
 * 两条不变量：① 只累加 llm.turn（层层嵌套不双算）；② totalUsage 口径不变。
 */

const U = (input: number, output: number, cost?: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ...(cost === undefined ? {} : { costEstimate: cost }),
});

describe('TraceRecorder：unit span 的 usage = 子孙 llm.turn 聚合', () => {
  it('直接子 turn 的 usage 汇总到 unit span（结束时就地写入）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'agent.run', null);
    const unit = r.begin('unit', 'summarize', root);
    r.setAttribute(unit, 'skill', 'summarize');
    const t1 = r.begin('llm.turn', 'claude-opus-5', unit);
    r.end(t1, { usage: U(100, 20, 0.01) });
    const t2 = r.begin('llm.turn', 'claude-opus-5', unit);
    r.end(t2, { usage: U(50, 10, 0.005) });
    r.end(unit, { status: 'ok' });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    const span = trace.spans.find((s) => s.spanId === unit)!;
    assert.deepEqual(
      { i: span.usage?.inputTokens, o: span.usage?.outputTokens, c: span.usage?.costEstimate },
      { i: 150, o: 30, c: 0.015 },
    );
    // totalUsage 口径不变：只累加 llm.turn（unit 的聚合值不得再算一遍）
    assert.deepEqual(
      { i: trace.totalUsage.inputTokens, o: trace.totalUsage.outputTokens, c: trace.totalUsage.costEstimate },
      { i: 150, o: 30, c: 0.015 },
    );
  });

  it('嵌套 unit（skill 里跑 subagent）：外层聚合含内层，且不双算', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'agent.run', null);
    const skill = r.begin('unit', 'pipeline', root);
    r.setAttribute(skill, 'skill', 'pipeline');
    // skill 自己先调一次模型
    const s1 = r.begin('llm.turn', 'claude-opus-5', skill);
    r.end(s1, { usage: U(10, 1, 0.001) });
    // 再起一个 subagent（它是 skill 的子 unit）
    const sub = r.begin('unit', 'researcher', skill);
    r.setAttribute(sub, 'subagent', 'researcher');
    const t1 = r.begin('llm.turn', 'claude-opus-5', sub);
    r.end(t1, { usage: U(200, 40, 0.02) });
    r.end(sub, { status: 'ok' });
    r.end(skill, { status: 'ok' });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    const skillSpan = trace.spans.find((s) => s.spanId === skill)!;
    const subSpan = trace.spans.find((s) => s.spanId === sub)!;
    assert.equal(subSpan.usage?.inputTokens, 200, '内层只算自己的子孙');
    assert.equal(skillSpan.usage?.inputTokens, 210, '外层聚合 = 自身 turn + 内层全部 turn');
    assert.equal(skillSpan.usage?.costEstimate, 0.021);
    // 全 trace 的 token 只算 llm.turn 一次
    assert.equal(trace.totalUsage.inputTokens, 210);
  });

  it('unit 内一次模型都没调 → usage 保持 undefined（不造假 0）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'agent.run', null);
    const unit = r.begin('unit', 'noop', root);
    r.setAttribute(unit, 'skill', 'noop');
    r.end(unit, { status: 'ok' });
    r.end(root, { status: 'ok' });
    const span = r.snapshot('ok').spans.find((s) => s.spanId === unit)!;
    assert.equal(span.usage, undefined);
  });

  it('调用方显式给 usage 时以显式值为准（不被聚合覆盖）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'agent.run', null);
    const unit = r.begin('unit', 'x', root);
    const t = r.begin('llm.turn', 'm', unit);
    r.end(t, { usage: U(100, 0) });
    r.end(unit, { status: 'ok', usage: U(7, 8) });
    r.end(root, { status: 'ok' });
    assert.equal(r.snapshot('ok').spans.find((s) => s.spanId === unit)!.usage?.inputTokens, 7);
  });

  it('未定价（无 costEstimate）的子孙不产出 costEstimate 字段', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'agent.run', null);
    const unit = r.begin('unit', 'x', root);
    const t = r.begin('llm.turn', 'mystery-model', unit);
    r.end(t, { usage: U(5, 5) });
    r.end(unit, { status: 'ok' });
    r.end(root, { status: 'ok' });
    const span = r.snapshot('ok').spans.find((s) => s.spanId === unit)!;
    assert.equal(span.usage?.inputTokens, 5);
    assert.equal('costEstimate' in (span.usage as object), false);
  });
});
