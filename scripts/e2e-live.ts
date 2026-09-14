// 真 API 集成验证：拿**真实厂商端点**跑框架主路径（Anthropic Messages / SSE / tool_use / cache_control）。
//
// 为什么要有这一条：全仓测试都走 `tests/helpers.ts` 的 `mockClient` —— 而 mock 只实现我们
// **以为** SDK 该有的形状。于是「SDK 真可选」这件事从没被真端点验过：如果 SDK 的真实行为
// （SSE 分片形状、`tool_use.input` 的解析、`usage` 字段名、`signal` 中转）与我们假设的不同，
// 现有门禁**全绿也发现不了**。这条就是那个缺失的证据。
//
// 端点：默认读 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（与框架默认 client 同款约定）。
// DeepSeek 提供 Anthropic 协议兼容端点（`https://api.deepseek.com/anthropic`），
// 因此**不需要 Anthropic key** 也能验完主路径。
//
// ⚠️ 与本仓其他 e2e 的三点不同，别混：
//   ① **会真花 token** ⇒ 不并入 `npm run e2e`、不进 verify-all、不进 CI。
//   ② 无凭据时**跳过并 exit 0**，但会打醒目横幅 —— 静默跳过等于假装验过。
//   ③ 断言只针对**协议契约**（框架依赖的形状），不针对某家模型的话术或选项支持度。
//      厂商特有的差异（如是否真支持 prompt caching）**只报告、不判失败**。
//
// 运行：ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... AGENTIA_LIVE_MODEL=... npm run e2e:live
import { createAnthropicClient, runAgent } from '../src/index.js';
import type { AgentTool, ModelClient } from '../src/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() ?? '';
const model = process.env.AGENTIA_LIVE_MODEL?.trim() || process.env.AGENTIA_MODEL?.trim() || '';

if (!apiKey) {
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  SKIP：未设置 ANTHROPIC_API_KEY —— 真 API 集成验证没有跑     │');
  console.log('│  这是**跳过**，不是通过。要真验：                             │');
  console.log('│    ANTHROPIC_API_KEY=... npm run e2e:live                     │');
  console.log('│  （用 DeepSeek 的 Anthropic 兼容端点可免 Anthropic key：      │');
  console.log('│    ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \\    │');
  console.log('│    AGENTIA_LIVE_MODEL=deepseek-v4-flash ...）                 │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  process.exit(0);
}

if (!model) {
  console.error('缺少模型名：设 AGENTIA_LIVE_MODEL（如 deepseek-v4-flash / claude-opus-5）。');
  console.error('真实端点未必认 `claude-opus-5` 这个缺省名，所以这里**不猜**。');
  process.exit(2);
}

/** 断言即收窄（`asserts`）—— 后续代码里 `block`/`out` 这类可空值直接可用，不必再 `!` */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`LIVE FAIL: ${msg}`);
}

/** 每步单独计时与报错，任何一步抛出即整体失败（不静默放过） */
async function step(title: string, fn: () => Promise<string | undefined>): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`· ${title} ... `);
  try {
    const note = await fn();
    console.log(`OK (${Date.now() - t0}ms)${note ? ` — ${note}` : ''}`);
  } catch (e) {
    console.log(`FAIL (${Date.now() - t0}ms)`);
    throw e;
  }
}

/** Anthropic SDK 的中止错误名随版本变，统一按「是不是 abort 语义」判定 */
function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.name === 'AbortError' ||
    e.name === 'APIUserAbortError' ||
    /abort/i.test(e.name) ||
    /abort/i.test(e.message)
  );
}

const client: ModelClient = createAnthropicClient({
  apiKey,
  ...(baseURL ? { baseURL } : {}),
});

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

console.log('');
console.log(
  `真 API 集成验证 —— model=${model}${baseURL ? ` baseURL=${baseURL}` : '（SDK 默认端点）'}`,
);
console.log('');

