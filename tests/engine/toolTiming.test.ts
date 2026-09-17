import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import type { AgentTool, Span, Trace } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * E1 —— 普通工具的耗时/成败必须可从 trace 读到。
 *
 * 背景：普通工具**不建 span**（既定决策，为控 trace 体积），只在 turn 上记
 * `tool.input` / `tool.output` 事件。补时序之前，占多数的普通工具其耗时**完全不可观测**。
 */

const SCHEMA: AgentTool['inputSchema'] = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

function toolOutputEvent(trace: Trace): Record<string, unknown> {
  for (const s of trace.spans) {
    for (const e of s.events)
      if (e.name === 'tool.output') return e.body as Record<string, unknown>;
  }
  throw new Error('trace 里没有 tool.output 事件');
}

function toolSpanWith(trace: Trace): Span {
  const s = trace.spans.find((x) => x.kind === 'llm.turn');
  if (!s) throw new Error('没有 llm.turn span');
  return s;
}

async function runWith(tool: AgentTool, toolTimeoutMs?: number) {
  const { client } = mockClient([toolUseMsg('echo', { text: 'hi' }), endTurnMsg('done')]);
  return runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: [tool],
    client: client as never,
    ...(toolTimeoutMs != null ? { toolTimeoutMs } : {}),
  });
}

