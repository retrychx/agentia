import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错），同 report/harvest 的约定。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SKIP = !existsSync(CLI) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
if (SKIP) distReadyOrLoud(CLI, 'CLI 构建产物');
/* 对拍用产物：CLI 移植副本（dist 缺失时整个 describe 已 skip）与框架真源 */
const CLI_EXPORT = fileURLToPath(new URL('../dist/export.js', import.meta.url));
const FW_EXPORT = fileURLToPath(new URL('../../../dist/eval/export.js', import.meta.url));

/** 一条带 tool 往返 + output.text（traceContent:'full' 产物）+ score 的完整 trace */
const FULL = {
  traceId: 'run-full',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    {
      spanId: 's0',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 0,
      endedAt: 100,
      status: 'ok',
      attributes: { model: 'claude-opus-5', stop_reason: 'end_turn' },
      events: [{ time: 99, name: 'score', body: { name: 'eval', value: 1 } }],
    },
    {
      spanId: 't1',
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 10,
      endedAt: 40,
      status: 'ok',
      attributes: {},
      events: [
        {
          time: 11,
          name: 'tool.input',
          body: { tool: 'search', tool_use_id: 'tu1', input: '{"q":"北京天气"}' },
        },
        {
          time: 30,
          name: 'tool.output',
          body: { tool: 'search', tool_use_id: 'tu1', ok: true, content: '晴 25℃' },
        },
      ],
    },
    {
      spanId: 't2',
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 50,
      endedAt: 90,
      status: 'ok',
      attributes: { 'output.text': '北京今天晴，25℃' },
      events: [],
    },
  ],
};

/** 未开 traceContent 的失败 run（无 output.text、无 score） */
const PLAIN_FAIL = {
  traceId: 'run-fail',
  rootSpanId: 's0',
  status: 'error',
  spans: [
    {
      spanId: 's0',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 0,
      endedAt: 50,
      status: 'error',
      attributes: { model: 'claude-opus-5', stop_reason: 'error' },
      events: [],
    },
    {
      spanId: 't1',
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 10,
      endedAt: 40,
      status: 'error',
      attributes: {},
      events: [],
    },
  ],
};

function run(args, cwd) {
  // spawnSync：成功路径也要拿得到 stderr（--out 的汇总打在 stderr 上）
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-export-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agentia export（R8-P3b：trace → 训练数据 JSONL）', { skip: SKIP }, () => {
  it('stdout 是产物：一行一份 { messages, meta }，无人类装饰', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 't.jsonl'), `${JSON.stringify(FULL)}\n`);
      const r = run(['export', 't.jsonl'], dir);
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.trim().split('\n');
      assert.equal(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.meta.traceId, 'run-full');
      assert.deepEqual(rec.meta.incomplete, ['input']);
      assert.equal(
        rec.messages[1].content[0].name,
        'search',
        'tool_use 在主线（无文本块时 content 从它起）',
      );
      assert.equal(rec.messages[3].content[0].text, '北京今天晴，25℃', '真文本入列');
    });
  });

  it('--min-score：没分数的 run 被排除（没判过 ≠ 及格）', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 't.jsonl'),
        `${JSON.stringify(FULL)}\n${JSON.stringify(PLAIN_FAIL)}\n`,
      );
      const keep = run(['export', 't.jsonl', '--min-score', '0.5'], dir);
      assert.equal(keep.status, 0, keep.stderr);
      assert.equal(keep.stdout.trim().split('\n').length, 1, '只有带分且及格的 run 留下');

      const none = run(['export', 't.jsonl', '--min-score', '2'], dir);
      assert.equal(none.status, 1, '全被过滤要报错（静默产空文件是最难查的那种错）');
      assert.match(none.stderr, /没有符合过滤条件的 run/);
    });
  });

  it('--ok-only：失败 run 被过滤', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 't.jsonl'),
        `${JSON.stringify(FULL)}\n${JSON.stringify(PLAIN_FAIL)}\n`,
      );
      const r = run(['export', 't.jsonl', '--ok-only'], dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim().split('\n').length, 1);
    });
  });

  it('--out 落盘：文件是产物，stderr 打一行汇总（stdout 不混人读文本）', () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, 't.jsonl'),
        `${JSON.stringify(FULL)}\n${JSON.stringify(PLAIN_FAIL)}\n`,
      );
      const r = run(['export', 't.jsonl', '--out', 'dataset.jsonl'], dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', '--out 时 stdout 必须为空');
      assert.match(r.stderr, /已写出 2 条训练记录/);
      const lines = readFileSync(join(dir, 'dataset.jsonl'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[1]).meta.incomplete.includes('assistant-text'), true);
    });
  });

  it('未知参数 / 缺文件 / --min-score 缺值：可读报错 + 退出码 1', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 't.jsonl'), `${JSON.stringify(FULL)}\n`);
      assert.equal(run(['export', 't.jsonl', '--bogus'], dir).status, 1);
      assert.match(run(['export'], dir).stderr, /用法：agentia export/);
      assert.match(
        run(['export', 't.jsonl', '--min-score'], dir).stderr,
        /--min-score 需要一个数值/,
      );
    });
  });

  it('CLI 移植副本与框架 exportRun 产物逐字相等（移植漂移对拍）', async () => {
    if (!distReadyOrLoud(FW_EXPORT, '框架构建产物')) return;
    const { exportRun: fw } = await import(FW_EXPORT);
    const { exportRun: cli } = await import(CLI_EXPORT);
    for (const [name, trace] of [
      ['全量记录 + score', FULL],
      ['未记录文本的失败 run', PLAIN_FAIL],
      [
        '没有主循环回合',
        { ...FULL, traceId: 'run-empty', spans: FULL.spans.filter((s) => s.kind !== 'llm.turn') },
      ],
    ]) {
      assert.equal(
        JSON.stringify(cli(trace)),
        JSON.stringify(fw(trace)),
        `对拍分叉（${name}）：CLI 移植副本与框架侧产物不一致 —— 改生成格式必须两边同步`,
      );
    }
  });
});
