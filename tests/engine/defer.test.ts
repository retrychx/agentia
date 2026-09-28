import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from '../../src/index.js';
import type { AgentTool, MessageParam, ToolResultBlockParam } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg, U } from '../helpers.js';
import { createDeferRequest, resolveWakeAt } from '../../src/engine/defer.js';

/**
 * 时间挂起（durable timer）引擎侧 —— 工具说「现在还不是时候，T 之后再问我」。
 *
 * 与 `approval.test.ts` 是同一条挂起骨架的两种**原因**，但有一条关键差别，本文件的用例
 * 就是围着它写的：审批那条闸在**执行前**（没有决定 ⇒ 一个工具都不跑），延后是**工具自己
 * 在跑的时候**提出来的 ⇒ 那个回合的工具**真跑过了**，只是结果整批作废（协议配平：
 * 每个 tool_use 必须有配对 tool_result，部分执行 + 部分挂起会产出残缺历史）。
 * 于是「工具真跑过」与「历史里没有 tool_result」必须同时成立 —— 只验其一会漏掉这一整类。
 */

const OBJ = { type: 'object', properties: {} } as const;
const NOW = 1_700_000_000_000;

/** 等时刻的开关（`null` = 时刻到了，本次不再请求延后） */
interface Gate {
  at: number | null;
}

/** 等时刻的工具：`gate.at` 非空 ⇒ 本次请求延后（测试随后把它置 null 模拟「时刻到了」） */
function waiterTool(spy: { calls: number }, gate: Gate): AgentTool {
  return {
    name: 'wait_for_batch',
    description: '等批处理作业',
    inputSchema: OBJ,
    run: (_input, ctx) => {
      spy.calls++;
      if (gate.at !== null) {
        ctx!.deferUntil!(gate.at);
        return 'deferred'; // 返回值不重要：整批作废
      }
      return 'ready';
    },
  };
}

/**
 * 从**请求侧**消息里按 tool_use_id 找那条 tool_result。
 *
 * ⚠️ 按 id 扫全表，而不是看末尾一条：mock client 存的是引擎那个**活数组的引用**，
 * run 跑完之后它已经继续长了几条（末尾会是收尾的 assistant）—— 用「最后一条」断言
 * 会假红（第一版就是这么错的）。这里要问的是「模型那次请求里**有没有**这条结果」。
 */
function findToolResult(
  messages: MessageParam[],
  toolUseId: string,
): ToolResultBlockParam | undefined {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const hit = m.content.find(
      (b): b is ToolResultBlockParam =>
        b.type === 'tool_result' && (b as { tool_use_id?: string }).tool_use_id === toolUseId,
    );
    if (hit) return hit;
  }
  return undefined;
}

describe('defer —— resolveWakeAt（工具契约的时刻校验）', () => {
  it('将来时刻原样通过：epoch 毫秒与 Date 两种入参', () => {
    assert.equal(resolveWakeAt(NOW + 60_000, NOW), NOW + 60_000);
    assert.equal(resolveWakeAt(new Date(NOW + 60_000), NOW), NOW + 60_000);
  });

  it('非有限数 ⇒ TypeError（NaN / ±Infinity / 非数字 / 非法 Date）', () => {
    const bad: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      'later',
      new Date(Number.NaN),
      undefined,
    ];
    for (const b of bad) {
      assert.throws(() => resolveWakeAt(b as number, NOW), TypeError, `应当响亮拒绝：${String(b)}`);
    }
  });

  it('不晚于现在 ⇒ TypeError（含**恰好等于现在**）—— 「立刻可续」会让到期扫描原地打转', () => {
    for (const b of [NOW, NOW - 1, NOW - 86_400_000, 0, -1]) {
      assert.throws(() => resolveWakeAt(b, NOW), TypeError, `应当响亮拒绝：${b}`);
    }
    // 阳性对照：只差 1ms 就必须通过（否则上面那组是靠「什么都拒」蒙对的）
    assert.equal(resolveWakeAt(NOW + 1, NOW), NOW + 1);
  });
});

