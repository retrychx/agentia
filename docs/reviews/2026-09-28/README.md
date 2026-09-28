# 2026-09-28 外部深评 / 审计 / 结构盘点 —— 归档 + **逐条落地状态**

> **本目录是什么**：2026-09-28 那轮外部复核产出的 **5 份报告原文逐字入库**（一个字没改），
> 加这一份索引。报告是**当日的快照**，下面的状态表才是「**今天还剩什么**」。
>
> **引用口径（重要）**：报告正文里写的「未修 / 存在 / 白算」是**当日判定**。要判「现在还成不成立」，
> 看本表与 `docs/spec.md` §10 的落地条目（⑧–⑱）。⚠️ **不要把正文当现状读** —— 它至少已经有
> **20 条**被修掉了（P1 8 + P2 12）—— 准确计数看 §2 的两张表，那才是真源（⚠️ 本行早先写的「18 条」是我自己的算术错，见 `docs/spec.md` §10 ⑳ 的订正说明）。

## 0. 为什么入库（这条改了一个惯例）

此前这类「给人读的复核报告」按仓库惯例**不随仓提交**（一直以 `??` 出现在 `git status`，
归档进 `.workbuddy/`，而那目录被 `.gitignore` 忽略）。改成入库的两个理由：

1. **剩余条目是真实的待办来源**（下面还有 13 条未做），不入库 ⇒ 只有当天在场的人还知道；
2. `spec.md` / `CHANGELOG.md` 里有 **7 处**引用这些报告（见 §3），而那 7 处此前指向一个
   **不在仓里**的文件 —— 「文档指向一个读不到的东西」本身就是坏引用。

⚠️ **代价如实**：入库意味着这些文字会随代码**漂移**。所以定三条：
- 报告正文**逐字保留**（它是历史记录，不改写；报告里被后续订正的判断，正文里也仍是原样）；
- 「现在还剩什么」**一律以本索引为准**；
- **每落地一条回来更新本表** —— 这是本目录唯一需要维护的地方。

> 「逐字保留」不是姿态：5 份文件入库前后逐份 `shasum -a 256` 比对，**逐字节一致**。
> 连报告自己标注错误的地方（例如 `SRC-STRUCTURE` §3.3 那段「初稿写错了、在此订正」）
> 也原样保留 —— 订正过程本身是该轮的记录。

## 1. 五份分别是什么

| 文件 | 行数 | 是什么 | 现在怎么读 |
|---|---:|---|---|
| `DEEP-AUDIT-VERIFIED-2026-09-28.md` | 138 | **最终确认清单**：33 条问题行**逐条回源复核后**的版本 | **要当施工清单就看这份**。P1 已清零；§1 的 P2 表见下方 §2.2（26 条，已落地 12） |
| `DEEP-AUDIT-2026-09-28.md` | 304 | 原始审计全貌（9 个模块分组 + 33 条问题行） | 问题清单已被上表取代；**独有价值**是 §3.2「现有验证手段盘点」/ §3.4「建议的四层验证策略」/ §1 逐模块叙述 / §3「刻意不动」论证 |
| `DEEP-REVIEW-2026-09-28.md` | 287 | 更早一轮外部深评（对象 v0.9.4 @ `25c1983`） | 两条 P1 与 P2-1/P2-2/P3-1/P3-2 **全部已落地**（见 §2.3） |
| `PR-164-REVIEW-2026-09-28.md` | 193 | 对 PR #164 的复核（同一条外部线） | 残余两条（§2 守卫盲区 / §4 折叠不变量）**均已落地**（见 §2.3） |
| `SRC-STRUCTURE-2026-09-28.md` | 213 | `src` 结构与体量盘点（大文件 / 大方法 / 要不要再加一层） | 结论「**先不加层**」仍有效；§4 的落地顺序 **1–4 全部已落地**（见 §2.3） |

## 2. 逐条落地状态（入库时**回源复核**，2026-09-28 夜）

