# 深度审计 —— 功能合理性 / 强壮性 / 易拓展性 / 可维护性 + 长时段功能怎么验证

> 审计对象：`main` @ `9e16d78`（2026-09-28，PR #168 合并后）
> 范围：`src/` 全部 96 文件 / 21 915 行，按 9 个模块分组
> 方法：五个模块群各自通读 → 关键断言**逐条回源核实**（不是转述）→ 对「长时段」相关结论做**实测**
>
> ⚠️ 本报告只做只读分析，**未修改任何生产代码**。
> 标注约定：`【实测】` = 我跑了代码验证过；`【回源】` = 我逐行读过源码确认。
>
> 📌 **本文件的问题清单已被逐条复核，最终版见 `DEEP-AUDIT-VERIFIED-2026-09-28.md`** ——
> 那份把 34 条全部打开源码重核了一遍，修正了 7 条表述、降级 2 条、改写 1 条性质。
> **要当施工清单用，看那份；本文件保留作为审计全貌与「刻意不动」论证的原始记录。**

### 关于本报告可信度的坦白（2026-09-28 19:10 补）

**问题清单共 33 条，全部带 `【回源】` 标 —— 这个标注粒度是失真的，我先把它说清楚。**

真实的核验分布是：

| 等级 | 条数 | 含义 |
|---|---|---|
| `【实测】` | 1 | 我写脚本跑了代码（定时器 2³¹ 上限） |
| 逐行回源 | 约 **11** | 我亲自打开文件逐行读过：`core/timeout.ts`（全文）、`engine/budget.ts`（全文）、`engine/policy.ts`、`engine/turn.ts:280-310`、`transport/async.ts`（构造期校验 / `#raceTimeout` / `#cancel` / `#runAborts`）、`store/redisStore.ts:140-175`、`tests/transport/durable-timer.test.ts` + 若干 grep 定点核实 |
| **模块审计提出 + 间接证据** | 约 **22** | 由五个并行模块审计提出，我用 grep 做了间接确认（如「`zeroClauseOf` 12 个调用点不含这 5 处」），**但没有逐条打开源码读** |

**这约 22 条该怎么用**：结论方向大体可信（提出者读过全文），但**表述精度未经我复核**——下文 §3.5 的抽查已经证实了两条 P1 都成立、却都**表述不准、会误导修法**。**若要当施工清单用，请先按 §3.5 的方式逐条复核。** 我没有把剩下 22 条全改成 `【转述】`，是因为逐行改标我一个都标不准（我无法准确回忆哪条读过哪条没读）——不如把这个分布写明白。

## 0. 先给总判断

这个仓库的真实水位不是「没缺陷」，而是**「每类缺陷都有对应的可执行守卫」**——这是我核对最深的印象：

- 「别写死几处」⇒ `core/limits.ts` 把「旋钮的 0 是什么」做成**可执行数据表**，改一处不改表 ⇒ 构建红（`tests/limits.test.ts` 穷尽表驱动）；
- 「别让内部件漏进公共面」⇒ `tests/docs/api-page.test.ts` 反向全覆盖；
- 「分层不许反向」⇒ `tests/architecture/layering.test.ts` + 新增的 `file-cycles.test.ts`；
- 「重构不许退化」⇒ `http-boundary-guard` / `dispatch-guard` 源码级钉形状。

**所以真正的问题不是「有 bug」，而是「守卫生长速度跟不上功能生长速度」的几处具体缺口。** 本报告的问题清单按这个口径筛：只报**现在真的会咬人**或**下一次改动必然踩到**的，不报风格问题。

一个反直觉但重要的观察：**仓库最强的三处与最弱的三处，是同一种能力的两副面孔**——凡「纯判定」被抽成独立文件的，质量都很高（`approval-policy` / `wake-policy` / `resume-policy` / `forwarded.ts`）；凡还混在编排里的，就还留着缺口（`async.ts` 的取消窗口、`module.ts` 的七处并行分支）。**抽件不只是整洁度问题，它是质量机制本身。**

---

## 1. 逐模块

### 1.1 `core/`（14 文件 / 1737 行）—— 最强的一块

**做对的**：
- `timeout.ts` 是「等待的终点」单源，且**硬超时判定用 `performance.now()` 单调钟**（`timeout.ts:104-131`）——墙钟回拨会让「超时的工具被记成 ok」，这正是它要防的静默失效。这个选择是对的。
- 判定用**实测耗时**而非 `Promise.race` 结果（`timeout.ts:129-131`），注释里连「8 倍 CPU 超订下 1200 次翻转 1 次」的实测样本都留着。

