import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错），同 harvest.test.mjs 的约定。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const CLI_DIFF = fileURLToPath(new URL('../dist/diff.js', import.meta.url));
const SKIP = !existsSync(CLI) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(CLI, 'CLI 构建产物');
/* 框架构建产物：对拍「CLI 与框架 diffTraces 逐字同形」要 import 它 */
const FW_DIFF = fileURLToPath(new URL('../../../dist/engine/trace-diff.js', import.meta.url));

const U1 = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costEstimate: 0.001,
};

/**
 * run（attributes: model / system.version）
 * ├─ llm.turn（model）：tool.input 一条 + 可选 note 一条
 * ├─ （可选）capability「skill:?」└─ llm.turn
 * └─ （可选）llm.turn（无计量）
 * totalUsage = 各 llm.turn usage 求和（与框架口径一致）
 */
function makeTrace(opts = {}) {
  const model = opts.model ?? 'model-a';
  const usage = opts.usage ?? U1;
  const traceId = opts.traceId ?? 'trace-1';
  const spans = [
    {
      spanId: 's0',
      traceId,
      parentSpanId: null,
      kind: 'run',
      name: 'app',
      startedAt: 0,
      endedAt: 100,
      status: 'ok',
      attributes: { model, 'system.version': '1' },
      events: [],
    },
  ];
  const t1 = {
    spanId: 't1',
    traceId,
    parentSpanId: 's0',
    kind: 'llm.turn',
    name: model,
    startedAt: 10,
    endedAt: 20,
    status: 'ok',
    usage,
    attributes: {},
    events: [{ time: 11, name: 'tool.input', body: { tool: 'search', input: '{}' } }],
  };
  if (opts.eventBody !== undefined) {
    t1.events.push({ time: 12, name: 'note', body: opts.eventBody });
  }
  spans.push(t1);
  if (opts.skill) {
    spans.push({
      spanId: 'c1',
      traceId,
      parentSpanId: 's0',
      kind: 'capability',
      name: opts.skill,
      startedAt: 30,
      endedAt: 60,
      status: 'ok',
      attributes: {},
      events: [],
    });
    spans.push({
      spanId: 't2',
      traceId,
      parentSpanId: 'c1',
      kind: 'llm.turn',
      name: model,
      startedAt: 35,
      endedAt: 55,
      status: 'ok',
      usage,
      attributes: {},
      events: [],
    });
  }
  if (opts.extraTurn) {
    spans.push({
      spanId: 't3',
      traceId,
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: model,
      startedAt: 70,
      endedAt: 80,
      status: 'ok',
      attributes: {},
      events: [],
    });
  }
  const totalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const s of spans) {
    if (s.kind !== 'llm.turn' || !s.usage) continue;
    totalUsage.inputTokens += s.usage.inputTokens;
    totalUsage.outputTokens += s.usage.outputTokens;
    totalUsage.cacheReadTokens += s.usage.cacheReadTokens;
    totalUsage.cacheCreationTokens += s.usage.cacheCreationTokens;
  }
  return { traceId, rootSpanId: 's0', spans, status: 'ok', totalUsage };
}

