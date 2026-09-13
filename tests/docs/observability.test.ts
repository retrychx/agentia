import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTaskStore } from '../../src/index.js';
import type { Span, Trace, TraceSink } from '../../src/index.js';
import { jsonLogSink, redactSink, sampleSink, sqliteTraceSink } from '../../examples/observability/src/index.js';

/**
 * 生产可观测栈配方的校验：`docs/observability.md` 与 `examples/observability/`（本地小包）。
 *
 * 仓库既有约定 —— 文档里写的写法必须**真能工作**（同 usage-guide §6 被单测真跑一遍）。
 * 这里跑四个 sink，并真的验掉 spec §9.3 那句「span 与 run 记录同库存储」。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const DOC = join(repoRoot, 'docs', 'observability.md');
const SINKS = join(repoRoot, 'examples', 'observability', 'src', 'index.ts');

/** 造一条含根 span + 两次 llm.turn + 一个错误 span 的 trace */
function makeTrace(opts: { traceId?: string; status?: 'ok' | 'error' } = {}): Trace {
  const traceId = opts.traceId ?? 'run-1';
  const rootSpanId = 'root-1';
  const spans: Span[] = [
    {
      spanId: rootSpanId,
      traceId,
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 1000,
      endedAt: 1300,
      status: opts.status ?? 'ok',
      ...(opts.status === 'error'
        ? { error: { type: 'upstream_error', message: 'boom', retryable: true } }
        : {}),
      attributes: { 'service.name': 'svc' },
      events: [],
    },
    {
      spanId: 'turn-1',
      traceId,
      parentSpanId: rootSpanId,
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1010,
      endedAt: 1100,
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0 },
      attributes: { authorization: 'Bearer secret-token' },
      events: [{ time: 1020, name: 'tool.input', body: { api_key: 'sk-live-123', query: 'hi' } }],
    },
    {
      spanId: 'turn-2',
      traceId,
      parentSpanId: rootSpanId,
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1110,
      endedAt: 1200,
      status: 'ok',
      usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
      attributes: {},
      events: [],
    },
    {
      spanId: 'tool-1',
      traceId,
      parentSpanId: 'turn-2',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 1210,
      endedAt: 1250,
      status: 'error',
      error: { type: 'rate_limit', message: '429 联系 13800138000', retryable: true },
      attributes: {},
      events: [],
    },
  ];
  return {
    traceId,
    rootSpanId,
    status: opts.status ?? 'ok',
    totalUsage: {
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      costEstimate: 0.0123,
    },
    spans,
  };
}

/** 记录被投递过的 trace（测试用下游 sink） */
function recorder(): TraceSink & { seen: Trace[] } {
  const seen: Trace[] = [];
  return {
    seen,
    export(t: Trace) {
      seen.push(t);
    },
  };
}

describe('可观测配方：文档与示例互相覆盖', () => {
  const doc = readFileSync(DOC, 'utf8');

  it('文档存在，且点名四条配方与示例文件', () => {
    for (const needle of ['sqliteTraceSink', 'jsonLogSink', 'sampleSink', 'redactSink']) {
      assert.ok(doc.includes(needle), `docs/observability.md 未提到 ${needle}`);
    }
    assert.ok(doc.includes('examples/observability/'), '文档应指向示例实现');
    assert.ok(doc.includes('spec'), '文档应回指 spec 定位/出口');
  });

  it('反向全覆盖：示例导出的每个 sink 工厂都在文档里出现', () => {
    const src = readFileSync(SINKS, 'utf8');
    const factories = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]!);
    assert.deepEqual(
      factories.sort(),
      ['jsonLogSink', 'redactSink', 'sampleSink', 'sqliteTraceSink'],
      `意外的导出面: ${factories}`,
    );
    for (const f of factories) assert.ok(doc.includes(f), `导出 ${f} 未在文档中说明`);
  });

  it('spec §9.3 不再把「同库存储」说成内建', () => {
    const spec = readFileSync(join(repoRoot, 'docs', 'spec.md'), 'utf8');
    assert.ok(
      spec.includes('不是框架内建'),
      'spec §9.3 应明确「同库存储」是 sink 配方而非内建',
    );
  });
});

