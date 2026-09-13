import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/* 对构建产物测试（未构建时跳过而非报错）。`report` 依赖构建期拷进
 * dist/inspector/ 的 trace-view 聚合实现，所以只有 build:cli 之后才有意义。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SUMMARY = fileURLToPath(new URL('../dist/inspector/summary.js', import.meta.url));
const SKIP = !existsSync(CLI) || !existsSync(SUMMARY) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

const trace = {
  traceId: 'run-1',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    { spanId: 's0', parentSpanId: null, kind: 'run', name: 'agent.run', startedAt: 0, endedAt: 500, status: 'ok', attributes: {}, events: [] },
    {
      spanId: 's1',
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 10,
      endedAt: 200,
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.01 },
      attributes: {},
      events: [
        { time: 50, name: 'tool.output', body: { tool: 'search', ok: true, durationMs: 300 } },
        { time: 60, name: 'tool.output', body: { tool: 'flaky', ok: false, durationMs: 12 } },
      ],
    },
    {
      spanId: 's2',
      parentSpanId: 's0',
      kind: 'unit',
      name: 'researcher',
      startedAt: 300,
      endedAt: 400,
      status: 'ok',
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costEstimate: 0.004 },
      attributes: { subagent: 'researcher' },
      events: [],
    },
  ],
};

function withFile(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-report-'));
  const file = join(dir, 'traces.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  try {
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('agentia report', { skip: SKIP }, () => {
  it('裸 Trace：打印按总耗时降序的单元排行', () => {
    withFile([JSON.stringify(trace)], (file) => {
      const out = run(['report', file]);
      assert.match(out, /runs {7}1（失败 0）/);
      assert.match(out, /subagent:researcher/);
      assert.match(out, /tool:search/);
      assert.match(out, /tool:flaky/);
      // 排序：researcher 100ms > search 300ms？—— search 是 300ms，应排第一
      assert.ok(out.indexOf('tool:search') < out.indexOf('subagent:researcher'), '总耗时大的排前面');
      // 未定价的工具在 tokens/cost 列显式给 '-'
      assert.match(out, /tool:flaky\s+1\s+1\s+12ms/);
      assert.match(out, /合计耗时/);
    });
  });

  it('TaskRecord（含 result.trace）也能解出来', () => {
    withFile([JSON.stringify({ ok: true, runId: 'run-1', result: { trace } })], (file) => {
      const out = run(['report', file]);
      assert.match(out, /runs {7}1/);
      assert.match(out, /tool:search/);
    });
  });

  it('多条记录按单元合并（calls/total 累加，max 取大）', () => {
    withFile([JSON.stringify(trace), JSON.stringify(trace)], (file) => {
      const out = run(['report', file]);
      assert.match(out, /runs {7}2/);
      assert.match(out, /tool:search\s+2\s+0\s+600ms\s+300ms/);
    });
  });

  it('无法解析的行被跳过并计数，不炸', () => {
    withFile([JSON.stringify(trace), 'oops', '{bad json'], (file) => {
      const out = run(['report', file]);
      assert.match(out, /跳过无法解析 2 行/);
      assert.match(out, /tool:search/);
    });
  });

  it('文件里没有可识别的 trace → 非零退出 + 说明', () => {
    withFile(['{"nope":1}'], (file) => {
      assert.throws(() => run(['report', file]), (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /没有可识别的 trace/);
        return true;
      });
    });
  });

  it('缺参数 / 文件不存在 → 非零退出', () => {
    assert.throws(() => run(['report']), (e) => {
      assert.equal(e.status, 1);
      assert.match(String(e.stderr), /用法：agentia report/);
      return true;
    });
    assert.throws(() => run(['report', '/tmp/definitely-not-here.jsonl']), (e) => {
      assert.equal(e.status, 1);
      assert.match(String(e.stderr), /读不到文件/);
      return true;
    });
  });

  it('--help 里列出 report', () => {
    assert.match(run(['--help']), /agentia report <trace\.jsonl>/);
  });
});
