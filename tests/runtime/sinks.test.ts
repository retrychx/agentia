import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Trace, TraceSink } from '../../src/index.js';
import { createOtlpExporter, executeRun } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/** 收集型 sink：记录收到的 trace */
function collector(): { sink: TraceSink; traces: Trace[] } {
  const traces: Trace[] = [];
  return {
    traces,
    sink: {
      export(t) {
        traces.push(t);
      },
    },
  };
}

describe('executeRun · trace 出口（sinks）', () => {
  it('成功 run：sink 收到完整 trace（含 run 根）', async () => {
    const { sink, traces } = collector();
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('done')]).client,
      runName: 't',
      sinks: [sink],
    });
    assert.equal(traces.length, 1);
    assert.equal(traces[0].traceId, run.runId);
    assert.equal(traces[0].traceId, result.trace.traceId);
    assert.ok(traces[0].spans.length >= 1);
    assert.equal(traces[0].spans[0].kind, 'run');
  });

  it('sink 抛错：run 结果不受影响，且不阻断后续 sink（吞错）', async () => {
    const bad: TraceSink = {
      export() {
        throw new Error('sink boom');
      },
    };
    const { sink, traces } = collector();
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('done')]).client,
      sinks: [bad, sink],
    });
    assert.equal(run.status, 'succeeded');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(traces.length, 1, '前一个 sink 抛错不阻断后续 sink');
  });

  it('sink 抛错：吞掉但**不再零信号** —— console.warn 落一条带「trace sink」与错误消息的告警', async () => {
    const bad: TraceSink = {
      export() {
        throw new Error('sink boom');
      },
    };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let status: string | undefined;
    try {
      const { run } = await executeRun({
        messages: [{ role: 'user', content: 'hi' }],
        client: mockClient([endTurnMsg('done')]).client,
        sinks: [bad],
      });
      status = run.status;
    } finally {
      console.warn = origWarn;
    }
    assert.equal(status, 'succeeded', 'run 照常成功（观测不击穿业务）');
    assert.equal(warnings.length, 1, '一次投递失败 = 恰好一条告警');
    assert.match(warnings[0]!, /trace sink/, '文案含「trace sink」字样（可 grep）');
    assert.match(warnings[0]!, /sink boom/, '告警要带 sink 的错误消息');
  });

  it('失败 run（rethrow:false）：sink 仍收到 trace，且状态为 error', async () => {
    const { sink, traces } = collector();
    const { run } = await executeRun({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('x')]).client,
      contextInit: () => {
        throw new Error('seed boom');
      },
      rethrow: false,
      sinks: [sink],
    });
    assert.equal(run.status, 'failed');
    assert.equal(traces.length, 1);
    assert.equal(traces[0].status, 'error');
  });

  it('缺省 rethrow：异常冒泡前也已投递', async () => {
    const { sink, traces } = collector();
    await assert.rejects(
      executeRun({
        messages: [{ role: 'user', content: 'hi' }],
        client: mockClient([endTurnMsg('x')]).client,
        contextInit: () => {
          throw new Error('seed boom');
        },
        sinks: [sink],
      }),
      /seed boom/,
    );
    assert.equal(traces.length, 1);
  });

  it('不给 sinks：不报错（缺省无观测）', async () => {
    const { run } = await executeRun({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('done')]).client,
    });
    assert.equal(run.status, 'succeeded');
  });

  it('createOtlpExporter 的返回值天然满足 TraceSink（形状复用，零改动可当 sink）', () => {
    // 类型层断言：赋值成功即证明结构兼容（否则 typecheck 失败）
    const exporter: TraceSink = createOtlpExporter({ endpoint: 'http://127.0.0.1:9/v1/traces' });
    assert.equal(typeof exporter.export, 'function');
  });
});
