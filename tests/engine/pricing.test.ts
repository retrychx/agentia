import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, buildPricing, DEFAULT_PRICING } from '../../src/index.js';
// 内部模块（刻意不进公共导出面）
import { costEstimate } from '../../src/engine/usage.js';
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

  it('缓存乘数非法值同样构造期抛错（只校验 in/out 等于没校验）', () => {
    // 乘数写错一样会算出 NaN 成本 ⇒ `NaN > maxCostUsd` 恒 false ⇒ 护栏静默失效。
    assert.throws(
      () => buildPricing({ m: { in: 1, out: 1, cacheWrite: Number.NaN } }),
      /cacheWrite/,
    );
    // 文案必须印得出 NaN：`JSON.stringify(NaN)` 是 'null'，会让人去找一个不存在的 null
    assert.throws(() => buildPricing({ m: { in: 1, out: 1, cacheWrite: Number.NaN } }), /收到 NaN/);
    assert.throws(
      () => buildPricing({ m: { in: Number.NaN, out: 1 } }),
      /收到 .*"in":"NaN"/,
      '整对象那条也不能把 NaN 印成 null',
    );
    assert.throws(() => buildPricing({ m: { in: 1, out: 1, cacheRead: -0.1 } }), /cacheRead/);
    assert.throws(() => buildPricing({ m: { in: 1, out: 1, cacheWrite: Infinity } }), /cacheWrite/);
    // 不给乘数仍然合法（走缺省）
    assert.deepEqual(buildPricing({ m: { in: 1, out: 1 } }).m, { in: 1, out: 1 });
  });
});

describe('F1 价格覆盖生效于 run（含嵌套能力透传）', () => {
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

  it('ToolRunContext 带上 priceOverrides（嵌套能力据此把定价传进子循环）', async () => {
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

  it('乘数随 priceOverrides 一起透传（子循环只拿到 in/out 的话 1h 缓存又被低估）', async () => {
    let seen: Record<string, { in: number; out: number }> | undefined;
    const tool: AgentTool = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: (_input, ctx) => {
        seen = ctx?.priceOverrides as never;
        return 'ok';
      },
    };
    const { client } = mockClient([toolUseMsg('probe', {}), endTurnMsg('done')]);
    await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      tools: [tool],
      client: client as never,
      priceOverrides: { 'claude-opus-5': { in: 5, out: 25, cacheWrite: 2 } },
    });
    assert.deepEqual(seen, { 'claude-opus-5': { in: 5, out: 25, cacheWrite: 2 } });
  });

  it('非法乘数：run 在**第一次 llm 调用之前**就以 status=error 收口（不是抛给调用方）', async () => {
    // 文档原话是「非法单价在 run 开始即抛错」—— 实测**不是抛**：本函数只在 turn 的循环入口
    // 被调用，runAgent 把它收成 {status:'error', stopReason:'error'} 的 result，错误记在 run 根
    // span 上。真正承重的是「早失败」这件事本身：**client 一次都没被调用**（不烧 token）。
    const { client, seen } = mockClient([endTurnMsg('done')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      client: client as never,
      priceOverrides: { m: { in: 1, out: 1, cacheWrite: Number.NaN } },
    });
    assert.equal(seen.length, 0, '一次 llm 调用都不该发生 —— 早失败是这条的全部意义');
    assert.equal(r.trace.status, 'error');
    assert.equal(r.stopReason, 'error');
    assert.equal(r.trace.totalUsage.costEstimate, undefined, '没烧 token 就没有成本');
    const root = r.trace.spans.find((s) => s.spanId === r.trace.rootSpanId);
    assert.match(root?.error?.message ?? '', /cacheWrite/);
    assert.equal(root?.error?.type, 'unknown', '宿主配置错，归不出可重试类别');
    assert.equal(root?.error?.retryable, false);
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
    const unpriced = result.trace.spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'usage.unpriced');
    assert.equal(unpriced.length, 2, '每个未定价 turn 都留痕');
    assert.deepEqual(unpriced[0]!.body, { model: 'mystery-model' });
    assert.equal(calls.length, 1, '同一作用域内每模型只回调一次');
    assert.equal(calls[0]!.model, 'mystery-model');
    assert.ok(calls[0]!.spanId.length > 0);

    // 不改变结局：定价缺失是宿主配置问题
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.trace.status, 'ok');
    assert.equal(
      result.trace.totalUsage.costEstimate,
      undefined,
      '未定价不计成本（而不是记 0 混进总和）',
    );
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
    const unpriced = result.trace.spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'usage.unpriced');
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
    assert.equal(a.model, 'claude-opus-5');
    assert.equal(a.stop_reason, 'end_turn');
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
    assert.deepEqual(
      keys.filter((k) => k.startsWith('config.') && /function|=>/.test(k)),
      [],
    );
  });
});