**问题**：

| 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|
| **P1** | `core/timeout.ts:124`/`:182`、`async.ts:1652`、`integrations/anthropic.ts:257`、`transport/drain-gate.ts:41` | 五处 `setTimeout(…, ms)` **无 2^31-1 上界校验**（超限只在 stderr 留一行警告后被钳成 1ms） | 【实测】见 §3.1 |
| **P1** | `transport/async.ts:368` | `runTimeoutMs` 构造期只查 `isFinite && >= 0`，**无上限**；而 `scheduler.ts:79` 的注释写着「runTimeoutMs 在 async.ts 有同款防线」——**该注释与实现不符** | 【回源】`MAX_TIMER_DELAY_MS` 全仓只在 `scheduler.ts` 定义并使用了 3 次 |
| **P1** | 5 处（`async.ts:363`、`anthropic.ts:96`、`metrics.ts:223/239/243`） | `badValue:'throws'` 旋钮**手写**文案，没插 `zeroClauseOf` ⇒ 「文案单源」这层已经第二次断头 | 【回源】`grep zeroClauseOf src/` 12 个调用点，这 5 处不在内 |
| P2 | `tests/limits.test.ts:542-592` | 文案对账的 `cases` 是**数组不是 Record** ⇒ 无穷尽性；16 个 throws 旋钮只列 10 个。而 `PROBES`（:151）是 Record 有编译期守卫——**两处守卫强度不对称** | 【回源】 |
| P2 | `engine/budget.ts:73` | `maxTotalTokens`/`maxCostUsd` 未登记进 limits 表，`NaN` 让护栏静默失效（`totalTokens > NaN` 恒 false） | 【回源】`budget.ts` 全文件不 import limits |
| P2 | `core/schema.ts:58-85` | `checkObject` 递归调 `check` 且**无深度上限** ⇒ 自引用 `properties` 的 schema **无限递归爆栈**（`RangeError`）。`inputSchema` 是使用者可控输入；这条也是 §3.5 抽查① 里 `mcp-server-http` 那条 P1 的**触发路径之一** | 【回源】2026-09-28 19:10 补，读了 `:58-85` |

**刻意不动（我复核后同意）**：`interruptibleSleep` 的 `ms<=0` 判先于 aborted 检查（有注释 + 用例钉住，2026-09-19 外部复核改反过一次被拦）；`withTimeout` 的 timer 不 unref（有 Node 22/26 实测对照表）；兜底块不带索引签名（AGENTS.md 硬约定，加了会让 SDK assignability 破产）。

---

### 1.2 `engine/`（29 文件 / 5529 行）

**做对的**：`forwarded.ts` 用 `-?` 映射类型 + `UnclassifiedToolContextKey` 做**编译期穷尽守卫**——这是全仓做得最好的一处，其他穷尽点都该照抄它。usage 累加**无双计**（`tracer.ts:342` 用 `kind !== 'llm.turn'` 排除 capability 聚合值，防重复计数）。

**问题**：

| 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|
| **P1** | `engine/turn.ts:289-304` | `contextPolicy.beforeTurn` **无 try/catch**，而它内部的 `summarize` 是**走模型的网络调用** ⇒ 一次 429/超时就废掉整条 run（收成 `stopReason:'error'`）。**compaction 恰恰是长跑独有的路径** | 【回源】且 `tests/engine/policy.test.ts` 无一条 `summarize` 抛错用例 |
| **P1** | `engine/policy.ts:81` | `lastCompactAt = info.iteration` 在 `await compactMessages(...)` **之前**赋值 ⇒ 压缩失败后滞回额度已被烧掉，接下来 `compactEvery` 个回合都不再尝试 | 【回源】与上条同源，是「长跑恢复力」的双重打击 |
| **P1** | `engine/mcp-server-http.ts:135-158` | 包 `core.dispatch` 的那个 `try` **只有 `finally`、没有 `catch`**（同文件的 auth 与 `JSON.parse` 两处都有 catch）⇒ 异常冒泡出 async handler ⇒ **unhandled rejection ⇒ 进程退出**。两条真实触发路径：`JSON.stringify(resp)`（工具返回自引用对象）、`validateJsonSchema` 递归爆栈。**修法只是给这一处补 catch** | 【回源】见 §3.5 抽查① |
| P2 | `engine/loop-result.ts:145,160` | `abortedResult`/`failedResult` 硬写 `eventsDelivered:false` ⇒ 事件已注入却报「没注入」⇒ 宿主保留 pendingEvents ⇒ **续跑重复注入**。与该文件 `:60-63` 自己写的「注入过 ⇒ 清簿记」正好相反 | 【回源】`loop.ts:218` 注入后可抛，路径可达 |
| P2 | `types.ts:38,73` + `stop-reason.ts:24` | 新增 stop_reason 要动 **4 处**且**无 `never` 断言**（对比 `http-endpoints.ts` 有 `const _never: never`） | 【回源】 |
| P2 | `types.ts:96` vs `policy.ts:66` | `budgetTokens` 只估 messages，system/tools schema 不在口径内，却声明为「估算 **input** tokens」 | 【回源】 |
| P2 | `tracer.ts:87` + `turn.ts:464` | `setAttribute` **不受 `maxEvents` 约束** ⇒ `traceContent:'full'` 下 trace 线性膨胀无闸 | 【回源】 |
| P2 | `'tool.input'`/`'tool.output'` 散落 7 处 | 跨 engine→eval→integrations 三层手写字面量，`tool-events.ts` 只导出载荷构造器不导出名字常量 | 【回源】 |

