import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, createSyncHandler } from '../../src/index.js';
import type { AppCallable, AgentRunResult, RunInvocationOptions } from '../../src/index.js';
import type Anthropic from '@anthropic-ai/sdk';

interface Call {
  messages: Anthropic.MessageParam[];
  opts?: RunInvocationOptions;
}

function recordingApp(): { app: AppCallable; calls: Call[] } {
  const calls: Call[] = [];
  const app: AppCallable = {
    name: 'rec',
    run: async (messages, opts) => {
      calls.push({ messages, opts });
      return {
        run: { runId: 'r1', status: 'succeeded' },
        result: { text: 'done' } as unknown as AgentRunResult,
      };
    },
  };
  return { app, calls };
}

describe('runSync / createSyncHandler（同步传输）', () => {
  it('string 入参规范化成 user message，返回 app.run 结果，opts 原样透传', async () => {
    const { app, calls } = recordingApp();
    const opts: RunInvocationOptions = { model: 'm', maxTokens: 100 };
    const out = await runSync(app, 'hi', opts);
    assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(calls[0].opts, opts, 'opts 同一引用透传');
    assert.equal(out.run.runId, 'r1');
    assert.equal(out.run.status, 'succeeded');
  });

  it('入参形态契约：{prompt} / {text} / {messages} / messages 数组', async () => {
    const { app, calls } = recordingApp();
    await runSync(app, { prompt: 'p' });
    await runSync(app, { text: 't' });
    await runSync(app, { messages: [{ role: 'user', content: 'm' }] });
    await runSync(app, [{ role: 'assistant', content: 'a' }]);
    assert.deepEqual(
      calls.map((c) => c.messages),
      [
        [{ role: 'user', content: 'p' }],
        [{ role: 'user', content: 't' }],
        [{ role: 'user', content: 'm' }],
        [{ role: 'assistant', content: 'a' }],
      ],
    );
  });

  it('空字符串入参 → 与 []、{prompt:""} 一致报错（不带空 messages 去调模型）', async () => {
    const { app, calls } = recordingApp();
    assert.throws(() => runSync(app, ''), /任务 messages 不能为空/);
    assert.throws(() => runSync(app, { prompt: '' }), /无法识别为任务输入/);
    assert.equal(calls.length, 0);
  });

  it('无法识别的入参同步抛错，不触碰 app.run', async () => {
    const { app, calls } = recordingApp();
    assert.throws(() => runSync(app, 123), /无法识别为任务输入/);
    assert.throws(() => runSync(app, {}), /无法识别为任务输入/);
    assert.throws(() => runSync(app, []), /任务 messages 不能为空/);
    assert.throws(() => runSync(app, { messages: [] }), /任务 messages 不能为空/);
    assert.equal(calls.length, 0);
  });

  it('app.run 拒绝 → 原样向上传播', async () => {
    const boom = new Error('engine down');
    const app: AppCallable = {
      name: 'f',
      run: async () => {
        throw boom;
      },
    };
    await assert.rejects(runSync(app, 'hi'), (e: unknown) => e === boom);
  });

  it('createSyncHandler：等价的 (input, opts?) 适配器', async () => {
    const { app, calls } = recordingApp();
    const handler = createSyncHandler(app);
    const out = await handler('hi');
    assert.equal(out.run.status, 'succeeded');
    assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(calls[0].opts, undefined);
    assert.throws(() => handler(null), /无法识别为任务输入/);
  });
});
