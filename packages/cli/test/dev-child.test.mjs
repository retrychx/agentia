import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。⚠️ 绝不真调 killTree() ——
 * 它会真发信号杀进程（在某平台上还会拉 taskkill）；这里只测纯判定 killPlanFor
 * 与「分派接线」。 */
const DIST = fileURLToPath(new URL('../dist/dev-child.js', import.meta.url));
let D = null;
if (existsSync(DIST)) D = await import(new URL('../dist/dev-child.js', import.meta.url).href);
const SKIP = !D ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

/**
 * 为什么这个文件存在（2026-09-26）：
 *
 * `killTree` 原本**直接读 `process.platform`**，于是 win32 那条 `taskkill /T /F` 分支
 * 在任何平台上都跑不到 —— CI 是 ubuntu、macOS 走 POSIX 分支，win32 只在用户真跑时才第一次
 * 执行。**同一个包里 `native-pick.ts` 的分派收平台参数，因此有十几条平台用例。**
 * 差别不在勤奋，在接口形状。⇒ 本轮把分派抽成 `killPlanFor(platform, pid, signal)` 纯函数。
 *
 * 行为等价的逐条依据（抽取前后的对照，执行器一字未改语义）：
 *   - `pid === undefined` ⇒ 直接返回          （旧 `if (pid === undefined) return;`）
 *   - win32               ⇒ taskkill /pid N /T /F（旧同，同一组参数）
 *   - 其余平台            ⇒ `process.kill(-pid, signal)`，抛错回落 `child.kill(signal)`（旧同）
 */
describe('dev-child：杀树计划（killPlanFor 纯判定）', { skip: SKIP }, () => {
  it('win32 → taskkill，且必须带 /T（不带就只杀直接子进程，孙进程留下孤儿）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const plan = D.killPlanFor('win32', 1234, 'SIGTERM');
    assert.equal(plan.kind, 'taskkill');
    assert.deepEqual(plan.args, ['/pid', '1234', '/T', '/F']);
    assert.ok(
      plan.args.includes('/T'),
      '「整棵树」的承诺全落在这个开关上 —— 去掉它，npx tsx 的孙进程会留成孤儿',
    );
    assert.ok(plan.args.includes('/F'), 'win32 上不加 /F 会弹确认框，无人值守场景等于没杀');
  });

  it('darwin / linux / 其它平台 → 对**进程组**发信号；计划里存**正** pid', async (t) => {
    if (SKIP) return t.skip(SKIP);
    for (const platform of ['darwin', 'linux', 'freebsd']) {
      const plan = D.killPlanFor(platform, 1234, 'SIGTERM');
      assert.equal(plan.kind, 'process-group', `${platform} 应走 POSIX 进程组分支`);
      assert.equal(plan.pid, 1234);
      assert.ok(
        plan.pid > 0,
        '计划里存正 pid —— 取负（负 pid = 进程组）是执行器的事，不是计划的事',
      );
      assert.equal(plan.signal, 'SIGTERM', '信号原样透传（SIGTERM 优雅退出 / SIGKILL 补刀都用它）');
    }
    assert.equal(D.killPlanFor('linux', 1234, 'SIGKILL').signal, 'SIGKILL');
  });

  it('没有 pid（早已退出）⇒ none（任何平台都不许发信号）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    for (const platform of ['darwin', 'win32', 'linux']) {
      assert.deepEqual(D.killPlanFor(platform, undefined, 'SIGKILL'), { kind: 'none' });
    }
  });
});

/**
 * 接线判据（源码级）：抽出来不接上等于没抽 —— 同 `native-pick.test.mjs` 的风格。
 *
 * 第一条守「执行器真走计划」，第二条守「分支不许再被写死回执行器里」（否则下一个人
 * 加平台分支时又会写出一个测试够不着的分支，正是本轮要修的那个形状）。
 */
describe('dev-child：分派接线（源码级）', () => {
  const src = (rel) =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
  const childSrc = src('dev-child.ts');
  const devSrc = src('dev.ts');

  it('killTree 经 killPlanFor 分派，且三态各有出口', () => {
    assert.match(
      childSrc,
      /export function killTree\(/,
      'killTree 仍是执行器（对外的名字不变，dev.ts 那 7 处调用不受影响）',
    );
    assert.match(
      childSrc,
      /const plan = killPlanFor\(process\.platform, child\.pid, signal\)/,
      'killTree 必须把平台交给计划函数 —— 这一行就是「平台被注入」的全部内容',
    );
    assert.match(childSrc, /plan\.kind === 'none'/, 'none ⇒ 什么都不做');
    assert.match(childSrc, /plan\.kind === 'taskkill'/, 'taskkill ⇒ 拉 taskkill（win32）');
    assert.match(childSrc, /process\.kill\(-plan\.pid, signal\)/, 'POSIX ⇒ 负 pid 发信号');
  });

  it('`process.platform` 在 dev-child.ts 的**代码**里只出现一次（就是那一处注入）', () => {
    // ⚠️ 必须先剥注释再数：本文件的两处注释里就有 `process.platform` 这个词（解释「为什么抽」），
    // 裸标识符判定会被自己的说明文案误命中 —— 与 `templates.test.mjs` 那条
    // 「main.ts 的报错文案里就有 loadEnvFile()，裸判会误红」同一个坑。
    const codeOnly = childSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = codeOnly.match(/process\.platform/g) ?? [];
    assert.equal(
      hits.length,
      1,
      '分支判断不许绕开 killPlanFor 直接读 process.platform —— 那样又会出现一个测试够不着的平台分支',
    );
  });

  it('dev.ts 真接线：import killTree 且有多处调用（抽出去没人用 = 没抽）', () => {
    assert.match(devSrc, /import \{[^}]*killTree[^}]*\} from '\.\/dev-child\.js'/);
    const calls = devSrc.match(/\bkillTree\(/g) ?? [];
    assert.ok(calls.length >= 3, `dev.ts 里应有 ≥3 处 killTree 调用，实际 ${calls.length}`);
  });
});
