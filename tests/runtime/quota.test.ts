import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunContext, SystemPrompt, Tool, createApp } from '../../src/index.js';
import type { BlackboardKey, TraceSink, UnitMiddleware } from '../../src/index.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

/**
 * 多租户配额（D4 第二部分）：框架**不做**独立配额子系统（spec §10），
 * 用既有 middleware + TraceSink + BudgetGuard 组合即可。本文件把
 * `docs/usage-guide.md` 里那段示例**真跑一遍** —— 文档里的写法必须真能工作，
 * 否则就是「文档承诺了、代码没有」（仓库的既有约定）。
 *
 * 注意：这里用 `as BlackboardKey` 断言拿租户键，而**不做** `declare module` 声明合并
 * —— 声明合并是**编译程序内全局生效**的，混进本套件会污染 src 的类型（见 AGENTS.md 的
 * typecheck 说明）。真实项目里用声明合并拿到键补全，见 usage-guide §5.1。
 */

const TENANT_LIMIT = 100;
const OBJ = { type: 'object', properties: {} } as const;

/** 按租户记账的配额：中间件拦在单元调用前，sink 在 run 收尾后累加 */
function tenantApp(limit: number) {
  const spentTokens = new Map<string, number>(); // 真实场景换成 Redis / DB，语义一样
  let toolRuns = 0;

  class Units {
    @Tool({ name: 'work', description: '干活', schema: OBJ })
    work(): string {
      toolRuns++;
      return 'done';
    }
  }

  const quotaMiddleware: UnitMiddleware = async (call, next) => {
    const tenant = RunContext.current()?.get('tenant' as BlackboardKey) as string | undefined;
    if (tenant && (spentTokens.get(tenant) ?? 0) >= limit) {
      // 抛错 → 该条 tool_result 记 is_error 回模型（不中断 run），
      // 且**单元执行体不会跑** —— 用满配额的租户不产生副作用。
      throw new Error(`租户 ${tenant} 的额度已用满`);
    }
    return next();
  };

  const quotaSink: TraceSink = {
    export(trace) {
      // sink 在 run 的 async 上下文里投递（executeRun 内 await），所以这里读得到黑板
      const tenant = RunContext.current()?.get('tenant' as BlackboardKey) as string | undefined;
      if (!tenant) return;
      const u = trace.totalUsage;
      const used = u.inputTokens + u.outputTokens;
      spentTokens.set(tenant, (spentTokens.get(tenant) ?? 0) + used);
    },
  };

  const app = createApp({
    name: 'quota-app',
    system: new SystemPrompt().add('role', 'r'),
    providers: [{ provide: 'u', useClass: Units }],
    middleware: [quotaMiddleware],
    sinks: [quotaSink],
  });

  return { app, spentTokens, toolRuns: () => toolRuns };
}

describe('多租户配额（D4：middleware + sink + BudgetGuard 组合）', () => {
  it('额度没满：单元正常执行，run 收尾后按租户记账', async () => {
    const { app, spentTokens, toolRuns } = tenantApp(TENANT_LIMIT);
    const { client } = mockClient([toolUseMsg('work', {}), endTurnMsg('搞定')]);
    const { result } = await app.run([{ role: 'user', content: 'go' }], {
      client,
      blackboard: { tenant: 'acme' },
    });

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(toolRuns(), 1, '额度内该跑就跑');
    assert.equal(spentTokens.get('acme'), 30, '两个回合各 10+5');
  });

  it('额度用满：拦在单元调用前 → 单元不执行、tool_result 记 is_error、run 不崩', async () => {
    const { app, spentTokens, toolRuns } = tenantApp(0); // 一开始就是满的
    const { client } = mockClient([toolUseMsg('work', {}), endTurnMsg('那算了')]);
    const { result } = await app.run([{ role: 'user', content: 'go' }], {
      client,
      blackboard: { tenant: 'acme' },
    });

    assert.equal(result.stopReason, 'end_turn', '配额拦截不该杀死 run（模型可以换路）');
    assert.equal(toolRuns(), 0, '被拦下的单元绝不能产生副作用');
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false);
    assert.match(String((out.body as { content: string }).content), /额度已用满/);
    assert.equal(spentTokens.get('acme'), 30, '被拦下的 run 同样花了模型钱，必须记账');
  });

  it('黑板没种 tenant 时中间件放行 —— 配额是可选护栏，不是全局闸门', async () => {
    const { app, spentTokens, toolRuns } = tenantApp(0);
    const { client } = mockClient([toolUseMsg('work', {}), endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'go' }], { client });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(toolRuns(), 1);
    assert.equal(spentTokens.size, 0, '没租户就不记账');
  });

  it('与 per-run 的 BudgetGuard 组合：租户累计额度 + 单次 run 上限，两道护栏各管一段', async () => {
    const { app, toolRuns } = tenantApp(TENANT_LIMIT);
    const { client } = mockClient([toolUseMsg('work', {}), endTurnMsg('不该走到这里')]);
    const { result } = await app.run([{ role: 'user', content: 'go' }], {
      client,
      blackboard: { tenant: 'acme' },
      maxTotalTokens: 10, // 比一个回合还小
    });

    assert.equal(result.stopReason, 'budget_exceeded', '单次上限由 BudgetGuard 拦（C1）');
    assert.equal(toolRuns(), 0, '超预算的 run 不执行工具（避免副作用）');
    assert.equal(
      result.trace.spans.some((s) => s.events.some((e) => e.name === 'budget.exceeded')),
      true,
      'run 根留一条 budget.exceeded 事件可观测',
    );
  });
});
