// 浸泡 / 压力验证（soak）：本地假端点 + 故障注入 + N 并发长跑，验证「时间维度」的问题 ——
// 单测与 e2e 都是「跑一轮看结果」，回答不了「连跑一小时会不会缓慢漏内存 / 句柄」。
//
// 为什么零成本：模型侧是**本地假端点**（与 e2e-examples 同一手法：替掉模型，绝不替掉
// 被测的框架链路），零网络、零 token，CI 之外的任意机器都能跑。
//
// 注入的故障（按请求概率，种子固定 ⇒ 可复现）：
//   2%  HTTP 429 + retry-after      —— 可重试，应被适配器/引擎重试吸收
//   2%  SSE 流写到一半掐断 socket    —— 截断 ⇒ AnthropicApiError/OpenAICompatApiError(500) 可重试
//   3%  HTTP 400 invalid_request     —— 不可重试，run 应以 api 错误收尾
//   1%  200 流内 error 分片（4xx 类）—— 不可重试，run 应以 api 错误收尾
//   8%  正常路径但先发 tool_call     —— 让「调工具 → 回灌 → 收尾」的多回合链路也在压力下跑
//
// 结尾断言（缺一不可，挂了 exit 1）：
//   ① 失败率落在注入率推出的区间内 —— 太低 = 故障被静默吞了，太高 = 重试没生效；
//   ② 每个失败 run 的错误分类 ∈ {api, server, rate_limit}，**绝不允许 unknown**（第六轮的主题）；
//   ③ metricsSink 的 snapshot 与实测计数逐一对得上，render() 恒定发三个 dropped_keys 样本；
//   ④ 内存有界：热身后 heapUsed 末段均值相对前段均值的增长 < 48MB；
//   ⑤ 干净退出：断言完若还有活着的句柄把进程吊住，看门狗超时后打印句柄并 exit 1。
//
// 不并入 verify-all（它是「跑多久」而不是「对不对」的验证，默认 60s 已偏慢）。
// 用法：npm run e2e:soak；调参：SOAK_DURATION_MS=7200000 SOAK_CONCURRENCY=32 npm run e2e:soak
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createOpenAIClient, metricsSink, runAgent } from '../src/index.js';
import type { AgentTool } from '../src/index.js';

const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 60_000);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY ?? 16);
const SEED = Number(process.env.SOAK_SEED ?? 42);
assert.ok(DURATION_MS >= 5000, 'SOAK_DURATION_MS 太短得不出任何结论（≥ 5s）');
assert.ok(CONCURRENCY >= 1 && CONCURRENCY <= 256, 'SOAK_CONCURRENCY 应在 1..256');

