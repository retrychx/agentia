import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetGuard, executeRun, runAgent } from '../../src/index.js';
import type { BudgetSnapshot, Trace, Usage } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg, U } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

function usageWith(u: Partial<Usage>): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...u,
  };
}

function traceWith(u: Partial<Usage>): Trace {
  return {
    traceId: 't',
    rootSpanId: 'r',
    spans: [],
    status: 'ok',
    totalUsage: usageWith(u),
  };
}

describe('createBudgetGuard（C1）', () => {
  it('未配置上限 → 永不触发（零配置即零开销）', () => {
    const g = createBudgetGuard();
    assert.equal(g.check(traceWith({ inputTokens: 1e9, outputTokens: 1e9 })), null);
  });

  it('入参只要求 totalUsage（引擎传廉价视图，不必整份 Trace）', () => {
    // 引擎侧走的是 `check({ totalUsage: recorder.usage() })` —— 不拷 spans / attributes /
    // events（本护栏每回合要判两次，走 snapshot() 会白拷全部 span 的 attributes/events）。
    // 这条同时钉住结构约束：参数类型里**根本没有 spans**，护栏想读也读不到。
    const g = createBudgetGuard({ maxTotalTokens: 10 });
    assert.equal(g.check({ totalUsage: usageWith({ inputTokens: 3 }) }), null);
    assert.equal(g.check({ totalUsage: usageWith({ inputTokens: 11 }) }), 'tokens');
  });

  it('token 口径 = input + output + cacheRead + cacheCreation；等于上限不算超（严格大于）', () => {
    const g = createBudgetGuard({ maxTotalTokens: 10 });
    assert.equal(g.check(traceWith({ inputTokens: 5, outputTokens: 5 })), null, '恰好等于不超');
    assert.equal(
      g.check(
        traceWith({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 1 }),
      ),
      null,
      '缓存 token 也计入',
    );
    assert.equal(
      g.check(
        traceWith({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 2 }),
      ),
      'tokens',
    );
  });

  it('tokens 先于 cost 判定（两个都超时报 tokens）', () => {
    const g = createBudgetGuard({ maxTotalTokens: 10, maxCostUsd: 0.000001 });
    assert.equal(
      g.check(traceWith({ inputTokens: 100, outputTokens: 0, costEstimate: 1 })),
      'tokens',
    );
  });

  it('只配 cost：按 costEstimate 判；未知模型（无 costEstimate）→ 不触发', () => {
    const g = createBudgetGuard({ maxCostUsd: 0.5 });
    assert.equal(g.check(traceWith({ inputTokens: 1, costEstimate: 0.4 })), null);
    assert.equal(g.check(traceWith({ inputTokens: 1, costEstimate: 0.6 })), 'cost');
    // 模型不在价格表 → costEstimate 为 undefined → 恒 0 → 护栏不触发（这是文档写明的边界）
    assert.equal(
      g.check(traceWith({ inputTokens: 1e9 })),
      null,
      '没有成本估算时 maxCostUsd 无从判断，不能假装超了',
    );
  });

  it('超限回调收到完整快照', () => {
    const seen: BudgetSnapshot[] = [];
    const g = createBudgetGuard({ maxTotalTokens: 10, onExceed: (s) => seen.push(s) });
    g.check(traceWith({ inputTokens: 8, outputTokens: 7, costEstimate: 0.25 }));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], {
      kind: 'tokens',
      limit: 10,
      actual: 15,
      totalTokens: 15,
      costUsd: 0.25,
    });
  });
});