function withFiles(linesA, linesB, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-diff-'));
  const fileA = join(dir, 'a.jsonl');
  const fileB = join(dir, 'b.jsonl');
  writeFileSync(fileA, linesA.join('\n') + '\n');
  writeFileSync(fileB, linesB.join('\n') + '\n');
  try {
    return fn(fileA, fileB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('agentia diff', { skip: SKIP }, () => {
  it('CLI diffTraces 与框架真源逐字同形（移植漂移对拍，六组夹具）', async () => {
    if (!distReadyOrLoud(FW_DIFF, '框架构建产物')) return; // 本地未 build：醒目警告后跳过
    const { diffTraces: fwDiff } = await import(FW_DIFF);
    const { diffTraces: cliDiff } = await import(CLI_DIFF);
    const cases = [
      ['全同', makeTrace(), makeTrace()],
      ['改模型名', makeTrace({ model: 'model-a' }), makeTrace({ model: 'model-b' })],
      ['一侧多 turn', makeTrace(), makeTrace({ extraTurn: true })],
      ['capability 名不同', makeTrace({ skill: 'skill:a' }), makeTrace({ skill: 'skill:b' })],
      ['usage 不同', makeTrace({ usage: U1 }), makeTrace({ usage: { ...U1, inputTokens: 20 } })],
      ['事件 body 不同', makeTrace({ eventBody: 'hello' }), makeTrace({ eventBody: 'world' })],
    ];
    for (const [label, a, b] of cases) {
      assert.equal(
        JSON.stringify(cliDiff(a, b)),
        JSON.stringify(fwDiff(a, b)),
        `夹具「${label}」：CLI 移植副本与框架 diffTraces 漂移了 —— packages/cli/src/diff.ts 是逐行移植，改算法要两边同步`,
      );
    }
  });

  it('两条等价 trace → 「等价」一行，退出码 0', () => {
    withFiles([JSON.stringify(makeTrace())], [JSON.stringify(makeTrace())], (fileA, fileB) => {
      const out = run(['diff', fileA, fileB]);
      assert.match(out, /两条 trace 等价（无结构与字段差异）/);
      assert.ok(!out.includes('run 级差异'));
    });
  });

  it('有差异 → run 级 summary + span 分组，退出码 1', () => {
    withFiles(
      [JSON.stringify(makeTrace({ model: 'model-a', traceId: 'trace-a' }))],
      [JSON.stringify(makeTrace({ model: 'model-b', traceId: 'trace-b' }))],
      (fileA, fileB) => {
        assert.throws(
          () => run(['diff', fileA, fileB]),
          (e) => {
            assert.equal(e.status, 1);
            const out = String(e.stdout);
            assert.match(out, /trace a {2}.+a\.jsonl（trace-a）/);
            assert.match(out, /run 级差异：/);
            assert.ok(out.includes('  attributes.model: model-a → model-b'));
            assert.match(out, /span 差异：/);
            assert.match(out, /run:app\/llm\.turn#0/);
            assert.ok(out.includes('  name: model-a → model-b'));
            return true;
          },
        );
      },
    );
  });

  it('一侧多回合 → 缺侧标 (仅存在于 b)，fields 为空', () => {
    withFiles(
      [JSON.stringify(makeTrace())],
      [JSON.stringify(makeTrace({ extraTurn: true }))],
      (fileA, fileB) => {
        assert.throws(
          () => run(['diff', fileA, fileB]),
          (e) => {
            assert.equal(e.status, 1);
            assert.match(String(e.stdout), /run:app\/llm\.turn#1 \(仅存在于 b\)/);
            return true;
          },
        );
      },
    );
  });

  it('坏行跳过计数；TaskRecord 形态（result.trace）也能提取', () => {
    const record = {
      taskId: 'task_1',
      status: 'succeeded',
      result: { trace: makeTrace() },
    };
    withFiles(['oops', JSON.stringify(record)], [JSON.stringify(makeTrace())], (fileA, fileB) => {
      const out = run(['diff', fileA, fileB]);
      assert.match(out, /跳过无法解析 1 行/);
      assert.match(out, /两条 trace 等价/);
    });
  });

  it('缺参数 / 文件不存在 / 没有可识别 trace / 坏 flag → 非零退出 + 说明', () => {
    assert.throws(
      () => run(['diff']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /用法：agentia diff/);
        return true;
      },
    );
    assert.throws(
      () => run(['diff', '/tmp/definitely-not-here-a.jsonl', '/tmp/definitely-not-here-b.jsonl']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /读不到文件/);
        return true;
      },
    );
    withFiles(['{"nope":1}'], [JSON.stringify(makeTrace())], (fileA, fileB) => {
      assert.throws(
        () => run(['diff', fileA, fileB]),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /没有可识别的 trace/);
          return true;
        },
      );
    });
    withFiles([JSON.stringify(makeTrace())], [JSON.stringify(makeTrace())], (fileA, fileB) => {
      assert.throws(
        () => run(['diff', fileA, fileB, '--verbose']),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /未知参数：--verbose/);
          return true;
        },
      );
    });
  });

  it('--help 里列出 diff', () => {
    assert.match(run(['--help']), /agentia diff <a\.jsonl> <b\.jsonl>/);
  });
});
