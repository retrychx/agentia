import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetGuard, executeRun } from '../../src/index.js';
import type { BudgetSnapshot, Trace, Usage } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg, U } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

function traceWith(u: Partial<Usage>): Trace {
  return {
    traceId: 't',
    rootSpanId: 'r',
    spans: [],
    status: 'ok',
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ...u,
    },
  };
}

describe('createBudgetGuard（C1）', () => {
  it('未配置上限 → 永不触发（零配置即零开销）', () => {
    const g = createBudgetGuard();
    assert.equal(g.check(traceWith({ inputTokens: 1e9, outputTokens: 1e9 })), null);
  });

  it('token 口径 = input + output + cacheRead + cacheCreation；等于上限不算超（严格大于）', () => {
    const g = createBudgetGuard({ maxTotalTokens: 10 });
    assert.equal(g.check(traceWith({ inputTokens: 5, outputTokens: 5 })), null, '恰好等于不超');
    assert.equal(
      g.check(traceWith({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 1 })),
      null,
      '缓存 token 也计入',
    );
    assert.equal(
      g.check(traceWith({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 2 })),
      'tokens',
    );
  });

  it('tokens 先于 cost 判定（两个都超时报 tokens）', () => {
    const g = createBudgetGuard({ maxTotalTokens: 10, maxCostUsd: 0.000001 });
    assert.equal(g.check(traceWith({ inputTokens: 100, outputTokens: 0, costEstimate: 1 })), 'tokens');
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
});

describe('U 常量与预算口径一致性（防 helpers 漂移）', () => {
  it('helpers 的 U 合计 15 token —— 上面几条断言的基准', () => {
    assert.equal(U.input_tokens + U.output_tokens, 15);
  });
});