describe('配方 ③ sqliteTraceSink：按 runId 落库检索', () => {
  it('export → getTrace/getSpans/listRecent 往返一致', () => {
    const sink = sqliteTraceSink({ db: ':memory:' });
    const trace = makeTrace();
    sink.export(trace);

    assert.deepEqual(sink.getTrace('run-1'), trace, 'getTrace 应按 runId 取回完整 trace');
    assert.equal(sink.getTrace('nope'), undefined);

    // spans 明细行：一 span 一行（只回 attributes/events，够 SQL 直接查）
    const spans = sink.getSpans('run-1');
    assert.equal(spans.length, 4);
    assert.deepEqual(spans[0]!.attributes, { 'service.name': 'svc' });

    const recent = sink.listRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.runId, 'run-1');
    assert.equal(recent[0]!.status, 'ok');
    assert.equal(recent[0]!.tokens, 355, 'tokens = 四类之和');
    assert.equal(recent[0]!.costUsd, 0.0123);
    sink.close();
  });

  it('重复 export 同 runId 幂等（INSERT OR REPLACE）', () => {
    const sink = sqliteTraceSink({ db: ':memory:' });
    sink.export(makeTrace());
    sink.export(makeTrace());
    assert.equal(sink.listRecent(10).length, 1);
    assert.equal(sink.getSpans('run-1').length, 4, 'span 行不重复');
    sink.close();
  });

  it('与 SqliteTaskStore 同库：tasks / traces / spans 三表并存（spec §9.3）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-obs-'));
    const file = join(dir, 'agentia.db');
    try {
      // run 记录：SqliteTaskStore（自建连接）—— 库文件与 trace sink 是同一个
      const store = new SqliteTaskStore(file);
      store.save({
        taskId: 'task_1',
        status: 'succeeded',
        spec: { messages: [{ role: 'user', content: 'hi' }] },
        runId: 'run-1',
        createdAt: 1,
      });

      // trace：我们的 sink 开另一个连接到同一文件
      const sink = sqliteTraceSink({ db: file });
      sink.export(makeTrace());

      const probe = new DatabaseSync(file);
      const tables = (
        probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      probe.close();
      for (const t of ['tasks', 'traces', 'spans']) {
        assert.ok(tables.includes(t), `同库应同时有 ${t} 表，实际: ${tables.join(',')}`);
      }

      // taskId → runId → trace 的两步关联（文档里写的查法）
      const rec = store.get('task_1')!;
      assert.equal(rec.runId, 'run-1');
      assert.equal(sink.getTrace(rec.runId!)!.traceId, 'run-1');
      sink.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('配方 ④ jsonLogSink：一 run 一行 JSON，runId 贯穿', () => {
  it('字段齐全，且 runId 等于 traceId（日志 → trace 的接缝）', () => {
    const lines: string[] = [];
    const sink = jsonLogSink({
      write: (l) => lines.push(l),
      labels: { service: 'svc', env: 'test' },
      now: () => 1_700_000_000_000,
    });
    sink.export(makeTrace());

    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.endsWith('\n'), '一行一条记录');
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.runId, 'run-1');
    assert.equal(entry.traceId, 'run-1');
    assert.equal(entry.msg, 'run.finished');
    assert.equal(entry.level, 'info');
    assert.equal(entry.status, 'ok');
    assert.equal(entry.durationMs, 300, '根 span 起止差');
    assert.equal(entry.iterations, 3, 'llm.turn span 数');
    assert.deepEqual(entry.tokens, {
      input: 300,
      output: 50,
      cacheRead: 5,
      cacheCreation: 0,
    });
    assert.equal(entry.costUsd, 0.0123);
    assert.equal(entry.service, 'svc');
    assert.equal(entry.env, 'test');
    assert.equal(entry.ts, new Date(1_700_000_000_000).toISOString());
  });

  it('失败 run 记 level=error 并带根 span 的错误', () => {
    const lines: string[] = [];
    jsonLogSink({ write: (l) => lines.push(l) }).export(makeTrace({ status: 'error' }));
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(entry.level, 'error');
    assert.equal(entry.status, 'error');
    assert.deepEqual(entry.error, { type: 'upstream_error', message: 'boom', retryable: true });
  });
});

