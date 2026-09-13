import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, buildPricing, DEFAULT_PRICING } from '../../src/index.js';
import type { AgentTool, Trace } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg, U } from '../helpers.js';

/**
 * F1（价格表可注入）/ F2（未定价显式）/ G3（生效配置快照）。
 *
 * 修的是两处「旋钮看着有、实际不生效」：
 * - 价格表硬编码 6 个模型 → 非 Anthropic 端点成本恒 0；
 * - 未定价模型静默返回 undefined → `maxCostUsd` 护栏静默失效、毫无提示。
 */

function turnSpans(trace: Trace) {
  return trace.spans.filter((s) => s.kind === 'llm.turn');
}

function rootSpan(trace: Trace) {
  const s = trace.spans.find((x) => x.spanId === trace.rootSpanId);
  if (!s) throw new Error('没有根 span');
  return s;
}

describe('F1 buildPricing', () => {
  it('不给覆盖 → 复用内置表；给覆盖 → 覆盖同名项 + 追加新模型', () => {
    assert.equal(buildPricing(), DEFAULT_PRICING);
    const merged = buildPricing({
      'claude-sonnet-4-6': { in: 1, out: 2 }, // 覆盖内置
      'deepseek-chat': { in: 0.27, out: 1.1 }, // 追加
    });
    assert.deepEqual(merged['claude-sonnet-4-6'], { in: 1, out: 2 });
    assert.deepEqual(merged['deepseek-chat'], { in: 0.27, out: 1.1 });
    assert.deepEqual(merged['claude-opus-5'], { in: 5, out: 25 }, '未覆盖的沿用内置');
    assert.deepEqual((DEFAULT_PRICING as Record<string, unknown>)['claude-sonnet-4-6'], {
      in: 3,
      out: 15,
    });
  });

  it('非法单价构造期抛错（不静默算出 NaN 成本让护栏失效）', () => {
    assert.throws(() => buildPricing({ m: { in: -1, out: 1 } }), /非法/);
    assert.throws(() => buildPricing({ m: { in: Number.NaN, out: 1 } }), /非法/);
    assert.throws(() => buildPricing({ m: { in: 1 } as never }), /非法/);
  });
});

describe('F1 价格覆盖生效于 run（含嵌套单元透传）', () => {
  it('非 Anthropic 模型配了 priceOverrides → turn 有 costEstimate', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      model: 'deepseek-chat',
      client: client as never,
      priceOverrides: { 'deepseek-chat': { in: 1, out: 2 } },
    });
    // usage 10 in / 5 out（helpers.U）→ 10e-6*1 + 5e-6*2 = 2e-5
    assert.equal(turnSpans(result.trace)[0]!.usage?.costEstimate, 0.00002);
    assert.equal(result.trace.totalUsage.costEstimate, 0.00002);
  });

  it('ToolRunContext 带上 priceOverrides（嵌套单元据此把定价传进子循环）', async () => {
    let seen: Record<string, { in: number; out: number }> | undefined;
    const tool: AgentTool = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: (_input, ctx) => {
        seen = ctx?.priceOverrides;
        return 'ok';
      },
    };
    const { client } = mockClient([toolUseMsg('probe', {}), endTurnMsg('done')]);
    await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      client: client as never,
      priceOverrides: { 'deepseek-chat': { in: 1, out: 2 } },
    });
    assert.deepEqual(seen, { 'deepseek-chat': { in: 1, out: 2 } });
  });

  it('未配 priceOverrides 时不往 ToolRunContext 塞字段（形状与旧版一致）', async () => {
    let hasField = true;
    const tool: AgentTool = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: (_input, ctx) => {
        hasField = ctx !== undefined && 'priceOverrides' in ctx;
        return 'ok';
      },
    };
    const { client } = mockClient([toolUseMsg('probe', {}), endTurnMsg('done')]);
    await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      client: client as never,
    });
    assert.equal(hasField, false);
  });
});