---

### 1.3 `transport/`（16 文件 / 3957 行）

**做对的**：「先落库再派发」五条路径全部遵守（approve / signal / expire / wake / redispatch），且 `#dispatch` 收成**唯一入口**由 `dispatch-guard` 钉住。已从 910 行的 `async.ts` 拆出六块纯件。

**问题**（长时段风险最集中的一块）：

| 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|
| **P1** | `async.ts:581-588` vs `:1415` | `#runAborts` 在**拿到槽位之后**才登记；而恢复路径先把状态落库成 `running` 再派发 ⇒ 这整段（concurrency=1 下可达分钟级）内 `cancel` 一律 409。**审批后想撤销、刚唤醒的长任务想掐掉，都撤不掉** | 【回源】`grep runAborts` 确认登记点只有 1415/1445 |
| **P1** | `resume-policy.ts:58-61` | `too-fresh` 是**新鲜度启发式，不是租约** ⇒ ① 单段 run 超过 `staleAfterMs` 的长跑任务，同伴进程一重启就被抢（真重复执行）；② 前任刚崩、继任启动即扫一次 ⇒ 孤儿落在保鲜期内被跳过后**无人再认领**（孤儿饿死） | 【回源】 |
| **P1** | `http.ts:250-255` | `drain()` 默认 `timeoutMs=0`（不限）时，`waitUntil(...Infinity)` 先跑，而**强制收口 SSE 排在等待之后** ⇒ 一个客户端不断线、run 不结束的 SSE 能让 `drain()` **永不返回** | 【回源】 |
| P2 | `task-events.ts:219-233` | LRU **只淘汰终态流**；挂起/长跑（非终态）流的缓冲永不淘汰 ⇒ 内存随「在等人的任务」线性增长。终态侧（16 条）收得很好，**非终态侧是敞口的** | 【回源】这也正是 soak 测不出来的那类（见 §3） |
| P2 | `async.ts:392-462` | 队列**无深度上限、无背压信号**，`POST /tasks` 永远 202；积压时每条 TaskRecord 含完整 messages + trace | 【回源】 |
| P2 | `async.ts:438-459` vs `:1418` | 异步 store 下初始 `save` 不 await 就派发 ⇒ 迟到的 `queued` 快照若落在 `save(running)` 之后，会把状态**回退**成 queued ⇒ 他进程 `resumePending` 看见 queued 再派一次 | 【回源】 |
| P2 | `scheduler.ts:190-195` | `status !== 'queued' && !== 'running'` ⇒ **挂起视为不占资源** ⇒ 全挂起时每 tick 仍 submit，任务无上限堆积 | 【回源】 |

**刻意不动（同意）**：`task-waiters` 只覆盖本进程写终态 ⇒ `awaitTask` 的 250ms 兜底轮询存在（AGENTS.md 明写「不是缺陷」）；跨进程 at-least-once 重复执行是显式诚实边界。

---

### 1.4 `store/` + `integrations/`（20 文件 / 5595 行）

**做对的**：metrics 常驻内存**有界可证**（`KeyBudget` 上限 × `DurationStat` 窗口，能力/模型/评分/label 组合四道 cap 齐备，`reset()` 防 CUMULATIVE 倒退）；OTLP 导出失败不影响主流程；mcp-stdio 子进程生命周期完整（ENOENT / exit 清空在途 / EPIPE 吞 / SIGTERM→SIGKILL 等真实 exit）。