**怎么核的**：不采信报告自述、也不采信上一轮的归档备注 —— 对每条按它自己给的位置
（文件 + 行 + 判据）在**当前 `main`** 上重跑定点 `grep` / 读源码。所以下面的「未做」
是**读数**，不是印象。（「未做」的判据举例：`E5` = `grep '_never\|: never' engine/types.ts
engine/stop-reason.ts` **仍为空**；`S3` = `statusOfStreamError` **仍有两份定义**。）

### 2.1 `DEEP-AUDIT-VERIFIED` §1 的 P1 表（9 条 + 1 条澄清）

| # | 条目 | 状态 | 落地处 / 现状读数 |
|---|---|---|---|
| `C1` | 定时器上界（**5 个真站点**） | ✅ **已落地** | #169：`MAX_TIMER_DELAY_MS` 上提 `core/timeout.ts` 单源；五站点走 `assertTimerDelay`（**拒**坏值）。⚠️ 报告自己已按第二轮修正措辞（不是「静默」，是「警告落在没人看的 stderr」） |
| `C1-附` | `awaitTask({ intervalMs })` 也加上界 | ❌ **未做**（低危） | `transport/async.ts:1323` `opts.intervalMs ?? 250`，无上界校验 —— 但实际被 `Math.min(intervalMs, left)` 夹到 ≤250ms，溢出不了（与报告判断一致） |
| `C2` | 两处构造期校验漏 2^31 上界 | ✅ **已落地** | #169：`async.ts:513`（`runTimeoutMs`）与 `anthropic.ts:105`（`createAnthropicClient.timeout`）各一句 `assertTimerDelay` |
| `E1` | `contextPolicy.beforeTurn` 无 try/catch | ✅ **已落地** | #170：压缩失败降级为「本回合原样放行」+ `context.policy_failed` 事件 + `console.warn` |
| `E2` | `mcp-server-http.ts` 的 `try` 只有 `finally` | ✅ **已落地** | #170：补 catch ⇒ 200 + JSON-RPC `-32603`（不带走宿主进程） |
| `T1` | cancel 409 文案说错 | ✅ **已落地** | #169：**只改文案、未放开闸** —— 与报告「别顺手放开这道闸」的判据一致（放开会踩 M23 的 `onFinished` 双发） |
| `T2` | `too-fresh` 是启发式不是租约 | ✅ **已落地** | #170：续跑租约 |
| `T3` | `drain()` 可能永不返回 | ✅ **已落地** | #170：收口顺序（兜底收口排在等待**之前**） |
| `J1` | 能力引用图无成环检测 | ✅ **已落地** | #170：装配期环检测 |

**P1 合计：8 条落地 / 1 条未做（低危澄清项）。报告 §0 说「P1 收敛为两条」的收敛过程本身也已归档在正文里。**

### 2.2 `DEEP-AUDIT-VERIFIED` §1 的 P2 表（26 条）

