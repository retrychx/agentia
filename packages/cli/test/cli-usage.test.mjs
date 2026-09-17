import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错），同 report.test.mjs 的约定。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SKIP = !existsSync(CLI) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
if (SKIP) distReadyOrLoud(CLI, 'CLI 构建产物');

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

/** 一条最小可 harvest 的 trace（run 根 + 一个带 tool.input 的 llm.turn） */
const TRACE = {
  traceId: 'r1',
  rootSpanId: 's0',
  status: 'ok',
  spans: [
    {
      spanId: 's0',
      parentSpanId: null,
      kind: 'run',
      name: 'agent.run',
      startedAt: 0,
      status: 'ok',
      attributes: {},
      events: [],
    },
    {
      spanId: 't1',
      parentSpanId: 's0',
      kind: 'llm.turn',
      name: 'claude-opus-5',
      startedAt: 10,
      status: 'ok',
      attributes: {},
      events: [
        {
          time: 11,
          name: 'tool.input',
          body: { tool: 'search', tool_use_id: 'tu_a1', input: '{"q":"北京天气"}' },
        },
      ],
    },
  ],
};

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CLI 用法与错误路径', { skip: SKIP }, () => {
  it('子命令 --help 打出该命令的用法（此前会被当成要读的文件名）', () => {
    for (const cmd of ['create', 'g', 'dev', 'doctor', 'report', 'harvest', 'diff', 'add']) {
      const r = run([cmd, '--help'], tmpdir());
      assert.equal(r.status, 0, `agentia ${cmd} --help 退出码应为 0（stdout=${r.stdout}）`);
      assert.match(r.stdout, /^用法：agentia /m, `agentia ${cmd} --help 应打出用法`);
      assert.equal(r.stderr, '', `agentia ${cmd} --help 不应报错`);
    }
  });

  it('create：目标路径是普通文件 → 可读报错，而不是裸 ENOTDIR 栈', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 'my-app'), 'not a directory');
      const r = run(['create', 'my-app'], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /已存在且不是目录/);
      assert.ok(!r.stderr.includes('ENOTDIR'), `不该漏出原始 ENOTDIR：${r.stderr}`);
    });
  });

  it('harvest：--out 指向已存在文件默认拒绝覆盖（--force 才写）', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 't.jsonl'), `${JSON.stringify(TRACE)}\n`);
      const kept = '// 我手改过的断言：expect(x).toBe(1)\n';
      writeFileSync(join(dir, 'cases.ts'), kept, 'utf8');

      const refused = run(['harvest', 't.jsonl', '--out', 'cases.ts'], dir);
      assert.equal(refused.status, 1, `应拒绝覆盖（stdout=${refused.stdout}）`);
      assert.match(refused.stderr, /已存在/);
      assert.equal(
        readFileSync(join(dir, 'cases.ts'), 'utf8'),
        kept,
        '人工核对过的产物必须原样保留',
      );

      const forced = run(['harvest', 't.jsonl', '--out', 'cases.ts', '--force'], dir);
      assert.equal(forced.status, 0, `--force 应放行（stderr=${forced.stderr}）`);
      assert.ok(
        !readFileSync(join(dir, 'cases.ts'), 'utf8').includes('我手改过'),
        '--force 后才是真正重写',
      );
    });
  });

  it('harvest：trace 里没有 llm.turn 时不写坏产物（保持可读报错）', () => {
    withTmp((dir) => {
      writeFileSync(join(dir, 'bad.jsonl'), 'not json\n');
      const r = run(['harvest', 'bad.jsonl', '--out', 'out.ts'], dir);
      assert.equal(r.status, 1);
      assert.ok(!existsSync(join(dir, 'out.ts')), '失败时不该留下产物文件');
    });
  });
});