**问题**：

| 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|
| **P1** | `store/redisStore.ts:153-157` | TTL **无差别过期**，挂起中的记录同样消失；而 `approvals`/`pendingApprovals` 是随记录落库的 ⇒ redis+TTL 部署下**一条等审批的 run 会在人批之前过期**，之后 approve 走 404、审批决定无家可归 | 【回源】`usage-guide.md` 全文无 `ttlSeconds`/`RedisTaskStore` 说明 |
| **P1** | `openai.ts:221/535` | 端点不给 usage（需 `stream_options.include_usage`）⇒ token/成本恒 **0** ⇒ `maxCostUsd` 静默失效，且因为返回 `0` 而不是 `null`，`unpricedTurns` 也**不涨** ⇒ 「算不出成本」这个信号完全静默 | 【回源】 |
| P2 | `anthropic.ts:586` vs `openai.ts:428` | `statusOfStreamError` 两份，目的完全相同（200 流内故障反推 status），一致**只靠注释**保证；`adapter-parity.test.ts:23-27` 明写「流内 error / 截断 / 连接失败不在本矩阵」 | 【回源】 |
| P2 | `metrics-otlp.ts:78` | 每次 flush 调 `snapshot()` ⇒ 为 200 能力 + 50 模型各排一次 1024 窗口（**白算约 250 次排序**），而 OTLP 侧**根本不用分位** | 【回源】 |
| P2 | `store.ts:99-119` | `compact()`/`close()` 在接口之外 ⇒ 第五套 store 的压实/关闭没有统一出口 | 【回源】 |
| P2 | `mcp-stdio.ts:76,134` | stdout 缓冲只按 `\n` 切分且**无上限**；server 永不出换行 ⇒ 无界增长 | 【回源】 |

**「看着像重复、其实不该抽」的判断（我复核后同意）**：`postWithRetries` 两份（响应消费形态不同，抽了只会得到「参数比逻辑多」的壳子）；`renderOpenMetrics` 复用 `renderPrometheus` 文本再改（刻意逐字节同源，比抽公共件更难漂）。**该抽的是 `statusOfStreamError`**。

---

### 1.5 `toolkit/` + `runtime/` + `eval/` + `container/`（21 文件 / 3179 行）

**做对的**：eval 的三份 CLI 移植副本，对拍**真在场且会咬人**（`packages/cli/test/{harvest,diff,export}.test.mjs` 各有一条逐字相等用例，且排在 `npm test` 第二段套件里）。

**问题**：

| 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|
| **P1** | `toolkit/module.ts:331-352,384` | **能力引用图无任何成环检测**（`module.ts` 全文 `cycle`/`visited`/`depth`/`maxDepth`/`seen` 五个关键词命中 **全为 0**）；`@SubAgent({tools:['本 provider']})` 的菜单里含它自己 ⇒ **运行期无限递归**（`resolveTools` 是延迟求值 thunk、`wrappedByToken` 装配期已建满 ⇒ 不是装配期顺序 bug）。DI 层有环检测（`container.ts:102-106`），能力层没有。`maxIterations` 只约束每层宽度、**不约束深度** ⇒ 树按 `宽度^深度` 爆炸 | 【回源】见 §3.5 抽查② |
| **P1** | `runtime/context.ts:17` + `run.ts:198-201` | **整棵嵌套树共用一份 RunContext / 一块黑板**。对话历史与 system 都裁剪了，**黑板没有**。spec 只写「单次运行内累积」，未提嵌套共享 | 【回源】全仓仅 `run.ts:201` 一处 `withRunContext` |
| P2 | `toolkit/module.ts`（7 处） | 加第五类能力要在同一文件改 **7 处并行分支**，且**无任何编译期护栏**（对照 `forwarded.ts` 的 `-?` + `never` 模式） | 【回源】 |
| P2 | `runtime/run.ts:40-113` | `RunStatus` 承诺 6 态，`Run` 实际只能到 **5** 态（`cancelled` 是 transport 层按「意图」重解释）；且 `start()` 有守卫而 `finish()` 没有 ⇒ `suspended` 之后再 finish 会静默翻终态 | 【回源】 |
| P2 | `container/container.ts:116-131` | async 工厂被**静默接受并缓存为 Promise** ⇒ 下游注入到的是 Promise 而非 await 过的值，首次属性访问全 undefined 且**零报错** | 【回源】 |
| P2 | `runtime/run.ts:367-378` | 记忆回写是**无条件全量读改写**，无版本号/CAS、无体积上限 ⇒ 并发 run 共用 `{store,keys}` 时 lost update | 【回源】 |
| P2 | `toolkit/subagent.ts:87-98` vs `usage-guide.md:246` | 三态 system 的隐性差异（前两形态追加 `REPORT_HINT`、函数形态不追加）**没进使用者文档**，而 usage-guide 是唯一使用者说明书 | 【回源】 |

