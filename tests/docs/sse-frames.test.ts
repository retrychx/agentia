import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * SSE **帧名**的守卫：usage-guide 里用反引号写出的帧名（`task.end` / `stream.closed` …）
 * 必须真从 `src/transport/http.ts` 的 `sse.event('…')` 发出来。
 *
 * 为什么需要它：帧名是**字符串面**，不进类型系统 —— 文档与实现各说各话没有任何机械守卫
 * （2026-09-22 复核记录 §6 第 5 条：「`tests/docs` 对 `task.end` / `stream.closed` /
 * `trace.event` 零命中，帧名漂移无机械守卫」）。
 *
 * 口径与已知边界：
 * - 只扫**带点前缀**（task./stream./trace./text./run.）的反引号词 ⇒ 无点的 `error` 帧
 *   不在射程内（太泛，误报多）；它由 http.ts 侧的实现测试守。
 * - `trace.truncated` 是 **run 根的 attribute**（`tracer` 度量闸超限时的记账），
 *   **不是** SSE 帧 ⇒ 显式排除。哪天它真成了帧名，把排除项删掉即可。
 * - 单向（文档 ⇒ 实现）：文档不许写实现里没有的帧。反向（新帧必须写文档）由人评审守 ——
 *   自动做会误伤「内部帧不该进使用者文档」的正当取舍。
 */
describe('SSE 帧名：文档 ⇐ 实现（单向，文档不许说谎）', () => {
  const http = readFileSync(join(repoRoot, 'src', 'transport', 'http.ts'), 'utf8');
  const emitted = new Set([...http.matchAll(/sse\.event\('([^']+)'/g)].map((m) => m[1]));
  const guide = readFileSync(join(repoRoot, 'docs', 'usage-guide.md'), 'utf8');

  /** run 根的 attribute，不是 SSE 帧（见文件头） */
  const NOT_A_FRAME = new Set(['trace.truncated']);

  it('usage-guide 里每个带点前缀的反引号帧名都必须真被 emit', () => {
    const mentioned = new Set(
      [...guide.matchAll(/`((?:task|stream|trace|text|run)\.[a-z]+(?:\.[a-z]+)?)`/g)]
        .map((m) => m[1] as string)
        .filter((name) => !NOT_A_FRAME.has(name)),
    );
    // 防真空变绿：文档里确实提到了帧名、实现侧也确实在 emit（正则口径变了要在这里炸出来）
    assert.ok(mentioned.size >= 6, `文档侧帧名少于预期（${mentioned.size}）—— 抽取口径变了？`);
    assert.ok(emitted.size >= 7, `实现侧帧名少于预期（${emitted.size}）—— 抽取口径变了？`);
    const lying = [...mentioned].filter((name) => !emitted.has(name));
    assert.deepEqual(
      lying,
      [],
      `usage-guide 提到了实现里不存在的 SSE 帧：${lying.join('、')} ` +
        `（实现实际 emit：${[...emitted].sort().join('、')}）—— 要么文档写错了，要么帧改名了没同步`,
    );
  });
});
