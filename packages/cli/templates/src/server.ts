/**
 * 服务入口（可上线的 HTTP 宿主）—— 与 main.ts（一次性批处理）的分工：
 *   npm start            → node dist/main.js    跑一次就退出（cron / CI / 容器一次性任务）
 *   npm run start:server → node dist/server.js  长期在线的 HTTP 服务（本文件）
 *
 * 本文件给到的：`/healthz`、同步 `POST /run`（含 SSE 逐帧）、异步 `POST /tasks` +
 * 崩溃续跑（SqliteTaskStore + resumePending）、优雅停机（SIGTERM/SIGINT → drain →
 * server.close）、可选 Bearer 鉴权（AGENTIA_TOKEN）。
 * 更完整的生产配方（metrics / OTLP / Dockerfile / compose / 反代）在框架仓库的
 * examples/deploy/ 与 docs/deployment.md；API 细节见本项目 AGENTS.md 的「触发与宿主」节。
 *
 * ⚠️ SqliteTaskStore 用 `node:sqlite`，需要 Node ≥ 22.5 —— 更低版本起服务时构造期
 * 抛可读报错（框架对它延迟加载，不耽误 `npm run dev` 与 `npm start`）。
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { AsyncRunner, SqliteTaskStore, createHttpHandler } from '@migor/agentia';
import { createAgentApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.AGENTIA_DB ?? 'agentia.db';
const TOKEN = process.env.AGENTIA_TOKEN;

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

// 不设 token 不静默：响亮警告，但不强制（与框架「鉴权只是缝」同档 —— 策略是宿主的事）
if (!TOKEN) {
  console.warn('[server] 警告：未设 AGENTIA_TOKEN，HTTP 面无任何鉴权，仅应监听回环/内网');
}

// 装配与 main.ts / dev 环共用同一个工厂 —— 别把 createApp(...) 搬来这里旁路它，
// 否则「能力选择 / 工作目录 / .env 读取」在生产与开发两条路上长出两个行为。
const app = await createAgentApp();

// 耐久任务存储（WAL，多进程安全）+ 崩溃续跑：上次未完成的 queued/running 任务
// 重启后接着跑（不是丢弃）；多进程共库时按 ownerId 跳过本进程记录
const store = new SqliteTaskStore(DB_PATH);
const runner = new AsyncRunner(app, { store });
const resumed = await runner.resumePending();
if (resumed) console.log(`[server] 续跑 ${resumed} 个未完成任务`);

// 设了 AGENTIA_TOKEN 才挂鉴权钩子（Bearer 校验）；框架的 authenticate 是缝，
// 抛错即 401（细节只进服务端日志），正常返回即通过。/healthz 不在鉴权面内。
const authenticate = TOKEN
  ? (req: IncomingMessage): void => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        throw new Error('缺少或错误的 Bearer token');
      }
    }
  : undefined;
const handler = createHttpHandler(app, {
  runner,
  ...(authenticate ? { authenticate } : {}),
});

const server = createServer(handler);

server.listen(PORT, () => {
  // PORT=0 时端口由操作系统分配，以 server.address() 拿到的实际端口为准
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  // ⚠️ 首行是**就绪信号**（e2e 从它解析实际端口判定服务可用）——
  //    改文案要同步改仓库 scripts/e2e-cli.ts 的正则
  console.log(`[server] listening on :${actualPort}（db=${DB_PATH}）`);
  console.log('  POST /run        同步 run（带 Accept: text/event-stream → SSE 逐帧）');
  console.log('  POST /tasks      异步任务（轮询 GET /tasks/:id）');
  console.log('  GET  /healthz    健康检查（探针用，不鉴权）');
});

// 优雅停机：框架**不订阅信号**，这是宿主的职责。第二次信号直接退出（便于强杀）
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${sig}：优雅停机……`);
    void (async () => {
      // 拒新单 → 等在飞同步 run 与异步任务收尾 → 超时强制收口 SSE
      const clean = await handler.drain({ timeoutMs: 15_000 });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.log(clean ? '[server] 已排空退出' : '[server] 超时收口，剩余任务下次启动续跑');
      process.exit(0);
    })();
  });
}
