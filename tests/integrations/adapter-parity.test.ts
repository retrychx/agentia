/*
 * 适配器**对拍矩阵** —— 「同一故障，两条适配器必须给出同一结论」的可执行版本。
 *
 * 为什么需要它（真实事故，见 docs/spec.md §10 2026-09-18）：
 * `anthropic.ts` 与 `openai.ts` 是**同一契约（`ModelClient`）的两条实现**，但历史上
 * 只有 anthropic 那条被反复测试。于是同一个 429：
 *   - anthropic：客户端内层重试 2 次 + 引擎层 1 次 = **3 次网络请求**；
 *   - openai：**没有内层重试** = **2 次**（且更早的版本连 status 都没有，引擎层一次都不重试）。
 * 各自的测试都「通过」了 —— 因为它们只断言「最终成功」，**从不比较两边的尝试次数**。
 * 这就是「成对实现不对称」：两份实现、两条覆盖率，谁都没错，合起来是错的。
 *
 * 本文件的形状刻意是**一份场景表跑两遍**（不是把两侧测试写成镜像）：
 * 断言只写一次，任何一条适配器偏离 → 同一行断言失败。新增场景 = 加一行。
 *
 * 注入面：两条适配器都在**调用时**解析全局 `fetch`（anthropic 直接用；
 * openai 是 `opts.fetchImpl ?? fetch`）。所以这里替换 `globalThis.fetch`，
 * 两种适配器共用同一个注入面 —— 也顺带暴露了「anthropic 没有 fetchImpl 选项」这个
 * 不对称（openai 有、anthropic 没有），本矩阵因此不依赖任何单侧的选项。
 *
 * 速度：每条失败响应都带 `retry-after: 0`，让两侧的退避都退化成 0ms ——
 * 否则真实指数退避（500ms 起）会让整个矩阵跑几十秒。这也顺带钉住「retry-after 被尊重」。
 *
 * ⚠️ 已知边界：连接级失败（fetch reject）与流内截断的**重试**不在本矩阵 ——
 * 前者没有响应可读 `retry-after`，会走真实指数退避（500ms 起，矩阵要跑几十秒）；
 * 这条路径两侧共用 `core/timeout.ts` 的同一份退避实现（±25% client 层曲线 ——
 * ±20% 那份是**引擎层** `retry.ts` 的，与适配器无关），对称性由单源保证；
 * 后者按设计不重试（流已开始，重试会重复输出），不属「对称」范畴。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, createAnthropicClient, createOpenAIClient } from '../../src/index.js';
import type { ModelClient } from '../../src/index.js';

type FetchLike = typeof fetch;

/** 一条适配器的构造面：只暴露「建 client」与「成功响应体」两件差异 */
interface Adapter {
  name: string;
  make(maxRetries: number): ModelClient;
  /** 该适配器协议下的「成功空回复」响应体 */
  okBody: Record<string, unknown>;
}

