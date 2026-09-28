/*
 * 上游**没回报 usage** 时如实标出 —— **适配器侧**（2026-09-28 外部深评 S2）。
 *
 * 病灶：`0` 与「不知道」在数值上无法区分。两条适配器此前都无条件 `?? 0`，
 * 于是端点不回 usage（或忽略流式请求里的 `stream_options.include_usage`）时
 * token/成本**恒 0** —— `maxCostUsd` 这条成本护栏静默失效，连「算不出成本」的信号都没有。
 * 现在适配器把「上游没给」标成 `MessageUsage.unreported`，引擎据此在 llm.turn span 上记
 * `usage.missing` 事件（引擎侧见 tests/engine/turn-usage-missing.test.ts）。
 *
 * 四种响应路径**都要标**（流式 / 非流式 × 两条适配器），且**不能误标**
 * （上游真给了 usage 时不得带这个位 —— 那会把预警变成假警报，报警没人看就等于没有）。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicClient, createOpenAIClient } from '../../src/index.js';

type FetchLike = typeof fetch;

const PARAMS = { model: 'm', max_tokens: 16, messages: [{ role: 'user' as const, content: 'hi' }] };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 固定响应体替换全局 fetch（两条适配器共用同一个注入面 —— anthropic 没有 `fetchImpl` 选项） */
function stub(body: string, contentType: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    })) as unknown as FetchLike;
}

/** 事件数组 → SSE 报文（`[DONE]` 原样写） */
function sse(events: Array<unknown | '[DONE]'>): string {
  return events
    .map((e) => `data: ${e === '[DONE]' ? '[DONE]' : JSON.stringify(e)}\n\n`)
    .join('');
}

// —— 上游**没给** usage 的四种响应 ——

const anthropicStreamNoUsage = () =>
  sse([
    {
      type: 'message_start',
      // 关键：`message` 里**没有** usage 字段（兼容端点会这样）
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [] },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    // message_delta 同样不带 usage
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);

const anthropicJsonNoUsage = () =>
  JSON.stringify({
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
  });

const openaiStreamNoUsage = () =>
  sse([
    { id: 'c1', model: 'm', choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ finish_reason: 'stop', delta: {} }] },
    '[DONE]',
  ]);

const openaiJsonNoUsage = () =>
  JSON.stringify({
    id: 'c2',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
  });

// —— 上游**给了** usage 的对照组 ——

const anthropicStreamWithUsage = () =>
  sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [],
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);

const anthropicJsonWithUsage = () =>
  JSON.stringify({
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 9 },
  });

const openaiStreamWithUsage = () =>
  sse([
    { id: 'c1', model: 'm', choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ finish_reason: 'stop', delta: {} }] },
    { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    '[DONE]',
  ]);

const openaiJsonWithUsage = () =>
  JSON.stringify({
    id: 'c2',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

async function anthropicFinal(body: string, contentType: string) {
  stub(body, contentType);
  return createAnthropicClient({ apiKey: 'k', maxRetries: 0 }).messages.stream(PARAMS).finalMessage();
}

async function openaiFinal(body: string, contentType: string, stream: boolean) {
  stub(body, contentType);
  return createOpenAIClient({ apiKey: 'k', maxRetries: 0, stream })
    .messages.stream(PARAMS)
    .finalMessage();
}

describe('S2：上游没回报 usage 时如实标出（不静默填 0）', () => {
  it('anthropic 流式：全程没有 usage ⇒ unreported，且 token 是 0（替身值，不是读数）', async () => {
    const msg = await anthropicFinal(anthropicStreamNoUsage(), 'text/event-stream');
    assert.equal(msg.usage.unreported, true, '必须标出来 —— 否则成本恒 0 且无声');
    assert.equal(msg.usage.input_tokens, 0, '0 是「不知道」的替身值');
    assert.equal(msg.usage.output_tokens, 0);
  });

  it('anthropic 流式：给了 usage ⇒ **不得**带 unreported（不然是假警报）', async () => {
    const msg = await anthropicFinal(anthropicStreamWithUsage(), 'text/event-stream');
    assert.equal(msg.usage.unreported, undefined);
    assert.equal(msg.usage.input_tokens, 12);
  });

  it('anthropic 非流式回落：响应没带 usage 字段 ⇒ 合成一份并标 unreported', async () => {
    const msg = await anthropicFinal(anthropicJsonNoUsage(), 'application/json');
    assert.equal(msg.usage.unreported, true);
    assert.equal(msg.usage.input_tokens, 0);
  });

  it('anthropic 非流式回落：带了 usage ⇒ 原样透传', async () => {
    const msg = await anthropicFinal(anthropicJsonWithUsage(), 'application/json');
    assert.equal(msg.usage.unreported, undefined);
    assert.equal(msg.usage.output_tokens, 9);
  });

  it('openai 流式：端点忽略 include_usage（收尾 chunk 无 usage）⇒ unreported', async () => {
    const msg = await openaiFinal(openaiStreamNoUsage(), 'text/event-stream', true);
    assert.equal(msg.usage.unreported, true);
    assert.equal(msg.usage.input_tokens, 0);
  });

  it('openai 流式：收尾 chunk 带 usage ⇒ 透传且不带 unreported', async () => {
    const msg = await openaiFinal(openaiStreamWithUsage(), 'text/event-stream', true);
    assert.equal(msg.usage.unreported, undefined);
    assert.equal(msg.usage.input_tokens, 11);
    assert.equal(msg.usage.output_tokens, 7);
  });

  it('openai 非流式：响应无 usage ⇒ unreported', async () => {
    const msg = await openaiFinal(openaiJsonNoUsage(), 'application/json', false);
    assert.equal(msg.usage.unreported, true);
  });

  it('openai 非流式：响应带 usage ⇒ 透传且不带 unreported', async () => {
    const msg = await openaiFinal(openaiJsonWithUsage(), 'application/json', false);
    assert.equal(msg.usage.unreported, undefined);
    assert.equal(msg.usage.input_tokens, 11);
  });
});
