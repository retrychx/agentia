// gRPC 宿主端到端验证（`npm run e2e` 第四步）：`examples/grpc-host` 真构建、真起服务，
// 再用**示例自带的那份 gRPC 客户端**跑四个 RPC。
//
// 为什么要有这一条：usage-guide 的「gRPC 宿主」配方与 `examples/grpc-host/README.md` 都指着
// 这份示例说「照这个抄」，但示例此前只在 `typecheck:tests` 里被编译过 —— 没有任何门禁真跑过它。
// 这条把「文档承诺可跑」变成「门禁证明可跑」，并顺手守住四处**框架语义**（换个宿主最容易丢的
// 也正是这四处）：
//   ① deadline 到期 → 服务端的 run **真被 abort**（trace 里是 error.type=aborted，不是跑完了）
//   ② metadata traceparent → run 根 links（跨进程关联在 gRPC 这个宿主上同样成立）
//   ③ session_id → 多轮 run 共享历史（第二次请求给模型的消息确实变多了）
//   ④ metadata idempotency-key → at-least-once 去重（同 key 重投返回同一个 taskId）
//
// 不联网：模型侧是本脚本内置的假 Anthropic 端点（真 SSE，逐事件下发），只走 127.0.0.1。
// 运行：npm run e2e（先 build 框架，再 tsx 跑本脚本）
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import type { GrpcAgentClient } from '../examples/grpc-host/src/client.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`E2E GRPC FAIL: ${msg}`);
};

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const exampleDir = join(repoRoot, 'examples', 'grpc-host');

/** trace 里本脚本要断言的最小形状（只声明用到的字段） */
interface TraceSpan {
  spanId: string;
  kind: string;
  name: string;
  status: string;
  error?: { type: string; message: string };
  links?: Array<{ traceId: string; spanId?: string }>;
  attributes: Record<string, string | number | boolean>;
}
interface TraceLine {
  traceId: string;
  rootSpanId: string;
  status: string;
  spans: TraceSpan[];
  totalUsage: { inputTokens: number; outputTokens: number };
}

// ── 假 Anthropic 端点（真 SSE，逐事件）──────────────────────────────────────────
//
// 剧本（够走完「主 agent 选能力 → 拿到结果 → 收尾」一个完整往返）：
// - 还没有 tool_result ⇒ 回 `echo` 的 tool_use，`input_json` 分两片；
// - 有 tool_result ⇒ 回收尾文本，**故意分两片**（`grpc` + `-ok`）——
//   流式 RPC 那条断言才有意义：收到 ≥2 个增量帧，而不是一坨。
//
// 可变 `delayMs`：deadline 那一条要服务端「正卡在模型调用上」时 deadline 到期。
interface FakeProviderObserved {
  /** 首次请求里模型看到的菜单（证明四类能力真装配上了，没被换宿主丢掉） */
  menu: string[];
  /** 每次请求带的消息条数（证明 session 历史真的拼进去了） */
  messageCounts: number[];
}