---

## 2. 四个维度的跨模块结论

### 功能合理性：**强**，但有三处「抽象没兑现」

1. **预算口径名不副实**：`budgetTokens` 只算 messages，却叫「估算 input tokens」（system + tools schema 不在内）。两个 60000/64000 相邻出现，使用者极易当成一套。
2. **`RunStatus` 6 态只到 5 态**：`cancelled` 在 runtime 层不可达，是 transport 的意图重解释。类型承诺了一个运行时到不了的状态。
3. **跨 run 续跑在 trace 里断开**：`traceId == runId`，审批挂起/崩溃续跑的**第二段是新 run ⇒ 新树**，与前一段**无任何结构关联**（`SpanLink` 只写入站上游）。AGENTS.md 自己也承认「一个任务可跨多个 run 段，每段 seq 从 1 重来」。**这是「可观测是一等公民」这个核心卖点上最大的一个洞**——恰恰在最长、最贵的那些 run 上断掉。

### 代码强壮性：**中上**。弱点不在单点 bug，在两类结构性风险

- **「在飞的定时器」**：见 §3.1，唯一一条「配置合法、行为反向」的坑（只在 stderr 留一行警告）。
- **「异步编排的窗口」**：cancel 窗口（`async.ts:581`）、初始 save 与派发的顺序（`async.ts:438`）、`SET`+`EXPIRE` 非原子（`redisStore.ts:149`）、`byIdempotency` 的两步读（`:163`）。**共同形状是「两步之间没有锁/租约/版本号」，且都是长跑 + 多进程才会撞上**。单进程短跑全都测不出来。

### 易拓展性：**分层做得好，穷尽性做得不均**

| 穷尽点 | 有守卫吗 |
|---|---|
| `http-endpoints.ts` 的 `route.kind` | ✅ `const _never: never = route`（12 个 kind 全覆盖） |
| `engine/forwarded.ts` 的工具上下文字段 | ✅ `-?` + `UnclassifiedToolContextKey`（全仓最佳） |
| `stop_reason` 联合 | ❌ 4 处手写、无断言 |
| MCP `transport` 联合 | ❌ 手写 `!==` 校验 + 三元，漏改即静默回落 http |
| capability kind（第 4/5 类） | ❌ `module.ts` 7 处并行分支 |
| 预算维度 `kind` | ❌ `turn.ts:247` 二值三元，第三个维度静默落进 cost 文案 |

**加新东西的成本**：新端点 4 处（可接受）／新触发宿主 **0 处**（很好）／新 store 实现 5 方法 + **6 条没写在接口上的隐含约定**（这是真缺口，其中「异步 save 必须先记录后幂等索引」被 async.ts 自认 load-bearing）／新厂商 ModelClient 要对齐 **9 项口径**，其中 **6 项无自动化对拍**。

### 可维护性：**抽件纪律好**，剩两处且都有明确下刀点

- `async.ts` 1690 行：已拆六块，剩下是「大类」病（10 个状态容器 + 4 把在飞闸）。**最值得抽的是 `#expireAndResumeInner`(954-988) 与 `#wakeDueInner`(1053-1080)——27 行逐字同形的模板**，抽成 `resumeBy(rec, predicate)`，两处各留一个已单测的纯判定。收益最大、风险最小（基线已在）。
- `module.ts` 562 行：构造函数独占 ~200 行做 7 件事。抽 `capability-slice.ts`（`CAPABILITY_KINDS` 注册表）+ 同款 `never` 断言。
- **不建议再动**：`#executeInner` 247 行是「编排留在原处」的有意余额（`SRC-STRUCTURE-2026-09-28.md` §2.3③ 判过，触及 14 个 runner 内部成员）。

---

## 3. 长时段功能怎么验证

先界定范围。「这两天做的长时段功能」是 **#156–#165 这一整块让任务能跨长时间活着的能力**：durable 挂起/唤醒（suspended 一状态一原因 + 时间挂起本体）、cancel（cancelled 是状态不是失败）、崩溃续跑、`signalTask` + `POST /tasks/:id/events`、sqlite/redis 到期索引 `listDue`、drain 优雅停机、待注入事件缓冲上限。

