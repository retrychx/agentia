import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner } from '../../src/index.js';
import type { AppCallable, TaskRecord, TaskSink } from '../../src/index.js';
import type { AgentRunResult } from '../../src/index.js';

function fakeApp(ok = true): AppCallable & { calls: number } {
  const app = {
    name: 'fake',
    calls: 0,
    async run() {
      app.calls++;
      return {
        run: { runId: `r-${app.calls}`, status: ok ? ('succeeded' as const) : ('failed' as const) },
        result: {
          finalText: ok ? 'ok' : '',
          ...(ok ? {} : { error: { type: 'api', message: 'boom', retryable: false } }),
        } as AgentRunResult,
      };
    },
  };
  return app;
}

/** 收集回调的 sink */
function collector(): { sink: TaskSink; got: TaskRecord[] } {
  const got: TaskRecord[] = [];
  return {
    got,
    sink: {
      onFinished: (rec) => {
        got.push(rec);
      },
    },
  };
}

describe('TaskSink —— 任务完成回调（C5）', () => {
  it('任务达终态后回调，收到的是那份记录', async () => {
    const app = fakeApp();
    const { sink, got } = collector();
    const runner = new AsyncRunner(app, { taskSinks: [sink] });
    const submitted = runner.submit('hi');
    const done = await runner.awaitTask(submitted.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(got.length, 1);
    assert.equal(got[0].taskId, submitted.taskId);
    assert.equal(got[0].status, 'succeeded');
    assert.equal(got[0].runId, 'r-1');
    assert.equal(got[0].finishedAt !== undefined, true, '回调里应看到收尾时间');
  });

  it('失败的任务同样回调（状态机视角「达终态」就够了）', async () => {
    const app = fakeApp(false);
    const { sink, got } = collector();
    const runner = new AsyncRunner(app, { taskSinks: [sink] });
    const submitted = runner.submit('hi');
    const rec = await runner.awaitTask(submitted.taskId);
    assert.equal(rec.status, 'failed');
    assert.equal(got.length, 1);
    assert.equal(got[0].status, 'failed');
    assert.equal(got[0].error?.message, 'boom');
  });

  it('sink 抛错被吞，不影响任务状态；也不挡住后面的 sink', async () => {
    const app = fakeApp();
    const order: string[] = [];
    const boom: TaskSink = {
      onFinished: () => {
        order.push('boom');
        throw new Error('回调炸了');
      },
    };
    const after: TaskSink = {
      onFinished: () => {
        order.push('after');
      },
    };
    const runner = new AsyncRunner(app, { taskSinks: [boom, after] });
    const submitted = runner.submit('hi');
    const rec = await runner.awaitTask(submitted.taskId);
    assert.equal(rec.status, 'succeeded', '回调抛错不得把任务打成失败');
    assert.deepEqual(order, ['boom', 'after'], '一个 sink 炸了，后面的照常收到');
  });

  it('异步 sink 会被等到（回调里的副作用先于「任务已知完成」发生）', async () => {
    const app = fakeApp();
    let flushed = false;
    const slow: TaskSink = {
      onFinished: async () => {
        await new Promise((r) => setTimeout(r, 15));
        flushed = true;
      },
    };
    const runner = new AsyncRunner(app, { taskSinks: [slow] });
    runner.submit('hi');
    await runner.drain({ timeoutMs: 2000 });
    assert.equal(flushed, true, 'drain 返回时回调必须已经跑完');
  });

  it('不配 taskSinks → 零开销、行为不变', async () => {
    const app = fakeApp();
    const runner = new AsyncRunner(app);
    const submitted = runner.submit('hi');
    const rec = await runner.awaitTask(submitted.taskId);
    assert.equal(rec.status, 'succeeded');
  });
});
