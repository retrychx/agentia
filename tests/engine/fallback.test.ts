import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/engine/loop.js';
import type { AgentTool, ModelClient } from '../../src/core/tool.js';
import type { Span } from '../../src/core/trace.js';
import { mockClient, endTurnMsg, toolUseMsg } from '../helpers.js';

/**
 * 模型 fallback 链（R8-P2，docs/plans/2026-09-27-evolution-r8.md）。
 *
 * 钉住的语义：
 * - 换环判定与重试共用 classifyError 的 retryable 位（rate_limit/server/timeout/connection
 *   才换；api/unknown 原样抛；aborted 永不换）；
 * - 每环开自己的 llm.turn span（model 名正确 ⇒ 成本归因对）；切换记 llm.fallback 事件；
 * - 「吐过字不换」（与 retry 的 !emitted 同一护栏）；每回合从主环重新起；
 * - 链在 run 入口校验（坏环/死 client 响亮抛 TypeError），快照记 config.fallbacks。
 */

/** 必失败的 client：finalMessage 抛给定错误；可选先吐一段文本（验「吐过字不换」） */
function failClient(err: unknown, opts: { text?: string } = {}) {
  const state = { calls: 0 };
  const client: ModelClient = {
    messages: {
      stream: () => {
        state.calls++;
        return {
          on(ev: string, cb: (d: string) => void) {
            if (ev === 'text' && opts.text) cb(opts.text);
          },
          finalMessage: async () => {
            throw err;
          },
        };
      },
    },
  };
  return { client, state };
}

/** 先失败 N 次再成功的 client（验「重试先于换环」与「同端点换模型」） */
function flakyClient(failures: number, err: unknown, then: Record<string, unknown>) {
  let i = 0;
  const seen: unknown[] = [];
  const client: ModelClient = {
    messages: {
      stream: (params) => {
        seen.push(params);
        return {
          on() {},
          finalMessage: async () => {
            i++;
            if (i <= failures) throw err;
            return then as never;
          },
        };
      },
    },
  };
  return { client, seen };
}

const rateLimit = () => Object.assign(new Error('429 too many'), { status: 429 });
const serverErr = () => Object.assign(new Error('500 boom'), { status: 500 });
const apiErr = () => Object.assign(new Error('400 bad request'), { status: 400 });

const llmSpans = (spans: Span[]) => spans.filter((s) => s.kind === 'llm.turn');