// ── ① 流式文本：on('text') 分片必须能拼回 finalMessage 的文本，且 usage 有值 ──────────
await step(
  '① SSE 流式文本：on(text) 分片拼接 == finalMessage 文本，usage 有 input/output',
  async () => {
    const s = client.messages.stream({
      model,
      max_tokens: 256,
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
    });
    let streamed = '';
    s.on('text', (d) => {
      streamed += d;
    });
    const final = await s.finalMessage();
    const text = textOf(final);
    assert(text.length > 0, 'finalMessage 里没有 text 块');
    assert(
      streamed === text,
      `on('text') 分片与 finalMessage 文本不一致：streamed=${JSON.stringify(streamed)} text=${JSON.stringify(text)}`,
    );
    const u = final.usage;
    assert(u && typeof u.input_tokens === 'number', 'usage.input_tokens 缺失');
    assert(typeof u.output_tokens === 'number', 'usage.output_tokens 缺失');
    return `${u.input_tokens} in / ${u.output_tokens} out，分片 ${streamed.length} 字`;
  },
);

// ── ② tool_use：框架靠 id/name/input 三者配对与执行，必须真解析出来 ──────────────────
const WEATHER_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
} as const;

const TOOL_MENU = [
  {
    name: 'get_weather',
    description: '查询一个城市的当前天气。',
    input_schema: WEATHER_SCHEMA as unknown as Record<string, unknown>,
  },
];

let toolUseId = '';
await step(
  '② tool_use：模型必须回一个可配对的 tool_use 块（id/name/input 都解析出来）',
  async () => {
    const s = client.messages.stream({
      model,
      max_tokens: 512,
      tools: TOOL_MENU as never,
      messages: [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }],
    });
    const final = await s.finalMessage();
    const block = final.content.find((b) => b.type === 'tool_use') as
      | { type: 'tool_use'; id: string; name: string; input: unknown }
      | undefined;
    assert(block, `没有 tool_use 块，实际内容：${JSON.stringify(final.content)}`);
    assert(typeof block.id === 'string' && block.id.length > 0, 'tool_use.id 为空');
    assert(block.name === 'get_weather', `tool_use.name=${block.name}，期望 get_weather`);
    const input = block.input as { city?: unknown };
    assert(
      input && typeof input === 'object' && typeof input.city === 'string',
      `tool_use.input 没被解析成符合 schema 的对象：${JSON.stringify(block.input)}`,
    );
    toolUseId = block.id;
    return `name=${block.name} city=${String(input.city)}`;
  },
);

// ── ③ 多轮 tool_result 回灌：框架每回合都把 tool_result 拼回 messages ───────────────
await step('③ tool_result 回灌：把工具结果发回去，模型能接着收尾（end_turn + 文本）', async () => {
  assert(toolUseId, '上一步没拿到 tool_use.id，无法构造 tool_result');
  const s = client.messages.stream({
    model,
    max_tokens: 512,
    tools: TOOL_MENU as never,
    messages: [
      { role: 'user', content: '北京现在天气怎么样？用工具查。' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'get_weather', input: { city: '北京' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: '晴，24°C，湿度 30%',
          },
        ],
      },
    ] as never,
  });
  const final = await s.finalMessage();
  assert(
    textOf(final).length > 0,
    `回灌 tool_result 后没有文本产出，content=${JSON.stringify(final.content)}`,
  );
  return `stop_reason=${final.stop_reason}，文本 ${textOf(final).length} 字`;
});

// ── ④ cache_control：system 走 TextBlockParam[] 形状（框架的 SystemParam 路径） ──────
await step('④ system 用 TextBlockParam[] 带 cache_control：端点须接受该形状', async () => {
  const s = client.messages.stream({
    model,
    max_tokens: 64,
    system: [
      { type: 'text', text: '你是一个简洁的助手。' },
      { type: 'text', text: '背景资料：'.padEnd(2000, '。'), cache_control: { type: 'ephemeral' } },
    ] as never,
    messages: [{ role: 'user', content: '说「好」' }],
  });
  const final = await s.finalMessage();
  assert(final.usage, 'usage 缺失');
  // 厂商支持度只报告不判失败：Anthropic 会回 cache_read/cache_creation，兼容端点常常忽略。
  const cr = (final.usage as { cache_read_input_tokens?: number | null }).cache_read_input_tokens;
  const cc = (final.usage as { cache_creation_input_tokens?: number | null })
    .cache_creation_input_tokens;
  return cr || cc
    ? `端点回报了缓存计量（read=${cr ?? 0} / creation=${cc ?? 0}）`
    : '端点接受了 cache_control 但未回报缓存计量（兼容端点常见，不判失败）';
});

