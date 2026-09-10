import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, Run, RunContext, Tool, createApp, SystemPrompt } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

describe('Run 生命周期', () => {
  it('状态机：非法迁移抛错', () => {
    const run = new Run();
    assert.equal(run.status, 'queued');
    run.start();
    assert.equal(run.status, 'running');
    assert.throws(() => run.start(), /cannot start a run in status running/);
    assert.equal(run.runId, run.recorder.traceId);
  });

  it('executeRun 成功路径：finish 映射 stopReason → 状态', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'hi' }],
      client,
      runName: 't',
    });
    assert.equal(run.status, 'succeeded');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.trace.traceId, run.runId);
  });

  it('contextInit 抛错 + rethrow:false：Run.fail 补根兜底，原始错误进 result.error', async () => {
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'hi' }],
      client: mockClient([endTurnMsg('x')]).client,
      contextInit: () => {
        throw new Error('seed boom');
      },
      rethrow: false,
    });
    assert.equal(run.status, 'failed');
    assert.equal(result.stopReason, 'error');
    assert.match(result.error?.message ?? '', /seed boom/);
    assert.ok(result.trace.spans.length >= 1, 'trace 有补开的根 span');
    assert.equal(result.trace.spans[0].status, 'error');
  });

  it('contextInit 抛错缺省 rethrow：异常冒泡', async () => {
    await assert.rejects(
      executeRun({
        messages: [{ role: 'user', content: 'hi' }],
        client: mockClient([endTurnMsg('x')]).client,
        contextInit: () => {
          throw new Error('seed boom');
        },
      }),
      /seed boom/,
    );
  });

  it('工具执行体内 RunContext.current() 可读 blackboard，run 外为 undefined', async () => {
    class T {
      @Tool({ description: 'd', schema: OBJ })
      probe(): string {
        return String(RunContext.current()?.get('k') ?? 'none');
      }
    }
    const app = createApp({
      providers: [{ provide: 't', useClass: T }],
      system: new SystemPrompt().add('role', 'r', true),
    });
    const { client, seen } = mockClient([toolUseMsg('probe', {}), endTurnMsg('ok')]);
    const { run } = await app.run([{ role: 'user', content: 'go' }], {
      client,
      blackboard: { k: 'v1' },
    });
    assert.equal(run.status, 'succeeded');
    assert.ok(JSON.stringify(seen[1]).includes('v1'), 'tool_result 应含 blackboard 值');
    assert.equal(RunContext.current(), undefined);
  });
});