describe('模型 fallback 链（R8-P2）', () => {
  it('主环 429 → 换环成功：两环各开 llm.turn，新环记 llm.fallback 事件', async () => {
    const primary = failClient(rateLimit());
    const backup = mockClient([endTurnMsg('备用模型答的')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false, // 关掉重试，直接看换环
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.finalText, '备用模型答的');

    const turns = llmSpans(r.trace.spans);
    assert.equal(turns.length, 2, '每环一个 llm.turn span');
    assert.equal(turns[0]!.name, 'primary-m');
    assert.equal(turns[0]!.status, 'error');
    assert.equal(turns[0]!.error!.type, 'rate_limit');
    assert.equal(turns[1]!.name, 'backup-m', '成功环的 span 名归对模型');
    assert.equal(turns[1]!.status, 'ok');
    const fb = turns[1]!.events.find((e) => e.name === 'llm.fallback');
    assert.deepEqual(fb?.body, { from: 'primary-m', to: 'backup-m', errorType: 'rate_limit' });
  });

  it('成本归因按**实际成功**的模型算（fallback 环的价目，不是主模型）', async () => {
    const primary = failClient(serverErr());
    const backup = mockClient([endTurnMsg('ok')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
      priceOverrides: {
        'primary-m': { in: 100, out: 100 }, // 主模型天价：按错模型算账立刻看得出来
        'backup-m': { in: 1, out: 1 },
      },
    });
    const okTurn = llmSpans(r.trace.spans).find((s) => s.status === 'ok')!;
    // 夹具 usage = 10 in / 5 out：backup-m 单价 1/1（$/1M）⇒ (10+5)/1e6 × $1
    assert.equal(okTurn.usage?.costEstimate, 15 / 1e6, '成本必须按 backup-m 的价目算');
  });

  it('链环缺省复用主 client（同端点换模型：只写 model）', async () => {
    // 同一个 client：第一次调用 429，第二次成功 —— 证明第二环用的就是它
    const { client, seen } = flakyClient(1, rateLimit(), endTurnMsg('同端点备用'));
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client,
      retry: false,
      fallbacks: [{ model: 'backup-m' }],
    });
    assert.equal(r.finalText, '同端点备用');
    assert.equal(seen.length, 2, '主 client 被调两次（两环都是它）');
    const models = seen.map((p) => (p as { model: string }).model);
    assert.deepEqual(models, ['primary-m', 'backup-m'], '请求体的 model 字段随环切换');
  });

  it('api 类错误（400）不换环：请求本身有病，备用 client 零调用', async () => {
    const primary = failClient(apiErr());
    const backup = failClient(serverErr());
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    assert.equal(r.stopReason, 'error');
    assert.equal(r.error!.type, 'api', '失败按主环的错误归类（没被换成备用的）');
    assert.equal(r.error!.message, '400 bad request');
    assert.equal(backup.state.calls, 0, 'api 错误不得触发换环');
  });

  it('aborted 永不换环（用户取消不是故障）', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const primary = failClient(abortErr);
    const backup = failClient(serverErr());
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    assert.equal(r.stopReason, 'aborted');
    assert.equal(backup.state.calls, 0);
    assert.equal(llmSpans(r.trace.spans).length, 1, '只开主环一个 span');
  });

  it('吐过字不换环：本环已产出文本后失败 ⇒ 失败收尾、备用零调用（与 retry 的 !emitted 同一护栏）', async () => {
    const primary = failClient(rateLimit(), { text: '半截回答' });
    const backup = mockClient([endTurnMsg('不该出现')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    assert.equal(r.stopReason, 'error');
    assert.equal(r.error!.type, 'rate_limit');
    assert.equal(backup.seen.length, 0, '吐过字后不得换环重跑（否则用户看到两段拼起来的回答）');
  });

  it('重试先于换环：主环重试到 maxAttempts 用尽才换', async () => {
    // 主 client 连续 429 两次（重试 2 次用尽）；备用一次成功
    const primary = flakyClient(2, rateLimit(), endTurnMsg('不该走到'));
    const backup = mockClient([endTurnMsg('备用答')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    assert.equal(r.finalText, '备用答');
    assert.equal(primary.seen.length, 2, '主环重试到用尽');
    const turns = llmSpans(r.trace.spans);
    assert.deepEqual(
      turns.map((t) => [t.name, t.status]),
      [
        ['primary-m', 'error'],
        ['primary-m', 'error'],
        ['backup-m', 'ok'],
      ],
    );
    assert.equal(turns[1]!.attributes['retry.attempt'], 2, '第二尝试带 retry.attempt');
    assert.ok(turns[0]!.events.some((e) => e.name === 'llm.retry'), '第一次失败记 llm.retry');
    assert.ok(
      turns[2]!.events.some((e) => e.name === 'llm.fallback'),
      '换环记 llm.fallback（不与重试记法混用）',
    );
  });

  it('链用尽：失败按最后一环的错误归类（原错误不被包装 —— 分类靠它身上的 status）', async () => {
    const primary = failClient(rateLimit());
    const backup = failClient(serverErr());
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    assert.equal(r.stopReason, 'error');
    assert.equal(r.error!.type, 'server', '冒泡到收尾的是最后一环（500）的错，不是第一环（429）');
    assert.equal(r.error!.message, '500 boom');
    assert.equal(llmSpans(r.trace.spans).length, 2, '两环各留一个 error span');
  });

  it('每回合从主环重新起：换环成功后，下一回合仍先试主模型', async () => {
    // 回合 1：主环 429 → 备用环成功（tool_use）⇒ 工具执行 ⇒ 回合 2：主环成功收尾
    const primary = flakyClient(1, rateLimit(), endTurnMsg('主模型收尾'));
    const backup = mockClient([toolUseMsg('noop', {}, 'tu1')]);
    const tool: AgentTool = {
      name: 'noop',
      description: 'no-op',
      inputSchema: { type: 'object', properties: {} },
      run: async () => 'done',
    };
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      retry: false,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
      tools: [tool],
    });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.finalText, '主模型收尾');
    assert.deepEqual(
      llmSpans(r.trace.spans).map((t) => [t.name, t.status]),
      [
        ['primary-m', 'error'], // 回合 1 主环失败
        ['backup-m', 'ok'], // 回合 1 换环成功
        ['primary-m', 'ok'], // 回合 2 回到主环
      ],
      '每回合从主环重新起（不把后续回合钉在备用模型上）',
    );
  });

  it('生效配置快照：config.fallbacks 记备用模型名；不配则不记', async () => {
    const primary = mockClient([endTurnMsg('ok')]);
    const backup = mockClient([]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: primary.client,
      fallbacks: [{ model: 'backup-m', client: backup.client }],
    });
    const root = r.trace.spans.find((s) => s.kind === 'run')!;
    assert.equal(root.attributes['config.fallbacks'], 'backup-m');

    const plain = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'primary-m',
      client: mockClient([endTurnMsg('ok')]).client,
    });
    const plainRoot = plain.trace.spans.find((s) => s.kind === 'run')!;
    assert.equal('config.fallbacks' in plainRoot.attributes, false, '没配就不该有这个键');
  });

  it('run 入口校验：坏环（空 model）响亮抛 TypeError', async () => {
    await assert.rejects(
      runAgent({
        messages: [{ role: 'user', content: 'hi' }],
        client: mockClient([endTurnMsg('ok')]).client,
        fallbacks: [{ model: '  ' }],
      }),
      (e: unknown) => e instanceof TypeError && /fallbacks\[0\]\.model/.test((e as Error).message),
    );
  });

  it('run 入口校验：死 client（持久化反序列化的空壳）响亮抛 TypeError', async () => {
    // 模拟 TaskRecord JSON 往返：client 变成 {}（方法全丢）—— 不得发请求时才爆
    const dead = JSON.parse(JSON.stringify({ client: { model: 'x' } })) as {
      client: ModelClient;
    };
    await assert.rejects(
      runAgent({
        messages: [{ role: 'user', content: 'hi' }],
        client: mockClient([endTurnMsg('ok')]).client,
        fallbacks: [{ model: 'backup-m', client: dead.client }],
      }),
      (e: unknown) => e instanceof TypeError && /ModelClient 契约/.test((e as Error).message),
    );
  });
});
