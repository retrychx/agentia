/*
 * 流内 error → HTTP status：**两条适配器必须同一档**（2026-09-28 外部深评 S3 的可执行版本）。
 *
 * 背景（为什么要专门一个文件）：`anthropic.ts` / `openai.ts` 是同一契约（`ModelClient`）的
 * 两条实现，而「流内 error 的 type/code 反推成哪个 HTTP status」原本**各写一份**，
 * 一致性只靠两边注释里「与那边同口径」互相喊话 —— 注释不会在被改的那一刻失败。
 * 事实是它们**当时就已经不一致**（下面 `not_found_error` / `model_not_found` 两行就是证据：
 * 同一病因，一侧 400、另一侧 500）。判定现已收进 `adapter-options.ts` 一份，
 * 这个文件是它的护栏：**同一张表跑两条适配器**，任何一侧偏离 ⇒ 同一行断言失败。
 *
 * 为什么走**真适配器 + 真 SSE**而不是直接调那个 helper：S3 要保的是「使用者拿到的结果一致」，
 * 不是「helper 的返回值一致」—— 两条适配器各自读事件、各自抛自己的错误类，中间任何一步
 * 把 status 丢掉或改写，都在本文件的射程内（helper 级单测看不见）。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../src/index.js';
import { createAnthropicClient } from '../../src/integrations/anthropic.js';
import { createOpenAIClient } from '../../src/integrations/openai.js';

type FetchLike = typeof fetch;

const PARAMS = { model: 'm', max_tokens: 16, messages: [{ role: 'user' as const, content: 'hi' }] };

/** 用一份固定的 SSE 报文替换全局 fetch（两条适配器共用同一个注入面 —— anthropic 没有 `fetchImpl` 选项） */
function stubSse(body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as FetchLike;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Case {
  /** 上游给的 type（两侧同一份词表 —— 判定合并后它们必须给出同一个结论） */
  type: string;
  /** 上游给的 code（同为判定输入的一部分） */
  code?: string;
  /** 期望 status（两侧都必须等于它） */
  status: number;
  /** 这一行为什么这么判（留着给后来人看，不是给断言看的） */
  why: string;
  /** 是否是**合并前两条适配器不一致**的那一行（修复的靶子） */
  wasDivergent?: boolean;
}

const CASES: Case[] = [
  { type: 'rate_limit_error', status: 429, why: '限流：可重试，引擎要认出它才谈得上退避' },
  { type: 'insufficient_quota', status: 429, why: '配额耗尽：同一档（此时重试也救不了，但分类一致）' },
  { type: 'overloaded_error', status: 529, why: '上游过载：5xx 可重试，保留 529 便于分开数' },
  { type: 'invalid_request_error', status: 400, why: '改配置才有救 ⇒ 400，引擎不得白重试' },
  { type: 'context_length_exceeded', status: 400, why: '上下文超限：改配置才有救' },
  { type: 'authentication_error', status: 400, why: '鉴权：引擎侧与 403/404 同一处置，不细分' },
  {
    type: 'not_found_error',
    status: 400,
    why: '合并前 anthropic=400 而 openai=500（把「模型名错」记成 server，排障方向被带偏）',
    wasDivergent: true,
  },
  {
    type: 'model_not_found',
    status: 400,
    why: '合并前 openai=400 而 anthropic=500（同一病因的另一半）',
    wasDivergent: true,
  },
  { type: 'server_error', status: 500, why: '真的上游故障：5xx 可重试' },
  { type: 'something_nobody_listed', status: 500, why: '未列出的病因按最保守档（可重试的 5xx）' },
];

/** 跑一条适配器：拿它抛出的错误（不抛 = 假成功，返回 undefined，调用点断言失败） */
async function anthropicError(c: Case): Promise<unknown> {
  const payload = JSON.stringify({
    type: 'error',
    error: { type: c.type, ...(c.code ? { code: c.code } : {}) },
  });
  stubSse(`data: ${payload}\n\n`);
  const client = createAnthropicClient({ apiKey: 'k', maxRetries: 0 });
  return client.messages
    .stream(PARAMS)
    .finalMessage()
    .then(
      () => undefined,
      (e: unknown) => e,
    );
}

async function openaiError(c: Case): Promise<unknown> {
  const chunk = JSON.stringify({
    error: { message: 'boom', type: c.type, ...(c.code ? { code: c.code } : {}) },
  });
  stubSse(`data: ${chunk}\n\ndata: [DONE]\n\n`);
  const client = createOpenAIClient({ apiKey: 'k', maxRetries: 0 });
  return client.messages
    .stream(PARAMS)
    .finalMessage()
    .then(
      () => undefined,
      (e: unknown) => e,
    );
}

const statusOf = (err: unknown): number | undefined => (err as { status?: number })?.status;

describe('S3：流内 error → status 的两条适配器对拍（同一张表跑两遍）', () => {
  for (const c of CASES) {
    it(`${c.type} → ${c.status}${c.wasDivergent ? '（合并前两侧不一致）' : ''}`, async () => {
      const a = await anthropicError(c);
      const o = await openaiError(c);

      assert.ok(a, 'anthropic 侧必须抛错（假成功 = 上游故障被记成正常收尾）');
      assert.ok(o, 'openai 侧必须抛错（同上）');
      assert.equal(statusOf(a), c.status, `anthropic：${c.why}`);
      assert.equal(statusOf(o), c.status, `openai：${c.why}`);

      // 分类也要同一结论 —— status 相同但分类不同，等于「两条适配器两本账」没修
      const ca = classifyError(a);
      const co = classifyError(o);
      assert.equal(ca.type, co.type, '两侧的引擎层分类必须一致');
      assert.equal(ca.retryable, co.retryable, '两侧的可重试结论必须一致');
    });
  }
});
