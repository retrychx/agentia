import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 对构建产物测试（inspector 的静态资源在 dist/inspector，src 下没有）。
 * 未构建时跳过而非报错 —— 免得只跑 npm test 的人卡在构建前置上。 */
const DIST = fileURLToPath(new URL('../dist/inspector.js', import.meta.url));
let startInspector = null;
if (existsSync(DIST)) {
  ({ startInspector } = await import(new URL('../dist/inspector.js', import.meta.url).href));
}
const SKIP = !startInspector ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

const sample = (id) => ({
  traceId: id,
  status: 'ok',
  totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  spans: [
    { spanId: 'r', parentSpanId: null, kind: 'run', name: 'demo', startedAt: 0, endedAt: 100, status: 'ok' },
    {
      spanId: 't', parentSpanId: 'r', kind: 'llm.turn', name: 'm', startedAt: 5, endedAt: 50, status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
      events: [{ time: 6, name: 'tool.input', body: { tool: 'echo', input: { a: 1 } } }],
    },
  ],
});

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('inspector 服务', () => {
  it('ingest → 列表 → 单条；面板与静态资源可访问', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;

      assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), [], '初始为空');

      assert.equal((await post(base, '/ingest', sample('t1'))).status, 200);

      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].traceId, 't1');
      assert.equal(list[0].tokens, 15, 'input+output 汇总');
      assert.equal(list[0].ms, 100, 'run 根耗时');
      assert.equal(list[0].ok, true);

      const one = await (await fetch(`${base}/api/runs/t1`)).json();
      assert.equal(one.spans.length, 2, '返回完整 trace');

      assert.match(await (await fetch(`${base}/`)).text(), /Agentia Inspector/);
      assert.match(await (await fetch(`${base}/index.js`)).text(), /playTrace|createTraceView/);
      assert.match(await (await fetch(`${base}/trace-view.css`)).text(), /\.tr-row/);

      assert.equal((await post(base, '/ingest', {})).status, 400, '无 traceId → 400');
      assert.equal((await fetch(`${base}/api/runs/nope`)).status, 404, '未知 run → 404');
    } finally {
      await srv.close();
    }
  });

  it('环形缓冲：超过上限淘汰最旧，最新的在前', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      for (let i = 0; i < 55; i++) await post(base, '/ingest', sample('r' + i));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 50, '上限 50');
      assert.equal(list[0].traceId, 'r54', '最新的在前');
      assert.ok(!list.some((x) => x.traceId === 'r0'), '最旧的已淘汰');
    } finally {
      await srv.close();
    }
  });

  it('SSE /stream：新 run 到达即推一条摘要', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}/stream`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      await post(base, '/ingest', sample('s1'));
      let buf = '';
      const deadline = Date.now() + 3000;
      while (!/s1/.test(buf) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      assert.match(buf, /"traceId":"s1"/, 'SSE 收到新 run 摘要');
      await reader.cancel();
    } finally {
      await srv.close();
    }
  });
});