describe('成本硬管控接进主循环（C1）', () => {
  it('超限即停：不再发下一个请求，也不执行本回合的工具；run 判失败', async () => {
    let toolCalls = 0;
    const { client, seen } = mockClient([toolUseMsg('t', {})]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxTotalTokens: 10, // U = 15 tokens，第一回合记账后即超
      tools: [
        {
          name: 't',
          description: 'x',
          inputSchema: OBJ,
          run: async () => {
            toolCalls++;
            return 'ok';
          },
        },
      ],
    });
    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(result.error?.type, 'budget_exceeded');
    assert.equal(run.status, 'failed', 'budget_exceeded 是护栏拦下的，算失败');
    assert.equal(seen.length, 1, '超限后不得再发模型请求（这才是「硬管控」）');
    assert.equal(toolCalls, 0, '超限后不执行本回合工具（避免继续产生副作用）');
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    const ev = root.events.find((e) => e.name === 'budget.exceeded');
    assert.ok(ev, 'run 根应记 budget.exceeded 事件');
    assert.equal((ev.body as BudgetSnapshot).kind, 'tokens');
  });

  it('cost 护栏：按模型价格表估算，超限同样停', async () => {
    const { client, seen } = mockClient([toolUseMsg('t', {})]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      model: 'claude-opus-5',
      maxCostUsd: 1e-9, // U 的 15 token 远超
      tools: [{ name: 't', description: 'x', inputSchema: OBJ, run: async () => 'ok' }],
    });
    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(seen.length, 1);
    assert.match(String(result.error?.message), /成本/);
  });

  it('自然收尾的 run 不因「最后一回合超限」被改判失败，但仍记事件（可观测）', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxTotalTokens: 10,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(run.status, 'succeeded', '这一回合本来就要结束了，不该被追认为失败');
    assert.equal(result.finalText, 'done');
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    assert.ok(
      root.events.some((e) => e.name === 'budget.exceeded'),
      '仍要留下超限痕迹，否则「最后一回合用超了」永远无人知晓',
    );
  });

  it('未超限时照常跑完（护栏不影响正常路径）', async () => {
    const { client, seen } = mockClient([toolUseMsg('t', {}), endTurnMsg('done')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxTotalTokens: 1000,
      tools: [{ name: 't', description: 'x', inputSchema: OBJ, run: async () => 'ok' }],
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(run.status, 'succeeded');
    assert.equal(seen.length, 2);
  });

  it('工具执行期间（嵌套能力记账）把用量推过上限 → 回合入口再判拦住，不发新请求', async () => {
    // 模拟子 agent 循环：工具在自己的执行过程中往**同一 recorder** 记了 100 token 的账
    // （子循环的真实记账方式）。回合末那次判断当时还没超（15 ≤ 50），
    // 超支发生在工具执行期间 —— 下一回合入口必须拦住，不得再发模型请求。
    const { client, seen } = mockClient([toolUseMsg('spend', {}), endTurnMsg('不该被请求')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxTotalTokens: 50,
      tools: [
        {
          name: 'spend',
          description: 'x',
          inputSchema: OBJ,
          run: (_input, ctx) => {
            const turn = ctx!.recorder.begin('llm.turn', 'claude-opus-5', ctx!.parentSpanId);
            ctx!.recorder.end(turn, {
              usage: {
                inputTokens: 60,
                outputTokens: 40,
                // 缓存两项刻意非零：护栏的 token 求和与 trace 的求和是**两份实现**，
                // 全 0 的话「谁漏加了哪个字段」两边都看不出来（见下面的对账断言）。
                cacheReadTokens: 5,
                cacheCreationTokens: 7,
              },
            });
            return 'spent';
          },
        },
      ],
    });
    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(result.error?.type, 'budget_exceeded');
    assert.equal(run.status, 'failed');
    assert.equal(seen.length, 1, '超支后不得再发模型请求');

    // ── 「护栏读到的数 = trace 交付的数」的真断言 ────────────────────────────
    // tracer.test.ts 那条 deepEqual 是**自我比较**（snapshot 的 totalUsage 就是 usage()），
    // 永远绿。这个不变量今天靠「三处调用点都写 args.recorder.usage()」保证，
    // 所以真正会被改坏的是**调用点**：谁换成增量 / 旧拷贝 / 手写的和，护栏就会拿错数
    // 而 trace 交付另一个数 —— 成本护栏按错的数判，没有任何报错。
    // 从产物侧对账：run 根 budget.exceeded 事件里的数 vs trace.totalUsage。
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    const ev = root.events.find((e) => e.name === 'budget.exceeded');
    assert.ok(ev, 'run 根应记 budget.exceeded（护栏触发时读到的数就在这里）');
    const snap = ev.body as BudgetSnapshot;
    const u = result.trace.totalUsage;
    assert.equal(
      snap.totalTokens,
      u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens,
      `护栏读到的累计 token 必须等于 trace 交付的 totalUsage（护栏 ${snap.totalTokens} vs trace ${u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens}）`,
    );
    assert.equal(
      snap.costUsd,
      u.costEstimate ?? 0,
      '成本同理：护栏判超限用的那个数必须就是 trace 交付的那个数',
    );
    assert.equal(snap.totalTokens, 127, '15（回合 1）+ 112（工具内嵌套记账）');
  });

  it('超预算的同回合：submit_result 仍被处理（纯内部提交不丢），其余工具跳过', async () => {
    let sideEffects = 0;
    const { client, seen } = mockClient([
      // 回合 1：普通工具（15 token，预算内）
      toolUseMsg('work', {}, 'tu1'),
      // 回合 2：同回合并行「有副作用的工具 + submit_result」，记账后累计 30 > 20
      {
        ...toolUseMsg('work', {}, 'tu2'),
        content: [
          { type: 'tool_use', id: 'tu2', name: 'work', input: {} },
          {
            type: 'tool_use',
            id: 'tu3',
            name: 'submit_result',
            input: { answer: '42' },
          },
        ],
      },
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      client,
      maxTotalTokens: 20,
      tools: [
        {
          name: 'work',
          description: 'x',
          inputSchema: OBJ,
          run: () => {
            sideEffects++;
            return 'ok';
          },
        },
      ],
      resultSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });
    assert.equal(
      result.stopReason,
      'end_turn',
      '结果已交出 → 按正常收尾（与自然收尾不改判同口径）',
    );
    assert.deepEqual(result.typed, { answer: '42' }, '超预算不该把已到手的结构化结果丢掉');
    assert.equal(sideEffects, 1, '超预算回合里的其他工具仍然跳过（不产生副作用）');
    assert.equal(seen.length, 2, '落定结果后不再发新请求');
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    assert.ok(
      root.events.some((e) => e.name === 'budget.exceeded'),
      '超限痕迹仍要留下（可观测），只是不改判已交付结果的 run',
    );
  });
});

describe('U 常量与预算口径一致性（防 helpers 漂移）', () => {
  it('helpers 的 U 合计 15 token —— 上面几条断言的基准', () => {
    assert.equal(U.input_tokens + U.output_tokens, 15);
  });
});