describe('defer —— 回合级收集器', () => {
  it('一条请求：earliest 是它、ids 记名', () => {
    const d = createDeferRequest(() => NOW);
    d.request('tu-1', NOW + 500);
    assert.equal(d.earliest(), NOW + 500);
    assert.deepEqual(d.ids(), ['tu-1']);
  });

  it('多条请求取**最早**（并行工具的完成顺序不定）；同一 tool_use 重复请求也取最早', () => {
    const d = createDeferRequest(() => NOW);
    d.request('tu-b', NOW + 9_000);
    d.request('tu-a', NOW + 3_000);
    assert.equal(d.earliest(), NOW + 3_000, '早醒可补救，晚醒白等');
    d.request('tu-b', NOW + 1_000);
    assert.equal(d.earliest(), NOW + 1_000, '同一个 tool_use 再请求一次：取更早的那个');
    d.request('tu-b', NOW + 8_000);
    assert.equal(d.earliest(), NOW + 1_000, '更晚的请求不改写已记下的更早时刻');
    assert.deepEqual(d.ids(), ['tu-b', 'tu-a'], '按请求到达顺序');
  });

  it('一个请求都没有 ⇒ earliest undefined（阴性对照：不挂起）', () => {
    assert.equal(createDeferRequest(() => NOW).earliest(), undefined);
    assert.deepEqual(createDeferRequest(() => NOW).ids(), []);
  });
});

