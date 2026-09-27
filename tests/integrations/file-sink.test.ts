import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonlTraceSink } from '../../src/index.js';
import type { Trace } from '../../src/index.js';

/** 造一条 JSON 干净（无 undefined 字段）的最小 trace —— 落盘往返要逐字相等 */
function makeTrace(traceId: string): Trace {
  return {
    traceId,
    rootSpanId: `${traceId}-root`,
    status: 'ok',
    totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: `${traceId}-root`,
        traceId,
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 1000,
        endedAt: 1300,
        status: 'ok',
        attributes: {},
        events: [],
      },
    ],
  };
}

describe('jsonlTraceSink（CLI report/diff/harvest 的输入格式）', () => {
  it('三次 export 三行，每行可解析且逐字等于投入的 trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'trace.jsonl');
      const sink = jsonlTraceSink({ path: file });
      const traces = [makeTrace('run-1'), makeTrace('run-2'), makeTrace('run-3')];
      for (const t of traces) sink.export(t);

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      assert.equal(lines.length, 3);
      for (const [i, line] of lines.entries()) {
        assert.deepEqual(JSON.parse(line), traces[i], `第 ${i + 1} 行应逐字等于投入的 trace`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('父目录不存在时构造期递归创建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'a', 'b', 'trace.jsonl');
      const sink = jsonlTraceSink({ path: file }); // 不抛即建好了
      const trace = makeTrace('run-1');
      sink.export(trace);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), trace);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('追加不覆盖：文件已有内容时接着写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'trace.jsonl');
      writeFileSync(file, `${JSON.stringify(makeTrace('old'))}\n`, 'utf8');
      jsonlTraceSink({ path: file }).export(makeTrace('new'));

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      assert.deepEqual(
        lines.map((l) => (JSON.parse(l) as Trace).traceId),
        ['old', 'new'],
        '旧行必须保留，新行追加在后',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写失败抛给调用方（flushSinks 会吞 —— sink 自己不藏）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const asDir = join(dir, 'not-a-file');
      mkdirSync(asDir);
      // path 指向一个目录：mkdir 父目录没问题，append 时才炸（EISDIR）
      const sink = jsonlTraceSink({ path: asDir });
      assert.throws(() => sink.export(makeTrace('run-1')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
