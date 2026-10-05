# dev 调试工作台：trace 落盘 + 并排 A/B（档A + 档 B）

> 撰写时刻：**2026-10-05**。来源：2026-10-05 讨论「CLI 的agent 调试工作台还有多大工作量」
> 的结论 —— 盘出三个档位，本稿只做 **档 A（落盘）** 与**档 B（并排 A/B）**，
> **档 C（挂起 / 审批可见，明确不做）**，理由见 §7。
> 定位判据复核：本稿**零 `src/` 改动**，全部在 `packages/cli` 内 ⇒ 不违反「不逼核心变厚」。

## 0. 一句话

让 `agentia dev` 面板的两次 run **可比**：第一次的 trace 落盘成CLI 三个命令能吃的文件，
第二次跑完能与第一条**并排看差在哪**（`diffTraces`），改一句 prompt 就能立刻重跑对照。

## 1. 事实基础（逐条核证过，标了 file:line）

| # | 事实 | 出处 |
|---|---|---|
| 1 | dev环的 trace 走 `registerDefaultTraceSink(createInspectSink(...))` ⇒ POST到父进程 `/ingest` 进**内存** `state.runs` | `packages/cli/src/dev-runner.ts:480-496`、`inspector-sink.ts:11-33` |
| 2 | 内存 ring buffer `MAX_RUNS = 50` / `MAX_NOTES = 50`；**无落盘、无跨进程、无重启恢复** | `packages/cli/src/inspector.ts:209-215, 239-243` |
| 3 | **框架已有现成落盘件**：`jsonlTraceSink({ path })` —— 一行一条裸 `Trace` 追加，构造期递归建父目录，写失败抛给调用方（`flushSinks` 吞掉落 warn） | `src/integrations/file-sink.ts:21-28` |
| 4 | 该 sink 的注释逐字点名：它是 CLI `report` / `diff` / `harvest` 三件套的**输入格式**（每行一个裸 Trace） | `src/integrations/file-sink.ts:8-9` |
| 5 | 前缀是**单进程写者**前提（多进程写同一文件会交错）⇒ dev 环只有 runner 一个写者，**天然满足** | `src/integrations/file-sink.ts:17-19` |
| 6 | 增量出口（`onTraceEvent` → `eventSink.send`）与落盘 sink 是**两条缝**，落盘不替代增量（增量是「此刻看到什么」，落盘是「事后能查什么」） | `dev-runner.ts:454`、`inspector-sink.ts:35-49` |
| 7 | ⚠️ **单飞闸与「延后重启」共用同一条判据**：`canAcceptRun` 与 `shouldDeferRestart` 都是 `!running && !launching`，`shouldDeferRestart` 刻意**委托** `canAcceptRun` | `packages/cli/src/dev-logic.ts:11-19` |
| 8 | 相位机是**单值** `run: RunPhase`（`idle`/`launching`/`running`/`aborting`），折算成布尔的唯一入口是 `runGateFlags` | `packages/cli/src/dev-machine.ts:58, 65, 255-260` |
| 9 | runner 侧还有**第二个**单飞标志 `let runInFlight = boolean`（含「`currentAbort` 还没建出来」的窄窗口，与 `abortRequested` 配对） | `packages/cli/src/dev-runner.ts:423-425, 434` |
| 10 | runner 的 app 按 `appKey(workdir, toolSources)` 缓存复用 ⇒ **同参数的两条 run 共享同一个 app 实例**（无状态冲突风险，`app.run` 本身无实例态） | `dev-runner.ts:387-403` |
| 11 | 面板选中态是**单值** `state.current: string \| null`，`open(id)` 拉 `/api/runs/:id` 后整树重绘 | `inspector-page.html:393, 885-908` |
| 12 | `diffTraces` 已是框架公共导出；CLI 侧有**去类型移植副本**（`diff.ts`，注释声明「改算法必须两边同步」，逐字对拍守护在 `test/diff.test.mjs`） | `src/index.ts:190`、`packages/cli/src/diff.ts:1-10` |
| 13 | ⚠️ **CLI 有规模棘轮**：`LINE_BUDGET`（逐文件）+ `TOTAL_BUDGET`（总量），**只许降不许升**；新文件**必须**登记 | `packages/cli/test/structure.test.mjs:29-89, 143` |
| 17 | 面板选中态是**单值** `state.current: string \| null`，`open(id)` 拉 `/api/runs/:id` 后整树重绘 | `inspector-page.html:393, 885-908` |
| 18 | `diffTraces` 已是框架公共导出；CLI 侧有**去类型移植副本**（`diff.ts:443` 行，注释声明「改算法必须两边同步」，逐字对拍守护在 `test/diff.test.mjs`） | `src/index.ts:190`、`packages/cli/src/diff.ts:1-10` |
| 19 | ⚠️ **CLI 有规模棘轮**：`LINE_BUDGET`（逐文件）+ `TOTAL_BUDGET = 8671`（总量），**只许降不许升**；新文件**必须**登记 | `packages/cli/test/structure.test.mjs:29-89, 143` |
| 20 | `panel-logic.ts` 已有单测（723 行 / 33 个 `it`）—— 补单测不是缺口（**更正 2026-10-05 会话里的说法**） | `packages/cli/test/panel-logic.test.mjs` |
| 21 | `.agentia/` 已被脚手架 gitignore（`node_modules`/`dist`/`.env` 之后）⇒ 落盘位置不进版本库 | `packages/cli/templates/gitignore:8-9` |
| 22 | 面板侧下发浏览器的模块白名单只有 `panel-logic` + `markdown`（W2/W3 守卫）⇒ **任何服务端新能力不能顺手加进这个白名单** | `structure.test.mjs:22` |
| 23 | 「换能力选择 ⇒ 重启进程」的判据是 `sameToolSources`；换工作目录**不**重启 | `dev-logic.ts:35-39`、`dev-machine.ts:499-508` |
| 24 | ⚠️ `diffTraces` 找根靠 `spans.find(s => s.spanId === a.rootSpanId)`，**找不到就整棵 walk 都不走** ⇒ `equal` 恒 `true` | `packages/cli/src/diff.ts:149-165` |
| 25 | ⚠️ `pushAttrDiffs` / `pushEventDiffs` **直接** `Object.keys(x)` / `x.length`，参数 `undefined` 时抛 `Cannot convert undefined or null to object`；而 `validateTrace` **不要求** `attributes` / `events` | `diff.ts:288-313`、`inspector-routes.ts:144-161` |
| 26 | `TraceLike`（面板的宽松投影）**漏了 `events` 字段** —— 运行时它在（ingest 收的是裸 `Trace`），但类型上访问不到 | `inspector.ts:57-77` |