| # | 条目（一行摘要） | 状态 | 落地处 / 现状读数 |
|---|---|---|---|
| `C3` | 5 处 `badValue:'throws'` 文案未插 `zeroClauseOf` | ✅ **已落地** | #172：实现侧文案接上 `zeroClauseOf`（7 处，含被通用文案盖掉的） |
| `C4` | `limits.test.ts` 的 `cases` 是数组 ⇒ 无穷尽性 | ✅ **已落地** | #172：改 `Record` + **A4 单向穷尽断言**（每个 throws 旋钮都必须有 case） |
| `C5` | `maxTotalTokens` / `maxCostUsd` 未登记进 limits 表 | ✅ **已落地** | #172：登记（0 语义 = 「任何用量都超」）+ `NaN` 构造期响亮失败；同批补登另 3 个未登记旋钮 |
| `C6` | `core/schema.ts` 无递归深度上限（环 ⇒ 爆栈） | ✅ **已落地** | #171：`assertNoSchemaCycle()` 前置抓环（祖先集，共享子树不算环）+ `MAX_SCHEMA_DEPTH` |
| `E3` | 压缩失败的滞回额度被烧掉 | ✅ **已落地** | #170：改记「上次**成功**压缩的回合」 |
| `E4` | `failedResult` 硬写 `eventsDelivered: false` | ✅ **已落地** | #178：`eventsDelivered` 从**内层** `LoopContext` 挪到**跨段共享**的 `progress` 上（外层 catch 够不到内层 —— 那正是它只能硬写 `false` 的原因），catch 按事实传。**零行为变更**（终态分支本来就无条件清 `pendingEvents`），坏的是**对外字段**；配回归用例，**变异撤回传参即红** |
| `E5` | 新增 `stop_reason` 无 `never` 穷尽断言 | ✅ **已落地** | #178：`===` 链换成 `Record<AgentStopReason, boolean>` **分类表** —— 往联合加成员不表态 ⇒ `tsc` 报缺属性（实测 `TS2741`）；比报告要的 `never` 断言**更强**（编译期就拦）。配 `tests/types/stop-reason.types.ts` 的 `@ts-expect-error` 正控 |
| `E6` | `budgetTokens` 口径文案说「input」但只估 messages | ✅ **已落地** | #178：口径改准 —— 只估 `messages`（system prompt 与 tools schema 不在其中，真实 input tokens 恒 ≥ 它）；`types.ts` 与 `usage-guide` 两处同改 |
| `E7` | `setAttribute` 不受 `maxEvents` 约束 | ✅ **已落地**（只改口径，代码未动） | #178：准确说法落进 `tracer.ts` 的 `setAttribute` 注与 `observability.md` 那张表（原表只写「超限即停」，易被读成「一切都不再记」）；⚠️ 并写明**为什么不加截断** —— 属性是交付 trace 与增量流**共用的同一份载荷**，折叠契约（按 `seq` 折回**逐字等于** `snapshot()`）的两端就是它们 |
| `E8` | `'tool.input'/'tool.output'` 跨三层手写 | ✅ **已落地** | #174：常量落 **`core/trace.ts`**（⚠️ **不是**报告建议的 `engine/tool-events.ts` —— `integrations` 只许依赖 `core`，落 engine 够不着）+ 源码级守卫 |
| `T4` | 非终态流的缓冲「永不淘汰」 | ❌ **未做**（但当日判据不完整） | 单流**条数**上限（`TASK_STREAM_DEFAULT_MAX_EVENTS = 500`，丢最旧 + `NaN` 闸）**在审计当时就已存在**（#115 起）—— 报告漏看了这一条；**仍然成立**的是「非终态流的**表项**不被回收」⇒ 挂起任务越多流表项越多（每个 ≤500 条 / ≈1MB）。要收就收表项，不是收条数 |
| `T5` | 队列无深度上限、无背压信号 | ✅ **已落地** | #173：`maxQueued` + `TaskQueueFullError` ⇒ HTTP **503 + `Retry-After`**（判据是「真正在排队的深度」，不是「已受理未持槽数」） |
| `T6` | 初始 `save` 不 await 就派发 | ❌ **未做**（P3，低危） | `async.ts:592` 仍 `const saved = this.store.save(rec);`（不 await）。报告已自行降级：redis 单连接命令 FIFO ⇒ 写序有保证 |
| `T7` | 挂起任务视为不占资源 | 🔒 **有意为之**（代码未动） | `scheduler.ts:191-192` 的作者注释仍在岗（「不放手会让 `maxInFlight` 永久自闭」）；报告自己改写性质为「代价已认」 |
| `S1` | redis TTL 无差别过期（挂起记录也消失） | ❌ **未做**（文档那半已落地） | `redisStore.ts:156` `applyTtl` **仍无条件**（不看 status）；但报告指出的「`usage-guide` 全文无 `ttlSeconds` 说明」**已补**（`usage-guide.md:505`） |
| `S2` | 端点不给 usage ⇒ token/成本恒 0 且静默 | ❌ **未做** | `openai.ts:585-587` 仍 `acc.usage?.prompt_tokens ?? 0`，**无** `unpriced` / `usage.missing` 通道 |
| `S3` | `statusOfStreamError` 两份、一致只靠注释 | ❌ **未做** | 仍是两份（`anthropic.ts:593` / `openai.ts:424`）。`adapter-options.ts` 已存在，只是没收它 |
| `S4` | 每次 flush 白算分位 | ✅ **已落地** | #176：**删掉那次 `state.snapshot()`**（三个标量直读公开字段）。⚠️ 与报告建议的两条（「分位可选」/「不算分位的视图」）**都不同**，理由见 `spec.md` §10 ⑱；实测白算 **99.3%**（`npm run bench:otlp`） |
| `S5` | `compact()` / `close()` 在 store 接口之外 | ❌ **未做** | `store.ts` 接口仍只有 `save/get/byIdempotency/list/listDue?/clear` |
| `S6` | `mcp-stdio.ts` stdout 缓冲无上限 | ❌ **未做** | 仍 `buf += chunk` 后按 `\n` 切分，无长度上限 |
| `K1` | 嵌套树共用一份 `RunContext` / 一块黑板 | ❌ **未做** | `context.ts:17` 单例 ALS + `run.ts:198` 唯一调用点（报告读数仍准确）；报告倾向的「先补文档写明不隔离」在 `spec.md` **也没有** |
| `K2` | 加第五类能力要改多处、无编译期护栏 | ❌ **未做** | 无 `toolkit/capability-slice.ts`，无 `CAPABILITY_KINDS` 注册表 |
| `K3` | `Run.finish()` 无守卫（`suspended` 后可静默翻终态） | ❌ **未做** | `runtime/run.ts:68` `finish()` 仍无守卫（`start()` / `suspend()` 都有） |
| `K4` | async 工厂被静默缓存为 Promise | ❌ **未做** | `container.ts` 仍无 thenable 检测 |
| `K5` | 记忆回写全量读改写、无 CAS / 体积上限 | ❌ **未做** | `run.ts:367` `flushMemory` 仍 last-write-wins |
| `K6` | 三态 `system` 的隐性差异没进使用者文档 | ❌ **未做** | `subagent.ts` 的 `resolveSubSystem`：函数形态 `return spec(task)`（**不追加** `REPORT_HINT`），`SystemPrompt` 与 `string` 两形态追加；`usage-guide.md:246` 只列三种形态、未提这个差异 |

