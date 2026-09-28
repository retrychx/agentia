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

/**
 * 未决 tool_use 遇上**没有它的菜单**（`errorKind='unknown_tool'`）—— 钉的是**现状**。
 *
 * ⚠️ 本组不是「期望行为」的用例，是**现状**的用例 —— 别把它读成对这个行为的背书：
 *   菜单变了（工具被删 / 改名）时，引擎把 `unknown tool: <name>` 当成该 tool_use 的出参
 *   交回模型，run **照常跑完**，而调用方这一侧**零失败信号**（`result.error === undefined`、
 *   `stopReason='end_turn'`、`finalText` 是模型自己编的那句）。唯一痕迹是 trace 上那条
 *   `errorKind='unknown_tool'`。
 *
 * 为什么要有这组：这条路径此前**一个用例都没有**（2026-09-27 实测 `grep -rn unknown_tool
 * tests/` 零命中 —— 它只出现在源码的类型联合 `tool-events.ts:27` 与分支 `turn.ts:611`；
 * 唯一提到它的是 `eventChars.test.ts` 的一句注释，解释子 agent 为什么要写 `tools: ['inner']`）。
 * 也就是说「菜单变了会静默降级」这件事，连我们自己都没盯过。
 *
 * 两条动作是**分开**的，别在本轮把它们合并：
 *   ① 补用例（本组）—— 防的是**无意改动**（分支被重排、归类被改掉、静默变成别的东西）；
 *   ② 把静默变成「调用方看得见的东西」—— 那要**改语义**，属 durable 调研文档候选 3
 *     （`docs/plans/2026-09-27-durable-execution-research.md` §4.1 实测 + §6 候选 3），
 *     动代码前按纪律回 spec §10 立项。
 *   ⇒ 将来要改这里时：**不要悄悄把断言改成「期望 run 失败」** —— 那等于跳过立项直接改语义
 *     （trace 口径与 result 口径会不一致）。要改就连同 ② 一起改，并把这段注释一起结清。
 */