// ── ⑤ signal 透传：契约写着「实现须转发给底层请求，否则调用方无法中止在飞 run」 ──────
await step('⑤ signal 真转发：在飞请求 abort 后必须中断（契约要的是「中止在飞 run」）', async () => {
  // 触发点用**首个文本分片到达**，不用墙钟 sleep —— 分片到了就说明请求确实在飞（确定性）。
  // ⚠️ 别用「预中止的 signal」当判据：那种 signal 在 SDK 挂 abort 监听器之前就已 abort，
  //    事件不会再触发 —— 实测预中止的请求会照常跑完（SDK 行为，与本框架无关，也不是契约要的语义）。
  const ac = new AbortController();
  const countTo300 = '从 1 数到 300，每个数字单独一行，一个都不要省略。';
  const s = client.messages.stream({
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: countTo300 }],
    signal: ac.signal,
  });
  let deltas = 0;
  let markFirst!: () => void;
  const firstDelta = new Promise<void>((r) => {
    markFirst = r;
  });
  s.on('text', () => {
    deltas++;
    markFirst();
  });
  await firstDelta; // 请求已在飞
  ac.abort();

  let aborted = false;
  try {
    await s.finalMessage();
  } catch (e) {
    if (!isAbortError(e)) throw e; // 抛别的错是真问题，别吞
    aborted = true;
  }
  assert(aborted, `abort 后请求仍跑到结束（已收 ${deltas} 个分片）⇒ 中止信号没被转发到在飞请求`);
  return `收 ${deltas} 个分片后 abort，流以 abort 语义收场`;
});

// ── ⑥ 引擎全链：runAgent + 真工具 ⇒ trace 记账必须对 ────────────────────────────────
await step(
  '⑥ 引擎全链：runAgent 真调工具，trace 里 llm.turn / tool.output / totalUsage 都对',
  async () => {
    const tool: AgentTool = {
      name: 'get_weather',
      description: '查询一个城市的当前天气。',
      inputSchema: WEATHER_SCHEMA as unknown as AgentTool['inputSchema'],
      run: async (input) =>
        `晴，24°C（工具返回，city=${String((input as { city: string }).city)}）`,
    };
    const result = await runAgent({
      model,
      maxTokens: 1024,
      client, // 走上面那个真 client（默认也会 createAnthropicClient，但显式传更清楚）
      system: '你可以调用工具。拿到工具结果后用一句话回答。',
      messages: [{ role: 'user', content: '上海现在天气怎么样？必须调用工具。' }],
      tools: [tool],
    });

    assert(!result.error, `run 出错：${JSON.stringify(result.error)}`);
    assert(result.iterations >= 2, `iterations=${result.iterations}，期望 ≥2（调工具 → 再问一次）`);

    const out = result.trace.spans.flatMap((s) => s.events).find((e) => e.name === 'tool.output');
    assert(out, 'trace 里没有 tool.output 事件 —— 引擎没把工具执行记进 trace');
    const body = out.body as { ok?: boolean; tool?: string; durationMs?: number; content?: string };
    assert(body.ok === true, `tool.output.ok=${body.ok}，期望 true`);
    assert(body.tool === 'get_weather', `tool.output.tool=${body.tool}`);
    assert(typeof body.durationMs === 'number', 'tool.output.durationMs 缺失');
    assert(
      typeof body.content === 'string' && body.content.includes('工具返回'),
      `trace 里记的工具结果不是真返回值：${body.content}`,
    );

    const turns = result.trace.spans.filter((s) => s.kind === 'llm.turn').length;
    assert(turns >= 2, `llm.turn span 只有 ${turns} 个，期望 ≥2`);

    const u = result.trace.totalUsage;
    // 注意：trace.totalUsage 是**框架归一化后**的 Usage（camelCase），不是 SDK Message.usage（snake_case）。
    assert(u.inputTokens > 0, `totalUsage.inputTokens=${u.inputTokens}，期望 >0`);
    assert(u.outputTokens > 0, `totalUsage.outputTokens=${u.outputTokens}，期望 >0`);

    return `${turns} 个 llm.turn，totalUsage ${u.inputTokens} in / ${u.outputTokens} out，finalText ${result.finalText.length} 字`;
  },
);

console.log('');
console.log('6/6 全绿 —— 真端点验完框架主路径。');
console.log('提醒：本脚本不在 verify-all 内，CI 不会跑它（会花 token）。');
