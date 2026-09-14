import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「被 await 的超时」必须在**空事件循环**下也能触发（2026-09-14，见 `docs/spec.md` §10 ④）。
 *
 * 起因：CI 上 `tests/engine/toolTiming.test.ts` 一次红法很怪 —— `# fail 0, # cancelled 4`，
 * 且 runner 自陈 `failureType: 'cancelledByParent'`、
 * `error: 'Promise resolution is still pending but the event loop has already resolved'`。
 * 根因：截止计时器 `unref()` 过。它的**触发本身就是「那个 await 得以结束」的条件**，
 * 一旦它是事件循环里唯一的把手，进程会在它触发前直接退出 —— 调用方**什么都没拿到**。
 *
 * 为什么用子进程：本性质的前提正是「进程里没有别的把手」。同进程跑测试时测试跑器自己就持有
 * 把手，会把缺陷藏起来 —— 所以必须另起一个干净的子进程（见 `tests/fixtures/timeoutLivenessProbe.ts`）。
 */
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const probe = join(repoRoot, 'tests', 'fixtures', 'timeoutLivenessProbe.ts');

function runProbe(which: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', probe, which],
      { cwd: repoRoot, timeout: 30_000 },
      (err, stdout, stderr) => {
        done({ code: err ? 1 : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
      },
    );
  });
}

describe('超时的活性（截止计时器不得 unref）', () => {
  for (const [which, expected, label] of [
    ['engine', /stopReason=end_turn errorKind=timeout/, '工具级超时：挂死的工具回到 end_turn'],
    ['mcp', /LIVENESS ok: mcp → .*调用超时/, 'MCP 调用超时：抛出「调用超时」'],
    ['drain', /LIVENESS ok: drain → false/, '优雅停机：预算耗尽返回 false'],
  ] as const) {
    it(`${label}（空事件循环下也必须 settle）`, async () => {
      const { code, out } = await runProbe(which);
      assert.equal(code, 0, `子进程非零退出：${out}`);
      assert.match(
        out,
        /LIVENESS ok:/,
        `探针没跑出结论 —— 进程极可能在截止计时器触发前就退出了（= 计时器被 unref 了）。原始输出：${out}`,
      );
      assert.match(out, expected, `结论不符合预期。原始输出：${out}`);
    });
  }
});