const anthropicOk = (): Record<string, unknown> => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'm',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const openaiOk = (): Record<string, unknown> => ({
  id: 'chatcmpl-1',
  model: 'm',
  choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const ADAPTERS: Adapter[] = [
  {
    name: 'anthropic',
    make: (maxRetries) => createAnthropicClient({ apiKey: 'k', maxRetries }),
    okBody: anthropicOk(),
  },
  {
    name: 'openai',
    // 非流式：本矩阵测「HTTP 失败 → 重试/分类」，与响应组装无关；非流式让两条适配器的
    // 成功路径形状一致，避免把 SSE 组装差异混进对拍结论。
    make: (maxRetries) => createOpenAIClient({ apiKey: 'k', maxRetries, stream: false }),
    okBody: openaiOk(),
  },
];

const PARAMS = { model: 'm', max_tokens: 16, messages: [{ role: 'user' as const, content: 'hi' }] };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 每次返回给定状态并计数；命中 `succeedAt` 次之后转成功。失败响应一律带 retry-after: 0 */
function installScriptFetch(
  status: number,
  okBody: Record<string, unknown>,
  opts: { succeedAt?: number; withRetryAfter?: boolean } = {},
): { hits: () => number } {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (opts.succeedAt !== undefined && n >= opts.succeedAt) {
      return new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('nope', {
      status,
      headers: {
        'content-type': 'application/json',
        // 让退避不真 sleep（两侧都认这个头）；也顺带证明它被尊重
        ...(opts.withRetryAfter === false ? {} : { 'retry-after': '0' }),
      },
    });
  }) as unknown as FetchLike;
  return { hits: () => n };
}

async function attempt(client: ModelClient): Promise<{ ok: boolean; err?: unknown }> {
  try {
    await client.messages.stream(PARAMS).finalMessage();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

/**
 * 可重试状态 + 各适配器的分类（两侧必须一致）。
 *
 * ⚠️ `retryable` 是**引擎层**口径（`classifyError` 的输出），与「客户端内层是否重试」
 * 是两件事，刻意不混：
 * - 408/409：客户端内层重试（HTTP 语义上值得重试），但分类为 `api` / **不可重试** ——
 *   引擎不再叠第二层（SDK 缺省也是这个口径）；
 * - 429：`rate_limit` / 可重试（客户端 + 引擎两层都重试）；
 * - 5xx：`server` / 可重试（同上）。
 * 这条区分写在这里，是因为「重试」有三个不同主体（客户端内层 / 引擎层 / 宿主重投），
 * 不写清楚就会被读成矛盾。
 */
const RETRYABLE: Array<{ status: number; type: string; engineRetryable: boolean }> = [
  { status: 408, type: 'api', engineRetryable: false },
  { status: 409, type: 'api', engineRetryable: false },
  { status: 429, type: 'rate_limit', engineRetryable: true },
  { status: 500, type: 'server', engineRetryable: true },
  { status: 503, type: 'server', engineRetryable: true },
];

for (const a of ADAPTERS) {
  describe(`适配器对拍 · ${a.name}`, () => {
    for (const { status } of RETRYABLE) {
      it(`${status}：客户端内层重试到成功，且尝试次数 == maxRetries+1`, async () => {
        const { hits } = installScriptFetch(status, a.okBody, { succeedAt: 3 });
        const client = a.make(2);
        const res = await client.messages.stream(PARAMS).finalMessage();
        assert.ok(res, `${status} 应在重试后拿到成功响应`);
        // 缺省 maxRetries=2 ⇒ 允许 2 次重试：第 3 次（succeedAt=3）成功
        assert.equal(hits(), 3, `${status}：尝试次数必须是 1 + maxRetries = 3`);
      });
    }

    for (const { status, type, engineRetryable } of RETRYABLE) {
      it(`${status} 耗尽重试后失败：错误带数值 status，分类为 ${type}/${
        engineRetryable ? '可重试' : '不可重试'
      }`, async () => {
        const { hits } = installScriptFetch(status, a.okBody); // 永不成功
        const client = a.make(2);
        const { ok, err } = await attempt(client);
        assert.equal(ok, false, `${status} 应最终失败`);
        assert.equal(hits(), 3, `${status} 重试耗尽 = 1 + maxRetries 次请求`);
        assert.equal(
          (err as { status?: number }).status,
          status,
          `${status}：错误对象必须自带数值 status（否则 classifyError 读不到）`,
        );
        const cls = classifyError(err);
        assert.equal(cls.type, type, `${status} → ${type}`);
        assert.equal(cls.retryable, engineRetryable, `${status} 的引擎层 retryable`);
      });
    }

    it('400 不可重试：只请求一次，分类为 api/不可重试', async () => {
      const { hits } = installScriptFetch(400, a.okBody, { withRetryAfter: false });
      const client = a.make(2);
      const { ok, err } = await attempt(client);
      assert.equal(ok, false, '400 应失败');
      assert.equal(hits(), 1, '400 不得重试（一次请求都不多打）');
      const cls = classifyError(err);
      assert.equal(cls.type, 'api');
      assert.equal(cls.retryable, false);
      assert.equal((err as { status?: number }).status, 400);
    });

    it('maxRetries: 0 → 可重试状态也不重试（重试可关闭，两适配器同语义）', async () => {
      const { hits } = installScriptFetch(429, a.okBody, { withRetryAfter: false });
      const client = a.make(0);
      const { ok } = await attempt(client);
      assert.equal(ok, false, 'maxRetries: 0 下 429 应直接失败');
      assert.equal(hits(), 1, 'maxRetries: 0 ⇒ 恰好一次请求');
    });
  });
}

/**
 * 跨适配器的**对称断言**（本文件的核心）：同一个 status 在两条适配器上，
 * 必须得到同一个「类型 + 可重试 + 尝试次数」。上面每一侧各自通过、这一条才会红 ——
 * 它把「两份实现各自正确、合起来不一致」这个盲区直接钉死。
 */
describe('适配器对拍 · 跨侧对称（同一故障 → 同一结论）', () => {
  const statuses = [400, 408, 409, 429, 500, 503];

  it('同一 status 在 anthropic 与 openai 上的 {type, retryable, 尝试次数} 完全一致', async () => {
    const rows: Array<{ status: number; side: string; cls: string; hits: number }> = [];
    for (const status of statuses) {
      for (const a of ADAPTERS) {
        const { hits } = installScriptFetch(status, a.okBody, {
          withRetryAfter: status !== 400,
        });
        const { err } = await attempt(a.make(2));
        const cls = classifyError(err);
        rows.push({ status, side: a.name, cls: `${cls.type}/${cls.retryable}`, hits: hits() });
      }
    }
    const byStatus = new Map<number, typeof rows>();
    for (const r of rows) byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r]);
    const mismatched: string[] = [];
    for (const [status, group] of byStatus) {
      const first = group[0]!;
      for (const g of group.slice(1)) {
        if (g.cls !== first.cls || g.hits !== first.hits) {
          mismatched.push(
            `${status}：${first.side}=${first.cls}/${first.hits}次 vs ${g.side}=${g.cls}/${g.hits}次`,
          );
        }
      }
    }
    assert.deepEqual(
      mismatched,
      [],
      '两条适配器对同一 HTTP 状态的结论必须一致（分类 + 尝试次数）—— 不一致意味着' +
        `「同一个 429」在两边的成本/延迟不同却没人发现：\n${mismatched.join('\n')}`,
    );
  });
});