describe('配方 ① sampleSink：采样', () => {
  it('rate 0 只留错误 run；rate 1 全留', () => {
    const keep = recorder();
    sampleSink({ rate: 0, sinks: [keep] }).export(makeTrace({ traceId: 'ok-1', status: 'ok' }));
    assert.equal(keep.seen.length, 0, 'rate=0 应丢掉成功 run');

    sampleSink({ rate: 0, sinks: [keep] }).export(makeTrace({ traceId: 'err-1', status: 'error' }));
    assert.equal(keep.seen.length, 1, '错误 run 永不采样掉');

    const all = recorder();
    sampleSink({ rate: 1, sinks: [all] }).export(makeTrace({ traceId: 'ok-2', status: 'ok' }));
    assert.equal(all.seen.length, 1);
  });

  it('判定按 runId 确定（同一 run 重复投递结果一致）', () => {
    const seen: boolean[] = [];
    for (let i = 0; i < 2; i++) {
      const r = recorder();
      sampleSink({ rate: 0.5, sinks: [r] }).export(makeTrace({ traceId: 'stable-run', status: 'ok' }));
      seen.push(r.seen.length === 1);
    }
    assert.equal(seen[0], seen[1], '同一 runId 的采样判定必须稳定');
  });

  it('非法 rate 构造期抛错（响亮失败）', () => {
    assert.throws(() => sampleSink({ rate: 1.5, sinks: [] }), /rate 必须在 \[0,1\]/);
    assert.throws(() => sampleSink({ rate: -0.1, sinks: [] }), /rate 必须在 \[0,1\]/);
    assert.throws(() => sampleSink({ rate: Number.NaN, sinks: [] }), /rate 必须在 \[0,1\]/);
  });
});

describe('配方 ② redactSink：脱敏', () => {
  it('按字段名抹掉 attributes 与 events.body 里的敏感值', () => {
    const out = recorder();
    redactSink({ keys: ['authorization', 'api_key'], sinks: [out] }).export(makeTrace());
    const t = out.seen[0]!;
    const turn = t.spans.find((s) => s.spanId === 'turn-1')!;
    assert.equal(turn.attributes.authorization, '[REDACTED]');
    assert.deepEqual(turn.events[0]!.body, { api_key: '[REDACTED]', query: 'hi' });
  });

  it('原 trace 不被改动（深拷贝 —— 其余 sink 仍拿得到原文）', () => {
    const trace = makeTrace();
    const out = recorder();
    redactSink({ keys: ['authorization'], sinks: [out] }).export(trace);
    assert.equal(
      trace.spans.find((s) => s.spanId === 'turn-1')!.attributes.authorization,
      'Bearer secret-token',
      '原 trace 必须保持不变',
    );
    assert.notEqual(out.seen[0], trace, '下游拿到的是副本');
  });

  it('patterns 对字符串值生效（手机号等）', () => {
    const out = recorder();
    redactSink({ patterns: [/1[3-9]\d{9}/], sinks: [out] }).export(makeTrace());
    const err = out.seen[0]!.spans.find((s) => s.spanId === 'tool-1')!.error!;
    assert.equal(err.message, '429 联系 [REDACTED]');
  });
});

describe('组装（文档 §2.5 那段）与稳健性', () => {
  it('sample → redact → [sqlite, log] 端到端：落库与日志都拿到脱敏副本', async () => {
    const db = new DatabaseSync(':memory:');
    const store = sqliteTraceSink({ db });
    const lines: string[] = [];
    const log = jsonLogSink({ write: (l) => lines.push(l) });

    const sink = sampleSink({
      rate: 1,
      sinks: [redactSink({ keys: ['authorization'], sinks: [store, log] })],
    });
    await sink.export(makeTrace()); // 组合链是 async（框架 await 每个 sink）

    assert.equal(store.getTrace('run-1')!.spans.find((s) => s.spanId === 'turn-1')!.attributes.authorization, '[REDACTED]');
    assert.equal((JSON.parse(lines[0]!) as { runId: string }).runId, 'run-1');
    db.close();
  });

  it('下游抛错被吞：一个 sink 坏掉不影响其余，更不影响 run', async () => {
    const good = recorder();
    const bad: TraceSink = {
      export() {
        throw new Error('落库挂了');
      },
    };
    const sink = sampleSink({ rate: 1, sinks: [bad, good] });
    await sink.export(makeTrace()); // 不应抛出
    assert.equal(good.seen.length, 1, '坏 sink 之后的正常 sink 仍应收到 trace');
  });
});
