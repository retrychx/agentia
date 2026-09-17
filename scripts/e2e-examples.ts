// 示例端到端验证：`examples/complete` 按它 README 里写的方式**真起服务、真跑三种触发**；
// `examples/code-review` 真构建并跑它的**离线确定性 demo**（scriptedClient 剧本，零网络）。
//
// 为什么要有这一条：`examples/complete` 被 usage-guide / 项目 README 指着说「完整可跑写法见
// examples/complete/」，但它此前只被 `typecheck:tests` 覆盖 —— 全仓**没有任何门禁真跑过**它
// （`examples/` 下 0 个测试）。这条把「文档承诺可跑」变成「门禁证明可跑」。
//
// 不联网：complete 的模型侧用本脚本内置的假 OpenAI 兼容端点（真 SSE，逐分片）；
// code-review 的 demo 模式根本不需要模型端点（scriptedClient）。只走 127.0.0.1。
//
// 运行：npm run e2e（先 build 框架与 CLI，再 tsx 跑本脚本）
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const exampleDir = join(repoRoot, 'examples', 'complete');
const obsPkgDir = join(repoRoot, 'examples', 'observability');
const codeReviewDir = join(repoRoot, 'examples', 'code-review');

/** 假 OpenAI 兼容端点的记录（断言「能力真的被执行」靠它，而不是靠自己读响应文本） */
interface FakeProviderObserved {
  /** 第一次请求里模型看到的工具菜单（证明四类能力真装配上了） */
  menu: string[];
  /** 回传给模型的能力执行结果（证明 echo 真跑过） */
  toolResults: string[];
  /** 调用次数（≥2 说明走完了「调能力 → 再问一次」完整回路） */
  calls: number;
}

/** SSE 分片构造：`data: {...}` 逐条下发，末尾 `[DONE]`（与真端点同形） */
function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * 起一个假的 OpenAI 兼容端点。
 *
 * 剧本（够模拟一次「主 agent 选能力 → 拿到结果 → 收尾」的完整往返）：
 * - 请求里还没有 tool 消息 ⇒ 回一个 `echo` 的 tool_call，**且把 arguments 拆成多片**下发
 *   （真端点就是这么发的，顺带把框架侧的分片累积逻辑放进真实链路里跑一遍）；
 * - 有了 tool 消息 ⇒ 回最终文本。
 */
