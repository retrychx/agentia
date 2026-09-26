/**
 * 示例评测套件 —— **断言的是「你的 agent 语义」**，不是框架的单测。
 *
 * 三个套件各演示一类「会被改坏、而人眼看不出来」的东西：
 *   1. 工具调用顺序（改 prompt / 改工具描述之后模型先调谁）
 *   2. 成本记账（换模型 / 换定价表之后每 run 花多少）
 *   3. 工具失败后的行为（后端炸了，run 是继续还是整轮失败）
 *
 * 全部走 `scriptedClient`（写死的模型脚本）⇒ **不联网、不需要 API key、结论稳定**。
 * 这是它能当发布判据的前提：一个要花钱、会抖的闸门没人敢用它挡发布。
 *
 * 三个套件各自独立（一个套件一个 `expect`）—— 与真实工程的形态一致：
 * 一个 eval 文件一个关注点，闸门把它们一起跑、一起对基线。
 */
import assert from 'node:assert/strict';
import { SystemPrompt, createApp, defineEval, scriptedClient } from '@migor/agentia';
import type { Trace } from '@migor/agentia';
import Search from './tools/search.js';

/** 每回合的用量（**缓存两项刻意非零** —— 成本断言要用到它们） */
const U = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
};

function toolUse(name: string, input: unknown, id = 'tu1'): Record<string, unknown> {
  return {
    id: 'm1',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    usage: U,
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function endTurn(text: string): Record<string, unknown> {
  return {
    id: 'm2',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: U,
    content: [{ type: 'text', text }],
  };
}

/** 读 trace：主循环里被调用的工具名（顺序即调用顺序） */
function toolOrder(trace: Trace): string[] {
  return trace.spans
    .flatMap((s) => s.events)
    .filter((e) => e.name === 'tool.input')
    .map((e) => (e.body as { tool?: string }).tool ?? '?');
}

/** 读 trace：工具输出的 `ok` 标志 */
function toolOutputs(trace: Trace): Array<{ tool: string; ok: boolean }> {
  return trace.spans
    .flatMap((s) => s.events)
    .filter((e) => e.name === 'tool.output')
    .map((e) => e.body as { tool: string; ok: boolean });
}

const system = new SystemPrompt({ version: 'gate-demo-v1' }).add(
  'role',
  '你是检索助手：先检索，再据检索结果回答。',
);

/** 每个套件都建自己的 app（`app` 每次 `run()` 只调一次，用例之间复用 —— 这是 defineEval 的语义） */
const app = (): ReturnType<typeof createApp> =>
  createApp({
    name: 'eval-gate-demo',
    system,
    providers: [{ provide: 'search', useClass: Search }],
  });

/** ① 工具调用顺序：**顺序断言从 trace 读**，框架不为此新增埋点 */
export const orderSuite = defineEval({
  name: 'demo-tool-order',
  app,
  cases: [
    {
      name: '先检索再回答',
      input: '查一下 tsconfig 的路径映射',
      client: scriptedClient([
        toolUse('search', { query: 'tsconfig paths' }),
        endTurn('查到 3 段：映射写在 tsconfig.tests.json。'),
      ]),
    },
  ],
  expect: (r, { trace }) => {
    assert.equal(r.stopReason, 'end_turn');
    assert.deepEqual(toolOrder(trace), ['search'], '应当先调 search（顺序从 trace 读）');
  },
});

/**
 * ② 成本记账：换模型 / 换定价表之后每 run 花多少 —— **精确值**断言。
 *
 * 100 tok × $5/1M = $0.0005；20 tok × $25/1M = $0.0005；
 * 1000 缓存读 × $5/1M × 0.1 = $0.0005；200 缓存写 × $5/1M × 1.25 = $0.00125 ⇒ 合计 $0.00275。
 * 缓存乘数一旦被改成「按输入价」或漏乘，这条立刻红。
 */
export const costSuite = defineEval({
  name: 'demo-cost',
  app,
  cases: [
    {
      name: '一次 run 的成本（含缓存乘数）',
      input: '这条用例只看钱',
      client: scriptedClient([endTurn('done')]),
      opts: { priceOverrides: { 'claude-opus-5': { in: 5, out: 25 } } },
    },
  ],
  expect: (r, { trace }) => {
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(
      trace.totalUsage.costEstimate,
      0.00275,
      '缓存读 0.1× / 写 1.25× 必须进成本（改乘数 ⇒ maxCostUsd 判据跟着偏）',
    );
  },
});

/** ③ 工具失败：后端炸了，run 继续（失败记成 `is_error` 的 tool_result，而不是杀 run） */
export const resilienceSuite = defineEval({
  name: 'demo-tool-failure',
  app,
  cases: [
    {
      name: '工具抛错后 run 仍正常收尾',
      input: '触发一次失败',
      client: scriptedClient([
        toolUse('search', { query: 'BOOM' }),
        endTurn('检索失败了，但我照样回答了。'),
      ]),
    },
  ],
  expect: (r, { trace }) => {
    assert.equal(r.stopReason, 'end_turn', '工具失败不杀 run');
    const out = toolOutputs(trace);
    assert.equal(out.length, 1, '应当有一次工具输出');
    assert.equal(out[0]!.ok, false, '失败的那次工具输出必须记 ok:false（is_error）');
  },
});

/**
 * ④ **一条已知失败的用例** —— 刻意留着，它演示闸门最重要的那条语义：
 * 「基线里本来就失败」不拦发布（团队选择「先记着」，而不是「不许发」）；
 * 但谁要是把这条基线改成「曾经通过」，闸门**立刻**红（那是撒谎，不是修复）。
 */
export const knownFailureSuite = defineEval({
  name: 'demo-known-failure',
  app,
  cases: [
    {
      name: '已知失败：回答里必须出现检索结果（当前实现不做）',
      input: '查一下 tsconfig',
      client: scriptedClient([toolUse('search', { query: 'tsconfig' }), endTurn('随便答的。')]),
    },
  ],
  expect: (r) => {
    assert.match(
      r.finalText,
      /命中 3 段/,
      '当前实现没有把检索结果带进回答 —— 这条已知失败，基线里记 false',
    );
  },
});

/** 闸门跑的套件全清单（加一个 eval 文件就往这里加一项） */
export const suites = [orderSuite, costSuite, resilienceSuite, knownFailureSuite];