**P2 合计：12 条已落地 / 13 条未做 / 1 条「有意为之」（代码未动、性质已认）—— 共 26 行。**

> ⚠️ **本表的两处订正（2026-09-28，`spec.md` §10 ⑳ 有完整说明）**：① 汇总行原先写「11 已落地 / 14 未做」——
> 那是我自己的算术错，逐行数出来是 8 / 17+1（`P2` 表共 **26** 行）；② 入库时**漏了第 26 行 `K6`**（三态 `system` 的差异），
> 现已补上。教训：**汇总数字要能从逐行状态里数出来**，不能凭印象写。

### 2.3 另外三份的残留项

| 出处 | 条目 | 状态 | 落地处 |
|---|---|---|---|
| `DEEP-REVIEW` | 两条 P1（drain 第四条派发路径 / `approvals` 无界） | ✅ 已落地 | #164 |
| `DEEP-REVIEW` | `P2-1` 停机窗口的派发散在七处 | ✅ 已落地 | #164 收成唯一入口（`spec.md` §10 ⑨） |
| `DEEP-REVIEW` | `P2-2` 缓冲满的 409 对「等审批」是死路 | ✅ 已落地 | 改按 `suspendedReason` 分两种说法（§10 ⑨） |
| `DEEP-REVIEW` | `P3-1` 截断在增量出口是静默的洞 | ✅ 已落地 | 同日 §10 ⑧：`trace.truncated` 一次性 marker 进增量流 |
| `DEEP-REVIEW` | `P3-2` `task.event.delivered` 时点超前于事实 | ✅ 已落地 | 同日 §10 ⑧：改名 `injected`，口径改「注入进本段消息流」 |
| `PR-164-REVIEW` | §2 守卫盲区 `#executeInner` | ✅ 已落地 | §10 ⑨：源码级穷尽守卫改为**两条**（`this.#execute(` 与 `this.#executeInner(` 各只许出现在自己的那一个家里） |
| `PR-164-REVIEW` | §4 「P3-1 增量 marker 打破折叠不变量」 | ✅ 已落地 | 同上 §10 ⑧（折叠不变量的用例随之补齐） |
| `SRC-STRUCTURE` | §4 落地顺序 **1**：`http.ts` 拆路由体 | ✅ 已落地 | `http-route.ts` / `http-endpoints.ts` / `http-io.ts`（§10 ⑩） |
| `SRC-STRUCTURE` | §4 落地顺序 **2**：`mcp-server.ts` 拆 `createMcpServer` | ✅ 已落地 | 441 → 47 行 + 两个传输各居其文件（§10 ⑩） |
| `SRC-STRUCTURE` | §4 落地顺序 **3**：`#executeInner`（247 行） | ✅ **已定案：不拆** | §10 ⑩ 第 3 件：**零代码改动**，产出一份有依据的「不拆」决定（编排归属的定义） |
| `SRC-STRUCTURE` | §4 落地顺序 **4**：补「文件级无环」守卫 | ✅ 已落地 | `tests/architecture/file-cycles.test.ts` + 抽 `integrations/mcp-protocol.ts` 断开那条**真实值环**（报告 §3.3 的订正：那条不是 `import type` 边） |
| `SRC-STRUCTURE` | §4 落地顺序 **5**：`src` 加层 | ✅ **已定案：不做** | 与报告结论一致：加层的前置三件事没做完时收益只是「目录树好看」 |