事实 7 是本稿的**关键约束**：解除单飞会连带改变「文件变更延后重启」的语义 ——
判据从「有 run 在飞就延后」变成「有任何 run 在飞就延后」，而两条 run 可以飞在**不同 app 实例**上
（事实 10）⇒ 换能力选择时的重启必须等**两条都**收尾，否则第二个 run 拿到的还是旧 app。

## 2. 档 A：trace 落盘

### 2.1 落点

`.agentia/traces.jsonl`（项目根，与 `session.json` / `dev-session-id` 同目录，已gitignore）。

### 2.2 接线（`dev-runner.ts`）

`main()` 里现有的 `registerTraceSink()` **之后**加一一步 `registerJsonlSink()`，内部
`req.resolve('@migor/agentia')` 拿到的 `mod.jsonlTraceSink` 建sink（与 `registerTraceSink`
同款失败纪律：catch + `console.warn`，**不阻断 dev**）。

⚠️ **`defaultSinks` 快照**：`createApp` 构造期对 `defaultSinks` 取快照 ⇒ sink 必须**早于**
用户 app 的 import（`dev-runner.ts:494` 那条注释已经为这件事把关）。落盘 sink 天然满足
（它在同一个 `main()` 序列里）。

### 2.3 判据

| 决定 | 理由 |
|---|---|
| **写失败不阻断 run** | 与 `inspector-sink` 同款纪律（观测失败不击穿业务）；`flushSinks` 本来就吞 |
| **不轮转 / 不清空** | dev 环的trace 体积以「一次调试几百 KB」计；`.agentia/` 已在 gitignore。真要清是用户自己 `rm`。⚠️ 代价如实标注：**长期开着一个 dev 环会攒一个只增不减的文件** |
| **不做「面板读历史 trace」** | 本档只落盘给 **CLI 四个命令** 吃（`report`/`diff`/`harvest`/`export`）。面板读历史是下一件事（要处理 `note` 缺失，见 §7档 C） |
| **不与 `MAX_RUNS`联动** | 内存 ring 与落盘文件是**两条缝**，各自的上限互不干涉 |