### 3.1 一条实测：长跑场景下唯一「配置合法、行为反向」的坑（只在 stderr 留一行警告）

```
2^31-1 (24.855 天, 边界内)  → 120ms 内触发=否     溢出告警=无
2^31   (刚越界)             → 120ms 内触发=是(!!)  溢出告警=有  ← 被钳到 1ms
30 天                       → 120ms 内触发=是(!!)  溢出告警=有  ← 被钳到 1ms
1 年                        → 120ms 内触发=是(!!)  溢出告警=有
```

【实测】Node 22 上，超过 `2^31-1` ms（≈24.86 天）的 `setTimeout` **被钳成 1ms**，只有一行 stderr `TimeoutOverflowWarning`（不打 `--trace-warnings` 时容易被日志淹没）。

**暴露面**（真站点 **5 处**，全部直喂 `setTimeout`、无上界校验）：
- `core/timeout.ts:124` `withTimeout` ⇒ `toolTimeoutMs` 配 30 天 = **每个工具调用立即 TIMED_OUT**
- `core/timeout.ts:182` `interruptibleSleep` ← `backoffMs` 的**产出值**喂进来（`backoffMs` 本身**不**调 `setTimeout`）⇒ 上游回 `Retry-After: 99999999` ⇒ 1e11 ms ⇒ 钳到 1ms ⇒ **退避变热重试，把 429 打成风暴**
- `transport/async.ts:1652` `runTimeoutMs` ⇒ 长跑任务配 30 天 = 立即超时失败
- `integrations/anthropic.ts:257` `composeSignal` ← `options.timeout`（`:92` 只查 `finite && >0`，**不查上界**）
- `transport/drain-gate.ts:41` ← `drain({ timeoutMs })`（`async.ts:924` **原样透传、零校验**）

**不是站点**（澄清）：`task-waiters.ts:44` 的 `timeoutMs` 被 `awaitTask` 的 `Math.min(intervalMs, left)`（缺省 250ms）夹住；`mcp-stdio.ts:277` 用常量 `MCP_CLOSE_GRACE_MS`；`http.ts:179` 是字面量 `5`。

**`scheduler.ts` 已经有这条防线**（`MAX_TIMER_DELAY_MS`，`every`/`at` 各一处），并且它的注释写着「runTimeoutMs 在 async.ts 有同款防线」——**这条注释是不实的**（async.ts 只有非负有限校验）。认知是有的，只是没铺开。

> 这是我认为**最该先做的一件事**：把 `MAX_TIMER_DELAY_MS` 上提到 core，**五处**同款校验（**拒绝坏值**、别改「钳制」语义 —— 现在不是静默，是警告落在没人看的 stderr）。成本极低，且它是唯一一条「使用者配了一个完全合理的值、框架给出完全相反行为」的坑。

### 3.2 现有验证手段盘点（三档，都要肯定）

**L0 · 纯判定层：`now` 已外置** ✅
`approvalExpired(rec, now, timeoutMs)` / `fillTimeoutDenials(rec, now)` / `timerDue(rec, now)` / `resumeSkipReason(rec, { now, … })` —— 四个时间判定**全部把 `now` 做成入参**。`resume-policy.test.ts` 直接喂 `now: 9e9`，**零等待、零 flaky**。这是抽纯件带来的直接红利。

**L1 · 持久化时刻倒填** ✅ —— 这个手法值得单独拎出来
```ts
// tests/transport/durable-timer.test.ts:82-92
/**
 * 把记录的目标时刻**倒填**到过去 = 确定性地模拟「时间到了」。
 * 不睡墙钟：这类用例要验的是「到点这条判据成不成立」，不是「时钟走得多准」——
 * 真睡 30ms 会把「调度慢」误判成「唤醒坏了」（CI 满载下最难查的那类红）。
 */
async function backdate(runner, taskId, deltaMs = 1) {
  const rec = await runner.store.get(taskId);
  rec.wakeAt = Date.now() - deltaMs;
  await runner.store.save(rec);
}
```
**洞见**：挂起时刻是**落库的数据**（`rec.wakeAt` / `rec.suspendedSince` / `rec.startedAt`），不是内存状态 ⇒ **「等一天」等价于「把 wakeAt 写成一天前」**，不需要假时钟。用例里 `gate.at = Date.now() + 3_600_000`（一小时）却一毫秒都不等。