async function startFakeProvider(): Promise<{
  baseURL: string;
  observed: FakeProviderObserved;
  setDelay: (ms: number) => void;
  close: () => Promise<void>;
}> {
  const observed: FakeProviderObserved = { menu: [], messageCounts: [] };
  let delayMs = 0;

  // 客户端 abort 之后这个连接已经没人要了：写入会失败，但那不是脚本的错
  const writeEvent = (res: ServerResponse, event: string, data: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const messageStart = {
    type: 'message_start',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
  const finish = (stopReason: string, outputTokens: number) =>
    [
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ] as const;

  const respond = (res: ServerResponse, hasToolResult: boolean): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    writeEvent(res, 'message_start', messageStart);
    if (!hasToolResult) {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_fake_1', name: 'echo', input: {} },
      });
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"text":' },
      });
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"ping"}' },
      });
      for (const [event, data] of finish('tool_use', 4)) writeEvent(res, event, data);
    } else {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      for (const piece of ['grpc', '-ok']) {
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        });
      }
      for (const [event, data] of finish('end_turn', 3)) writeEvent(res, event, data);
    }
    if (!res.writableEnded) res.end();
  };

  const server: Server = createServer((req, res) => {
    res.on('error', () => undefined); // 连接被 abort 后的写入失败
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        tools?: Array<{ name?: string }>;
        messages?: Array<{ content?: unknown }>;
      };
      const messages = parsed.messages ?? [];
      if (observed.messageCounts.length === 0) {
        for (const t of parsed.tools ?? []) if (t.name) observed.menu.push(t.name);
      }
      observed.messageCounts.push(messages.length);
      // Anthropic 协议：tool_result 是 user 消息 content 里的一个 block
      const hasToolResult = messages.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result'),
      );
      if (delayMs > 0) setTimeout(() => respond(res, hasToolResult), delayMs);
      else respond(res, hasToolResult);
    });
    req.on('error', () => undefined);
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
    setDelay: (ms) => {
      delayMs = ms;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * 让示例的 `import '@migor/agentia'` 可解析（与 `scripts/e2e-examples.ts` 同一手法：软链回仓库根）。
 * CI 上示例目录里的 node_modules 不存在（已 gitignore）；本地 `npm install` 装出来的
 * `file:../..` 是**快照拷贝**，改了 dist 不生效 —— 对「验证当前代码」的脚本是失真。
 */
function ensureLinks(): void {
  const link = join(exampleDir, 'node_modules', '@migor', 'agentia');
  let current: string | null = null;
  try {
    current = realpathSync(link);
  } catch {
    current = null; // 不存在
  }
  if (current === realpathSync(repoRoot)) return;
  rmSync(link, { recursive: true, force: true });
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(repoRoot, link, 'dir');
}

/** 按示例自己的构建脚本构建（验「示例能不能构建」，同时拿到部署形态的产物） */
function buildExample(): void {
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
}

/**
 * 起示例进程（`node dist/main.js`，即 README 的 `npm run serve`），等它的就绪日志。
 *
 * PORT=0 + 解析日志里的**实际**端口：先探空闲端口再交给别人 bind，两步之间会被抢
 * （e2e-deploy 的 EADDRINUSE flake 就是这么来的）—— 这里由服务自己分配，没有那个窗口。
 */
async function startExample(
  fakeBaseURL: string,
  traceFile: string,
): Promise<{
  port: number;
  stdout: () => string;
  stop: () => Promise<number | null>;
}> {
  const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: '0',
      // 部署路径的关键缝：**默认 Anthropic client** 由 ANTHROPIC_BASE_URL 接管（不改代码换端点）
      ANTHROPIC_BASE_URL: fakeBaseURL,
      ANTHROPIC_API_KEY: 'fake-key',
      AGENTIA_MODEL: 'fake-model',
      AGENTIA_TRACE_FILE: traceFile,
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

  const deadline = Date.now() + 30_000;
  let port: number | undefined;
  while (port === undefined) {
    const m = /\[boot\] listening on 127\.0\.0\.1:(\d+)/.exec(out);
    if (m) port = Number(m[1]);
    else if (child.exitCode !== null)
      throw new Error(`示例进程启动即退出（code=${child.exitCode}）\n${out}\n${err}`);
    else if (Date.now() > deadline)
      throw new Error(`等示例就绪超时（30s）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    else await new Promise((r) => setTimeout(r, 25));
  }

  return {
    port,
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

/** 读已落盘的 trace 行（sink 在 run 结束才写，所以一律配 waitFor 用） */
function readTraces(file: string): TraceLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TraceLine);
}

/** 轮询直到取到值（就绪预算是给足的：验的是「最终会成立」，不是「多快成立」） */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`等超时（${timeoutMs}ms）：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const fake = await startFakeProvider();
const workDir = mkdtempSync(join(tmpdir(), 'agentia-grpc-e2e-'));
const traceFile = join(workDir, 'trace.jsonl');
let example: Awaited<ReturnType<typeof startExample>> | undefined;
try {
  ensureLinks();
  buildExample();
  example = await startExample(fake.baseURL, traceFile);
  const address = `127.0.0.1:${example.port}`;
  // 用示例自带的那份客户端（走源码：类型是真的，且客户端与验证共享同一份实现）
  const clientModule = (await import(`${exampleDir}/src/client.ts`)) as {
    makeGrpcClient: (address: string) => GrpcAgentClient;
  };
  const client = clientModule.makeGrpcClient(address);

  // —— 1) 一元 Run：能力真跑、trace 真记、入站 traceparent 真落成 run 根 link ——
  const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const UP_SPAN = '00f067aa0ba902b7';
  const unary = await client.run('回显 ping', { traceparent: `00-${UP_TRACE}-${UP_SPAN}-01` });
  assert(unary.status === 'succeeded', `一元 run status=${unary.status} error=${unary.error}`);
  assert(unary.stopReason === 'end_turn', `stopReason=${unary.stopReason}`);
  assert(
    unary.finalText.includes('grpc-ok'),
    `finalText 应是假端点给的收尾文本，实际 ${JSON.stringify(unary.finalText)}`,
  );
  assert(unary.runId.length > 0, 'runId 应非空（== traceId）');
  assert(unary.spans >= 2, `调用树应至少含 run 根 + llm.turn，实际 ${unary.spans}`);
  assert(unary.inputTokens > 0, `token 记账应经宿主透传，实际 inputTokens=${unary.inputTokens}`);
  assert(
    JSON.stringify([...fake.observed.menu].sort()) === JSON.stringify(['echo']),
    `能力应进模型菜单（换宿主不丢能力），实际 ${JSON.stringify(fake.observed.menu)}`,
  );

  const rootOf = (t: TraceLine): TraceSpan | undefined =>
    t.spans.find((s) => s.spanId === t.rootSpanId);
  const unaryTrace = await waitFor(
    () => readTraces(traceFile).find((t) => t.traceId === unary.runId),
    `一元 run 的 trace 落盘（runId=${unary.runId}）`,
  );
  assert(unaryTrace.status === 'ok', `跑成功的 run trace.status=${unaryTrace.status}`);
  const links = rootOf(unaryTrace)?.links;
  assert(
    links?.length === 1 && links[0].traceId === UP_TRACE && links[0].spanId === UP_SPAN,
    `metadata traceparent 应记成 run 根的一条 link，实际 ${JSON.stringify(links)}`,
  );

  // —— 2) session_id：第二轮请求必须带上第一轮的历史 ——
  const before = fake.observed.messageCounts.length;
  const firstRun = await client.run('第一句', { sessionId: 'e2e-session' });
  const secondRun = await client.run('第二句', { sessionId: 'e2e-session' });
  assert(
    fake.observed.messageCounts[before + 2] > fake.observed.messageCounts[before],
    `同 session 的第二轮应把历史拼进请求，实际消息条数 ${JSON.stringify(fake.observed.messageCounts)}`,
  );
  const sessionTrace = await waitFor(
    () => readTraces(traceFile).find((t) => t.traceId === secondRun.runId),
    '带 session 的第二条 run trace',
  );
  assert(
    rootOf(sessionTrace)?.attributes['session.id'] === 'e2e-session',
    `session 标识应落 run 根 attribute session.id，实际 ${JSON.stringify(rootOf(sessionTrace)?.attributes)}`,
  );
  assert(
    firstRun.status === 'succeeded' && secondRun.status === 'succeeded',
    `带 session 的两轮都应成功，实际 ${firstRun.status} / ${secondRun.status}`,
  );

  // —— 3) 服务端流：增量逐帧 + 末帧整份结果（对应 SSE 的 text.delta / run.end）——
  const streamed = await client.runStream('回显 ping');
  assert(streamed.deltas.length >= 2, `流式应逐帧下发，实际 ${streamed.deltas.length} 帧`);
  assert(
    streamed.deltas.join('') === 'grpc-ok',
    `增量拼起来应是收尾文本，实际 ${JSON.stringify(streamed.deltas)}`,
  );
  assert(streamed.end?.status === 'succeeded', `末帧 status=${streamed.end?.status}`);

  // —— 4) 异步：Submit + GetTask，且同 idempotency-key 重投不重复执行 ——
  const taskId = await client.submit('回显 ping', { idempotencyKey: 'e2e-grpc-1' });
  const again = await client.submit('回显 ping', { idempotencyKey: 'e2e-grpc-1' });
  assert(
    taskId === again,
    `at-least-once 去重：同 key 应返回同一个 taskId，实际 ${taskId} / ${again}`,
  );
  const done = await waitFor(
    async () => {
      const rec = await client.getTask(taskId);
      return rec.status === 'queued' || rec.status === 'running' ? undefined : rec;
    },
    `任务 ${taskId} 到终态`,
    20_000,
  );
  assert(done.status === 'succeeded', `异步任务终态=${done.status} error=${done.error}`);
  assert(done.runId.length > 0, '任务终态应回填 runId');
  const missing = await client.getTask('task-does-not-exist').then(
    () => undefined,
    (e: grpc.ServiceError) => e.code,
  );
  assert(
    missing === grpc.status.NOT_FOUND,
    `查不存在的 taskId 应回 NOT_FOUND(${grpc.status.NOT_FOUND})，实际 ${String(missing)}`,
  );

  // —— 5) deadline 到期：客户端拿到 DEADLINE_EXCEEDED，**服务端的 run 必须真被 abort** ——
  //    模型侧卡 800ms，客户端 deadline 只给 60ms —— 若宿主没把 deadline 接进 AbortSignal，
  //    这次 run 会照跑完（token 照烧），trace 里也就不会出现 aborted。
  const tracesBefore = readTraces(traceFile).length;
  fake.setDelay(800);
  const startedAt = Date.now();
  const deadlineCode = await client.run('回显 ping', { deadlineMs: 60 }).then(
    () => undefined,
    (e: grpc.ServiceError) => e.code,
  );
  const elapsed = Date.now() - startedAt;
  fake.setDelay(0);
  assert(
    deadlineCode === grpc.status.DEADLINE_EXCEEDED,
    `超时应回 DEADLINE_EXCEEDED(${grpc.status.DEADLINE_EXCEEDED})，实际 ${String(deadlineCode)}`,
  );
  assert(elapsed < 800, `应在 deadline 附近就返回，实际等了 ${elapsed}ms（像在等模型跑完）`);
  const abortedTrace = await waitFor(
    () =>
      readTraces(traceFile)
        .slice(tracesBefore)
        .find((t) => rootOf(t)?.error?.type === 'aborted'),
    '被 abort 的那条 trace（服务端 run 真被中止，而不是跑完）',
  );
  assert(
    abortedTrace.status === 'error',
    `被中止的 run trace.status 应为 error，实际 ${abortedTrace.status}`,
  );

  // —— 6) 优雅停机：SIGTERM 排空后 exit 0（框架不订阅信号，这一步是宿主的职责）——
  const code = await example.stop();
  assert(code === 0, `SIGTERM 应优雅退出（exit 0），实际 ${String(code)}`);
  assert(
    example.stdout().includes('[bye] 已排空退出'),
    `停机日志应走排空分支，实际 stdout 尾部：\n${example.stdout().slice(-400)}`,
  );
  client.close();

  const summary = {
    unary: `${unary.status}/${unary.stopReason} spans=${unary.spans}`,
    link: `${UP_TRACE.slice(0, 8)}…→run 根`,
    session: `第 2 轮消息 ${fake.observed.messageCounts[before + 2]} 条 > 第 1 轮 ${fake.observed.messageCounts[before]} 条`,
    stream: `${streamed.deltas.length} 帧 + 末帧 ${streamed.end?.status}`,
    async: `${done.status}（去重复用 ${taskId === again ? '生效' : '失效'}）`,
    deadline: `${elapsed}ms 内回 DEADLINE_EXCEEDED，服务端 run 已 abort`,
    shutdown: 'exit 0 / 已排空',
  };
  console.log('[e2e-grpc] 全部通过：');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(9)} ${v}`);
} finally {
  // 中途失败也要收口：别把进程和临时 trace 留在机器上
  if (example) await example.stop();
  await fake.close();
  rmSync(workDir, { recursive: true, force: true });
}