/** 确定性 RNG（mulberry32）：种子固定 ⇒ 故障序列可复现，挂了能原样重放 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// —— 假端点（OpenAI 兼容 SSE + 故障注入）——

interface FaultStats {
  requests: number;
  f429: number;
  truncated: number;
  f400: number;
  errorShard: number;
  toolPath: number;
  plain: number;
}

function sseChunks(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFaultyProvider(rng: () => number): Promise<{
  baseURL: string;
  stats: FaultStats;
  close: () => Promise<void>;
}> {
  const stats: FaultStats = {
    requests: 0,
    f429: 0,
    truncated: 0,
    f400: 0,
    errorShard: 0,
    toolPath: 0,
    plain: 0,
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      stats.requests++;
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
      const r = rng();

      if (r < 0.02) {
        // 可重试限流（retry-after: 0 ⇒ 退避不拖时间，soak 才能跑出量）
        stats.f429++;
        res.writeHead(429, { 'retry-after': '0' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }));
        return;
      }
      if (r < 0.04) {
        // 截断：吐出一个正常分片后直接把 socket 掐掉（无 [DONE]、无 finish_reason）
        stats.truncated++;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-x', model: 'soak-model', choices: [{ delta: { content: '半句' } }] })}\n\n`,
        );
        res.socket?.destroy();
        return;
      }
      if (r < 0.07) {
        // 不可重试 4xx：改配置才有救的病因，引擎一次都不该重试
        stats.f400++;
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              message: 'too long',
            },
          }),
        );
        return;
      }
      if (r < 0.08) {
        // 200 流内 error 分片（兼容端点常见形态）—— 同样按 4xx 判
        stats.errorShard++;
        sseChunks(res, [
          {
            error: {
              type: 'invalid_request_error',
              code: 'model_not_found',
              message: 'no such model',
            },
          },
        ]);
        return;
      }

      const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
      if (!hasToolResult && r < 0.16) {
        // 8%：先发 tool_call（arguments 分两片，与真端点同形），让多回合链路也承压
        stats.toolPath++;
        sseChunks(res, [
          {
            id: 'chatcmpl-t',
            model: 'soak-model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_echo_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] } },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"ping"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        ]);
        return;
      }

      stats.plain++;
      sseChunks(res, [
        { id: 'chatcmpl-ok', model: 'soak-model', choices: [{ delta: { content: '收尾' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
      ]);
    });
  });

  const baseURL = await new Promise<string>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert.ok(typeof addr === 'object' && addr !== null, '假端点没有拿到端口');
      ready(`http://127.0.0.1:${addr.port}`);
    });
  });
  return {
    baseURL,
    stats,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// —— soak 主体 ——

const echoTool: AgentTool = {
  name: 'echo',
  description: '回显输入文本。',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  } as unknown as AgentTool['inputSchema'],
  run: async (input) => `echo: ${String((input as { text: string }).text)}`,
};

async function main(): Promise<void> {
  const rng = mulberry32(SEED);
  const provider = await startFaultyProvider(rng);
  const client = createOpenAIClient({ baseURL: provider.baseURL, apiKey: 'soak', maxRetries: 1 });
  const sink = metricsSink();

  // 看门狗：断言结束后进程若被活着的句柄吊住，打出来再死 —— 「没退出」本身是一条失败
  const watchdog = setTimeout(() => {
    console.error('\n✖ soak 结束后进程未退出（句柄泄漏）。活跃句柄：');
    const handles = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    console.error(`  ${handles?.length ?? '?'} 个`);
    process.exit(1);
  }, DURATION_MS + 30_000);

  const memSamples: Array<{ t: number; heap: number; rss: number }> = [];
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    memSamples.push({ t: Date.now(), heap: m.heapUsed, rss: m.rss });
  }, 2000);

  let total = 0;
  let failed = 0;
  let thrown = 0; // runAgent 正常失败是 result.error 在场，throw 出来 = 契约破了
  const badErrorTypes: string[] = [];
  const endAt = Date.now() + DURATION_MS;

  const worker = async (id: number): Promise<void> => {
    let n = 0;
    while (Date.now() < endAt) {
      n++;
      try {
        const result = await runAgent({
          model: 'soak-model',
          maxTokens: 256,
          client,
          messages: [{ role: 'user', content: `worker ${id} 第 ${n} 轮` }],
          tools: [echoTool],
        });
        total++;
        sink.export(result.trace);
        if (result.error) {
          failed++;
          if (!['api', 'server', 'rate_limit'].includes(result.error.type)) {
            badErrorTypes.push(result.error.type);
          }
        }
      } catch (e) {
        thrown++;
        total++;
        badErrorTypes.push(`THROWN:${(e as Error).message.slice(0, 80)}`);
      }
    }
  };

  console.log(
    `soak 开跑：${CONCURRENCY} 并发 × ${DURATION_MS / 1000}s，种子 ${SEED}（故障：2% 429 / 2% 截断 / 3% 400 / 1% 流内错误 / 8% 工具路径）`,
  );
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  clearInterval(sampler);

  const elapsed = (Date.now() - started) / 1000;
  const snap = sink.snapshot();
  const rendered = sink.render();
  sink.stop();
  await provider.close();

  // —— 汇总 ——
  const rate = total === 0 ? 0 : failed / total;
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log('\n—— soak 结果 ——');
  console.log(
    `run：total=${total} failed=${failed}（${(rate * 100).toFixed(2)}%）thrown=${thrown}，吞吐 ${(total / elapsed).toFixed(1)} run/s`,
  );
  console.log(
    `端点：requests=${provider.stats.requests} 429=${provider.stats.f429} 截断=${provider.stats.truncated} 400=${provider.stats.f400} 流内错误=${provider.stats.errorShard} 工具路径=${provider.stats.toolPath} 正常=${provider.stats.plain}`,
  );
  if (memSamples.length >= 4) {
    console.log(
      `内存：heap ${mb(memSamples[0]!.heap)} → ${mb(memSamples[memSamples.length - 1]!.heap)}，rss 峰值 ${mb(Math.max(...memSamples.map((s) => s.rss)))}（${memSamples.length} 个采样）`,
    );
  }

  // —— 断言 ——
  assert.ok(total >= 100, `样本太少（${total} 个 run），统计结论无意义 —— 加长 SOAK_DURATION_MS`);

  // ① 失败率区间：不可重试注入率 4%/请求，工具路径一次 run 两次请求（≈7.8%），重试吸收可重试故障。
  //    区间放得很宽：下界钉「故障没被静默吞掉」，上界钉「重试真的在吸收可重试故障」。
  assert.ok(failed > 0, '注入了 8% 的故障却 0 失败 —— 故障被静默吞了（比全挂更可怕）');
  assert.ok(
    rate > 0.005 && rate < 0.3,
    `失败率 ${(rate * 100).toFixed(2)}% 不在 (0.5%, 30%) 区间：偏离注入率太远说明重试/分类出了问题`,
  );

  // ② 错误分类：绝不允许 unknown / throw 出契约外
  assert.equal(
    thrown,
    0,
    `有 ${thrown} 个 run 以 throw 收尾（契约是 result.error 在场）：${badErrorTypes[0] ?? ''}`,
  );
  assert.deepEqual(
    [...new Set(badErrorTypes)],
    [],
    `存在未知错误分类：${[...new Set(badErrorTypes)].join(', ')}`,
  );

  // ③ metricsSink 与实测逐一对账
  assert.equal(snap.runs, total, 'snapshot().runs 与实测 run 数不符');
  assert.equal(snap.failed, failed, 'snapshot().failed 与实测失败数不符');
  for (const k of ['capability', 'model', 'score']) {
    assert.match(
      rendered,
      new RegExp(`agentia_dropped_keys\\{kind="${k}"\\} \\d+`),
      `render() 缺 dropped_keys{kind=${k}}`,
    );
  }

  // ④ 内存有界：丢掉前 20% 采样（预热），末 3 个均值相对前 3 个均值的增长 < 48MB。
  //    真泄漏在数千次 run 下是数百 MB 量级，这个阈值的信噪比足够。
  if (memSamples.length >= 10) {
    const warm = memSamples.slice(Math.ceil(memSamples.length * 0.2));
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const headAvg = avg(warm.slice(0, 3).map((s) => s.heap));
    const tailAvg = avg(warm.slice(-3).map((s) => s.heap));
    assert.ok(
      tailAvg - headAvg < 48 * 1024 * 1024,
      `heapUsed 热身后仍增长 ${mb(tailAvg - headAvg)}（${mb(headAvg)} → ${mb(tailAvg)}）—— 疑似泄漏`,
    );
  } else {
    console.log('（采样不足 10 个，跳过内存断言 —— 加长 SOAK_DURATION_MS 才会启用）');
  }

  clearTimeout(watchdog);
  console.log('\nOK —— soak 全过：故障被看见、被分类、被重试吸收，内存有界，进程能干净退出。');
}

await main();
