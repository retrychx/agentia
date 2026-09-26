# 边界表守卫 + CLI 平台分派可测化 设计与实施

> **状态**：**已实施完成**（2026-09-26）。两处分叉按下方推荐执行（用户在同一条消息里授权
> 「落个文档，并开始严格开发验证」）。反向验证读数、两条守卫的登记、以及实施中发现的偏差见
> 本文末尾「实施记录」。
>
> 范围：**只加守卫与可测化，不改框架语义**。`src/` 零改动；`packages/cli/src/dev-child.ts`
> 有一处**纯函数抽取**（行为逐字不变，见 Phase B）。

## ⚠️ 实施记录：三处与设计不同的地方（写下来，免得下一轮按设计稿误解现状）

1. **A3 的 `pin` 判据从「子串在场」改成「整条标题相等」。** 设计稿写的是 marker 必须出现在
   用例标题里；第一版实现用了 `titles.some(t => t.includes(marker))`，变异 M4（把被引用用例的
   标题加一个字）**照样绿** —— 与本仓记过的 `rawArg` → `rawArgument`（子串匹配照样绿，
   M76 exit 0）同一个坑。⇒ 改成整条相等，38 条 pin 里 37 条换成**标题原文**；
   `scripts/check-import-floor.mjs` 那条没有「用例标题」概念，退回「逐字在场 + 长度 ≥ 12」。
2. **`structure.test.mjs` 的规模棘轮按仓库惯例补账**：`dev-child.ts` 82 → 112、总量
   8290 → 8320（+30）。设计稿没预见到 —— 该文件对 CLI 源码有单文件与总量双基线。
3. **两条守卫都落进既有套件 glob**（`tests/**/*.test.ts` / `packages/cli/test/*.test.mjs`），
   **没有加 verify-all 步数** —— 设计稿的验收第 1 条成立。

## ⚠️ 纪律（本轮踩到两次，写进这里）

**变异脚本必须跑在已提交的树上。** 变异靠 `git checkout --` 复原，而它会连**未提交的改动**
一起抹掉：第一次抹掉了 Phase B 的源码改动（于是后两条变异打在空气上、dist 里没有 `killPlanFor`
⇒ 全红，看起来像「守卫全面咬人」的假象），第二次抹掉了 A3 的判据改进（M4 因此没打上）。
⇒ **先 commit，再变异。**

---

## ⚠️ 勘误：上一轮「CLI 平台分支零门禁」是**错的**，本轮的 B 阶段据此改口径

提出本轮前我只做了两条读数，两条都错在有**同一个方法论缺陷**——按「我猜的文件位置 + 我猜的扩展名」
去数，而不是先读测试运行器实际收哪些 glob：

| 我上轮用的判据 | 读数 | 真实情况 |
|---|---|---|
| `find packages/cli -name '*.test.ts'` | 0 ⇒ 判「CLI 零单测」 | CLI 套件是 **`packages/cli/test/*.test.mjs`（14 个文件）**，扩展名是 `.mjs` —— `scripts/test-all.mjs` 里明写着这是**独立一个套件**（`{ name: 'CLI 套件（packages/cli/test/*.test.mjs）' }`） |
| `grep -rn "win32\|powershell\|taskkill" tests/` | 0 ⇒ 判「平台分支无覆盖」 | 那只搜了**框架套件目录** `tests/`。CLI 侧 `packages/cli/test/native-pick.test.mjs` **已有 14 条平台用例**：三平台分派、三种取消形态（含本地化 `(-128)` 与反向 -1743）、路径归一化（尾斜杠 / 根目录 / 空格 / 非 ASCII）、signal 视同取消、以及接线断言 |

**正确读数**：`native-pick.ts` 的平台分派**已被完整守住**，而且它之所以守得住，是因为接口形状是
**收平台参数的纯函数**（`resolvePicker(platform, has)`、`isCancel(platform, ...)`、
`normalizePickedPath(platform, ...)`，见 `packages/cli/src/native-pick.ts:54,82,105`）。

**留下来的真缺口更小、也更难辩解**：同一个包里 `dev-child.ts` 的 `killTree()`
（`packages/cli/src/dev-child.ts:62`）**直接读 `process.platform`**：

```ts
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {          // ← 测试改不动这个
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  process.kill(-pid, signal);                  // ← POSIX 进程组
  try { … } catch { child.kill(signal); }
}
```

所以 `taskkill /T /F` 那条分支（win32 唯一的进程树回收路径）**在任何平台上都跑不到**：
CI 是 ubuntu、macOS 走 POSIX 分支、而它在 win32 上只由用户真跑触发。**这不是「没人写测试」，
是「接口形状让人写不了」** —— 同一个仓库里 `native-pick.ts` 用参数注入就守住了，
`killTree` 用 `process.platform` 就没守住。差别是形状，不是勤奋。

⇒ 本轮 B 阶段的口径因此不同：**不是补平台用例（已经很多），而是把这条分派抽成可注入平台的纯函数，再补它自己的用例。**

---