describe('时间挂起（引擎侧）', () => {
  // ⚠️ 时刻用**真实时钟**的相对偏移（不是上面那个固定的 NOW）：取值校验是拿真 `Date.now()`
  // 比的，写一个固定时间戳当「将来」，在它写下的当天就已经是过去 —— 那会让工具当场抛错、
  // 整条 run 走成 error（第一版用例正是这么咬到自己的）。
  const soon = () => Date.now() + 3_600_000;

  it('工具请求延后 ⇒ 整批挂起：工具真跑过、结果作废、wakeAt 落定、trace 记 defer.requested', async () => {
    const spy = { calls: 0 };
    const target = soon();
    const gate: Gate = { at: target };
    const { client } = mockClient([toolUseMsg('wait_for_batch', {}, 'tu1')]); // 只一步：挂起发生在请求模型之前
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [waiterTool(spy, gate)],
    });

    assert.equal(result.stopReason, 'suspended');
    assert.equal(run.status, 'suspended', '挂起不是成功也不是失败');
    assert.equal(run.finishedAt, undefined, '挂起不是终态：finishedAt 不置');
    assert.equal(result.error, undefined, '挂起不带 error');
    assert.equal(result.trace.status, 'ok', '挂起段执行无误，trace 不算失败');
    assert.equal(result.suspendedReason, 'timer', '挂起原因是**时间**（不是等人工）');
    assert.equal(result.wakeAt, target, '目标时刻落进结果形状');
    assert.deepEqual(result.pendingApprovals, ['tu1'], '在等的是这条 tool_use');

    assert.equal(
      spy.calls,
      1,
      '工具**真的执行过**（延后是执行中提出来的，与审批那条执行前闸不同）',
    );
    const sm = result.suspendedMessages!;
    assert.equal(sm.length, 2);
    assert.equal(sm[1].role, 'assistant');
    assert.deepEqual(
      (sm[1].content as Array<{ type: string }>).map((b) => b.type),
      ['tool_use'],
      '结果作废：历史以含未决 tool_use 的 assistant 结尾，一个 tool_result 都没推',
    );

    // 台账：请求记在发起回合的 turn span 上；工具的两笔账照记（它确实跑了）
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const req = turn.events.filter((e) => e.name === 'defer.requested');
    assert.equal(req.length, 1);
    const body = req[0]!.body as { wake_at: number; tool_use_ids: string[]; discarded: number };
    assert.equal(body.wake_at, target);
    assert.deepEqual(body.tool_use_ids, ['tu1']);
    assert.equal(body.discarded, 1, '被作废的 tool_result 条数要留痕');
    assert.equal(turn.events.filter((e) => e.name === 'tool.input').length, 1);
    assert.equal(turn.events.filter((e) => e.name === 'tool.output').length, 1);
  });

  it('醒来**重跑那一批**：拿到 tool_result 后接着走，收尾不带挂起痕迹', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: soon() };
    const { client, seen } = mockClient([
      toolUseMsg('wait_for_batch', {}, 'tu1'),
      endTurnMsg('到位了'),
    ]);
    const tools = [waiterTool(spy, gate)];
    const first = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools,
    });
    assert.equal(first.result.suspendedReason, 'timer');

    gate.at = null; // 时刻到了：工具这次不再请求延后
    const resumed = await executeRun({
      messages: first.result.suspendedMessages!,
      client,
      tools,
    });

    assert.equal(spy.calls, 2, '醒来重跑那一批（这是「整批语义」的直接后果）');
    assert.equal(resumed.result.stopReason, 'end_turn');
    assert.equal(resumed.run.status, 'succeeded');
    assert.equal(resumed.result.suspendedReason, undefined, '终态后挂起痕迹清掉');
    assert.equal(resumed.result.wakeAt, undefined, '目标时刻一并清掉');
    // 重跑的结果**这次真的进了历史**：第二次请求模型时末尾带上了 tool_result
    assert.equal(seen.length, 2, '恢复段又请求了一次模型');
    const sent = (seen[1] as { messages: MessageParam[] }).messages;
    const tr = findToolResult(sent, 'tu1');
    assert.ok(tr, '第二次请求里带了 tool_result（否则工具白跑了）');
    assert.equal((tr as { is_error?: boolean }).is_error, false, '这次是正常结果，不是错误');
    assert.equal(tr!.content, 'ready', '内容是**重跑**那一遍的产物（gate 已放开）');
  });

  it('醒来时条件仍未成熟 ⇒ 再挂一次，目标时刻以**本次**请求为准（不复用上一段的）', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: soon() };
    const { client } = mockClient([toolUseMsg('wait_for_batch', {}, 'tu1')]);
    const tools = [waiterTool(spy, gate)];
    const first = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools,
    });

    const later = soon() + 3_600_000;
    gate.at = later;
    const again = await executeRun({
      messages: first.result.suspendedMessages!,
      client,
      tools,
    });
    assert.equal(again.result.stopReason, 'suspended');
    assert.equal(again.result.suspendedReason, 'timer');
    assert.equal(again.result.wakeAt, later, '本次请求说了算，不是沿用上一段的时刻');
    assert.equal(spy.calls, 2, '重跑那一批（又请求了一次）');
    assert.deepEqual(again.result.pendingApprovals, ['tu1']);
  });

  it('非法时刻（在过去）⇒ 当场抛错走 is_error 的 tool_result，run **不**挂起', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() - 1 }; // 工具拿一个过去时刻去请求
    const { client, seen } = mockClient([
      toolUseMsg('wait_for_batch', {}, 'tu1'),
      endTurnMsg('看清了错误，改换路径'),
    ]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      tools: [waiterTool(spy, gate)],
    });

    assert.equal(result.stopReason, 'end_turn', '不挂起：契约违规走既有 is_error 路径');
    assert.equal(run.status, 'succeeded', '工具抛错不中断 run（同既有语义）');
    assert.equal(result.suspendedReason, undefined);
    assert.equal(result.wakeAt, undefined);
    assert.equal(spy.calls, 1);
    assert.equal(result.suspendedMessages, undefined, '非挂起收尾不带挂起历史');

    // 模型**看到**的是 is_error 的 tool_result，理由是「时刻必须在将来」（不是静默忽略、
    // 也不是把 run 整条废掉）—— 断言落在第二次请求的消息体上，因为那才是模型读到的东西
    assert.equal(seen.length, 2, '不挂起 ⇒ 照常再请求一次模型');
    const tr = findToolResult((seen[1] as { messages: MessageParam[] }).messages, 'tu1');
    assert.ok(tr, '第二次请求里带了这条 tool_result');
    assert.equal((tr as { is_error?: boolean }).is_error, true);
    assert.match(JSON.stringify(tr!.content), /必须在将来/);

    // 台账：这次调用记 threw（不是 unknown_tool / timeout），正文原样留下
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    const body = out.body as { ok: boolean; errorKind?: string };
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'threw');
  });

  it('同批有**没请求延后**的兄弟工具 ⇒ 事件记 discarded + 一条 console.warn，且醒来那个副作用**真的**再来一遍', async () => {
    // 这条钉的是「整批语义」的代价（spec §10 ② 决策 3）：作废的是**整批** tool_result，
    // 所以同回合里已经执行完的兄弟工具会在醒来重跑时再跑一遍。契约把它写成「看得见」的
    // 三件东西 —— 事件里的 discarded 条数、一条 console.warn、以及**行为本身**。
    // 前两件是信号，第三件才是事实：本项目最贵的一类错就是「只剩信号、行为没跟上」。
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const wait = { calls: 0 };
    const charge = { calls: 0 };
    const { client } = mockClient([
      {
        id: 'm1',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        usage: U,
        // 一个 assistant 消息带**两个** tool_use：模型只给延后的那个工具，兄弟是顺带的
        content: [
          { type: 'tool_use', id: 'tu1', name: 'wait_for_batch', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'charge_card', input: {} },
        ],
      },
      endTurnMsg('到位了'),
    ]);
    const tools: AgentTool[] = [
      waiterTool(wait, gate),
      {
        name: 'charge_card',
        description: '有副作用的工具（醒来重跑时会被执行第二遍）',
        inputSchema: OBJ,
        run: () => {
          charge.calls++;
          return 'charged';
        },
      },
    ];

    // console.warn 用**手写替换 + finally 还原**（不引 mock 库）：断言的是「有没有这条告警、
    // 它说的是不是这件事」。node:test 单文件内用例串行，替换窗口不会串到别的用例。
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warnings.push(a.map(String).join(' '));
    };
    let first: Awaited<ReturnType<typeof executeRun>>;
    try {
      first = await executeRun({ messages: [{ role: 'user', content: 'go' }], client, tools });
    } finally {
      console.warn = origWarn;
    }

    assert.equal(first.result.stopReason, 'suspended');
    assert.equal(first.result.suspendedReason, 'timer');
    assert.deepEqual(first.result.pendingApprovals, ['tu1'], '在等的只有**请求延后**的那条');
    assert.equal(wait.calls, 1);
    assert.equal(charge.calls, 1, '兄弟工具**真的执行过** —— 这正是要提示的代价');

    const turn = first.result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const body = turn.events.find((e) => e.name === 'defer.requested')!.body as {
      discarded: number;
      tool_use_ids: string[];
    };
    assert.equal(body.discarded, 2, '两条 tool_result 全被作废（含没请求延后的那条）');
    assert.deepEqual(body.tool_use_ids, ['tu1']);

    assert.equal(warnings.length, 1, '恰好一条告警（只有真存在兄弟时才提示）');
    assert.match(warnings[0]!, /1 条没有请求延后/);
    assert.match(warnings[0]!, /副作用会在醒来重跑时重复/);

    // 行为这一半：醒来整批重跑 ⇒ 那个有副作用的兄弟**再跑一遍**（不是理论上的重复）
    gate.at = null;
    const resumed = await executeRun({ messages: first.result.suspendedMessages!, client, tools });
    assert.equal(resumed.result.stopReason, 'end_turn');
    assert.equal(charge.calls, 2, '副作用真的重复了（契约②的代价）');
    assert.equal(wait.calls, 2);
  });
});
