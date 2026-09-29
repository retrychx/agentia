// soak-app：把**完整装配**放到**时间维度**下压 —— 补 `e2e-examples` 与 `e2e-soak` 之间那一格。
//
// 另两条各占一头，射程不重叠：
//   · `e2e-examples` 起的是完整装配，但每个断言都是「打一次、看结果」的**一轮**结构 ——
//     它回答不了「连跑十分钟之后任务还收得敛吗 / 幂等簿记还准吗 / 会不会攒出 stuck 任务」。
//   · `e2e-soak` 验的正是时间维度（连跑、故障注入、内存有界），但它的 import 面只有
//     `runAgent`（无 createApp / 容器 / store / scheduler / 恢复扫描）⇒ 它压不出**装配层**的病。
// 本脚本补的就是这个交集：让 `examples/complete` 装配出来的常驻服务（四类能力 +
// `SqliteTaskStore` + `AsyncRunner` + `Scheduler` + 优雅停机）在**持续负载 + 故障注入 +
// 进程猝死**下真跑一段，然后验「跑久了没坏」。
//
// 零成本、零网络：模型侧是**本地假端点**（与 e2e-examples / e2e-soak 同一手法 ——
// 替掉模型，绝不替掉被测的框架链路），只走 127.0.0.1。
//
// 注入的故障（按请求概率，种子固定 ⇒ 故障序列可复现）：
//   2%  429 + retry-after      —— 可重试，应被适配器/引擎重试吸收，**不该**变成任务失败
//   2%  SSE 流半途掐断         —— 截断 ⇒ 可重试，同上
//   3%  HTTP 400 invalid_request —— 不可重试，任务应以 `failed` **终态**收尾（不是卡住）
//   8%  正常路径先发 tool_call —— 让「选能力 → 回灌 → 收尾」的多回合链路一并承压
//
// 断言（每条都是「跑一轮」结构上抓不到的）：
//   ① 不丢：提交过的每个 taskId 都能查到，且**全部到达终态**（无 queued/running 残留）
//   ② 不重：拿一个已 succeeded 的幂等键重复提交 ⇒ 仍返回同一个 taskId（簿记在长跑后仍准）
//   ③ 猝死续跑：负载中途用假端点**闸门**把任务精确停在 running → SIGKILL → 同库重启必须打
//      `[boot] 续跑 N 个未完成任务`，且开闸后那些任务**真的跑完**（不是只打印了一行）
//   ④ 故障按比例落地（注入数 ≥ 1，证明注入机制没空转）且**失败率有界**（可重试故障被吸收了）
//   ⑤ 定时触发在时间维度上真在派（metrics 总 run 数 − 本脚本提交数 ≥ 期望 tick 的一半）
//   ⑥ 干净退出：SIGTERM 后 exit 0（没有句柄把进程吊住）
//   ⑦ DB 每任务字节数有界（用**线性**口径「字节/任务」—— 长档短档才可比，「30s 涨到 32MB」不是判据）
//
// ⚠️ ③ 走的是一段**临时关掉故障注入**的窗口（`pauseFaults()` / `resumeFaults()`）：它判的是
//    「恢复能不能把活干完」，不该由「续跑那次模型调用恰好抽中 3% 的不可重试 400」决定成败 ——
//    否则这条断言**概率性变红**（2026-09-29 实测：8s 档重复跑时抓到过一次假红，首跑绿是运气）。
//    窗口之后注入必须**重新开始**（有专门一条自证，防「忘了重开」让阶段 B 静默变成无故障负载）；
//    阶段 A / B 的几千个请求照旧吃满注入，注入机制的存活性由 ④ 在那里对账。
//
// 不并入 verify-all：与 `e2e-soak` 同档 —— 它是「跑多久」而不是「对不对」的验证，
// 默认 30s 已明显偏慢（verify-all 是每个 PR 都要跑的 8 步链）。手跑即可。
// 用法：npm run e2e:soak:app
// 调参：SOAK_APP_DURATION_MS=600000 SOAK_APP_CONCURRENCY=12 npm run e2e:soak:app
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DURATION_MS = Number(process.env.SOAK_APP_DURATION_MS ?? 30_000);
const CONCURRENCY = Number(process.env.SOAK_APP_CONCURRENCY ?? 6);
const TICK_MS = Number(process.env.SOAK_APP_TICK_MS ?? 1_000);
const SEED = Number(process.env.SOAK_APP_SEED ?? 42);
assert.ok(DURATION_MS >= 5_000, 'SOAK_APP_DURATION_MS 太短得不出任何结论（≥ 5s）');
assert.ok(CONCURRENCY >= 1 && CONCURRENCY <= 64, 'SOAK_APP_CONCURRENCY 应在 1..64');
assert.ok(TICK_MS >= 200, 'SOAK_APP_TICK_MS 太短（≥ 200ms）');

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const exampleDir = join(repoRoot, 'examples', 'complete');
const obsPkgDir = join(repoRoot, 'examples', 'observability');

