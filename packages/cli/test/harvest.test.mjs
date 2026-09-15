import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/* 对构建产物测试（未构建时跳过而非报错），同 report.test.mjs 的约定。 */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SKIP = !existsSync(CLI) ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* 框架构建产物：只在它也在时才跑「CLI 与框架 harvestEvalCase 逐字同形」的对拍 */
const FW_HARVEST = fileURLToPath(new URL('../../../dist/eval/harvest.js', import.meta.url));

const turn1 = {
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
};
const turn2 = {
  spanId: 't2',
  parentSpanId: 's0',
  kind: 'llm.turn',
  name: 'claude-opus-5',
  startedAt: 20,
  status: 'ok',
  attributes: {},
  events: [],
};

function traceOf(traceId, status) {
  return {
    traceId,
    rootSpanId: 's0',
    status,
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
      { ...turn1 },
      { ...turn2 },
    ],
  };
}

/** TaskRecord 形态：spec.messages 是原始输入、result.trace 是完整 trace、status 是终态 */
function recordOf({ taskId, status, traceId, input }) {
  return {
    taskId,
    status,
    spec: { messages: [{ role: 'user', content: input }] },
    runId: traceId,
    result: { trace: traceOf(traceId, status === 'failed' ? 'error' : 'ok') },
  };
}

const okRecord = recordOf({
  taskId: 'task_1',
  status: 'succeeded',
  traceId: 'run-ok',
  input: '帮我查下北京天气',
});
const failedRecord = recordOf({
  taskId: 'task_2',
  status: 'failed',
  traceId: 'run-bad',
  input: '这一步挂了',
});
const bareTrace = traceOf('run-bare', 'ok');

function withFile(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-harvest-'));
  const file = join(dir, 'traces.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  try {
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('agentia harvest', { skip: SKIP }, () => {
  it('默认收全部记录：汇总成含 import 骨架与 defineEval 指引的 eval 脚手架', () => {
    withFile(
      [JSON.stringify(okRecord), JSON.stringify(failedRecord), JSON.stringify(bareTrace)],
      (file) => {
        const out = run(['harvest', file]);
        // 文件骨架
        assert.match(out, /import assert from 'node:assert\/strict';/);
        assert.match(out, /import \{ defineEval, scriptedClient \} from '@migor\/agentia';/);
        assert.match(out, /export const harvestedCases = \[/);
        assert.match(out, /EvalCase 没有 expect 字段/);
        // 三条记录 → 三个用例骨架；TaskRecord 的 spec.messages 进 input
        assert.equal(out.match(/client: scriptedClient\(\[/g).length, 3);
        assert.ok(out.includes('name: "harvest-run-ok",'));
        assert.ok(out.includes('name: "harvest-run-bad",'));
        assert.ok(out.includes('name: "harvest-run-bare",'));
        assert.ok(out.includes('input: "帮我查下北京天气",'));
        assert.ok(out.includes('input: "这一步挂了",'));
        // 裸 Trace 没有 spec.messages → input 占位 + 注释
        assert.match(out, /未提供原始输入（TaskRecord 的 spec\.messages）/);
        // tool_use 重建（原 id 保留）与轨迹断言
        assert.ok(out.includes('"id": "tu_a1"'));
        assert.ok(out.includes('assert.deepEqual(tools, ["search"]);'));
      },
    );
  });

  it('--failed 只收失败记录（TaskRecord status=failed；裸 trace status=error）', () => {
    withFile(
      [JSON.stringify(okRecord), JSON.stringify(failedRecord), JSON.stringify(bareTrace)],
      (file) => {
        const out = run(['harvest', file, '--failed']);
        assert.equal(out.match(/client: scriptedClient\(\[/g).length, 1);
        assert.ok(out.includes('name: "harvest-run-bad",'));
        assert.match(out, /仅失败/);
      },
    );
  });

  it('--limit 限制条数（先过滤再截断）', () => {
    withFile(
      [JSON.stringify(okRecord), JSON.stringify(failedRecord), JSON.stringify(bareTrace)],
      (file) => {
        const out = run(['harvest', file, '--limit', '2']);
        assert.equal(out.match(/client: scriptedClient\(\[/g).length, 2);
        assert.ok(out.includes('harvest-run-ok'));
        assert.ok(out.includes('harvest-run-bad'));
        assert.ok(!out.includes('harvest-run-bare'));
      },
    );
  });

  it('--out 写文件（stdout 只给摘要）；文件内容关键片段齐全', () => {
    withFile([JSON.stringify(okRecord)], (file, dir) => {
      const target = join(dir, 'harvested.eval.ts');
      const out = run(['harvest', file, '--out', target]);
      assert.match(out, /已写出 .+harvested\.eval\.ts：1 个用例骨架/);
      const content = readFileSync(target, 'utf8');
      assert.match(content, /import \{ defineEval, scriptedClient \} from '@migor\/agentia';/);
      assert.ok(content.includes('name: "harvest-run-ok",'));
      assert.ok(content.includes('"id": "tu_a1"'));
    });
  });

  it('无法解析的行被跳过并在头部注释计数，不炸', () => {
    withFile([JSON.stringify(okRecord), 'oops'], (file) => {
      const out = run(['harvest', file]);
      assert.match(out, /跳过无法解析 1 行/);
      assert.ok(out.includes('harvest-run-ok'));
    });
  });

  it('缺参数 / 文件不存在 / 没有可识别 trace / 坏 flag → 非零退出 + 说明', () => {
    assert.throws(
      () => run(['harvest']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /用法：agentia harvest/);
        return true;
      },
    );
    assert.throws(
      () => run(['harvest', '/tmp/definitely-not-here.jsonl']),
      (e) => {
        assert.equal(e.status, 1);
        assert.match(String(e.stderr), /读不到文件/);
        return true;
      },
    );
    withFile(['{"nope":1}'], (file) => {
      assert.throws(
        () => run(['harvest', file]),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /没有可识别的 trace/);
          return true;
        },
      );
    });
    withFile([JSON.stringify(okRecord)], (file) => {
      assert.throws(
        () => run(['harvest', file, '--limit', '0']),
        (e) => {
          assert.equal(e.status, 1);
          assert.match(String(e.stderr), /--limit 需要一个正整数/);
          return true;
        },
      );
    });
  });

  it('--help 里列出 harvest', () => {
    assert.match(run(['--help']), /agentia harvest <trace\.jsonl>/);
  });

  it('CLI 生成器与框架侧 harvestEvalCase 逐字同形（移植漂移对拍）', async () => {
    if (!existsSync(FW_HARVEST)) return; // 框架未构建时跳过（对拍是加强校验，不是门禁主体）
    const { harvestEvalCase } = await import(FW_HARVEST);
    withFile([JSON.stringify(bareTrace)], (file) => {
      // CLI 对裸 trace 的调用形状：无 spec.messages，name 按 traceId，source 是文件名
      const fw = harvestEvalCase({
        trace: bareTrace,
        name: 'harvest-run-bare',
        source: file,
      });
      // CLI 汇总文件里把每个用例骨架缩进了两格 —— 反缩进后应逐字包含框架产物
      const out = run(['harvest', file]);
      const deindented = out.replace(/^ {2}/gm, '');
      assert.ok(
        deindented.includes(fw.trim()),
        'CLI 产物与框架 harvestEvalCase 漂移了 —— packages/cli/src/harvest.ts 是逐行移植，改生成格式要两边同步',
      );
    });
  });
});