### 2.4 验收

- `npm run dev` 跑一次 ⇒ `.agentia/traces.jsonl` 增**一行**（一行 = 一条裸 `Trace`）。
- `agentia report .agentia/traces.jsonl` 出调优报告；`agentia diff` 出差异（有差异时 exit 1）。
- 落盘失败（如目录只读）⇒ 面板**照常**可用，终端有 `console.warn`。
- e2e 续一条：`scripts/e2e-dev.ts` 断言「跑完 → 文件行数 +1 且能被 `extractTrace` 读出」。

## 3. 档 B：并排 A/B

### 3.1 先说清「解除单飞」的真实成本（事实 7 的连锁）

要解除的闸不止一处，三处联动：

| 位置 | 现状 | 必须改成 |
|---|---|---|
| `dev-logic.canAcceptRun` | `!running && !launching` | **保持**（受理闸仍要有：并发多条要排队还是真同时跑，见下分叉） |
| `dev-machine.run`（事实 8） | 单值 `RunPhase` | `run: Map<runId, RunPhase>` 或拆成「受理闸」+「在飞集合」两字段 |
| `dev-runner.runInFlight`（事实 9） | 布尔 | `Set<runId>`（`currentAbort` 同样要成 Map，否则中止会串到别的 run） |
| `dev-logic.shouldDeferRestart`（事实 7） | 委托 `canAcceptRun` | **必须**改成「在飞集合非空」，不能复用受理闸 —— 这两件事在本档之后**语义分叉**（受理闸可以放开，延后重启不能） |

⚠️ **判据分叉（须拍板）**：本档的并排 A/B **需要真并发吗**？
- 需要：两条 run 同时飞，右栏两棵树同步长。形态是「双栏实时」。
- 不需要：第二条排队等第一条收完。形态是「串行，但能并排**回看**两条已完成的」。

**建议：不解除单飞，只做「历史并排 + 一键重跑」。** 理由三条：
1. 真并发会连带改`shouldDeferRestart` 的语义（事实 7），而那条判据是 2026-09-23 治理时
   刻意单源化的（注释里写着「两处各写就会漂」）—— 分叉它要有理由和守卫。
2. 换能力选择时的重启（事实 17）在并发下要等**两条都**收尾才安全，这个「都」字很难
   证对（`pendingRestart` 只是一枚pending 位，不记「等谁」）。
3. A/B 对比的**收益全部来自「事后并排看差在哪」**，不来自「同时跑」—— 同时跑还多烧一倍 token。

⇒ **本档定「串行 + 并排回看」**：run 列表支持**多选两条** → 右栏并排两棵树 + 中间一条差异摘要。
真并发留作后续（§7）。

### 3.2 面板改动

| 元素 | 改什么 |
|---|---|
| run 列表 | 单击= 打开（不变）；`Ctrl/⌘ + 单击` = 加入对比选择（最多 2 条，超了挤掉最早那条） |
| 右栏 | 新增「对比模式」：选中两条时，左树 A / 右树 B，顶部一条差异摘要 |
| 差异摘要 | 复用 **CLI 侧那份 `diff.ts` 的 `diffTraces`**（事实 12）——⚠️ **不是** import 框架：CLI 零运行时依赖（`diff.ts` 头注已声明它是去类型移植副本） |
| 输入条 | 加一个「▷ 用当前输入重跑」：把输入框内容发一次 `POST /run`，并**自动把上一次选中的那条**设为对比基准 |

### 3.3 关键约束：两条 run 的可比性（**这才是真难点**）

`diffTraces` 比的是 **span 路径与字段**，所以两条 run 的可比性取决于**它们有多像**。
面板的四个输入里，**只有 prompt 与多轮是 per-run的**，而能力选择与工作目录是 **app 级**的
（换它们要重启进程，`RunRequest` 注释已写明）。于是：

