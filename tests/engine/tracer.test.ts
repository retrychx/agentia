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
    r.end(turn, {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
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

  it('totalUsage 只累加 llm.turn：capability 的聚合用量不参与求和（不双算）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const capability = r.begin('capability', 'subagent:reviewer', root);
    const turn = r.begin('llm.turn', 'model-x', capability);
    const u = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 };
    r.end(turn, { usage: u });
    // capability span 写入「子孙聚合」用量（子 agent 展示用）——不得计进 totalUsage
    r.end(capability, { usage: u });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    assert.equal(trace.totalUsage.inputTokens, 100, 'capability 聚合不得与 llm.turn 重复计数');
    assert.equal(trace.totalUsage.outputTokens, 40);
    // 但 capability span 自身的 usage 仍保留在 span 上（供展示）
    assert.equal(trace.spans.find((s) => s.spanId === capability)?.usage?.inputTokens, 100);
  });

  it('totalUsage.costEstimate 按 1e-6 取整（与 capability 聚合同口径，浮点尾差不进 trace）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    for (const costEstimate of [0.1, 0.2]) {
      const turn = r.begin('llm.turn', 'model-x', root);
      r.end(turn, {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate,
        },
      });
    }
    r.end(root, { status: 'ok' });
    // 0.1 + 0.2 = 0.30000000000000004（IEEE754）—— 取整口径必须一致收成 0.3
    assert.equal(r.snapshot('ok').totalUsage.costEstimate, 0.3);
  });

  it('snapshot 的 events/attributes 是拷贝：交付后迟到的记账不变异已交付的 trace', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'model-x', root);
    r.end(turn, {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const delivered = r.snapshot('ok');
    const snapTurn = delivered.spans.find((s) => s.spanId === turn)!;
    assert.equal(snapTurn.events.length, 0);

    // 模拟「超时工具的后台残尾」：trace 已交付，recorder 仍在向同一 span 记账
    r.event(turn, 'tool.output', { tool: 'slow' });
    r.setAttribute(turn, 'late_write', true);

    assert.equal(snapTurn.events.length, 0, '已交付的 snapshot 不得被事后变异');
    assert.equal(snapTurn.attributes.late_write, undefined);
    // recorder 的内部视角不受影响：下一次 snapshot 能看到迟到的事件
    const later = r.snapshot('ok');
    assert.equal(later.spans.find((s) => s.spanId === turn)!.events.length, 1);
  });
});