/** 确定性 RNG（mulberry32）：种子固定 ⇒ **故障序列**可复现。按墙钟停表 ⇒
 *  总请求数/吞吐不可复现，别拿它们当回归基线（同 e2e-soak 的口径）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 闸门标记：body 里带它 = 这个请求要被**挂住**，用来把任务精确停在 running 态 */
const HOLD_MARK = 'SOAK_HOLD';

// —— 假端点（OpenAI 兼容 SSE + 故障注入 + 闸门）——

interface FaultStats {
  requests: number;
  f429: number;
  truncated: number;
  f400: number;
  toolPath: number;
  plain: number;
  held: number;
}

interface FakeProvider {
  baseURL: string;
  stats: FaultStats;
  /** 打开闸门：此后所有带标记的请求都挂住，直到 `release()` */
  hold(): void;
  /** 放行全部挂住的请求（写一个正常的 SSE 响应） */
  release(): void;
  /** 当前挂住几个（用来判定「任务真的停在 running 了」再动手 kill） */
  heldCount(): number;
  /** 临时关掉故障注入（**恢复窗口**用，默认是开的）。理由见 `main` 里 ③ 那段：
   *  那条断言要判的是「续跑能不能把活干完」，不该由 3%/请求的不可重试故障决定成败 —— 否则
   *  它会**概率性变红**（2026-09-29 实测：8s 档重复跑时抓到过一次假红）。 */
  pauseFaults(): void;
  /** 重新开启故障注入（与 `pauseFaults` 成对；阶段 B 的负载要靠它） */
  resumeFaults(): void;
  close: () => Promise<void>;
}

