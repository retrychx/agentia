import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, mapWithConcurrency } from '../../src/index.js';
import { TIMED_OUT, withTimeout } from '../../src/engine/concurrency.js';
import { mockClient, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

/** 造一条「一个回合里并行调 N 个工具」的响应 */
function parallelToolsMsg(n: number) {
  return {
    id: 'm-par',
    model: 'claude-opus-5',
    stop_reason: 'tool_use' as const,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
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

/**
 * `withTimeout` 的**硬保证**（2026-09-14 语义收紧，见 `docs/spec.md` §10 / roadmap 同日记）。
 *
 * 背景：旧实现只认 `Promise.race` 的结果，而竞速**不是硬保证** —— 工具与截止计时器
 * 在同一毫秒内建、又因事件循环被饿住而同批到期时，列表顺序决定谁先 resolve。
 * 实测「60ms 工具 vs 20ms 预算」在 8 倍 CPU 超订下单进程 1200 次翻转 1 次：
 * 超预算的工具被记成 `ok: true`，超时护栏**静默失效**。
 */
describe('withTimeout：超时是硬保证（语义收紧后的回归门禁）', () => {
  /**
   * 造「计时器输给工具」的竞速：工具在自己的回调里 resolve 之后**同步阻塞**越过截止。
   * 微任务虽已排入，但要等本轮回调跑完 —— 于是工具先被 `race` 看见，
   * 而截止计时器（已到期）只能等下一轮 timers 阶段。
   *
   * 这是**确定性**复现，不靠调度运气：实测旧实现返回 `'late'`、硬化后返回 `TIMED_OUT`。
   */
  const resolveThenBlock = (value: string, innerMs: number, blockMs: number): Promise<string> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(value);
        const until = Date.now() + blockMs;
        while (Date.now() < until) {}
      }, innerMs);
    });

  it('工具超预算才 settle：即便赢了竞速也必须记超时（旧实现会放行）', async () => {
    const out = await withTimeout(resolveThenBlock('late', 10, 60), 20);
    assert.equal(out, TIMED_OUT, '超预算的工具不得因竞速结果被记成成功');
  });

  it('预算内完成则照常返回（硬化不得把「完成得早、观察得晚」误判成超时）', async () => {
    // 同一形态，但预算远大于实测耗时：工具实测 ~70ms，预算 5000ms ⇒ 必须成功。
    const out = await withTimeout(resolveThenBlock('done', 10, 60), 5000);
    assert.equal(out, 'done');
  });

  it('工具不自行结束：截止计时器先赢 ⇒ TIMED_OUT', async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((r) => {
      release = r;
    });
    // 本用例**故意不加**心跳保活：截止计时器不得 `unref`（否则它作为唯一把手时进程会先退出、
    // 这个 await 永不 settle）。同一条性质有专门门禁跑在干净子进程里：
    // `tests/timeoutLiveness.test.ts`（同进程测不出来 —— 测试跑器自己持有把手）。
    try {
      assert.equal(await withTimeout(gate, 20), TIMED_OUT);
    } finally {
      release('late');
    }
  });

  it('工具 reject 原样抛出（不得被兜底判定吞成超时）', async () => {
    await assert.rejects(() => withTimeout(Promise.reject(new Error('boom')), 5000), /boom/);
  });

  it('timeoutMs 非正数 = 不设超时，原样透传', async () => {
    assert.equal(await withTimeout(Promise.resolve('x'), 0), 'x');
    assert.equal(await withTimeout(resolveThenBlock('y', 1, 0), -1), 'y');
  });
});