**L2 · 真跑**：`e2e:soak`（假端点 + 种子固定故障注入 429/截断/400/流内错误 + N 并发长跑，断言失败率≈注入率、错误分类无 unknown、metrics 对账、内存有界、干净退出；`SOAK_DURATION_MS=7200000` 即真两小时）、`e2e-deploy`（SIGKILL 后同库重启 `resumePending` 续跑）。

### 3.3 五个缺口

1. **「在飞的定时器」不可伪造**。L1 只对**落库时刻**有效；`runTimeoutMs`、`approvalTimeoutMs` 的**真定时器**只能真等 ⇒ 于是「超时真的发生」这条端到端路径没人测（用例都用小值 + 真等）。**建议在 `AsyncRunnerOptions` 上加一个可选的 `now: () => number` / `timers` 注入缝**——不用改架构，只是把 L0 那套「时钟外置」从纯判定件推到编排层。

2. **时钟回拨完全没被测过**。全仓墙钟 `Date.now()` 39 处，**无一单调钟兜底**（唯一例外是 `withTimeout` 的耗时判定用了 `performance.now`）。NTP 回拨 ⇒ 到期判定推迟、保鲜期变长。`wake-policy.ts:59` 的注释已经意识到「监控端算 `nextWakeAt - now` 会得到巨大负数」，但没落成用例。**建议**：给 `approvalExpired` / `timerDue` 各加一条「回拨」用例（喂 `now` 往回跳），成本近零。

3. **多进程续跑的竞态窗口没有确定性测试**。现在只有 `e2e-deploy` 的 SIGKILL——跑一次撞一次，撞不上就是绿。而 §1.3 里那两条 P1（cancel 窗口 409、`too-fresh` 非租约）**恰好都在这个窗口里**。**建议**：用 L1 手法造「刚崩」的记录（`startedAt` 倒填到保鲜期内/外），驱动 `resumePending` 走纯判定路径，把「会不会被抢」「孤儿会不会饿死」变成确定性断言。

4. **长跑的内存有界没进 CI**。`task-events.ts` 的非终态流永不淘汰（§1.3 P2），而 **soak 造不出这个场景**（soak 是「并发长跑」，不造「挂着等人」）。**建议**：soak 加 `--suspend` 场景（挂起/唤醒/审批超时混合注入），并把内存断言挂到非终态流上。

5. **soak 不覆盖 suspend/defer**。同 4。另外 `e2e:soak` 默认 60s×16 并发**不进 verify-all**（是「跑多久」不是「对不对」）——这个定位是对的，但要保证**有人定期真跑两小时**，否则它等于不存在。

### 3.4 建议的四层验证策略

| 层 | 手段 | 现状 | 要补的 |
|---|---|---|---|
| **L0** 纯判定 | 喂 `now`，零等待 | ✅ 4 个件已具备 | 推广到其他时间判定；加「时钟回拨」用例 |
| **L1** 时刻倒填 | 改落库的 `wakeAt`/`suspendedSince`/`startedAt` | ✅ `backdate()` 已有 | 推广到审批超时、崩溃续跑、事件缓冲上限 |
| **L2** 定时器注入 | 可选的 `now()` / `timers` 缝 | ❌ **缺** | 加注入缝 + `MAX_TIMER_DELAY_MS` 五处校验 |
| **L3** 真跑 | soak / e2e-deploy | ⚠️ 有但不覆盖挂起 | soak 加 `--suspend` 场景 + 非终态流的内存断言 |

**一条纪律**：L0/L1 之所以能成立，前提是「时间判定被抽成了纯件」。**所以「能不能零成本验证长时段行为」与「纯件抽得彻不彻底」是同一件事**——这反过来支持 §2 的结论：抽件是质量机制，不只是整洁度。

---

### 3.5 抽查记录（2026-09-28 19:10 补，两条 P1）

**抽查 ①** `engine/mcp-server-http.ts` —— **P1 成立，但原表述错了**。
原写「async handler 全程无 try/catch」。实际：该文件有 3 处 `try` / 2 处 `catch`，**auth 钩子（:91-97）与 `JSON.parse`（:121-126）都有 catch 兜底**。真正的问题精确来说是：

```ts
// src/engine/mcp-server-http.ts:135-158
try {
  const resp = await core.dispatch(msg, signal);
  ...
  const payload = JSON.stringify(resp);   // ← 这里才可能抛
  res.writeHead(200, headers); res.end(payload);
} finally {                                // ← 只有 finally，没有 catch
  res.off('close', onClose);
  core.untrackCall(ac);
}
```

