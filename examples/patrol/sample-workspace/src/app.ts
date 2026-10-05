/**
 * 订单服务入口（示例巡检目标）。
 * 这里刻意留了一处会过期的东西，供巡检 agent 用 search_text 找到。
 */
import { createServer } from 'node:http';

/** 单机最大并发 */
export const MAX_CONCURRENCY = 64;

// FIXME(2024-06-11, @zhang): 这里的超时是拍脑袋定的 30s，等压测报告出来再调。
//   压测报告：notes/perf.md —— 至今没人回来改过这一行。
const REQUEST_TIMEOUT_MS = 30_000;

export function start(): void {
  const server = createServer((req, res) => {
    req.socket.setTimeout(REQUEST_TIMEOUT_MS);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, maxConcurrency: MAX_CONCURRENCY }));
  });
  server.listen(Number(process.env.PORT ?? 8080));
}
