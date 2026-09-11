import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder } from '../../src/index.js';

describe('TraceRecorder', () => {
  it('begin/end/属性/事件 全链路', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'model-x', root);
    r.setAttribute(turn, 'input_tokens', 10);
    r.event(turn, 'tool.input', { tool: 't' });
    r.end(turn, { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    assert.equal(trace.spans.length, 2);
    assert.equal(trace.spans[1].parentSpanId, root);
    assert.equal(trace.totalUsage.inputTokens, 10);
    assert.equal(trace.rootSpanId, root);
  });

  it('end 幂等：重复 end 不抛错也不覆盖', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    r.end(root, { status: 'ok' });
    r.end(root, { status: 'error' }); // 幂等忽略
    const trace = r.snapshot('ok');
    assert.equal(trace.spans[0].status, 'ok');
  });

  it('end 未知 span 抛错；event/setAttribute 对未知 span 静默（观测不中断业务）', () => {
    const r = new TraceRecorder();
    assert.throws(() => r.end('nope'), /span not found/);
    r.event('nope', 'e', {});
    r.setAttribute('nope', 'k', 'v');
  });

  it('run 根只能开一次；根未开 snapshot 抛错', () => {
    const r = new TraceRecorder();
    assert.throws(() => r.snapshot('ok'), /run root not started/);
    r.begin('run', 'app', null);
    assert.equal(r.rootStarted, true);
    assert.throws(() => r.begin('run', 'again', null), /run root already started/);
  });

  it('totalUsage 只累加 llm.turn：unit 的聚合用量不参与求和（不双算）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const unit = r.begin('unit', 'subagent:reviewer', root);
    const turn = r.begin('llm.turn', 'model-x', unit);
    const u = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 };
    r.end(turn, { usage: u });
    // unit span 写入「子孙聚合」用量（子 agent 展示用）——不得计进 totalUsage
    r.end(unit, { usage: u });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    assert.equal(trace.totalUsage.inputTokens, 100, 'unit 聚合不得与 llm.turn 重复计数');
    assert.equal(trace.totalUsage.outputTokens, 40);
    // 但 unit span 自身的 usage 仍保留在 span 上（供展示）
    assert.equal(trace.spans.find((s) => s.spanId === unit)?.usage?.inputTokens, 100);
  });
});