| 情形 | 两条 run 的可比性 | 面板该怎么办 |
|---|---|---|
| 只改 prompt / 只改多轮 | 高（同 app、同 workdir） | 正常可比，**推荐路径** |
| 改了工作目录 | 中（能力菜单同，路径不同） | 可比，但摘要要显示 `workdir` 不同（否则「差在哪」会被误读成模型变了） |
| 改了能力选择 | **低**（跨进程重启，`runConfigSnapshot` 全变） | ⚠️ 面板**必须**显示一条显式提示「这两条跨了能力选择进程，比对意义有限」 |

⇒ **不是「能选两条就能比」**：要加一条**可比性判据**（`panel-logic` 里一个纯函数：比
`RunNote.toolSources` + `workdir`），不一致时给显式提示。**静默地给一个没意义的 diff 是本仓最忌讳的事。**

### 3.4 命名

- 内部：`compareSelection`（两条 traceId 或 null）——面板状态，与 `state.current` 并列。
- 协议：`GET /api/runs/compare?a=<id>&b=<id>` → `{ summary, spans, notes }`（`notes` 供
  面板显示可比性判据的结果）。

### 3.5 验收

- 选同prompt 的两条 ⇒ 摘要显示 `equal: true`、无span 差异。
- 改一句 prompt 再跑 ⇒ 摘要**逐 span** 指出差异路径（`path` 形如 `run:main/llm.turn#1`）。
- 改能力选择后选两条 ⇒ **必须**出现「跨了能力选择进程」的显式提示。
- `equal: true` 时面板**如实显示「无差异」**，不显示空的差异区（`diff.ts` 的既有语义：
  `spans` 为空数组）。

## 3.5 闭环：重跑后自动补对（实施期补上，2026-10-05）

§0 承诺的是「改一句 prompt 就能**立刻重跑对照**」，可档 B 落地后配对要用户手动 ⌘ 点两条
⇒ **三步操作不是「立刻」**。这一节补上中间那一跳。

**判据**（`panel-logic.ts` 的 `autoPairTarget`，带单测）：**只在 picking 态**（已选一条、
还没选第二条）自动补上第二条。

| 情形 | 行为 | 为什么 |
|---|---|---|
| 已选一条 + 新 run 收尾 | **自动配对并进双栏** + 播一条 notice | dev 环**单飞** ⇒ picking 态下新收尾的那条必然是用户刚跑的，而他在 picking 态下的意图几乎必然是「拿它跟刚跑的这条比」 |
| 空选择 | 不配对 | 用户还没表达对比意图，自动切双栏是**替用户决定**（会被读成面板在乱跳） |
| 已选两条 | 不配对 | 再塞一条等于**挤掉**他刚选的那条 |
| 同一条 id | 不配对 | 否则出现 `[a, a]` |

**接线**（`inspector-page.html` 的 `es.onmessage`，收尾帧那一支）：判定通过 ⇒ 写
`state.compare`、**把 `state.current` 移到第一条**（左栏画的是第一条 ⇒ 列表高亮必须跟着
走，否则又出现「点谁以为在看谁」的失真，与守卫 W4 守的是同一类），然后 `refreshCompare()`。

⚠️ **不静默**：触发时播 notice 说清「为什么屏幕变双栏了」；退出路径 = 普通单击任意一条。
⚠️ **不动单飞**：这是「事后回看」的自动化，不是「同时跑」—— 真并发要改
`shouldDeferRestart` 那条单源化判据（§8 的「不做」）。

**验证**：6 个断言（含「不改入参」与「返回长度恒为 2 ⇒ 必进 dual」）+ **变异反向验证**
（把 `selected.length !== 1` 改成 `!== 2` ⇒ 红，报「picking 态必须能自动配上」）。
⚠️ **DOM 接线本身仍无自动化覆盖**（本稿 §6 已认这笔债）—— 收尾帧 → 判定 → 双栏这条
链只有 `scripts/e2e-dev.ts` 间接兜（它不打 DOM），**如实标注**。

## 4. 改动清单（按文件）