/** helpers.U 的固定用量，供本文件断言使用（避免魔数散落） */
assert.deepEqual({ i: U.input_tokens, o: U.output_tokens }, { i: 10, o: 5 });

describe('costEstimate 的价格表查找', () => {
  it('模型名撞 Object.prototype（constructor / toString）→ 判未定价，而不是 NaN', () => {
    // `pricing[model]` 命中原型链时 p 是个函数（真值）而 p.in/p.out 为 undefined ⇒ 成本 NaN；
    // NaN 会流进 trace/OTLP，且 `NaN > maxCostUsd` 恒 false ⇒ 成本护栏静默失效。
    const usage = { inputTokens: 1000, outputTokens: 500 } as never;
    for (const m of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.equal(costEstimate(m, usage), undefined, `${m} 应判「未定价」`);
    }
    assert.equal(costEstimate('nope', usage), undefined, '普通未知模型仍是 undefined');
  });

  it('模型名是精确匹配：带日期后缀的 id 与不带日期的别名互不相通', () => {
    // Anthropic 每个型号都发两个 id（别名 + 带日期快照），而 `Object.hasOwn` 是精确匹配 ——
    // 表里有 `claude-haiku-4-5` 不代表 `claude-haiku-4-5-20251001` 能算出成本。
    // 这条不是「静默」失效：未定价会留 `usage.unpriced` + 抬 unpriced_turns 指标 + report 告警，
    // 但**成本护栏本身是关的**。语义若改成「剥后缀归一」，这里与 usage-guide 都要一起改。
    const full = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    } as never;
    assert.equal(costEstimate('claude-haiku-4-5', full), 6, '别名在表内');
    assert.equal(costEstimate('claude-haiku-4-5-20251001', full), undefined, '带日期快照不在表内');
    assert.equal(costEstimate('claude-sonnet-4-6', full), 18, '内置表其余键照旧命中');
  });

  it('缓存乘数逐项钉住：读 0.1×、写 1.25×（此前整仓没有一条非零缓存的成本断言）', () => {
    // 2026-09-26 实测：把这两个乘数改成 0.5 / 1.0，全量 1139 个测试**照样全绿** ——
    // 因为所有用例的 cache 字段都是 0，公式里那两项恒等于 0，改多少都看不出来。
    // 而它们是承重的：`maxCostUsd` 就吃这个数（低估 ⇒ 护栏迟触发）。
    // 官方乘数（platform.claude.com 定价页）：5 分钟写 1.25×、**1 小时写 2×**、读 0.1×；
    // ⚠️ 已知边界：框架的 `CacheControl.ttl` 允许 `'1h'`（src/core/message.ts）且请求体原样透传，
    // 那种情况下真实计费是 2×，这里仍按 1.25× 算 ⇒ 低估 37.5%。框架自己的调用点都不设 ttl，
    // 故对自家调用成立；宿主若显式用 `ttl: '1h'`，请把这段偏差计入预算余量。
    const cacheOnly = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    } as never;
    // 读：1e6/1e6 × $5 × 0.1 = $0.5；写：1e6/1e6 × $5 × 1.25 = $6.25
    assert.equal(costEstimate('claude-opus-5', cacheOnly), 6.75);

    const mixed = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    } as never;
    // 5 + 25 + 0.5 + 6.25
    assert.equal(costEstimate('claude-opus-5', mixed), 36.75);
  });

  it('乘数可逐模型覆盖：ttl 1h 的写 2× / Opus 5.5 的读 0.05×', () => {
    // 缺省乘数分不出 TTL，也算不出官方的逐模型读例外 —— 这两档只能由价格表表达。
    const cacheOnly = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    } as never;

    // 宿主在块上用了 cache_control: { ttl: '1h' } → 官方写是 2×（不是缺省的 1.25×）
    const with1h = buildPricing({ 'claude-opus-5': { in: 5, out: 25, cacheWrite: 2 } });
    assert.equal(costEstimate('claude-opus-5', cacheOnly, with1h), 10.5, '读 0.5 + 写 10');
    assert.equal(costEstimate('claude-opus-5', cacheOnly), 6.75, '缺省仍是 5m 档');

    // 逐模型读例外：Opus 5.5 官方是 0.05×
    const opus55 = buildPricing({ 'claude-opus-5.5': { in: 5, out: 25, cacheRead: 0.05 } });
    assert.equal(costEstimate('claude-opus-5.5', cacheOnly, opus55), 6.5, '读 0.25 + 写 6.25');

    // 覆盖要真的进 run（透传给子循环的那条链不变）
    const merged = buildPricing({ 'claude-opus-5': { in: 5, out: 25, cacheWrite: 2 } });
    assert.equal(merged['claude-opus-5']?.cacheWrite, 2);
    assert.equal(merged['claude-sonnet-5']?.cacheWrite, undefined, '未覆盖的模型不带乘数字段');
  });

  it('乘数写 0 就是「乘数为零」，不是「未设」—— 两个 `??` 不能被写成 `||`', () => {
    // 2026-09-26 起手动作② 抓到的缺口：`costEstimate` 写的是
    // `p.cacheRead ?? CACHE_READ_MULTIPLIER`，而 `??` 与 `||` 的差别**恰好只落在 `0` 上**。
    // 实测把两个 `??` 改成 `||`，本文件 **19/19 照样全绿** —— 因为上面所有用例的乘数
    // 要么是缺省、要么是 0.05 / 2，**没有一条把它设成 0**。
    // 语义：`buildPricing` 的校验是 `finite && >= 0`，所以 `0` 是**合法**值，含义是
    // 「这个模型的缓存读 / 写不要钱」；一旦被读成「未设」，就会回落到 0.1 / 1.25 ⇒
    // 成本虚高、`maxCostUsd` **提前**触发（账不对，方向上还是误伤）。
    // 同一条纪律在 `src/core/limits.ts`（「限制旋钮的 0 是什么」的单一真源）与
    // `exactOptionalPropertyTypes` 迁移里各出现过一次 ——「显式给的 0」与「没给」必须分开。
    const cacheOnly = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    } as never;

    const free = buildPricing({ 'claude-opus-5': { in: 5, out: 25, cacheRead: 0, cacheWrite: 0 } });
    assert.equal(
      costEstimate('claude-opus-5', cacheOnly, free),
      0,
      '两项都写 0 ⇒ 缓存成本必须是 0',
    );

    // 只把「读」写成 0：读 0 + 写 1e6/1e6 × $5 × 1.25 = $6.25
    const freeRead = buildPricing({ 'claude-opus-5': { in: 5, out: 25, cacheRead: 0 } });
    assert.equal(costEstimate('claude-opus-5', cacheOnly, freeRead), 6.25);

    // 只把「写」写成 0：读 1e6/1e6 × $5 × 0.1 = $0.5
    const freeWrite = buildPricing({ 'claude-opus-5': { in: 5, out: 25, cacheWrite: 0 } });
    assert.equal(costEstimate('claude-opus-5', cacheOnly, freeWrite), 0.5);

    // 阳性对照的另一半：**不写**乘数必须仍走缺省 —— 否则上面几条可以靠「永远返回 0」蒙过
    assert.equal(costEstimate('claude-opus-5', cacheOnly), 6.75, '缺省 0.1 / 1.25');
  });
});