function sseChunks(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 一段正常的 SSE 回复（收尾用；arguments 分两片下发，与真端点同形） */
function plainReply(res: ServerResponse): void {
  sseChunks(res, [
    { id: 'chatcmpl-ok', model: 'soak-model', choices: [{ delta: { content: '收尾' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
  ]);
}

async function startFaultyProvider(rng: () => number): Promise<FakeProvider> {
  const stats: FaultStats = {
    requests: 0,
    f429: 0,
    truncated: 0,
    f400: 0,
    toolPath: 0,
    plain: 0,
    held: 0,
  };
  let holdEnabled = false;
  let faultsEnabled = true;
  const held: ServerResponse[] = [];

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

      // 闸门优先于一切故障注入：这是**测试的控制面**，不该被随机故障干扰
      if (holdEnabled && body.includes(HOLD_MARK)) {
        stats.held++;
        held.push(res);
        return;
      }

      // 恢复窗口：故障注入可被临时关掉（默认开）。只影响「排除运气成分」的那一小段，
      // 阶段 A / B 的负载照旧吃满故障 —— 注入机制本身由 ④ 在几千个请求上对账。
      if (!faultsEnabled) {
        stats.plain++;
        plainReply(res);
        return;
      }

      const r = rng();
      if (r < 0.02) {
        stats.f429++;
        res.writeHead(429, { 'retry-after': '0' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }));
        return;
      }
      if (r < 0.04) {
        stats.truncated++;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-x', model: 'soak-model', choices: [{ delta: { content: '半句' } }] })}\n\n`,
        );
        res.socket?.destroy();
        return;
      }
      if (r < 0.07) {
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

      const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
      if (!hasToolResult && r < 0.15) {
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
      plainReply(res);
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
    hold: () => {
      holdEnabled = true;
    },
    release: () => {
      holdEnabled = false;
      for (const res of held.splice(0)) plainReply(res);
    },
    heldCount: () => held.length,
    pauseFaults: () => {
      faultsEnabled = false;
    },
    resumeFaults: () => {
      faultsEnabled = true;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// —— 被测服务的准备与起停（手法与 e2e-examples 同源）——

/** 让示例的 `@migor/agentia` 解析到**仓库根**。两个理由必须自己建：
 *  ① CI 上示例目录的 `node_modules` 不存在（已 gitignore），不建直接起不来；
 *  ② 本地 `npm install` 出来的 `file:../..` 是**快照拷贝**（npm 拷贝而非软链），
 *     照它跑就等于跑「安装那天的框架」—— 对「验证当前工作区代码」的脚本是失真。 */
function ensureLinks(): void {
  const links: Array<[string, string]> = [
    [join(exampleDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    [join(exampleDir, 'node_modules', '@migor', 'agentia-observability'), obsPkgDir],
  ];
  for (const [link, target] of links) {
    let current: string | null = null;
    try {
      current = realpathSync(link);
    } catch {
      current = null; // 不存在
    }
    if (current === realpathSync(target)) continue;
    rmSync(link, { recursive: true, force: true });
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(target, link, 'dir');
  }
}

/** 本地小包 `@migor/agentia-observability` 的 main 指向 dist —— 没有就先构建（离线、几秒） */
function ensureObsPkgBuilt(): void {
  if (existsSync(join(obsPkgDir, 'dist', 'index.js'))) return;
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: obsPkgDir,
    stdio: 'inherit',
  });
}

/** 按示例自己的构建脚本构建（`tsc -p tsconfig.json && node scripts/copy-assets.mjs`）。
 *  用 dist 而不是 tsx 跑 src：node 就是应用进程本身（SIGKILL/SIGTERM 直达信号处理器，
 *  不经过 tsx 的包装进程），且验的是**部署形态**的产物。 */
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

interface ServiceHandle {
  port: number;
  stdout: () => string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

async function startService(
  dbPath: string,
  fakeBaseURL: string,
  tickMs: number,
): Promise<ServiceHandle> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '0', // 由系统分配端口，从就绪日志里读
    AGENTIA_DB: dbPath, // **不用 :memory:** —— 要看 DB 随时间的体量，且续跑要同一份库
    OPENAI_BASE_URL: fakeBaseURL, // 走上示例里那段「注入 model client」的缝
    OPENAI_API_KEY: 'fake-key',
    AGENTIA_MODEL: 'fake-model',
    AGENTIA_SAMPLE_RATE: '1',
    AGENTIA_CHECK_INTERVAL_MS: String(tickMs), // 打开定时触发 —— 它是最容易在长跑里攒东西的一条
    NODE_ENV: 'soak',
  };
  // 剥掉模型侧环境：本机 export 过 ANTHROPIC_* 时，示例的 provider 选择会随环境漂移
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_MODEL;
  // 不设 API_KEY ⇒ 不开鉴权。本脚本验的是「长时间跑会不会坏」，鉴权另由 e2e-examples 钉住。

  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: exampleDir,
    env,
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

  const deadline = Date.now() + 30_000;
  let port: number | undefined;
  while (port === undefined) {
    const m = /\[boot\] listening on :(\d+)/.exec(out);
    if (m) {
      port = Number(m[1]);
    } else if (child.exitCode !== null) {
      throw new Error(
        `示例进程启动即退出（code=${child.exitCode}）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    } else if (Date.now() > deadline) {
      throw new Error(`等服务就绪超时（30s）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    } else {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return { port, stdout: () => out, child, exited };
}

// —— 负载 ——

/**
 * `submitted` / `byKey` **不在这里返回** —— 它们跨阶段累积，由调用方持有并传进来
 * （返回一份不可变的副本会让人误以为可以拿它当唯一真源）。
 */
interface LoadResult {
  syncRuns: number;
  /** 同步 run 里 `status !== 'succeeded'` 的次数（含被故障杀死的）。⚠️ 必须一起统计：
   *  不可重试故障是**按请求**注入的，而请求同时来自同步 run 与异步任务 ⇒ 只对账异步
   *  那一半会得出「注入数 > 失败数」的假结论（2026-09-29 首跑实测：129 vs 267）。 */
  syncFailed: number;
  /** 预期的异常（进程被 SIGKILL 时在飞请求会 ECONNRESET/ECONNREFUSED）—— 不算失败 */
  interruptions: number;
}

/**
 * 打一段持续负载：一半 workers 提交异步任务、一半打同步 `/run`。
 * 到点各自停 —— **不做「跑固定轮数」**，因为本脚本要的就是「时间维度」，轮数是墙钟的结果。
 */
async function runLoad(opts: {
  base: string;
  durationMs: number;
  concurrency: number;
  tag: string;
  submitted: string[];
  byKey: Map<string, string>;
}): Promise<LoadResult> {
  const { base, durationMs, concurrency, tag, submitted, byKey } = opts;
  const syncRuns = { n: 0 };
  const syncFailed = { n: 0 };
  const interruptions = { n: 0 };
  const endAt = Date.now() + durationMs;

  const submitOne = async (n: number): Promise<void> => {
    // 幂等键**唯一**：本段负载要的是「每笔都真跑」，去重交给下面的专项断言去验
    const key = `${tag}-${n}`;
    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '回显 ping', idempotencyKey: key }),
    });
    assert.equal(res.status, 202, `POST /tasks 应 202，实际 ${res.status}`);
    const rec = (await res.json()) as { taskId?: string };
    assert.ok(typeof rec.taskId === 'string' && rec.taskId.length > 0, '202 应带 taskId');
    submitted.push(rec.taskId);
    byKey.set(key, rec.taskId);
  };

  const worker = async (id: number): Promise<void> => {
    let n = 0;
    while (Date.now() < endAt) {
      n++;
      try {
        if ((id + n) % 2 === 0) {
          await submitOne(id * 1_000_000 + n);
        } else {
          const res = await fetch(`${base}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: '回显 ping' }),
          });
          assert.equal(res.status, 200, `POST /run 应 200，实际 ${res.status}`);
          const body = (await res.json()) as { status?: string };
          syncRuns.n++;
          if (body.status !== 'succeeded') syncFailed.n++;
        }
      } catch (e) {
        // 进程猝死阶段的在飞请求必然是网络错 —— 这是**预期内**的中断，不是被测代码的失败。
        // ⚠️ 但要计数并打印（允许 ≠ 不看）。
        const msg = (e as Error).message;
        if (/ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|aborted/i.test(msg)) {
          interruptions.n++;
        } else {
          throw e;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  return { syncRuns: syncRuns.n, syncFailed: syncFailed.n, interruptions: interruptions.n };
}

/** `/metrics` 里的 run 总数（Prometheus counter；带不带 label 都收） */
async function readRunTotal(base: string): Promise<number> {
  const text = await (await fetch(`${base}/metrics`)).text();
  let sum = 0;
  const re = /^agentia_runs_total(?:\{[^}]*\})?\s+(\d+)$/gm;
  for (const m of text.matchAll(re)) sum += Number(m[1]);
  return sum;
}

/** 轮询任务到终态。终态 = 不在 {queued, running, suspended} 里的任何一个 */
async function pollUntilTerminal(base: string, taskId: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const res = await fetch(`${base}/tasks/${taskId}`);
    if (res.status === 404) return 'NOT_FOUND';
    const rec = (await res.json()) as { status?: string };
    const status = rec.status ?? 'UNKNOWN';
    if (status !== 'queued' && status !== 'running' && status !== 'suspended') return status;
    if (Date.now() > deadline) return status; // 交给调用方判红（把「超时未终态」原样暴露出来）
    await new Promise((r) => setTimeout(r, 50));
  }
}

// —— 主流程 ——

async function main(): Promise<void> {
  const rng = mulberry32(SEED);
  const workDir = mkdtempSync(join(tmpdir(), 'agentia-soak-app-'));
  const dbPath = join(workDir, 'agentia.db');

  ensureLinks();
  ensureObsPkgBuilt();
  buildExample();

  const provider = await startFaultyProvider(rng);
  const submitted: string[] = [];
  const byKey = new Map<string, string>();
  let service: ServiceHandle | undefined;

  try {
    service = await startService(dbPath, provider.baseURL, TICK_MS);
    const base = `http://127.0.0.1:${service.port}`;
    const phaseA = Math.floor(DURATION_MS / 2);

    console.log(
      `soak-app 开跑：${CONCURRENCY} 并发 × ${DURATION_MS / 1000}s（定时 ${TICK_MS}ms），种子 ${SEED}`,
    );

    // —— 阶段 A：持续负载 ——
    const a = await runLoad({
      base,
      durationMs: phaseA,
      concurrency: CONCURRENCY,
      tag: 'a',
      submitted,
      byKey,
    });
    const runsA = await readRunTotal(base);
    console.log(
      `阶段 A：提交 ${submitted.length} 个异步任务、${a.syncRuns} 次同步 run，metrics runs=${runsA}`,
    );

    // —— 猝死：先把几个任务用闸门**精确停在 running**，再 SIGKILL ——
    provider.hold();
    const holdKeys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const key = `hold-${i}`;
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: `${HOLD_MARK} 停在 running 态`, idempotencyKey: key }),
      });
      assert.equal(res.status, 202, `闸门任务 POST /tasks 应 202，实际 ${res.status}`);
      const rec = (await res.json()) as { taskId?: string };
      assert.ok(typeof rec.taskId === 'string', '闸门任务应带 taskId');
      submitted.push(rec.taskId);
      byKey.set(key, rec.taskId);
      holdKeys.push(key);
    }
    // 等假端点真收到并挂住这些请求 —— 这才等于「任务确实停在 running」
    const holdDeadline = Date.now() + 10_000;
    while (provider.heldCount() < 3) {
      assert.ok(
        Date.now() < holdDeadline,
        `等闸门挂住 3 个请求超时（当前 ${provider.heldCount()} 个）—— 闸门没生效，` +
          '后面的续跑断言会在空转',
      );
      await new Promise((r) => setTimeout(r, 25));
    }
    console.log(`闸门已挂住 ${provider.heldCount()} 个请求（任务停在 running）→ SIGKILL`);
    service.child.kill('SIGKILL');
    const killedCode = await service.exited;
    assert.notEqual(killedCode, 0, 'SIGKILL 后不应干净退出（退出码应为 null 或非 0）');
    const beforeRestart = submitted.length;

    // —— 阶段 B：同库重启，续跑必须发生 ——
    provider.release(); // 开闸：让续跑的那次模型调用能跑完
    // ⚠️ 这一段**临时关掉故障注入**（**只**这一段，见 FakeProvider.pauseFaults）：
    //    ③ 判的是「恢复能不能把活干完」，不该由「续跑那次模型调用恰好抽中 3% 的不可重试
    //    400」决定成败 —— 那会让这条断言**概率性变红**（2026-09-29 实测：8s 档重复跑时
    //    抓到过一次假红；30s 首跑绿是运气，不是保障）。
    //    注入机制本身不靠这一段验：阶段 A / B 的几千个请求照旧吃满，由 ④ 对账。
    provider.pauseFaults();
    service = await startService(dbPath, provider.baseURL, TICK_MS);
    const base2 = `http://127.0.0.1:${service.port}`;
    const resumedMatch = /\[boot\] 续跑 (\d+) 个未完成任务/.exec(service.stdout());
    assert.ok(
      resumedMatch,
      `重启应打印续跑行，实际 stdout 开头：${service.stdout().slice(0, 400)}`,
    );
    const resumed = Number(resumedMatch[1] ?? '0');
    assert.ok(resumed >= 1, `续跑数应 ≥ 1（至少那 3 个闸门任务），实际 ${resumed}`);

    // —— ③ 猝死续跑：闸门任务必须**真跑完**（不只是打印了一行）——
    for (const key of holdKeys) {
      const id = byKey.get(key);
      assert.ok(id !== undefined, `闸门键 ${key} 没有 taskId`);
      const st = await pollUntilTerminal(base2, id, 60_000);
      assert.equal(st, 'succeeded', `闸门任务 ${key}（${id}）续跑后应 succeeded，实际 ${st}`);
    }
    provider.resumeFaults(); // 恢复窗口结束 —— 阶段 B 的负载照旧吃满故障注入
    const faultsAtResume = provider.stats.f429 + provider.stats.truncated + provider.stats.f400;
    console.log(
      `续跑：重启前 ${beforeRestart} 个任务在库，续跑 ${resumed} 个，闸门任务均已跑完` +
        '（恢复窗口内无故障注入）→ 重开注入，继续压阶段 B',
    );

    const b = await runLoad({
      base: base2,
      durationMs: DURATION_MS - phaseA,
      concurrency: CONCURRENCY,
      tag: 'b',
      submitted,
      byKey,
    });
    const runsB = await readRunTotal(base2);
    console.log(
      `阶段 B：累计提交 ${submitted.length} 个异步任务、${b.syncRuns} 次同步 run，metrics runs=${runsB}`,
    );

    // —— ① 不丢：每个提交过的任务都要能查到、且都到终态 ——
    const statuses = new Map<string, number>();
    const stuck: string[] = [];
    for (const id of submitted) {
      const st = await pollUntilTerminal(base2, id, 60_000);
      statuses.set(st, (statuses.get(st) ?? 0) + 1);
      if (st === 'queued' || st === 'running' || st === 'suspended' || st === 'NOT_FOUND') {
        stuck.push(`${id}:${st}`);
      }
    }
    assert.deepEqual(
      stuck,
      [],
      `${stuck.length} 个任务没到终态（stuck/丢失）：${stuck.slice(0, 5).join(', ')}`,
    );
    const tally = [...statuses].map(([s, n]) => `${s}=${n}`).join(' ');
    console.log(`任务终态：${tally}（合计 ${submitted.length}）`);

    // —— ② 不重：拿一个已 succeeded 的键重复提交 ⇒ 必须仍是同一个 taskId ——
    let dupKey: string | undefined;
    for (const [key, id] of byKey) {
      const rec = (await (await fetch(`${base2}/tasks/${id}`)).json()) as { status?: string };
      if (rec.status === 'succeeded') {
        dupKey = key;
        break;
      }
    }
    assert.ok(dupKey !== undefined, '一个 succeeded 的任务都没有 —— 负载/假端点都坏了，断言无意义');
    const firstId = byKey.get(dupKey);
    for (let i = 0; i < 3; i++) {
      const again = (await (
        await fetch(`${base2}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: '回显 ping', idempotencyKey: dupKey }),
        })
      ).json()) as { taskId?: string };
      assert.equal(
        again.taskId,
        firstId,
        `同幂等键（${dupKey}）重复提交应返回既有 taskId，实际 ${again.taskId}`,
      );
    }
    console.log(`幂等：键 ${dupKey} 重复提交 3 次均返回 ${firstId}`);

    // —— ③ 猝死续跑已在恢复窗口里判过（见阶段 B 开头）——

    // —— ④ 故障按比例落地 + 失败率有界 ——
    // ⚠️ 口径：不可重试故障是**按请求**注入的，而请求同时来自**异步任务**与**同步 run**
    //    ⇒ 两边都要统计，只对账一边会得出「注入数 > 失败数」的假结论（首跑实测 129 vs 267）。
    //    闸门挂起的请求不经过故障注入（闸门优先），所以它们不在这笔账里。
    const nonRetryable = provider.stats.f400;
    const asyncFailed = statuses.get('failed') ?? 0;
    const failedTotal = asyncFailed + a.syncFailed + b.syncFailed;
    const myRuns = submitted.length + a.syncRuns + b.syncRuns;
    assert.ok(
      provider.stats.f429 + provider.stats.truncated > 0,
      '可重试故障一次都没注入 —— 注入机制坏了，后面的断言都在空转',
    );
    assert.ok(nonRetryable > 0, '不可重试故障一次都没注入 —— 同上');
    // 「恢复窗口忘了关」也要能被发现：窗口之后必须**重新开始**注入。否则 `resumeFaults()`
    // 被删掉时阶段 B 会静默变成无故障负载，而前面的断言照样全绿（注入只来自阶段 A）。
    assert.ok(
      provider.stats.f429 + provider.stats.truncated + provider.stats.f400 > faultsAtResume,
      '恢复窗口之后一次故障都没再注入 —— pauseFaults/resumeFaults 没成对（阶段 B 在无故障下空跑）',
    );
    const slack = Math.max(3, Math.ceil(provider.stats.requests * 0.002));
    // ⚠️ 这里量的是**量级**，不是逐笔 —— 与 `e2e-soak` 的判据刻意不同：
    //   单点 soak 里「一个不可重试故障恰好杀死一个 run」是恒等式，但到了**完整装配**
    //   它就不成立了。两半的依据不同，别混写：
    //   ① **代码依据**（不是从「对账已经很接近」那个读数反推的）—— 子能力（子 agent / skill）的失败
    //      由能力层包成 `is_error` 的 tool_result 回主循环，**不杀 run**（`src/engine/loop.ts`
    //      的「子循环超限…由能力层包成 is_error 回主循环」、`src/engine/spec.ts` 的
    //      「超时该条 tool_result 记 is_error，不杀 run」）。本例的装配里**真有**子 agent 与
    //      skill（`examples/complete/src/registry.ts` 导入 Researcher / OutlineWriter），
    //      而假端点服务的是**所有**模型调用 ⇒ 打进子流程的 400 不必然变成一次 run 失败。
    //   ② **实测依据** —— 猝死窗口内被中断、随后续跑成功的任务，会把那次失败从终态里洗掉。
    //   （2026-09-29 实测：同一次运行里 335 vs 336，已经很接近。但接近**不等于**恒等 ——
    //   ① 给出的代码依据说明它**本来就没有恒等式保证**，首跑只是恰好贴合 ⇒ **不该断言恒等式**，
    //   否则负载一换就假红。）
    //   所以：下界防「故障被静默吞」（真吞了会趋近 0），上界防「重试失效」。
    const lower = Math.max(1, Math.floor(nonRetryable / 2));
    assert.ok(
      failedTotal >= lower,
      `失败总数 ${failedTotal}（异步 ${asyncFailed} + 同步 ${a.syncFailed + b.syncFailed}）` +
        `低于不可重试注入数 ${nonRetryable} 的一半（下限 ${lower}）—— 故障被静默吞了（比全挂更可怕）`,
    );
    assert.ok(
      failedTotal <= nonRetryable + slack,
      `失败总数 ${failedTotal} 超出不可重试注入数 ${nonRetryable} 太多（容差 ${slack}）—— ` +
        '重试没在吸收可重试故障（429/截断），或出现了计划外的失败类别',
    );
    console.log(
      `故障对账：失败总数 ${failedTotal}（异步 ${asyncFailed} + 同步 ${a.syncFailed + b.syncFailed}）` +
        ` vs 不可重试注入 ${nonRetryable}、请求总数 ${provider.stats.requests}`,
    );

    // —— ⑤ 定时触发在时间维度上真在派 ——
    const expectedTicks = Math.floor(DURATION_MS / TICK_MS);
    const scheduledRuns = runsA + runsB - myRuns;
    assert.ok(
      scheduledRuns >= Math.floor(expectedTicks / 2),
      `定时触发派的 run 只有 ${scheduledRuns} 个（期望约 ${expectedTicks} 个，下限一半）—— ` +
        `总 runs=${runsA + runsB}、本脚本提交=${myRuns}`,
    );
    console.log(
      `定时触发：约 ${scheduledRuns} 个 run 来自 scheduler（本脚本提交 ${myRuns}，期望 tick ${expectedTicks}）`,
    );

    // —— ⑥ 干净退出：SIGTERM 后 exit 0（句柄泄漏会把进程吊住）——
    service.child.kill('SIGTERM');
    const byeCode = await Promise.race([
      service.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
    ]);
    assert.equal(byeCode, 0, `SIGTERM 后应 exit 0，实际 ${String(byeCode)}（null = 被句柄吊住）`);

    const dbBytes = statSync(dbPath).size;
    // ⑦ DB 增长有界：长期运行最先暴露的问题之一是「**每单位工作的写入量悄悄放大**」——
    //    它不是某个断言失败，而是线性系数变了（比如某条路径开始重复落库）。所以量的是
    //    「每任务字节数」这个**线性口径**（长档短档可比）；绝对字节数随负载量走，不能当基线。
    //    ⚠️ 它只抓「放大」，不抓「本来就大」：示例默认 `AGENTIA_SAMPLE_RATE=1` 全量留 trace，
    //    写入本来就重（2026-09-29 首跑基线 ≈ 9.1KB/任务，30s 就 32MB）——生产按量调采样。
    const bytesPerTask = dbBytes / Math.max(1, submitted.length);
    assert.ok(
      bytesPerTask <= 64 * 1024,
      `每任务写入 ${(bytesPerTask / 1024).toFixed(1)}KB` +
        `（DB ${(dbBytes / 1024 / 1024).toFixed(1)}MB / ${submitted.length} 任务）` +
        '—— 超出 64KB/任务的量级上限，疑似写入放大（长跑会线性放大成磁盘问题）',
    );
    console.log(
      `DB：${(dbBytes / 1024 / 1024).toFixed(1)}MB，每任务 ${(bytesPerTask / 1024).toFixed(1)}KB`,
    );
    console.log(
      `\nOK —— soak-app 全过：${submitted.length} 个任务全部终态（${tally}），` +
        `幂等簿记准，猝死续跑 ${resumed} 个且都跑完，中断 ${a.interruptions + b.interruptions} 次（预期内），` +
        `DB ${(dbBytes / 1024).toFixed(0)}KB，SIGTERM 干净退出。`,
    );
    console.log(
      `假端点：requests=${provider.stats.requests} 429=${provider.stats.f429} ` +
        `截断=${provider.stats.truncated} 400=${provider.stats.f400} ` +
        `工具路径=${provider.stats.toolPath} 闸门挂起=${provider.stats.held}`,
    );
  } finally {
    provider.release();
    if (service !== undefined && service.child.exitCode === null) {
      service.child.kill('SIGKILL');
    }
    await provider.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