| 文件 | 改什么 | 性质 |
|---|---|---|
| `packages/cli/src/dev-runner.ts` | 加 `registerJsonlSink()`；面板侧 `AGENTIA_DEV_COMPARE` 之类钩子若需要则一并 | **新功能**（落盘） |
| `packages/cli/src/dev-protocol.ts` | 无需改（落盘不产生新帧；对比是**请求/响应**不是推送） | — |
| `packages/cli/src/inspector-routes.ts` | 加 `GET /api/runs/compare`（**必须**排在 `/api/runs/` 之后吗？—— 见下） | **新功能** |
| `packages/cli/src/panel-logic.ts` | `compareSelection` 状态 + `comparability(a, b)` 纯判据（事实 3.3 三种情形） | **新功能** |
| `packages/cli/src/inspector-page.html` | 多选交互 + 双栏渲染 + 差异摘要区 + 「用当前输入重跑」 | **新功能** |
| `packages/cli/test/panel-logic.test.mjs` | `comparability` 三种情形各一条 | 新用例 |
| `packages/cli/test/structure.test.mjs` | **抬LINE_BUDGET 四项 + TOTAL_BUDGET**，并写补账注释（事实 13） | 门禁对账 |
| `scripts/e2e-dev.ts` | 落盘断言（§2.4）+ 对比端点断言（§3.5） | e2e |

⚠️ **路由顺序**：`handleListRuns` 的注释写着「`/api/runs` 必须排在 `/api/runs/` 之前（后者是前缀匹配）」
⇒ 新路由 `/api/runs/compare` 是 `/api/runs/` 的**子路径**，会被那条前缀分支先吃掉。
**必须**把 compare 判据放在 `/api/runs/` 之前，且 query string 要剥（`ctx.path` 带 query）。

⚠️ **W2/W3 白名单**（事实 16）：`comparability` 放`panel-logic.ts` 是对的（它已在白名单里），
**不要**为它新增一个下发模块。

## 5. 门禁与文档对齐

- 门禁四件+ `e2e-dev`（`e2e` 脚本第2 段已含 `tsx scripts/e2e-dev.ts`）。
- ⚠️ **棘轮补账必须写清类别**（本仓惯例：搬移 / 行为变更 / 纯注释 / 新功能，逐笔记账）——
  本稿两笔都是**新功能**，不属「纯搬移的净增是结构开销」那一类。
- 口径同步：`docs/usage-guide.md` §2.2（开发期调试环）要加落盘一句 + 对比一段；
  `AGENTS.md` 若提到 dev 环的描述要一起对齐；`CHANGELOG.md` 往**已存在的那个空
  `[Unreleased]`** 里写（不是文件顶部）。
- `docs/spec.md` §10：**本稿零 `src/` 改动** ⇒ 按根目录 `CONTRIBUTING.md` 的判据
  （「语义变更才写」）**不写 §10**，但 `docs/usage-guide.md` 改了就必须跑 `npm test`
  （README 在 `code-fences` 取样面内）。
- `docs/guards.md` §1：本次**不新增不变量**（没有新的「必须为真」被钉）⇒ 不登记。

## 6. 实施期发现的三个坑（本稿写设计时**没有**预判，逐条记下）

> 纪律：本节的价值高于上面的设计本身 —— 设计稿漏判的坑，只有真做了才看得见。

### 6.1 `rootSpanId` 缺失 ⇒ diff **恒等于「无差异」**（事实 24）

`diffTraces` 靠 `spans.find((s) => s.spanId === a.rootSpanId)` 找根 span，**找不到就整棵
walk 都不走** ⇒ `equal` 恒 `true`、`spans` 恒空。
症状是**最坏的一种**：一份看起来完全正常的「两条 trace 等价」结论。
⇒ 处置：测试里所有要比对的样本**必须**走 `withRoot()` 这个构造器（它强制带 `rootSpanId`），
让「缺 rootSpanId」这个形态**没有入口**；并做了变异反向验证（去掉那行 ⇒ 断言当场红）。

### 6.2 `diffTraces` 不接受 `undefined` 的 `attributes` / `events`（事实 25+26）

`pushAttrDiffs` 直接 `Object.keys(x)`、`pushEventDiffs` 直接 `x.length` ⇒ 参数为
`undefined` 时抛 `Cannot convert undefined or null to object`。而 `validateTrace`
（面板的入站校验）**只**要求 `spanId` / `name` / `startedAt` ⇒ **一条裁剪过的 trace 能合法
进 `/ingest`**，于是 compare 端点会 500。
⚠️ 顺带发现：`TraceLike`（面板的宽松投影）**漏了 `events` 字段** —— 运行时它在（ingest 收的
是裸 `Trace`），类型上访问不到 ⇒ 归一化只能按索引读 + `Array.isArray` 守卫。

