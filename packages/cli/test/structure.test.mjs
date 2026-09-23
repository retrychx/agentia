import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/*
 * CLI（packages/cli）结构守卫 —— 方案 docs/plans/2026-09-23-cli-structure.md §3 横切 W。
 *
 * 为什么 CLI 需要单独一套：框架侧的 `tests/architecture/layering.test.ts` 守的是
 * 「分层单向 + 无环」，而 CLI 是**扁平**的一堆文件（没有分层可守）。真正会坏的形状是：
 *  - W1：文件越长越大却没人察觉（dev.ts 长到 1148 行、长出一台隐式状态机，就是这么来的）；
 *  - W2/W3：下发浏览器的模块悄悄多一条**值导入** ⇒ 产物带 `import './dev-protocol.js'` ⇒
 *    浏览器取不到（STATIC 白名单没有它）⇒ 面板白屏，而 node 侧单测照样全绿
 *    （它们 import 的是 TS 源，不受白名单约束）。
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const DIST_URL = new URL('../dist/', import.meta.url);

/** 下发浏览器的 CLI 自有模块（`inspector-routes.ts` 的 STATIC 白名单里、由页面 import 的那批） */
const BROWSER_MODULES = ['panel-logic', 'markdown'];

describe('CLI 结构守卫（W1 规模棘轮 / W2 产物零 import / W3 源码只 import type）', () => {
  // ---------- W1：规模棘轮（只许降不许升）----------
  // 基线 = 2026-09-23 治理启动时的实测（`wc -l packages/cli/src/*`）。
  // 纪律：存量条目只能**往下**调（拆分真做完了才调）；新增文件**必须**在这里登记
  // （不登记 = 「每个文件都在表里」那条断言会红）。棘轮在拆分期间持续偏红是有意的摩擦。
  const LINE_BUDGET = {
    'inspector-page.html': 1226,
    // 2026-09-23 A 阶段（抽纯判定 → dev-logic.ts）：1148 → 1133
    // 2026-09-23 B 阶段（显式状态机 → dev-machine.ts）：1133 → 1054
    // 2026-09-23 C 阶段（按职责切文件）：1054 → 776
    // （watch 件 → dev-watch.ts、子进程原语 → dev-child.ts；spawn/stop/restart 三个
    //   执行器读写机器状态，留在 dev.ts 接线层）
    'dev.ts': 776,
    // 2026-09-23（inspector 路由表拆分）：818 → 413。切走的 431 行去了
    // inspector-routes.ts；本文件只剩「服务」——监听 / 三道鉴权闸 / 应答原语 /
    // 公开类型（`DevHooks` 等）/ `HttpError`。那两个导出（`HttpError` / `startInspector`）
    // 是 `dev.ts` 与 `inspector.test.mjs` 的 dist 出口，不能动。
    'inspector.ts': 413,
    // 2026-09-23 新增（同上，**纯搬移**）：路由表（14 条路由各抽成命名函数）
    // + `RouteCtx` / `InspectorState` + `handleRoutes` 分发器 + 只被路由用到的件。
    'inspector-routes.ts': 545,
    'panel-logic.ts': 578,
    'dev-runner.ts': 547,
    'diff.ts': 443,
    'harvest.ts': 389,
    'dev-protocol.ts': 323,
    'markdown.ts': 296,
    'templates.ts': 259,
    'doctor.ts': 213,
    'cli.ts': 206,
    'native-pick.ts': 198,
    'report.ts': 194,
    'create.ts': 140,
    'dev-logic.ts': 58, // 2026-09-23 A 阶段新增（server 侧纯判定，单源化后注释只留一份）
    // 2026-09-23 B 阶段新增（显式状态机：类型 + update 纯函数；零副作用零 node:* import）
    'dev-machine.ts': 703,
    // 2026-09-23 C 阶段新增（自 dev.ts 纯搬移；dev.ts 保留 re-export 守住 dist/dev.js 出口）
    'dev-watch.ts': 224,
    'dev-child.ts': 82,
    'registry.ts': 93,
    'generate.ts': 82,
    'inspector-sink.ts': 75,
    'add.ts': 72,
    'npm-bin.ts': 59,
    'layout.ts': 51,
  };
  // 2026-09-23 实测总行数（`wc -l packages/cli/src/*`，wc 的计数 = 换行数）。
  // A 阶段后实测仍恰好 7410：dev.ts 1148→1133、新增 dev-logic 58，差额由同期
  // panel-logic 的收窄（578→535）吸收 —— 棘轮不抬。
  // ⚠️ B 阶段（2026-09-23）**抬了一次总量**：7410 → 8034。状态机文件的类型声明 +
  //   迁移规则注释（DevEventIn / DevEffect 两个判别联合）是净新增，而 dev.ts 里的
  //   watch / killTree / spawn 接线件要等 C 阶段才切出去 —— 方案 §3 B 预估的
  //   「dev.ts ~300 行 + dev-machine ~200 行」是 **B+C 做完之后**的形状。C 阶段
  //   拆分时必须把总量压回去（届时本条注释与基线一起调）。
  // C 阶段（2026-09-23）落账：8034 → 8062。B 注释里「C 阶段压回去」的承诺**只兑现了
  //   一半**：dev.ts 1054 → 776（watch 件与子进程原语各归各家），但总量**压不回 7410**
  //   —— 纯搬移的净增是 +28 行（两个新文件的头部注释 + import/re-export 行；搬走的
  //   「为什么」注释随代码走、行数原样带走），而 B 抬上来的 624 行里大头是
  //   dev-machine.ts 的类型与迁移注释本体，不是待切走的接线件。再往下降只能靠删注释
  //   或真删行为，都不是「纯搬移」该做的事 —— 如实记 8062，不留谎。
  // 补账（2026-09-23）：8062 → 8102（+40）。`inspector-page.html` 已经 import 了
  //   `filterSelected` / `formatToolSources` / `chatViewVisible` / `turnKey` 四个名字、
  //   `panel-logic.test.mjs` 也逐条钉了它们的行为，但 `panel-logic.ts` 里**没有实现** ——
  //   当时的工作区是**面板白屏**状态（浏览器 import 一个不存在的导出 = 整块模块求值失败）。
  //   这 40 行不是新功能，是把页面与测试**已经欠着**的东西补上；不补则面板起不来。
  //   `panel-logic.ts` 的单文件基线**没有为它抬价**（575 ≤ 578，走原基线）。
  // 补账（2026-09-23，inspector 路由表拆分）：8102 → 8242（+140）。
  //   搬移本身只带走 431 行，净增的 140 行**全是新文件的结构开销**，逐项：
  //     +21  inspector-routes.ts 头注（切分口径 / 依赖方向 / 为什么不是换 HTTP 框架）
  //     +15  import 块（原文件那批 import 要按「谁用谁引」在两个文件间重分）
  //     +14  InspectorState（4 个集合收成一个对象，好在 ctx 里整体传递）
  //     +30  RouteCtx（每请求一份的上下文；字段 = 原来闭包捕获的那批）
  //     +25  handleRoutes 分发器（原来是 handler 里一串 if，现在是「路径 → 命名 handler」）
  //      +9  14 个 handler 的函数签名与分隔空行
  //     +26  inspector.ts 侧：baseCtx 注入面 + state 对象化 + 解释「为什么切」的注释
  //   与 B / C 两次抬价的理由同类：**净增是注释与类型声明本体，不是待搬走的代码**。
  //   再往下降只能删注释或删行为 —— 都不是「纯搬移」该做的事，如实记 8242。
  const TOTAL_BUDGET = 8242;

  it('W1 规模棘轮：单文件不超基线、总量不超基线、每个文件都登记在表', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts') || f.endsWith('.html'));
    let total = 0;
    const problems = [];
    for (const f of files) {
      // 与 `wc -l` 同口径：数换行符（文件末的尾换行使 split('\n').length 会多 1）
      const lines = (
        readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').match(/\n/g) ?? []
      ).length;
      total += lines;
      const budget = LINE_BUDGET[f];
      if (budget === undefined) {
        problems.push(`新文件 ${f} 没在 LINE_BUDGET 里登记（新增文件必须显式登记基线）`);
      } else if (lines > budget) {
        problems.push(`${f} 超了：${lines} 行 > 基线 ${budget}（棘轮只许降不许升）`);
      }
    }
    const unregistered = Object.keys(LINE_BUDGET).filter((f) => !files.includes(f));
    for (const f of unregistered) {
      problems.push(`${f} 在基线表里但文件不存在了（删文件要把基线条目一起删）`);
    }
    if (total > TOTAL_BUDGET) {
      problems.push(`总行数 ${total} > 基线 ${TOTAL_BUDGET}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  // ---------- W3：源码侧前置（不依赖 dist 就能红）----------
  it('W3 下发浏览器的模块只许 `import type`（值导入 ⇒ 产物带真 import ⇒ 浏览器 404 ⇒ 白屏）', () => {
    for (const name of BROWSER_MODULES) {
      const src = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      assert.equal(
        /^import\s+(?!type\b)/m.test(src),
        false,
        `${name}.ts 出现了值导入 —— 它会随产物下发浏览器，而 STATIC 白名单里没有它的依赖`,
      );
      assert.equal(
        /^export\s*(\*|\{[^}]*\})\s*from/m.test(src),
        false,
        `${name}.ts 出现了 re-export —— 同上，产物会带真 import`,
      );
    }
  });

  // ---------- W2：产物侧（真 import 在编译后才现形）----------
  const distMissing = BROWSER_MODULES.some((f) => !existsSync(new URL(`${f}.js`, DIST_URL)));
  if (distMissing) {
    distReadyOrLoud(
      fileURLToPath(new URL('../dist/panel-logic.js', import.meta.url)),
      'CLI 构建产物',
    );
  }
  it('W2 产物 panel-logic.js / markdown.js 运行期零 import', { skip: distMissing }, () => {
    for (const name of BROWSER_MODULES) {
      const built = readFileSync(new URL(`${name}.js`, DIST_URL), 'utf8');
      // 只看**行首**：tsc 会保留注释（块注释里可能出现 "import" 字样），行首的才是真语句
      assert.equal(
        /^import\s/m.test(built),
        false,
        `dist/${name}.js 带有运行期 import —— 浏览器取不到它的依赖（STATIC 白名单），面板白屏`,
      );
      assert.equal(
        /^export\s*(\*|\{[^}]*\})\s*from/m.test(built),
        false,
        `dist/${name}.js 带有 re-export —— 同上`,
      );
    }
  });
});