## Phase A：`§7 已知边界` 的守卫（`tests/docs/boundary-table.test.ts`）

### 现状证据

`docs/usage-guide.md` 的 `## 7. 已知边界` 是一张 **77 行**的表（第 1392–1468 行），
逐条说明框架**不保证什么**（沙箱 / 配额 / 内容护栏 / 记忆无删除语义 / SSE 跨进程 /
预算粒度 / 缓存 TTL 低估 37.5% / 价格表精确匹配 / 图片 token 只按上界估 …）。
它是使用者判断「我能不能用这个框架」的**唯一依据**，也是仓库最厚的一张对外承诺表。

**它现在零守卫，而且是被解析器结构性地排除的：**

```ts
// tests/docs/usage-guide.test.ts:164-169
const first = line.slice(1).split('|')[0].trim();
const m = /^`([^`]+)`$/.exec(first);      // 首列必须「恰好是一个反引号标识符」
if (!m) { current = undefined; continue; } // §7 的首列是散文 ⇒ 整表零采集
```

仓库给**导出面**（`api-page.test.ts` 反向全覆盖）、**旧术语**（`no-legacy-terms.test.ts`）、
**帧名**（`sse-frames.test.ts`）、**提交引用**（`commit-refs.test.ts`）、**官网版式**都立了守卫，
唯独对使用者决策最重的那一页没有。

**会怎么烂**：某天有人实现了出站注入、换了默认 client、改了 store 的幂等档位或指标口径，
表里那几行就**变成假话而全绿**。这与仓库自己记过的「假守卫」是同一失败类
（`docs/guards.md` §2 尾注：断言是真的、绿的，只是它守的是**另一件事**），
而这一处更隐蔽：**连断言都没有**。

### 守卫设计（四条，全部机械可判）

**A1 · 标识符不悬空。** §7 全表（两列一起）里每个反引号 token，都要在**源码语料**里真实存在
（`src/` + `packages/*/src` + `packages/*/test` 的文本）。防的是「文档引用了一个已改名的东西」
（与 `commit-refs.test.ts` 同一形状：引用必须指向真东西）。
外部协议词（`function_call` / `[DONE]` / `finish_reason` / `SIGTERM` …）走**显式豁免表**，
每条带理由，且**豁免条数有上限**；另有 **`checked ≥ N` 防真空下限**（否则语料读空就全绿）。

**A2 · 行集合与登记表互为真值。** 登记的 key == 文档里的行集合，**双向**：
新写一条边界而不登记 ⇒ 红；删掉一条边界却留着登记项 ⇒ 红。

**A3 · `pin` 必须可证伪。** 登记项分三态，`pin` 的形状是 `{ file, marker }`：
**文件必须存在，且 `marker` 必须真的出现在该文件里**（用例文件里是那条 `it(...)` 的标题原文，
脚本里是那行代码/提示语）。⇒ 「钉住某条边界的用例」不是我说了算，是**能被机械证伪**的；
把 `marker` 写在登记表里也让审阅者一眼看得见**我到底钉的是哪条用例**。

**A4 · 三态都要在场，且不许一边倒。** `pin` / `choice`（设计选择，没有机制可钉，必须带理由）/
`gap`（机制有测试，但「这条边界仍然成立」这句话本身没有任何东西可证伪 —— **附最可能接上的用例**）。
另有下限：`pin ≥ 20`、`choice ≥ 10`，防「全标 choice 把表洗绿」。

`gap` 的语义要写清楚：**它不是「功能缺失」**，而是「这句话今天为真、明天可能为假，而没人会发现」。
这份清单本身就是本轮最值钱的产物 —— 它是 §7 的**「下一次 review 从这里开始」**，
与 `guards.md §2 待守` 同一哲学。

### 已知限制（如实标注）

- **`gap` 的判定是我的读法，不是仓库已声明的候选**。判定规则：该行声称的机制有没有用例
  （机械可查）+ 有没有用例钉住**这句话**（我读标题判）。标 `gap` 的行我给了候选文件，
  下一轮从这里接。
- **行文改动会让守卫红**（key 用的是首列文本的归一形态）。这是**有意**的：一条边界的措辞
  改了，就是它的**断言口径**改了，本来就该重读它的登记项。报错文案会直接给出「请更新登记表」
  与两个候选键。

---

## Phase B：`killTree` 的平台分派抽成纯函数（`packages/cli/`）

### 改动（不改行为）

`dev-child.ts` 抽出并导出一个**纯判定**，`killTree` 变成它的执行器：

```ts
export type KillPlan =
  | { kind: 'none' }                                   // 没有 pid：什么都不做
  | { kind: 'taskkill'; args: string[] }               // win32：taskkill /pid N /T /F
  | { kind: 'process-group'; pid: number; signal: NodeJS.Signals };  // 其余：对负 pid 发信号

/** 平台 → 杀树计划（**导出为单测用**；`platform` 可注入 ⇒ 三平台分支都测得到） */
export function killPlanFor(platform: NodeJS.Platform, pid: number | undefined, signal: NodeJS.Signals): KillPlan;

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void;  // 行为逐字不变
```

**行为等价断言**（写进用例头注，逐条对旧实现）：
`pid === undefined` ⇒ 直接返回（旧：`if (pid === undefined) return`）；
win32 ⇒ `spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })` 后返回（旧同）；
其余 ⇒ `process.kill(-pid, signal)`，抛错则回落 `child.kill(signal)`（旧同）。

### 新用例（`packages/cli/test/dev-child.test.mjs`）

跟 `native-pick.test.mjs` 同款：import `dist/` 产物（`distReadyOrLoud` 兜底），
`describe(..., { skip: SKIP })`，**不 spawn 任何东西**（`killTree` 的真执行会真的杀进程，
所以只测 `killPlanFor`）。

- `killPlanFor('win32', 1234, 'SIGTERM')` ⇒ `{ kind:'taskkill', args:['/pid','1234','/T','/F'] }`
  （**`/T` 是关键**：不带它就只杀直接子进程，`npx tsx` 的孙进程留下孤儿 —— 旧注释里
  的「整棵树」承诺就落在这里）；
- `killPlanFor('darwin'|'linux', 1234, sig)` ⇒ `{ kind:'process-group', pid:1234, signal:sig }`
  （**负 pid 由执行器负责**：计划里存正数、执行时才取负，这条要在用例里点名，否则
  「计划里是负数」与「执行时才取负」两种实现都能绿）；
- `killPlanFor(任何平台, undefined, sig)` ⇒ `{ kind:'none' }`；
- 源码级接线断言（照 `native-pick.test.mjs` 的「抽出来不接上等于没抽」）：`killTree` 必须
  经 `killPlanFor` 分派，且**不得再出现 `process.platform`**（这条把「新分支又被写死回去」钉住）。

### 非目标（YAGNI，写明理由）

- **不加 win32/macOS 的 CI 矩阵行**：`native-pick.test.mjs` 头注与 `docs/usage-guide.md` §7 都写着
  「**绝不能在 CI 真触发**原生对话框」；而进程树回收的真平台验证需要真起子进程再杀 ——
  收益（一条只能在 win32 上验的分支）与代价（每个 PR 多两行 runner + 一类新 flake）不成比例。
  纯函数化的目的正是**把平台分派从「需要那个平台」变成「不需要」**。
- **真端点 `e2e:live` 不加进门禁**：它要真 API 凭据、会引入网络 flake。触发条件已写在 §7 里
  （「接入官方端点前自己跑 `npm run e2e:live`」），属条件立项。

---

## 分叉与拍板

| # | 分叉 | 选项 | 拍板 | 理由 |
|---|---|---|---|---|
| 1 | 边界守卫的强度 | A) 只验标识符存在 B) A + 行↔用例登记（三态，`pin` 可证伪） C) B + 逐行钉住机制文本 | **B** | A 只防改名，防不了「这句话已经变假」；C 会把每行散文钉死、与「只断言在场、不钉措辞」冲突 |
| 2 | `pin` 的判据 | A) 共享标识符自动匹配 B) **文件 + `marker` 在场**（机械可证伪） C) 只写文件路径 | **B** | A 实测误报（「contextPolicy 不进子循环」被 `maxCostUsd` 命中）；C 允许引用一条其实不相关的用例，正是「假守卫」的温床 |
| 3 | `gap` 怎么处理 | A) 都算缺口、本轮全补 B) **登记成清单 + 附候选，不本轮补** C) 不区分、都标 choice | **B** | 77 行里大半的「边界」是**设计选择**（只给缝、刻意不内建），本就无机制可钉；把它们标成缺口是拿用户的钱买他没买的东西。B 给出诚实清单与下一轮起点 |
| 4 | CLI 平台分支 | A) 只加 CI 矩阵 B) 抽纯函数 + 单测（**本轮做**） C) 什么都不做（`native-pick` 已守住） | **B** | A 的代价与 §7「不得在 CI 真触发」冲突；C 漏掉 `killTree` 的形状问题 —— 差别不在勤奋，在接口形状 |

---

## 验收

1. `tests/docs/boundary-table.test.ts` 与 `packages/cli/test/dev-child.test.mjs` 落地并接入既有套件
   （**不改套件 glob、不改步数** ⇒ `verify-all` 第 1 步的口径不变）。
2. **变异电池**（逐条真跑、报读数）：见实施记录。至少覆盖 ① 新增一条边界不登记 ⇒ 红；
   ② 引用的 `marker` 改名 ⇒ 红；③ 标识符改成不存在的 ⇒ 红；④ 语料读空 ⇒ 防真空下限红；
   ⑤ `killPlanFor` 的 win32 分支去掉 `/T` ⇒ 红。
3. `bash scripts/verify-all.sh` **8/8 绿**（含 CLI 套件那一步）。
4. `docs/guards.md` §1.4 登记两条守卫（含反向验证读数）；`docs/spec.md` §10 补一条决策记录。
