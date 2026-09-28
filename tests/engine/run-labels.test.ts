import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/engine/loop.js';
import { createApp } from '../../src/toolkit/module.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/**
 * 归因标签 labels（R8-P4，docs/plans/2026-09-27-evolution-r8.md）。
 *
 * 钉住的语义：
 * - `labels` 落 run 根的 `labels.<key>` 属性（trace 侧无基数问题）；
 * - 入口校验响亮抛 TypeError（键空 / 值非字符串 / 非对象），不收成「失败的 run」；
 * - 配置快照只记**键名**（`config.labels`），值本体在 labels.* 属性里；
 * - AppOptions.labels 是缺省，单次 run 的 labels **整体替换**它（不是合并）；
 * - 进 metrics 是另一个开关（metricsSink 的 labelKeys），见 tests/integrations/metrics.test.ts。
 */

const rootOf = (r: Awaited<ReturnType<typeof runAgent>>) =>
  r.trace.spans.find((s) => s.spanId === r.trace.rootSpanId)!;

describe('归因标签 labels（R8-P4）', () => {
  it('labels 落 run 根的 labels.<key> 属性', async () => {
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      client: mockClient([endTurnMsg('ok')]).client,
      labels: { tenant: 'acme', plan: 'pro' },
    });
    assert.equal(r.stopReason, 'end_turn', 'run 必须真的成功（属性断言不该对着失败 run 做）');
    const root = rootOf(r);
    assert.equal(root.attributes['labels.tenant'], 'acme');
    assert.equal(root.attributes['labels.plan'], 'pro');
  });

  it('空串值是有意义的值（租户未知），照常落根', async () => {
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      client: mockClient([endTurnMsg('ok')]).client,
      labels: { tenant: '' },
    });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(rootOf(r).attributes['labels.tenant'], '');
  });

  it('配置快照只记键名（config.labels），不复制值', async () => {
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      client: mockClient([endTurnMsg('ok')]).client,
      labels: { plan: 'pro', tenant: 'acme' },
    });
    assert.equal(r.stopReason, 'end_turn');
    const root = rootOf(r);
    assert.equal(root.attributes['config.labels'], 'plan,tenant', '键名排序后逗号连');
    assert.equal(
      String(root.attributes['config.labels']).includes('acme'),
      false,
      '快照只记键名，值本体不该被复制进 config.*',
    );
  });

  it('不传 labels：根上没有 labels.* 也没有 config.labels', async () => {
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      client: mockClient([endTurnMsg('ok')]).client,
    });
    assert.equal(r.stopReason, 'end_turn');
    const root = rootOf(r);
    for (const k of Object.keys(root.attributes)) {
      assert.equal(k.startsWith('labels.'), false, `不该有 ${k}`);
    }
    assert.equal('config.labels' in root.attributes, false);
  });

  it('坏 labels 在 run 入口抛 TypeError（键空 / 值非字符串 / 数组 / null）', async () => {
    const base = {
      messages: [{ role: 'user' as const, content: 'hi' }],
      model: 'm',
      client: mockClient([endTurnMsg('ok')]).client,
    };
    await assert.rejects(
      () => runAgent({ ...base, labels: { '': 'x' } }),
      (e) => e instanceof TypeError && /键不能为空/.test(String(e)),
    );
    await assert.rejects(
      () => runAgent({ ...base, labels: { tenant: 42 } as never }),
      (e) => e instanceof TypeError && /必须是字符串/.test(String(e)),
    );
    await assert.rejects(
      () => runAgent({ ...base, labels: ['tenant'] as never }),
      (e) => e instanceof TypeError && /Record<string, string>/.test(String(e)),
    );
    await assert.rejects(
      () => runAgent({ ...base, labels: null as never }),
      (e) => e instanceof TypeError,
    );
  });

  it('坏 labels 抛错不收成失败的 run（异常直抛调用方）', async () => {
    // 与 resolveModelChain 同一条纪律：配置错响亮抛，不产生 trace
    await assert.rejects(() =>
      runAgent({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'm',
        client: mockClient([endTurnMsg('ok')]).client,
        labels: { '': 'x' },
      }),
    );
  });

  it('AppOptions.labels 是缺省；单次 run 的 labels 整体替换（不合并）', async () => {
    // AppOptions 没有 client 键（client 是 per-run 的）—— 两次 run 各自带上
    const app = createApp({
      model: 'm',
      system: 'test',
      labels: { tenant: 'base-tenant', plan: 'free' },
    });
    const r1 = await app.run([{ role: 'user', content: 'hi' }], {
      client: mockClient([endTurnMsg('a')]).client,
    });
    assert.equal(r1.result.stopReason, 'end_turn');
    let root = r1.result.trace.spans.find((s) => s.spanId === r1.result.trace.rootSpanId)!;
    assert.equal(root.attributes['labels.tenant'], 'base-tenant');
    assert.equal(root.attributes['labels.plan'], 'free');

    const r2 = await app.run([{ role: 'user', content: 'hi' }], {
      client: mockClient([endTurnMsg('b')]).client,
      labels: { tenant: 'acme' },
    });
    assert.equal(r2.result.stopReason, 'end_turn');
    root = r2.result.trace.spans.find((s) => s.spanId === r2.result.trace.rootSpanId)!;
    assert.equal(root.attributes['labels.tenant'], 'acme');
    assert.equal(
      'labels.plan' in root.attributes,
      false,
      '单次 run 的 labels 整体替换缺省，不是合并（plan 不该留下来）',
    );
  });
});