**这三份的残留项：除「定案不做」的两条外，全部已落地。**（本表按 `spec.md` §10 的落地记录标注；
其中 `DEEP-REVIEW` / `PR-164-REVIEW` 的条目未逐行重读源码 —— 它们是**功能**已验证的条目，
落地时各自带用例；§2.1 / §2.2 那两张表才是逐条 `grep` / 定点读复核过的。）

## 3. 引用面：7 处「未随本仓提交」现在要读成什么

`spec.md` 与 `CHANGELOG.md` 里此前有 7 处这样写（**原文不改**，因为那是当日事实的记录）：

| 位置 | 原文口径 |
|---|---|
| `spec.md:4224` | `PR-164-REVIEW-2026-09-28.md`，**未随本仓提交** |
| `spec.md:4256` | 来源：`SRC-STRUCTURE-2026-09-28.md`（**未随本仓提交**，与两份复核报告同惯例） |
| `spec.md:4438` | 来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md`（**未随本仓提交**，与三份复核报告同惯例） |
| `spec.md:4489` | 来源：`DEEP-AUDIT-VERIFIED-2026-09-28.md`（**未随本仓提交**） |
| `CHANGELOG.md:12` | 来源同上：`DEEP-AUDIT-VERIFIED-2026-09-28.md`（**未随本仓提交**） |
| `CHANGELOG.md:315` | 底盘见**仓库根** `SRC-STRUCTURE-2026-09-28.md` 的落地顺序 1–4 |

⇒ **自本目录入库起：**
- 前 5 处的「未随本仓提交」**不再成立** —— 那些文件现在在 `docs/reviews/2026-09-28/`。
  按 `spec.md` 的**只增不改**纪律，原文一字未动，权威更正是 `spec.md` §10 ⑲ 那条。
- 第 6 处（`CHANGELOG.md:315`）是一个**坏引用**（指向一个从来没在仓库根存在过的路径），
  已就地修成入库后的真实路径 —— **修的是坏引用，不是历史事实**（记录这条的是 `CHANGELOG`
  Unreleased 段，同一批改动里有说明）。

## 4. 下一轮从哪接

1. **P2 表还有 13 条未做**（`T4` / `T6` / `S1`–`S3` / `S5` / `S6` / `K1`–`K6`），按「会不会真咬人」排序，
   先看这四条：`K3`（`finish()` 无守卫 ⇒ `suspended` 后可静默翻终态）、`K4`（async 工厂被静默缓存成 Promise，
   下游拿到的是 Promise）、`S2`（端点不给 usage ⇒ 成本静默恒 0，连「算不出」的信号都没有）、
   `K6`（文档缺一句：函数形态的 `system` 不追加运行提示 —— 纯文档，最便宜）。
2. `DEEP-AUDIT-2026-09-28.md` §3.2 / §3.4 那两节（验证手段盘点 / 四层验证策略）**从未被动过**，
   它是本仓质量门禁的下一步来源。
3. 每落地一条，回来改 §2 的表 —— 详见 §0 的三条约定。