**为什么不在 `diff.ts` 里修**（这是本稿最该记的一条决策）：
`diff.ts` 是 `src/engine/trace-diff.ts` 的**逐字同形移植副本**（注释与
`structure.test.mjs` 都声明「改算法必须两边同步」）⇒ 单方面加固会让两侧**分叉**，
逐字对拍守护（`test/diff.test.mjs`）当场红。那条路的正解是**框架侧一起改**
（`?? {}` / `?? []`），属 `src/` 语义变更、要走 spec §10 —— **不在本稿范围**。
⇒ 本次取「**消费侧归一化**」（`normalizeForDiff`）的零核心改动解。
⚠️ 这是**一笔自认的债**，已在 `CHANGELOG` 与结构棘轮补账注里如实标明，不假装它是必要开销。

### 6.3 别用 Bash 里的 `node -e` 做源码文本替换

变异注入时用 `node -e "...s.replace(...)"` 改 `panel-logic.ts`，把**字面 NUL 字符**
（`'\u0000'`）打进了源文件 ⇒ 整个 `.ts` 被 `file` / `grep` 判成 **binary**
（`grep` 报「Binary file matches」、`tsc` 照过，但**源码审查与 diff 全废**）。
根因是照抄了 `dev-logic.sameToolSources` 的 NUL 分隔符写法 —— 它比的是**拼接后的字符串**
（NUL 不可能出现在能力名里，安全），而我这个场景该用 `'\n'`（能力名走
`^[A-Za-z0-9_-]{1,64}$`，换行同样不可能出现）。
⇒ 已在 `comparability` 的注释里写明**为什么用 `'\n'` 而非 NUL**，防止下一个人照抄回去。
⚠️ 附带一条更值钱的教训：**`tsc` 全绿不等于文件是好的** —— 文本层的损坏类型检查看不见。

### 6.4 面板那211 行：判断抽出来，剩纯接线（**同日的补债**）

§4 的补账里我把「`inspector-page.html` 那 211 行测试覆盖率为零」标成了缺口。
同日补掉了其中**能补的那部分** —— 做法不是给 DOM 写测试（本仓没有 jsdom，且那会引入
DOM 依赖），而是**把判断从面板里搬进 `panel-logic`**（那个模块的既有纪律正是
「所有判断都走 panel-logic，那份有单测」）。搬了四条：

| 搬出来的 | 判据错的后果 |
|---|---|
| `compareView`（三态） | 把「选了一条」并进「不并排」⇒ 取消选择会连带清掉已选的第一条 |
| `diffSideLabel` | 缺侧标签判错 ⇒ **静默指错方向**（A 独有被说成「B 侧少」） |
| `diffValueText` | `null` 折成 `0`/空串 ⇒「读不出」伪装成「读数」（本仓老病） |
| `diffFetchErrorText` | 响应非 JSON 时折成「HTTP 500」⇒ 明明是 token 过期/网关插页，被说成服务端故障 |

⚠️ **剩下的是真的补不了**：DOM 接线（`fetch` / `addEventListener` / `replaceChildren`）
在 Node 里没有对应物，**只能靠 `scripts/e2e-dev.ts` 间接兜**。这一条不假装已补 ——
上表的四条是**搬出来的**，不是「新写的」。

⚠️ **本轮又踩了一次「变异验证的恢复会骗人」**（§15 那条纪律的第二次实证）：
变异 1 注入后我用 `/tmp` 备份恢复，但那份备份在**变异 2/3 期间被覆盖成了变异 1 的版本** ⇒
「恢复」后源码里留着变异 1（`picking` → `single`），单测立刻红。
**判据**：备份文件与变异注入的**先后顺序**要对上；不确定就当没恢复过，重新 Read 源码核对。

## 6.5 入库前评审修掉的缺陷（同批，未发布）

一次**入库前评审**（同日的变更集复核）在这批改动里找到 **1 个用户可见缺陷 + 6 处
「注释/断言与事实不符」**，已全部修掉。本节是设计稿对「实施后才发现的事」的如实记账
—— 写 §3 时**没有**预判到它们。