`dispatch` 本身（`mcp-server.ts:277-350`）无 try/catch，但它调用的 `callTool`（:206+）**有** catch 会把工具抛错转成 `isError` ⇒ **工具抛错不会冒泡**。真正会冒泡的是两条：
① `validateJsonSchema(tool.inputSchema, rawArgs)`（`mcp-server.ts:338`）—— schema 循环引用时 `core/schema.ts:70` 无限递归爆栈（**这正是本报告 §1.1 另列的 P2**，两条是同一个洞的两面）；
② **`JSON.stringify(resp)`（`:144`）—— 工具返回一个自引用对象即可触发** `TypeError: Converting circular structure to JSON`（`callTool` 把工具返回值原样放进 `content`）。
任一条冒泡 ⇒ async `onRequest` 返回 rejected promise ⇒ `server.on('request', onRequest)` 不接管 ⇒ **unhandled rejection ⇒ 进程退出**（Node ≥15 默认 `--unhandled-rejections=throw`）。
**修法由此变得很轻**：不是「整段加兜底」，而是**给 :135 那个 try 补一个 catch**（stdio 侧 `mcp-server-stdio.ts:52` 已有 `.catch`，对齐即可）。

**抽查 ②** `toolkit/module.ts` 能力引用成环 —— **P1 成立，且比原报告说的更确定**。
`module.ts` 全文**没有任何环检测痕迹**（`cycle` / `visited` / `depth` / `maxDepth` / `seen` 五个关键词命中数**全为 0**）；`resolveRefTools`（:331-352）只校验「provider 存在」与「能力名存在」，**不做图遍历**。
补充一个原报告没写清的细节：`subagentToTool(capability, resolveTools)` 的第二个参数是**延迟求值的 thunk**（`subagent.ts`：`resolveTools: () => AgentTool[]`），而 `wrappedByToken.set(p.provide, wrap(buildSlice(p.provide)))` 是在循环里**先全部建好**的。所以这不是「装配期建了空菜单」那种顺序 bug，而是**纯运行期无限递归**：`@SubAgent({ tools: ['own-provider'] })` 的菜单里含它自己，每次调用都新起一层，`maxIterations` 只限每层宽度、**深度无闸**，只能靠共享的 `maxTotalTokens` 软止损。

---

## 4. 建议的修复顺序

**第一批（P1，且都是长跑场景会真撞上的）**
1. `MAX_TIMER_DELAY_MS` 上提 core + 五处校验（`timeout.ts:124/:182` / `async.ts:1652` / `anthropic.ts:257` / `drain-gate.ts:41`）+ 修 `scheduler.ts:79` 的不实注释与「静默」措辞
2. `turn.ts:289` `beforeTurn` 包 try/catch（压缩失败降级为本回合不压缩）+ `policy.ts:81` `lastCompactAt` 移到成功之后
3. `async.ts` cancel 判据改「本进程已受理」；`resume-policy` 的 `too-fresh` 改心跳租约或加启动二次扫描
4. `redisStore` 挂起态跳过 EXPIRE（或独立 TTL）+ 补文档
5. 能力引用图装配期 DFS 环检测 + 可选 `maxCapabilityDepth`
6. `mcp-server-http.ts:135` 那个 try **补一个 catch**（不是整段重构；顺带 stdio 侧也是 `.catch(() => {})` 静默丢弃，值得改成记一行）+ `core/schema.ts` 加递归深度上限

**第二批（P2，结构性）**
7. `module.ts` 抽 `capability-slice.ts` + `never` 断言；`async.ts` 抽 `resumeBy(rec, predicate)`
8. 5 处手写文案改插 `zeroClauseOf`；`cases` 改 Record 穷尽
9. `task-events` 非终态流加总条数/总字节上限；`submit` 加 `maxQueued` + 503
10. `loop-result` 的 `eventsDelivered` 接 ctx；stop_reason / transport 加穷尽断言
11. `statusOfStreamError` 抽进 `adapter-options.ts` + 对拍行；openai usage 缺失走 `unpriced` 通道出声
12. 嵌套黑板隔离的选型（要么文档写明不隔离，要么派生子 ctx）

**刻意不做（比做同等重要）**
- 为 `TaskEventStreams.forget` 写测试（未导出、无人调用 ⇒ 等于锁死死代码）
- 为 11 个只读访问器补「被调用」用例（不含分支，断言恒真）
- 抽 `postWithRetries` / `renderOpenMetrics`（论证见 §1.4）
- 给 `verify` 加第 9 步（CI job name 是分支保护的必需检查，写死 8 步）