describe('未决 tool_use 遇上没有它的菜单（errorKind=unknown_tool —— 钉现状）', () => {
  const echoTool = (run: () => unknown = () => 'echo-ok'): AgentTool => ({
    name: 'echo',
    description: 'echo',
    inputSchema: SCHEMA,
    run,
  });

  function toolOutputs(trace: Trace): Record<string, unknown>[] {
    return trace.spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'tool.output')
      .map((e) => e.body as Record<string, unknown>);
  }

  /**
   * 某次请求里**回给模型**的 tool_result 块（未找到则抛 —— 别让空数组静默通过）。
   *
   * ⚠️ 不能只看 `messages.at(-1)`：`mockClient` 的 `seen.push(params)` 存的是**引用**，
   * 引擎随后往同一个 `messages` 数组里继续追加（下一轮 assistant……）⇒ 等你回头读时，
   * 那次请求的末尾早已不是当轮的 tool_result。实测就是这么挂的（报「末尾是 assistant」）。
   * 所以按**类型**扫全部消息，并顺手断言装它的那条消息是 user。
   */
  function toolResultsSent(seen: unknown[], index = 1): Record<string, unknown>[] {
    const msgs = (seen[index] as { messages?: unknown[] } | undefined)?.messages;
    if (!msgs) throw new Error(`第 ${index} 次请求没有 messages（mock 脚本没跑到位？）`);
    const carriers = msgs.filter(
      (m) =>
        (m as { role?: string }).role === 'user' &&
        Array.isArray((m as { content?: unknown }).content) &&
        ((m as { content: Record<string, unknown>[] }).content as Record<string, unknown>[]).some(
          (b) => b.type === 'tool_result',
        ),
    ) as { content: Record<string, unknown>[] }[];
    if (carriers.length === 0)
      throw new Error(`第 ${index} 次请求里没有带 tool_result 的 user 消息`);
    return carriers.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'));
  }

  it('未知工具：trace 记 unknown_tool，run 照常收尾，模型收到「没有这个工具」', async () => {
    const { client, seen } = mockClient([
      toolUseMsg('ghost', { q: 1 }, 'tu-ghost'),
      endTurnMsg('done'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [echoTool()], // 菜单里没有 ghost（= 老 run 的未决 tool_use 遇上改过的菜单）
      client: client as never,
    });

    const outputs = toolOutputs(result.trace);
    assert.equal(outputs.length, 1);
    const body = outputs[0]!;
    assert.equal(body.tool, 'ghost');
    assert.equal(body.tool_use_id, 'tu-ghost');
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'unknown_tool');
    assert.equal(body.content, 'unknown tool: ghost', '出参就是这一句（没有栈、没有堆）');

    // 调用方这一侧：**零失败信号** —— 这就是 G4 的静默（候选 3 要收口的东西）
    assert.equal(result.error, undefined);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.suspendedMessages, undefined, '未知工具不挂起');
    assert.equal(result.pendingApprovals, undefined);

    // 模型这一侧：拿到 is_error 的 tool_result，可以据此自己往下编 —— run 因此照样收尾
    const blocks = toolResultsSent(seen);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.tool_use_id, 'tu-ghost');
    assert.equal(blocks[0]!.is_error, true);
    assert.equal(blocks[0]!.content, 'unknown tool: ghost');
  });

  it('未知工具的归类与审批无关：硬塞决定（批准或拒绝）都仍记 unknown_tool', async () => {
    // 判序钉的是两处**独立**机制，缺一处这条不变量都还成立 —— 变异验证时踩过：
    //   ① `turn.ts:536` 的 `decision = tool?.approval === 'required' ? … : undefined`
    //      ⇒ 不存在的工具拿不到决定；
    //   ② `turn.ts:609` 的 `else if (!tool)` **在** `else if (decision && !decision.approved)` 之前。
    // 单独放宽 ①（改成 `args.approvals?.[use.id]`）或单独调换 ② 都**语义等价于原代码**，
    // 用例当然不红（那不是用例空转，是变异设计错 —— 技能 §8.9 ⑥）。真正能证伪的做法是
    // **两处一起破**：实测那样做 ⇒ 恰好这条红（approved=false 落到 denied）。
    // ⇒ 将来重构这段时：别以为「只动一处很安全」——两处是对同一件事的双保险，
    //   动之前先确认另一处还在，否则这条静默降级会变成**错误的**归类（denied）。
    for (const approved of [true, false]) {
      const { client } = mockClient([toolUseMsg('ghost', {}, 'tu-ghost'), endTurnMsg('done')]);
      const result = await runAgent({
        messages: [{ role: 'user', content: 'go' }],
        tools: [echoTool()],
        client: client as never,
        approvals: { 'tu-ghost': { approved } },
      });
      const body = toolOutputs(result.trace)[0]!;
      assert.equal(body.errorKind, 'unknown_tool', `approved=${approved} 不该改变归类`);
      assert.equal(result.suspendedMessages, undefined, `approved=${approved} 不该挂起`);
    }
  });

  it('同回合混合：未知工具不拖垮其他工具（正常的照常执行，两条结果都回给模型）', async () => {
    let echoCalled = false;
    const { client, seen } = mockClient([
      {
        ...toolUseMsg('echo', { text: 'hi' }, 'tu-echo'),
        content: [
          { type: 'tool_use', id: 'tu-echo', name: 'echo', input: { text: 'hi' } },
          { type: 'tool_use', id: 'tu-ghost', name: 'ghost', input: {} },
        ],
      },
      endTurnMsg('done'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        echoTool(() => {
          echoCalled = true;
          return 'echo-ok';
        }),
      ],
      client: client as never,
    });

    assert.equal(echoCalled, true, '未知工具不该阻止同回合其他工具执行');
    const bodies = toolOutputs(result.trace);
    assert.equal(bodies.length, 2, '两个 tool_use 各记一条 tool.output');
    assert.deepEqual(
      bodies.map((b) => (b.tool === 'ghost' ? b.errorKind : b.ok ? 'ok' : '???')).sort(),
      ['ok', 'unknown_tool'],
    );
    // Anthropic 协议要求每个 tool_use 都有配对 tool_result：两条都得回给模型
    const blocks = toolResultsSent(seen);
    assert.deepEqual(blocks.map((b) => b.tool_use_id).sort(), ['tu-echo', 'tu-ghost']);
    assert.deepEqual(blocks.map((b) => b.is_error).sort(), [false, true]);
  });
});