describe('E1 工具级时序（tool.output 事件带 durationMs / ok / errorKind）', () => {
  it('成功：durationMs ≥ 0，ok=true，无 errorKind', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'ok';
      },
    };
    const result = await runWith(tool);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.tool, 'echo');
    assert.equal(body.ok, true);
    assert.equal('errorKind' in body, false, '成功路径不带 errorKind');
    assert.equal(typeof body.durationMs, 'number');
    // ⚠️ 别写成 `>= 5`：Node 的 setTimeout 允许**提前不到 1ms** 触发，阈值不是运行时承诺的下限。
    // 实测探针（2× CPU 超订，各 20000 轮）：5ms 提前触发 90 次，最小实测 4ms；
    // 20ms 提前触发 133 次，最小实测 19ms。上下界一起给，既容忍那一毫秒，
    // 又不让它退化成「只要 ≥ 阈值就过」。
    const dur = body.durationMs as number;
    assert.ok(dur >= 4 && dur <= 500, `durationMs 应覆盖工具内部 5ms 等待，实际 ${dur}`);
  });

  it('工具自判超时（抛 code="timeout"）→ 记 errorKind=timeout，不落成 threw/unknown', async () => {
    // 契约（见 core/timeout.ts）：任何 `code === 'timeout'` 的错误都归超时账 ——
    // 「谁判的超时」不再改变 trace 的归类（此前桥自判的超时落成 error(unknown) + threw）。
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: async () => {
        throw Object.assign(new Error('上游连接超时'), { code: 'timeout' });
      },
    };
    const result = await runWith(tool);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'timeout');
    assert.match(String(body.content), /^error\(timeout\): 上游连接超时$/);
  });

  it('工具抛错：ok=false + errorKind=threw，且 run 不失败（is_error 回模型）', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: () => {
        throw new Error('boom');
      },
    };
    const result = await runWith(tool);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'threw');
    assert.equal(result.stopReason, 'end_turn', '工具抛错不应中断 run');
    assert.equal(result.error, undefined);
  });

  it('入参不合 schema：ok=false + errorKind=invalid_input（方法体不执行）', async () => {
    let called = false;
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: () => {
        called = true;
        return 'x';
      },
    };
    // 模型给的 input 缺 required 的 text
    const { client } = mockClient([toolUseMsg('echo', {}, 'tu1'), endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      client: client as never,
    });
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'invalid_input');
    assert.equal(called, false, 'schema 不过时方法体不得执行');
  });

  it('工具超时：ok=false + errorKind=timeout，durationMs ≥ 超时阈值（且 run 不失败）', async () => {
    // ⚠️ 用**永不自行结束**的工具断言超时路径 —— 别写成「工具 sleep 60ms vs 超时 20ms」的赛跑。
    // 那种写法靠两条 setTimeout 的先后定输赢，3 倍余量在满载 runner 上会翻：实测 8 倍 CPU 超订下
    // **29 次挂 1 次**（工具赢了超时，ok=true 而不是 timeout）。
    // 这里的闸门只由本测试释放，所以工具在断言前**不可能** settle ⇒ 超时必然先生效，与调度无关。
    // 「超预算的工具即便赢了竞速也必须记 timeout」由下面那条用例守着（引擎侧已按实测耗时硬化）。
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tool: AgentTool = {
      name: 'echo',
      description: 'slow',
      inputSchema: SCHEMA,
      run: async () => {
        await gate;
        return 'late';
      },
    };
    try {
      const result = await runWith(tool, 20);
      const body = toolOutputEvent(result.trace);
      assert.equal(body.ok, false);
      assert.equal(body.errorKind, 'timeout');
      // 同上：容忍 setTimeout 提前不到 1ms —— CI 的红就是这么来的。
      // 实测该延迟下 20000 轮提前触发 133 次（最小 19ms vs 预算 20），
      // 且同一超订条件下这条断言修前 90 次挂 1 次、修后 0 次。
      const timedOutDur = body.durationMs as number;
      assert.ok(
        timedOutDur >= 19 && timedOutDur <= 2000,
        `超时路径也要记耗时，实际 ${timedOutDur}`,
      );
      assert.equal(result.stopReason, 'end_turn');
    } finally {
      release(); // 放掉挂起的工具（超时语义是「放弃等待」，工具内部可能还在跑 —— 正是本用例的前提）
    }
  });

  it('超预算才 settle 的工具必须记 timeout（赢了竞速也不算通过）', async () => {
    // 回归门禁（2026-09-14 语义收紧）：旧实现只认 `Promise.race` 的结果，而竞速不是硬保证 ——
    // 工具与截止计时器同批到期时列表顺序决定谁先 resolve，超预算的工具会被记成 ok=true。
    // 这里的工具在**自己的回调里 resolve 之后同步阻塞**越过截止：确定性复现「计时器输给工具」，
    // 不靠调度运气（旧实现返回 'late' ⇒ ok=true，硬化后必须记 timeout）。
    const tool: AgentTool = {
      name: 'echo',
      description: 'slow',
      inputSchema: SCHEMA,
      run: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('late');
            const until = Date.now() + 60;
            while (Date.now() < until) {}
          }, 10);
        }),
    };
    const result = await runWith(tool, 20);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false, '超预算的工具即便赢了竞速也不得记成成功');
    assert.equal(body.errorKind, 'timeout');
    assert.ok((body.durationMs as number) >= 20, `超时路径也要记耗时，实际 ${body.durationMs}`);
  });

  it('每个工具各记一条 tool.output（并行工具不串）', async () => {
    const mk = (name: string): AgentTool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => name,
    });
    const { client } = mockClient([
      {
        ...toolUseMsg('a', {}, 'tu_a'),
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'a', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'b', input: {} },
        ],
      },
      endTurnMsg('done'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [mk('a'), mk('b')],
      client: client as never,
    });
    const bodies = result.trace.spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'tool.output')
      .map((e) => e.body as Record<string, unknown>);
    assert.equal(bodies.length, 2);
    assert.deepEqual(
      bodies.map((b) => b.tool_use_id).sort(),
      ['tu_a', 'tu_b'],
      'tool_use_id 保证同名/并行工具的事件可正确配对',
    );
    for (const b of bodies) assert.equal(typeof b.durationMs, 'number');
  });

  it('tool.input 事件不带时序（时序只在 output 上，避免同一事实两处记）', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: () => 'ok',
    };
    const result = await runWith(tool);
    const inputEvent = toolSpanWith(result.trace).events.find((e) => e.name === 'tool.input')!;
    assert.equal('durationMs' in (inputEvent.body as object), false);
  });
});