async function startFakeProvider(): Promise<{
  baseURL: string;
  observed: FakeProviderObserved;
  close: () => Promise<void>;
}> {
  const observed: FakeProviderObserved = { menu: [], toolResults: [], calls: 0 };
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
      observed.calls++;
      const parsed = JSON.parse(body) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      if (observed.calls === 1) {
        for (const t of parsed.tools ?? []) {
          if (t.function?.name) observed.menu.push(t.function.name);
        }
      }
      const toolMsgs = (parsed.messages ?? []).filter((m) => m.role === 'tool');
      for (const m of toolMsgs) observed.toolResults.push(String(m.content));

      if (toolMsgs.length === 0) {
        sse(res, [
          {
            id: 'chatcmpl-fake-1',
            model: 'fake-model',
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
          // arguments 分片：`{"text":` + `"ping"}` —— 真端点的形态
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

      sse(res, [
        {
          id: 'chatcmpl-fake-2',
          model: 'fake-model',
          choices: [{ delta: { content: '已回显：' } }],
        },
        { choices: [{ delta: { content: 'ping' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ]);
    });
  });

  const baseURL = await new Promise<string>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert(typeof addr === 'object' && addr !== null, '假端点没有拿到端口');
      ready(`http://127.0.0.1:${(addr as { port: number }).port}`);
    });
  });

  return {
    baseURL,
    observed,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** 取一个空闲端口（listen 0 拿到再放掉；留给被 spawn 的示例进程用） */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((ready) => {
    probe.listen(0, '127.0.0.1', () => ready((probe.address() as { port: number }).port));
  });
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/**
 * 让示例的 `import '@migor/agentia'` 可解析 —— 与 `scripts/e2e-cli.ts` 同一手法（symlink 回仓库根）。
 *
 * 两个理由必须自己建：
 * 1. CI 上示例目录里的 `node_modules` 不存在（已 gitignore），不建示例直接起不来；
 * 2. 本地 `npm install` 装出来的 `file:../..` 是**快照拷贝**（实测 npm 会拷贝而非软链），
 *    于是示例跑的是安装那天的框架，改了 dist 也不生效 —— 对「验证当前代码」的脚本来说这是失真。
 *    指向仓库根即可拿到**当前** dist。
 */
function ensureLinks(): void {
  const links: Array<[string, string]> = [
    // 示例应用：要能解析框架本体与本地小包
    [join(exampleDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    [join(exampleDir, 'node_modules', '@migor', 'agentia-observability'), obsPkgDir],
    [join(codeReviewDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    // 本地小包**自己也要能构建** —— CI 上没有它的 node_modules，不建的话 `tsc -p` 会
    // 报「Cannot find module '@migor/agentia'」+「Cannot find name 'process'」
    // （@types/node 沿目录树上溯到仓库根即可解析，只有 @migor 需要这一步）
    [join(obsPkgDir, 'node_modules', '@migor', 'agentia'), repoRoot],
  ];
  for (const [link, target] of links) {
    let current: string | null = null;
    try {
      current = realpathSync(link);
    } catch {
      current = null; // 不存在
    }
    if (current === realpathSync(target)) continue; // 已指向正确目标
    rmSync(link, { recursive: true, force: true }); // 清掉快照拷贝 / 错链
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(target, link, 'dir');
  }
}

/** 本地小包 `@migor/agentia-observability` 的 main 指向 dist —— 没构建就先构建（离线、几秒） */
function ensureObsPkgBuilt(): void {
  if (existsSync(join(obsPkgDir, 'dist', 'index.js'))) return;
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: obsPkgDir,
    stdio: 'inherit',
  });
}

/**
 * 按示例**自己的构建脚本**构建（`tsc -p tsconfig.json && node scripts/copy-assets.mjs`）。
 *
 * 顺手把「示例能不能构建」也纳入门禁 —— 此前它同样没人跑过。
 * 用 dist 而不是 tsx 跑 src 还有两个好处：node 就是应用进程本身（SIGTERM 直达信号处理器，
 * 不经过 tsx CLI 的包装进程），且验的是**部署形态**的产物。
 */
function buildExample(): void {
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/copy-assets.mjs'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
}

/** 起示例进程（`node dist/main.js`，即示例 README 的 `npm run serve`），等它的就绪日志（不 sleep 猜时间） */
async function startExample(
  port: number,
  fakeBaseURL: string,
): Promise<{ child: ChildProcess; stdout: () => string; stop: () => Promise<number | null> }> {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: String(port),
      AGENTIA_DB: ':memory:',
      // 走 OpenAI 兼容端点 ⇒ 用上示例里那段「注入 model client」的缝（而不是框架默认 Anthropic client）
      OPENAI_BASE_URL: fakeBaseURL,
      OPENAI_API_KEY: 'fake-key',
      AGENTIA_MODEL: 'fake-model',
      API_KEY: 'e2e-secret', // 打开鉴权缝，验 README 里那条 401
      AGENTIA_CHECK_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });

  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const deadline = Date.now() + 30_000; // 就绪预算给足：这里验的是「能不能起来」，不是「多快起来」
  while (!out.includes('[boot] listening')) {
    if (child.exitCode !== null) {
      throw new Error(
        `示例进程启动即退出（code=${child.exitCode}）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`等示例就绪超时（30s）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  return {
    child,
    stdout: () => out,
    stop: async () => {
      child.kill('SIGTERM'); // README 承诺的优雅停机路径
      const code = await Promise.race([
        exited,
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);
      if (code === null) child.kill('SIGKILL');
      return code;
    },
  };
}

/** 轮询任务记录到终态（就绪预算是给足的：验的是「最终会成功」，不是「多快成功」） */
async function pollTask(
  base: string,
  taskId: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rec = (await (await fetch(`${base}/tasks/${taskId}`, { headers })).json()) as Record<
      string,
      unknown
    >;
    if (rec.status !== 'queued' && rec.status !== 'running') return rec;
    if (Date.now() > deadline) throw new Error(`任务 ${taskId} 20s 未终态：${JSON.stringify(rec)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** code-review demo 产出的 trace 里本脚本要断言的最小形状（只声明用到的字段） */
interface CodeReviewSpan {
  spanId: string;
  kind: string;
  name: string;
  events: Array<{ name: string; body: unknown }>;
}

/**
 * `examples/code-review` 的离线 demo 验证（README「npm run demo」一节的可执行版本）：
 * 真构建（tsc + copy-assets）→ 跑 dist/demo.js（exit≠0 时 execFileSync 直接抛）→
 * 断言 stdout 摘要与 out/ 产物（trace.jsonl 的 capability span / llm.turn 数 / score 事件 /
 * token 口径，report.json 的结构化结论）。
 *
 * demo 是**确定性**的（scriptedClient 8 步剧本）：token 数与成本数字钉死断言，
 * 任何框架侧记账口径的变化都会在这里响亮失败 —— 这正是「产品验证」要的效果。
 */
function verifyCodeReview(): Record<string, unknown> {
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: codeReviewDir,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/copy-assets.mjs'], {
    cwd: codeReviewDir,
    stdio: 'inherit',
  });

  // 剥掉模型侧 env：本机 export 过 AGENTIA_MODEL / ANTHROPIC_* 时，demo 的数字会随之变 ——
  // 确定性验证必须在自己控制的环境里跑
  const env = { ...process.env };
  delete env.AGENTIA_MODEL;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  const out = execFileSync(process.execPath, ['dist/demo.js'], {
    cwd: codeReviewDir,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  assert(out.includes('stopReason=end_turn'), `demo 应正常收尾，实际 stdout:\n${out}`);
  assert(out.includes('整体定级 high'), `结论应定级 high，实际 stdout:\n${out}`);
  assert(
    out.includes('估算成本：$0.002796'),
    `demo 的成本行是确定性数字（25600 入 / 1180 出 × deepseek-v4-flash 定价），实际 stdout:\n${out}`,
  );

  const tracePath = join(codeReviewDir, 'out', 'trace.jsonl');
  assert(existsSync(tracePath), 'demo 应产出 out/trace.jsonl');
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n');
  assert(lines.length === 1, `一次 run 一行 trace，实际 ${lines.length} 行`);
  const trace = JSON.parse(lines[0]) as {
    rootSpanId: string;
    spans: CodeReviewSpan[];
    totalUsage: { inputTokens: number; outputTokens: number; costEstimate?: number };
  };

  const capabilities = trace.spans
    .filter((s) => s.kind === 'capability')
    .map((s) => s.name)
    .sort();
  assert(
    JSON.stringify(capabilities) === JSON.stringify(['security_scan', 'summarize']),
    `应有 subagent/skill 两个 capability span，实际 ${JSON.stringify(capabilities)}`,
  );
  const turns = trace.spans.filter((s) => s.kind === 'llm.turn').length;
  assert(turns === 8, `llm.turn 应 8 个（主 5 + 子 agent 2 + skill 1），实际 ${turns}`);

  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  const score = root?.events.find((e) => e.name === 'score')?.body as
    | { name?: string; value?: number }
    | undefined;
  assert(
    score?.name === 'fixture_coverage' && score?.value === 1,
    `根 span 应有 fixture_coverage=1 的 score 事件（种子问题全命中），实际 ${JSON.stringify(score)}`,
  );
  assert(
    trace.totalUsage.inputTokens === 25_600 && trace.totalUsage.outputTokens === 1_180,
    `totalUsage 口径变了：${JSON.stringify(trace.totalUsage)}`,
  );
  assert(
    trace.totalUsage.costEstimate === 0.002796,
    `priceOverrides 定价应算出 $0.002796，实际 ${JSON.stringify(trace.totalUsage.costEstimate)}`,
  );

  const report = JSON.parse(readFileSync(join(codeReviewDir, 'out', 'report.json'), 'utf8')) as {
    riskLevel?: string;
    findings?: unknown[];
  };
  assert(
    report.riskLevel === 'high' && report.findings?.length === 5,
    `report.json 应是 5 条发现 + high 定级，实际 ${JSON.stringify(report).slice(0, 200)}`,
  );

  return {
    demoExit: 0,
    spans: trace.spans.length,
    llmTurns: turns,
    capabilities,
    score: `${score!.name}=${score!.value}`, // 上面已断言存在
    costUsd: trace.totalUsage.costEstimate,
  };
}

const fake = await startFakeProvider();
let example: Awaited<ReturnType<typeof startExample>> | undefined;
try {
  ensureLinks();
  ensureObsPkgBuilt();
  buildExample();

  // freePort() 先 listen(0) 拿到再放掉，并行时有窗口被抢（EADDRINUSE）—— 换个端口重试
  let port = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3 && !example; attempt++) {
    port = await freePort();
    try {
      example = await startExample(port, fake.baseURL);
    } catch (e) {
      lastErr = e;
      if (!String(e).includes('EADDRINUSE')) throw e; // 非端口冲突的失败不重试
    }
  }
  if (!example) throw lastErr;
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-api-key': 'e2e-secret', 'content-type': 'application/json' };

  // —— 1) /healthz（不鉴权）——
  const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
  assert(health.ok === true, `healthz.ok=${health.ok}`);
  assert(health.draining === false, '刚起来不该是 draining');

  // —— 2) 鉴权缝：开了 API_KEY 时无凭据必须 401（README 明写）——
  const unauthorized = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assert(unauthorized.status === 401, `无凭据应 401，实际 ${unauthorized.status}`);

  // —— 3) 同步 /run：主 agent → 选能力（echo）→ 出结果 ——
  // 顺带带上 W3C `traceparent`（入站链路，C）：真实验证「头 → run 根 links」这条跨进程关联路径，
  // 而不只是单测里过一遍（e2e 的价值就在于走真 HTTP 栈、真装配）。
  const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const UP_SPAN = '00f067aa0ba902b7';
  const runRes = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { ...auth, traceparent: `00-${UP_TRACE}-${UP_SPAN}-01` },
    body: JSON.stringify({ prompt: '回显 ping' }),
  });
  assert(runRes.status === 200, `POST /run 应 200，实际 ${runRes.status}`);
  // /run 的响应是**扁平**形状（toHttpBody）：runId/status/stopReason/finalText/typed/trace/error
  const runBody = (await runRes.json()) as {
    status?: string;
    stopReason?: string;
    finalText?: string;
    trace?: { spans: Array<{ kind: string; links?: Array<{ traceId: string; spanId?: string }> }> };
  };
  assert(runBody.status === 'succeeded', `status=${runBody.status}`);
  assert(runBody.stopReason === 'end_turn', `stopReason=${runBody.stopReason}`);
  const rootLinks = runBody.trace?.spans.find((s) => s.kind === 'run')?.links;
  assert(
    rootLinks?.length === 1 && rootLinks[0].traceId === UP_TRACE && rootLinks[0].spanId === UP_SPAN,
    `traceparent 头应记成 run 根的一条 link，实际 ${JSON.stringify(rootLinks)}`,
  );
  assert(
    (runBody.finalText ?? '').includes('已回显'),
    `finalText 应是假端点给的收尾文本，实际 ${JSON.stringify(runBody.finalText)}`,
  );
  assert(
    fake.observed.toolResults.some((t) => t.includes('echo: ping')),
    `能力应真执行并回传 tool_result，实际收到 ${JSON.stringify(fake.observed.toolResults)}`,
  );
  const expectedMenu = ['echo', 'house_style', 'outline_writer', 'researcher'];
  const menu = [...fake.observed.menu].sort();
  assert(
    JSON.stringify(menu) === JSON.stringify(expectedMenu),
    `四类能力应全部进菜单，实际 ${JSON.stringify(menu)}`,
  );

  // —— 4) SSE 流式下发 ——
  const sseRes = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { ...auth, accept: 'text/event-stream' },
    body: JSON.stringify({ prompt: '回显 ping' }),
  });
  assert(sseRes.status === 200, `SSE 应 200，实际 ${sseRes.status}`);
  assert(
    (sseRes.headers.get('content-type') ?? '').includes('event-stream'),
    `SSE content-type=${sseRes.headers.get('content-type')}`,
  );
  const sseText = await sseRes.text();
  assert(sseText.includes('已回显'), `SSE 应下发了增量文本，实际 ${sseText.slice(0, 200)}`);

  // —— 5) 异步 /tasks + 幂等键去重 + 轮询到终态 ——
  const submit = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ input: '回显 ping', idempotencyKey: 'e2e-demo-1' }),
  });
  assert(submit.status === 202, `POST /tasks 应 202，实际 ${submit.status}`);
  const queued = (await submit.json()) as { taskId?: string };
  assert(typeof queued.taskId === 'string' && queued.taskId.length > 0, '202 应带 taskId');
  const done = await pollTask(base, queued.taskId as string, auth);
  assert(done.status === 'succeeded', `异步任务终态=${done.status}`);

  const again = (await (
    await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ input: '回显 ping', idempotencyKey: 'e2e-demo-1' }),
    })
  ).json()) as { taskId?: string };
  assert(again.taskId === queued.taskId, `同幂等键应去重返回既有记录，实际 ${again.taskId}`);

  // —— 6) /metrics（Prometheus 文本）——
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert(metrics.includes('agentia_runs_total'), '/metrics 应含 agentia_runs_total');
  assert(
    /agentia_capability_calls_total\{capability="[^"]+"\} [1-9]/.test(metrics),
    `能力级指标应有非零样本（证明 E2 在真链路里生效），实际片段 ${metrics.slice(0, 300)}`,
  );

  // —— 7) 优雅停机：SIGTERM → 排空后 exit 0 ——
  const code = await example.stop();
  assert(code === 0, `SIGTERM 后应 exit 0，实际 ${String(code)}`);
  assert(
    example.stdout().includes('[bye] 已排空退出'),
    `应走排空分支，实际尾部 ${example.stdout().slice(-300)}`,
  );

  // —— 8) code-review 示例：离线 demo 真跑 + 产物断言（见 verifyCodeReview）——
  const codeReview = verifyCodeReview();

  console.log('E2E-EXAMPLES PASS');
  console.log(
    JSON.stringify(
      {
        menu,
        providerCalls: fake.observed.calls,
        toolResultsReachedModel: fake.observed.toolResults.length,
        syncRunStatus: runBody.status,
        sseBytes: sseText.length,
        taskStatus: done.status,
        idempotentDedupe: again.taskId === queued.taskId,
        metricsHasCapabilitySamples: true,
        shutdownExitCode: code,
        codeReview,
      },
      null,
      2,
    ),
  );
} finally {
  if (example) await example.stop();
  await fake.close();
}
