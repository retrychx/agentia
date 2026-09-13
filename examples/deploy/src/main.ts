/**
 * Agentia 部署示例 —— 最小「可交付 Agent 服务」。
 *
 * 演示定位里那一脚（spec §1「交付物是可上线的 Agent 服务」）：
 *   耐久任务存储（SqliteTaskStore，WAL + busy_timeout，多进程安全）
 *   + 重启续跑（resumePending）
 *   + 健康检查（/healthz，探针不鉴权）
 *   + 指标（/metrics，Prometheus 文本）
 *   + 优雅停机（drain，框架不订阅信号 —— 这里是宿主自己的事）
 *
 * 观测配方（落库 / 采样 / 脱敏 / 日志关联）见 ../observability/sinks.ts 与 docs/observability.md。
 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import {
  AsyncRunner,
  SqliteTaskStore,
  SystemPrompt,
  createApp,
  createHttpHandler,
  metricsSink,
} from '@migor/agentia';
import { providers } from './units.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.AGENTIA_DB ?? 'agentia.db';

if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

// —— 1) 观测出口：指标 sink（满足 TraceSink 即接入，零新出口）——
// 需要 OTLP 再加一个：sinks: [metrics, createOtlpExporter({ endpoint: process.env.OTEL_ENDPOINT! })]
const metrics = metricsSink({ prefix: 'agentia_' });

// —— 2) 装配 ——
const app = await createApp({
  name: 'deploy-example',
  providers,
  system: new SystemPrompt().add(
    'role',
    '你是部署示例的主 agent，按任务自主调度菜单里的单元。',
    true,
  ),
  sinks: [metrics],
  maxTotalTokens: 200_000, // 单条 run 的 token 上限（硬管控，超限以 budget_exceeded 收尾）
});

// —— 3) 耐久任务存储 ——
const store = new SqliteTaskStore(DB_PATH);
const runner = new AsyncRunner(app, { store, runTimeoutMs: 120_000 });

// 重启续跑上次未完成的 queued/running 任务（不是丢弃）；多进程共库时按 ownerId 跳过本进程记录
const resumed = await runner.resumePending();
if (resumed) console.log(`[boot] 续跑 ${resumed} 个未完成任务`);

// —— 4) HTTP 宿主 ——
const handler = createHttpHandler(app, { runner, maxConcurrentRuns: 32 });

const server = createServer((req, res) => {
  // 额外运维端点：/metrics（Prometheus 抓取）。⚠️ 走 handler 之外，不受 authenticate 管 ——
  // 生产请由反代 / 内网限制其可达性（探针端点通常如此）。
  if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metrics.render());
    return;
  }
  void handler(req, res);
});

server.listen(PORT, () => {
  console.log(`[boot] listening on :${PORT}（db=${DB_PATH}）`);
  console.log('  POST /run        同步 run（带 Accept: text/event-stream → SSE 逐帧）');
  console.log('  POST /tasks      异步任务（轮询 GET /tasks/:id）');
  console.log('  GET  /healthz    健康检查（探针用，不鉴权）');
  console.log('  GET  /metrics    Prometheus 指标');
});

// —— 5) 优雅停机（框架不订阅信号 —— 这是宿主的职责）——
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return; // 第二次信号不再拦截，便于强杀
    stopping = true;
    console.log(`[${sig}] 优雅停机……`);
    void (async () => {
      // 拒新单 → 等在飞同步 run 与异步任务收尾 → 超时强制收口 SSE
      const clean = await handler.drain({ timeoutMs: 15_000 });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.log(clean ? '[bye] 已排空退出' : '[bye] 超时收口，剩余任务下次启动续跑');
      process.exit(0);
    })();
  });
}