| # | 缺陷 | 性质 | 修法 |
|---|---|---|---|
| 1 | 并排态下**普通单击切 run 时只清 `state.compare`、不复位 DOM** ⇒ 右栏与差异摘要留在屏幕上（内容还是上一对的），而列表里的选中标记已经消失 | **用户可见**（本批唯一一个） | 清空必须走 `exitCompare()`；抽 `resetCompareDom()` 消掉三处逐字重复的复位序列 |
| 2 | `refreshCompare` 读不到某条 run 时 `continue` ⇒ 那一栏**静默留白**（看起来像「这条没有调用树」，真相是已被内存 ring 淘汰） | 与本档「不静默」口径相反 | 该栏显式说「读不到这条 run 的调用树（可能已被淘汰）」 |
| 3 | `state.diff` **只写不读**，注释还承诺了一个不存在的「读取中…」渲染 | 死字段 + 骗人的注释 | 删字段与那条注释 |
| 4 | `comparability` 的长 JSDoc **错挂在 `capsKey` 上**，本体反而没有；且分段标题逐字重复了两次 | 注释骗人 | 长注挪回 `comparability`；其中讲 `capsKey` 实现的那段（NUL/换行）留给 `capsKey` |
| 5 | `inspector.test.mjs` 的 `bothFull` 与上一条 `crossDir` 是**同一对 run、同一断言** | 死断言（零信息量） | 删掉，并把「面板侧 `undefined` 表示到不了服务端」指到真正的覆盖处 |
| 6 | trace-view 结构守卫的注释说「本文件是 `.mjs`（ESM 严格模式）⇒ 重复键是 SyntaxError」—— **实测证伪** | 注释骗人，且把重要性**说反了** | 改成「那条自检是**唯一防线**」（变异实测：重复键补在表尾时「单文件不超基线」那条照样绿） |
| 7 | `tree.test.js` 一条断言消息里夹着**两个 U+FFFD** | `assert` 失败时唯一给线索的那句话是乱码 | 重写消息 |

⚠️ **连带补的机制才重点**：缺陷 1 落在面板的 **DOM 接线**上（§6 已认这笔债，无 jsdom 单测）
⇒ 只修代码等于「同一形态下次再犯没人知道」。所以新增结构守卫 **W4**：
`inspector-page.html` 里 `state.compare = []` **只许出现在 `exitCompare` 内**。
**射程要看清**：守的是「裸清空」这个已知形态（`state.compare.length = 0` / `splice(0)`
之类绕过不在射程内）—— 与 W2/W3 同款定位，**守卫不是证明**。已做变异验证
（改回裸清空 ⇒ 红，报「出现了 2 次」）。

## 7. 风险与已知假红

| 风险 | 缓解 |
|---|---|
| `jsonlTraceSink` 是**同步写**（`appendFileSync`）⇒ 大 trace 会阻塞 runner 的事件循环 | dev 场景单条 trace 以百 KB 计；`traceLimits.maxEvents` 本来就兜上限。**如实标注**，不假装无影响 |
| 长跑 dev 环让 `traces.jsonl` 只增不减 | §2.3 已定不轮转；文档写一句「删它就是清历史」 |
| 跨能力选择的两条 run 比对没意义 | §3.3 的 `comparability` **显式提示**，不做静默 |
| 双栏把 `inspector-page.html` 推到 1600+ 行 | 结构棘轮会**逼**这件事被看见；真到那一步该抽件而不是抬基线（棘轮的意义） |
| 环境假红（`npm test` 撞批量删闸） | `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR`；**先冻结树再跑门禁** |

## 8. 本稿明确不做

| 不做 | 理由 |
|---|---|
| **档 C：挂起 / 审批 / `deferUntil` 可见** | 要让 dev 走 `AsyncRunner`（引入 store + 任务生命周期），5–8 人日且使用频率低；它本质是「dev 环要不要演化成半个 deploy 示例」这个更大决策的一部分，不该顺手带 |
| **真并发（两条同时飞）** | §3.1 三条理由；收益全在「事后并排」，不来自「同时跑」 |
| 面板读**历史** trace（跨重启回看） | 落盘后文件里**没有 `RunNote`**（`toolSources` / `workdir` 是 dev 侧记账、不进 trace）⇒ 回看时那四个输入无从显示。要么读旁边的 note 文件，要么放弃这批note。三条路都比「先落盘给 CLI 用」贵|
| 轮转 / 保留策略 | §2.3 |
| 改 `src/` 加真并发原语 | 违反定位判据（且 `AsyncRunner` 已有的 `concurrency` 闸是服务端语义，dev 环不一定该复用） |
