import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/*
 * dev 环 server 侧纯判定（dist/dev-logic.js）的单测 —— 方案
 * docs/plans/2026-09-23-cli-structure.md §3 A（抽纯判定）的配套。
 *
 * 为什么这些判定值得单测：它们曾经是 dev.ts 闭包里的内联 `if`，而 F1（闸只看 running
 * 漏了 launching）/ G1（`??` 把上一代旧错误当成这一代退出原因）那类缺陷**只能真起进程
 * 才验得到**。抽成纯件之后，判据本身在这里钉死；「谁在什么时候调用它」仍由
 * scripts/e2e-dev.ts 守（那是拆分期间的安全网）。
 *
 * ⚠️ 反向验证记录（2026-09-23，本文件落地时真做过，不是口头承诺）：
 * 把 `exitReason` 的判据临时改回 G1 之前的 `lastError ?? generic` 语义（src 改完
 * 重新 build:cli）⇒ 「lastError === errBaseline ⇒ 回通用文案」那条断言**变红**
 * （拿到的是上一代留下的旧错误文案，正是 G1 的归因误导）；改回 errBaseline 判据、
 * 重新构建后转绿。这证明下面的断言真的钉着 G1 的判据，而不是钉一句永远成立的话。
 */

/* 对构建产物测试（未构建时跳过而非报错）—— 与 panel-logic.test.mjs 同一模式 */
const DIST = fileURLToPath(new URL('../dist/dev-logic.js', import.meta.url));
let L = null;
if (existsSync(DIST)) L = await import(new URL('../dist/dev-logic.js', import.meta.url).href);
const SKIP = !L ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

describe('dev 环 server 侧纯判定（dev-logic）', { skip: SKIP }, () => {
  it('受理闸（canAcceptRun）：running 与 launching 任一在飞都拒（F1 的闸）', () => {
    assert.equal(L.canAcceptRun({ running: false, launching: false }), true);
    assert.equal(L.canAcceptRun({ running: true, launching: false }), false);
    // launching 窄窗口（已受理、await restart 中、run 还没发出）也必须拒 ——
    // 只判 running 正是 F1 漏掉的那条路径（两个 runOnce 并发、pendingNote 挂错 traceId）
    assert.equal(
      L.canAcceptRun({ running: false, launching: true }),
      false,
      'launching 窄窗口必须拒（F1）',
    );
    assert.equal(L.canAcceptRun({ running: true, launching: true }), false);
  });

  it('延后重启（shouldDeferRestart）与受理闸是**同一条**忙闲判据（逐格对拍）', () => {
    // onFileChange 的「在飞就 pendingRestart 延后」与 submitRun 的 409 闸若各写一份
    // `running || launching`，改一处漏一处就是 F1 的复现 —— 这里逐格对拍，漂开即红。
    for (const running of [false, true]) {
      for (const launching of [false, true]) {
        assert.equal(
          L.shouldDeferRestart({ running, launching }),
          !L.canAcceptRun({ running, launching }),
          `running=${running} launching=${launching}`,
        );
      }
    }
    // 闲时才此刻重启（不延后）
    assert.equal(L.shouldDeferRestart({ running: false, launching: false }), false);
  });

  it('退出原因（exitReason）：这一代写出新原因才用它，否则用通用文案（G1 的判据）', () => {
    // spawn 时基线是 null、这一代没写新原因 ⇒ 通用文案
    assert.equal(L.exitReason({ lastError: null, errBaseline: null, generic: 'G' }), 'G');
    // 基线是 null，但 runner 先发来具体原因（装配失败的 run-error）再退出 ⇒ 用那句人话
    assert.equal(
      L.exitReason({ lastError: '装配失败：x', errBaseline: null, generic: 'G' }),
      '装配失败：x',
      '已写出的具体原因不能被通用文案盖掉',
    );
    // ⚠️ G1 的核心：基线是上一代留下的旧错误、这一代没写新原因 ⇒ **不能**把旧错误当原因
    //    （`lastError ?? generic` 在这里会返回旧错误 = 归因误导。反向验证改回那句时红的就是这条）
    assert.equal(
      L.exitReason({ lastError: '上一轮 run 失败', errBaseline: '上一轮 run 失败', generic: 'G' }),
      'G',
      'lastError === errBaseline 是「没写新原因」，不是「原因」（G1）',
    );
    // 这一代写了新原因（与基线不同）⇒ 用新的
    assert.equal(
      L.exitReason({ lastError: '新原因', errBaseline: '旧错误', generic: 'G' }),
      '新原因',
    );
    // 上一轮成功后告警条清过（lastError 回到 null）、基线是旧错误 ⇒ 仍是「没写新原因」
    assert.equal(L.exitReason({ lastError: null, errBaseline: '旧错误', generic: 'G' }), 'G');
    // 通用文案由调用方给（未就绪退出 / 在飞意外退出两条路径文案不同），纯件不内嵌文案
    assert.equal(
      L.exitReason({ lastError: null, errBaseline: null, generic: '意外退出' }),
      '意外退出',
    );
  });

  it('中止幂等（abortDecision）：升级计时器在 ⇒ idempotent，不再挂第二个', () => {
    assert.equal(L.abortDecision({ hasTimer: true }), 'idempotent');
    assert.equal(L.abortDecision({ hasTimer: false }), 'send');
  });

  it('能力选择比较（sameToolSources）：null/undefined 形状 + 逐元素', () => {
    assert.equal(
      L.sameToolSources(null, undefined),
      true,
      '全量 == 全量（prev null / next undefined）',
    );
    assert.equal(L.sameToolSources(['a', 'b'], ['a', 'b']), true);
    assert.equal(L.sameToolSources([], []), true);
    // 顺序不同算不同 —— 顺序归一是上游 normalizeToolSources 的活（字典序），这里不重复做
    assert.equal(L.sameToolSources(['a', 'b'], ['b', 'a']), false);
    assert.equal(L.sameToolSources(['a'], ['a', 'b']), false);
    // 全量 ↔ 收窄是「变了」（两个方向都要重启进程）
    assert.equal(L.sameToolSources(null, ['a']), false);
    assert.equal(L.sameToolSources(['a'], undefined), false);
    // null/undefined 是两侧各自的「全量」约定，不交叉配对
    assert.equal(
      L.sameToolSources(null, []),
      false,
      'null 只与 undefined 配对（normalizeToolSources 永不传空数组）',
    );
    // 为什么分隔符是 \u0000 而不是缺省的逗号：来源名里若出现逗号，
    // join(',') 会把 ['a,b'] 与 ['a','b'] 拼成同一串（误判「没变」⇒ 该重启的不重启）
    assert.equal(L.sameToolSources(['a,b'], ['a', 'b']), false, '逗号分隔会撞串');
  });

  it('选择器串行化（pickGate）：在飞 ⇒ reject（系统对话框同时只许一个）', () => {
    assert.equal(L.pickGate({ inFlight: true }), 'reject');
    assert.equal(L.pickGate({ inFlight: false }), 'accept');
  });
});
