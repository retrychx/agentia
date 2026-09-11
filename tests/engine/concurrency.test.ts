import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, mapWithConcurrency } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

/** 造一条「一个回合里并行调 N 个工具」的响应 */
function parallelToolsMsg(n: number) {
  return {
    id: 'm-par',
    model: 'claude-opus-5',
    stop_reason: 'tool_use' as const,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: Array.from({ length: n }, (_, i) => ({
      type: 'tool_use',
      id: `tu${i}`,
      name: 't',
      input: { n: i },
    })),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency（C2）', () => {
  it('结果顺序与输入一致（模型靠 tool_use_id 配对，但可读性靠顺序）', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await sleep(n * 5); // 故意让先发起的后完成
      return n * 10;
    });
    assert.deepEqual(out, [30, 10, 20]);
  });

  it('并发数被限制在 limit 内', async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      live++;
      peak = Math.max(peak, live);
      await sleep(5);
      live--;
      return null;
    });
    assert.equal(peak, 2, `峰值并发应为 2，实际 ${peak}`);
  });

  it('limit 非正 / 非有限 / 超过条数 → 一律视为不限', async () => {
    for (const limit of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 99]) {
      let live = 0;
      let peak = 0;
      await mapWithConcurrency([1, 2, 3], limit, async () => {
        live++;
        peak = Math.max(peak, live);
        await sleep(5);
        live--;
        return null;
      });
      assert.equal(peak, 3, `limit=${limit} 应不限并发`);
    }
  });

  it('空数组 → 空结果（不启动 worker）', async () => {
    assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
  });
});

describe('工具级超时 / 并发闸门接进主循环（C2）', () => {
  it('工具超时 → 该条 tool_result 记 is_error 回模型，run 继续跑完', async () => {
    const { client } = mockClient([parallelToolsMsg(1), endTurnMsg('收工')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      toolTimeoutMs: 20,
      tools: [
        {
          name: 't',
          description: 'x',
          inputSchema: OBJ,
          // 比超时慢得多
          run: () => new Promise((res) => setTimeout(() => res('late'), 200)),
        },
      ],
    });
    assert.equal(result.stopReason, 'end_turn', '工具超时不杀 run');
    assert.equal(run.status, 'succeeded');
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false, '超时按失败记账');
    assert.match(String((out.body as { content: string }).content), /timeout/);
  });

  it('工具没超时则照常返回（超时是上限不是延迟）', async () => {
    const { client } = mockClient([parallelToolsMsg(1), endTurnMsg('收工')]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      toolTimeoutMs: 200,
      tools: [{ name: 't', description: 'x', inputSchema: OBJ, run: async () => 'fast' }],
    });
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, true);
    assert.match(String((out.body as { content: string }).content), /fast/);
  });

  it('maxToolConcurrency 限制同回合并发（默认不限 = 旧行为）', async () => {
    const runWith = async (limit: number | undefined): Promise<number> => {
      let live = 0;
      let peak = 0;
      const { client } = mockClient([parallelToolsMsg(6), endTurnMsg('done')]);
      await executeRun({
        messages: [{ role: 'user', content: 'go' }],
        client,
        ...(limit === undefined ? {} : { maxToolConcurrency: limit }),
        tools: [
          {
            name: 't',
            description: 'x',
            inputSchema: OBJ,
            run: async () => {
              live++;
              peak = Math.max(peak, live);
              await sleep(10);
              live--;
              return 'ok';
            },
          },
        ],
      });
      return peak;
    };
    assert.equal(await runWith(2), 2, '设了闸门就该卡在 2');
    assert.equal(await runWith(undefined), 6, '不设闸门保持全并行（旧行为）');
  });

  it('工具抛错仍不中断 run（与超时同一语义，回归保护）', async () => {
    const { client } = mockClient([parallelToolsMsg(1), endTurnMsg('收工')]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [
        {
          name: 't',
          description: 'x',
          inputSchema: OBJ,
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
    });
    assert.equal(result.stopReason, 'end_turn');
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false);
  });
});