describe('F2 未定价模型显式（护栏失效看得见）', () => {
  it('只记 usage.unpriced 事件、回调每模型一次，且不改变 run 结局', async () => {
    const calls: Array<{ model: string; spanId: string }> = [];
    const { client } = mockClient([toolUseMsg('noop', {}), endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      model: 'mystery-model',
      tools: [
        {
          name: 'noop',
          description: 'n',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          run: () => 'ok',
        },
      ],
      client: client as never,
      onUnpricedModel: (info) => calls.push(info),
    });

    // 两个 llm.turn（工具往返 + 收尾）都是未定价 → 事件两条、回调一次
    const unpriced = result.trace.spans.flatMap((s) => s.events).filter((e) => e.name === 'usage.unpriced');
    assert.equal(unpriced.length, 2, '每个未定价 turn 都留痕');
    assert.deepEqual(unpriced[0]!.body, { model: 'mystery-model' });
    assert.equal(calls.length, 1, '同一作用域内每模型只回调一次');
    assert.equal(calls[0]!.model, 'mystery-model');
    assert.ok(calls[0]!.spanId.length > 0);

    // 不改变结局：定价缺失是宿主配置问题
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.trace.status, 'ok');
    assert.equal(result.trace.totalUsage.costEstimate, undefined, '未定价不计成本（而不是记 0 混进总和）');
  });

  it('配了 priceOverrides 之后不再有 usage.unpriced（护栏真正生效）', async () => {
    const calls: unknown[] = [];
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      model: 'mystery-model',
      client: client as never,
      priceOverrides: { 'mystery-model': { in: 3, out: 15 } },
      onUnpricedModel: (i) => calls.push(i),
    });
    const unpriced = result.trace.spans.flatMap((s) => s.events).filter((e) => e.name === 'usage.unpriced');
    assert.equal(unpriced.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(result.trace.totalUsage.costEstimate, (10 / 1e6) * 3 + (5 / 1e6) * 15);
  });

  it('回调抛错被吞（观测是辅助动作，不得影响 run）', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      model: 'mystery-model',
      client: client as never,
      onUnpricedModel: () => {
        throw new Error('告警通道挂了');
      },
    });
    assert.equal(result.stopReason, 'end_turn');
  });

  it('同一 run 内已定价模型不产生 unpriced 事件（内置表仍生效）', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      model: 'claude-opus-5',
      client: client as never,
    });
    assert.equal(
      result.trace.spans.flatMap((s) => s.events).filter((e) => e.name === 'usage.unpriced').length,
      0,
    );
  });
});

describe('G3 生效配置快照（run 根 config.* attributes）', () => {
  it('配了的旋钮落 run 根；缺省值也记（"没配"与"配了缺省"可区分）', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      model: 'claude-opus-5',
      client: client as never,
      maxTokens: 1234,
      maxIterations: 7,
      maxCostUsd: 0.5,
      maxTotalTokens: 9000,
      toolTimeoutMs: 250,
      maxToolConcurrency: 3,
      priceOverrides: { 'deepseek-chat': { in: 1, out: 1 } },
    });
    const a = rootSpan(result.trace).attributes;
    assert.equal(a['config.model'], 'claude-opus-5');
    assert.equal(a['config.maxTokens'], 1234);
    assert.equal(a['config.maxIterations'], 7);
    assert.equal(a['config.maxCostUsd'], 0.5);
    assert.equal(a['config.maxTotalTokens'], 9000);
    assert.equal(a['config.toolTimeoutMs'], 250);
    assert.equal(a['config.maxToolConcurrency'], 3);
    assert.equal(a['config.retry.maxAttempts'], 3, '缺省重试次数也要可见');
    assert.equal(a['config.contextPolicy'], false);
    assert.equal(a['config.priceOverrides'], 'deepseek-chat');
    // 既有 attribute 不受影响
    assert.equal(a['model'], 'claude-opus-5');
    assert.equal(a['stop_reason'], 'end_turn');
  });

  it('retry:false → config.retry.maxAttempts=0；有 contextPolicy → 记 budgetTokens', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      client: client as never,
      retry: false,
      contextPolicy: { budgetTokens: 4200, beforeTurn: async (m) => m },
    });
    const a = rootSpan(result.trace).attributes;
    assert.equal(a['config.retry.maxAttempts'], 0);
    assert.equal(a['config.contextPolicy'], true);
    assert.equal(a['config.contextPolicy.budgetTokens'], 4200);
  });

  it('快照不含函数型选项的内容（只记"配没配"）', async () => {
    const { client } = mockClient([endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      client: client as never,
      onUnpricedModel: () => {},
    });
    const keys = Object.keys(rootSpan(result.trace).attributes);
    assert.deepEqual(keys.filter((k) => k.startsWith('config.') && /function|=>/.test(k)), []);
  });
});

/** helpers.U 的固定用量，供本文件断言使用（避免魔数散落） */
assert.deepEqual({ i: U.input_tokens, o: U.output_tokens }, { i: 10, o: 5 });
