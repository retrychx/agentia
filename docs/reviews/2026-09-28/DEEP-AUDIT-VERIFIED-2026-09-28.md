# 深度审计 —— **逐条复核后**的最终确认清单

> 来源：`DEEP-AUDIT-2026-09-28.md`（33–34 条问题行，其中约 22 条只经模块审计转述、未逐行读源码）
> 本次动作：把**每一条**引用的源码行都亲自打开读过，再判「成立 / 需修正 / 降级 / 撤回 / 有意为之」
> 对象：`main` @ `9e16d78`
> 结论口径：**只列我亲手在源码上确认过的**。「修法」一栏是复核后的建议，不是原文照抄。
> 第二轮（用户独立复核，读源码 + 亲跑探针）后已并入：**3 处收窄 + 1 处措辞修正 + 优先级归位**（见 §5）。
> 第二轮同时纠正了复核方自己的三处：`awaitTask.timeoutMs` **不是**定时器站点、真站点比它列的多两个、`runTimeoutMs` 属「旋钮但只差上界」。

---

## 0. 复核覆盖自述（先说清楚我做了什么）

- 逐条打开读过源码的：**34/34**。判据三条 —— ① 引用行号处的**代码真的长那样**；② claim 的**因果/可达性**对不对（路径真能走到吗？别处有没有守卫？）；③ **修法方向**会不会误导。
- 复核手段：`Read` 定点读 + `Grep` 计数（如「`badValue:'throws'` 的旋钮数」「`zeroClauseOf` 调用点」「`'tool.input'` 字面量散落数」「`withRunContext` 调用点」）。
- **与原报告的差异**：**4 条需修正表述**（其中 1 条可达路径比原文窄、1 条「无闸」不准确、2 条原因/计数不准）、**2 条降级**、**1 条性质改写为「有意为之」**、其余 27 条成立。**无 P0**。

| 复核结论 | 条数 |
|---|---|
| ✅ 成立（现象与因果都对） | 21 |
| ⚠️ 成立但表述需修正（原因/范围/计数不准） | 7 |
| ⬇️ 降级（成立但严重性或可达性低于原判） | 2 |
| ↩️ 撤回 | 0 |
| 🔒 性质为「有意为之」（代价已认） | 1 |
| 定义处成立但**当前不可达**（缩范围） | 1 |
| 刻意不做（原报告的「不做」清单，我复核后同意） | 4 |
| 合计问题行 | 33 |

**第二轮（用户独立复核）并入的调整**：`C1` 站点清单精确化（原「三处」不准）、`E4` 收窄为「如实类」、`T1` 收窄为「只改文案不放开闸」、措辞修正「静默」→「stderr 一行警告」。

> **收口后的 P1 收敛为两条**：**`C1` 定时器上界校验**（五站点，别改钳制语义）与 **`T1` cancel 409 文案**（不放开闸）。
> 其余原判 P1（`E1` `beforeTurn` 无 catch、`E2` `mcp-server-http` 补 catch、`T2` `too-fresh`、`T3` `drain` 永不返回、`J1` 能力成环）**本轮复核方未覆盖**，我保留原判、不擅自升降。

---

## 1. 最终确认清单（按级别；每条均【逐行读过】）

### P1 —— 长跑 / 多进程场景会真撞上

| # | 位置 | 现象（已复核） | 证据（我读到的行） | 修法 |
|---|---|---|---|---|
| **C1** | 真站点 **5 处**：`core/timeout.ts:124`（`withTimeout`）、`:182`（`interruptibleSleep`）、`async.ts:1652`（`#raceTimeout`）、`integrations/anthropic.ts:257`（`composeSignal`）、`transport/drain-gate.ts:41`（`drain`） | 超过 `2^31-1ms`（≈24.86 天）的 `setTimeout`：**不报错、不改语义**，只在 stderr 留**一行** `TimeoutOverflowWarning`，然后延迟**被 Node 钳成 1ms**（`30 天` → 立即触发）。**措辞修正**：不是「静默」（有警告），准确说是「警告落在没人看的 stderr」。五处真站点**均无上界校验** | ① `turn.ts:692` / `mcp-server.ts:208` → `withTimeout(p, toolTimeoutMs ?? 0)`（limits 表里 `withTimeout.ms` 的 `badValue:'none'`）；② `anthropic.ts:213`/`openai.ts:267` → `interruptibleSleep(backoffMs(attempt, retryAfter))`，`retry-after` 是**上游头**（`99999999` ⇒ 9.99e10ms）；③ `async.ts:1652` 喂 `this.runTimeoutMs`；④ `anthropic.ts:257` 喂 `options.timeout`（`:92` 只查 `finite && >0`）；⑤ `async.ts:924` `drain` 把 `opts.timeoutMs` **原样透传**到 sleep，一次校验都没有。`MAX_TIMER_DELAY_MS` 全仓只在 `scheduler.ts` 定义 | 把 `MAX_TIMER_DELAY_MS` 上提 `core`，五站点同款**入参/构造期校验 + 响亮报错**（照 `Scheduler.at` 先例：超上限直接抛，文案说「远期单发请拆成多次自检」）。**⚠️ 别改「钳制」语义** —— 现在不是静默，要的是**拒绝坏值** |
| **C1-附** | 澄清（**不是**站点） | `transport/task-waiters.ts:44` 的 `timeoutMs` 来自 `awaitTask` 的 `Math.min(intervalMs, left)`（`async.ts:1154`，`intervalMs` 缺省 250）⇒ **被夹到 ≤250ms，`timeoutMs` 再大也不溢出** | 真能溢出的是 `awaitTask({ intervalMs: 巨大值 })`（缺省 250，低危）。`mcp-stdio.ts:277` 用常量 `MCP_CLOSE_GRACE_MS`、`http.ts:179` 是字面量 `5` ⇒ 均非站点 | 若顺手，可给 `awaitTask` 的 `intervalMs` 也加同款上界 |
| **C2** | `transport/async.ts:363-370`（`runTimeoutMs`）、`integrations/anthropic.ts:92`（`options.timeout`） | 两处**构造期校验只查下界 / 有限性、不查 2^31 上界** | `async.ts:363` `if (!Number.isFinite(this.runTimeoutMs) \|\| this.runTimeoutMs < 0)` —— 作者注释已写「NaN/Infinity 都会被钳到 1ms」，**却漏了「>2^31 也一样」**（真喂点在 `:1652`）；`anthropic.ts:92` 同形（`!Number.isFinite \|\| <=0`）。`scheduler.ts:79` 那句「runTimeoutMs 在 async.ts 有同款防线」**与实现不符** | 两处各补一条上界校验（与 `C1` 同批）；**顺手改掉 `scheduler.ts:79` 的不实注释，以及 `:22`/`:77`/`:128` + `spec.md:2095` + `CHANGELOG.md:1254` 的「静默」措辞** |
| **E1** | `engine/turn.ts:289-304` | `contextPolicy.beforeTurn` **无 try/catch**，而它内部的 `summarize` 是走模型的网络调用 | `turn.ts:289-293` `if (args.contextPolicy) { const next = await args.contextPolicy.beforeTurn(...) }` —— 无 try | 包 try/catch，压缩失败降级为「本回合不压缩」 |
| **E2** | `engine/mcp-server-http.ts:135-158` | 包 `core.dispatch` 的 `try` **只有 `finally`、没有 `catch`**（同文件 auth 与 `JSON.parse` 两处都有 catch）⇒ 异常冒泡 ⇒ unhandled rejection ⇒ 进程退出 | `:135-158` 结构为 `try { ...JSON.stringify(resp)... } finally { res.off(...); core.untrackCall(ac); }`。触发路径：`JSON.stringify(resp)`（`:144`，工具返回自引用对象）、`validateJsonSchema` 递归爆栈（`core/schema.ts:70`）。**工具自身抛错不会冒泡**（`callTool` 有 catch 转 `isError`） | 只给 `:135` 那个 try **补一个 catch**（对齐 `mcp-server-stdio.ts:52` 的 `.catch`），不是整段重构 |
| **T1** | `transport/async.ts:581-588` vs `:1388`/`:1415` | cancel 在「状态已 running、但 `#runAborts` 尚未登记」的窗口内**一律 409**，且 **409 文案说「不在本进程」是错的**（同进程、只是还没拿到并发槽位）。窗口来源：四条恢复路径（`:748`/`:846`/`:964`/`:1059`）都**先置 `running` 再 `#dispatch`**，而登记在 `#slots.acquire()`（`:1388`）**之后**（`:1415`） | `:581` `if (rec.status === 'running' && !inflight) throw 409`；`:1394-1396` 作者亲笔注释确认「恢复那几条路都先置 running 再派发」。**⚠️ 别顺手放开这道闸**：cancel 的记账只在 `wasQueued`（`:601`/`:614`）时进 `#cancelSettled`；若允许取消「本进程未起跑的 running」，等槽位那趟 `#execute` 的 finally（`:1317`/`:1324`）查不到标记 ⇒ **`onFinished` 双发** —— 正是 spec §10 的变异 **M23（sinks 那道闸失效）**，其回归用例的断言时点在「拿到槽位之后」（`spec.md:4012-4017`） | **第一步只做两件事**：① 改 `:584-587` 文案（说「本进程已受理但尚未起跑，请稍后重试」）；② 给「本进程但未起跑」一个**可区分信号**。**放开闸是独立设计项**（须同时改记账归属），另立 |
| **T2** | `transport/resume-policy.ts:58-61` | `too-fresh` 是新鲜度启发式、不是租约。① 单段 run 超过 `staleAfterMs` ⇒ 他进程重启即抢（真重复执行）；② 崩溃孤儿落在保鲜期内被跳过 ⇒ 无人再认领 | `:58-61` `if (opts.staleAfterMs > 0 && rec.ownerId !== undefined) { if (opts.now - since < opts.staleAfterMs) return 'too-fresh'; }`；`ownerId` 恒为 `p<pid>-<uuid>`（`async.ts:383`）⇒ **崩掉的进程留下的孤儿仍有 ownerId**，`resume-policy.ts:48-49` 那句「无主记录永远可抢」的保护**覆盖不到它**。`resumePending` 由宿主在启动时调（`examples/complete/src/main.ts:86`），非周期 | 改心跳租约，或启动后周期性重扫；**注意缺省 `staleAfterMs=0` 时不触发**（`async.ts:1190`），问题只在宿主显式设了 >0 时出现 |
| **T3** | `transport/http.ts:250-255` | `drain()` 默认 `timeoutMs=0`（不限）时，`waitUntil(...Infinity)` 先跑，**强制收口 SSE 排在等待之后** ⇒ 一条不断线、run 不结束的 SSE 让 `drain()` **永不返回** | `:232-233` `timeoutMs ?? 0` ⇒ `deadline = +Infinity`；`:250-251` `runsDrained = ... await waitUntil(..., deadline)`；`:255` `for (const close of [...state.openSse]) close();` —— 收口在等待**之后**。`:249` 注释确认 SSE 计入 `inFlightRuns` | 兜底收口（或至少把 SSE 的 `inFlightRuns` 计数与「等任务跑完」解耦）放在等待之前 |
| **J1** | `toolkit/module.ts:331-352,384` | **能力引用图无任何成环检测**；`@SubAgent({tools:['本 provider']})` 的菜单含它自己 ⇒ 运行期无限递归 | `module.ts` 全文 `cycle`/`visited`/`depth`/`maxDepth`/`seen` 五个关键词命中 **全为 0**；`resolveRefTools(:324-360)` 只校验 provider/能力名存在性。`subagentToTool(capability, resolveTools)` 第二参是**延迟求值 thunk**（`subagent.ts:107`），`wrappedByToken.set(...)` 在循环里先全部建好（`:383-385`）⇒ **纯运行期递归**，`maxIterations` 只限每层宽度 | 装配期 DFS 环检测 + 可选 `maxCapabilityDepth` |

### P2 —— 结构性 / 配置相关 / 一致性问题

| # | 位置 | 现象（已复核） | 证据 | 修法 |
|---|---|---|---|---|
| **C3** ⬇️ | 5 处（`async.ts:363`、`anthropic.ts:96`、`metrics.ts:223/239/243`） | `badValue:'throws'` 旋钮**手写文案**，未插 `zeroClauseOf` ⇒ 文案单源第二次断头 | **精确 5 处**：`async.ts:362-364`、`anthropic.ts:95-97`、`metrics.ts:222-223/238-239/242-243`；表里 `AsyncRunner.concurrency` / `createAnthropicClient.timeout` / `metricsSink.windowSize` / `maxLabelValues` / `maxLabelCombos` **都有 `zeroClause`** | 5 处改插 `zeroClauseOf(...)`。**严重性从我判定为 P2**（不改行为，只影响文案一致性），原报告列 P1 |
| **C4** | `tests/limits.test.ts:542-592` | 对账用例的 `cases` 是**数组不是 Record** ⇒ 无穷尽性；`throws` 旋钮 **16 个只列 10 个** | `:542` `const cases: Array<[LimitKnob, () => unknown, RegExp]> = [...]`，实列 **10** 条；表里 `badValue:'throws'` 数 = **16**（`runTimeoutMs`/`approvalTimeoutMs`/`maxEvents`/`maxRetries`/`retainTerminal`/`concurrency`/`every.maxInFlight`/`maxBodyBytes`/`maxConcurrentRuns`/`maxBufferedBytes`/`streamBufferEvents`/`every.intervalMs`/`createAnthropicClient.timeout`/`windowSize`/`maxLabelValues`/`maxLabelCombos`）。`PROBES` 是 Record 有编译期守卫 | `cases` 改 `Record<`throws 子集`, …>`，与 `PROBES` 同强度 |
| **C5** | `engine/budget.ts:73` | `maxTotalTokens`/`maxCostUsd` 未登记进 limits 表；`NaN` 让护栏静默失效（`totalTokens > NaN` 恒 false） | `budget.ts:73` `if (maxTotalTokens != null && totalTokens > maxTotalTokens)`；`:83` 同构。全文件**不 import limits**（`:1` 只 import `Usage`）。表里确无这两个旋钮 | 登记进表（0 语义 = 「任何用量都超」）；`NaN` 构造期响亮失败 |
| **C6** | `core/schema.ts:58-85` | `checkObject` 递归调 `check` 且**无深度上限** ⇒ 自引用 `properties` 的 schema 无限递归爆栈（`RangeError`） | `:70-75` `const err = check(sub, obj[key], ...)`；`check(:28)` 可再回 `checkObject`。同类还有 `checkArray(:92)`（原报告漏列） | 加递归深度上限（同时兜住 `checkArray`） |
| **E3** | `engine/policy.ts:81` | `lastCompactAt = info.iteration` 在 `await compactMessages(...)` **之前**赋值 ⇒ 压缩失败后滞回额度已被烧掉 | `:81` `lastCompactAt = info.iteration;` `:82` `return compactMessages(...)` | 移到成功之后。**⚠️ 只有在 E1 修好（beforeTurn 有 try/catch）之后才真有后果** —— 否则压缩抛错直接废掉整条 run，谈不上「下次再试」 |
| **E4** ⬇️ 如实类 | `engine/loop-result.ts:145,160` + `loop.ts:427` | **两条独立收窄**：① `failedResult` 只出现在**终态分支**，而终态分支 `async.ts:1562` **无条件**清 `pendingEvents`（作者注释 `:1553-1561` 明写「终态没有第二次机会」）⇒ 该字段在**唯一会出现它的分支里根本没被读**（读取点只有 `:1537` 的挂起分支）⇒ **当前零行为差异**；② 即便补上，事件也**不会**进历史（终态不重放）。所以不是「救回事件」，是「**如实类**：别让结果字段超前于事实」 | `loop-result.ts:135` `suspendedResult` 读 `ctx.eventsDelivered`；`:189` `failedResult` 硬写 `false`。`async.ts:1537` `if (out.result.eventsDelivered) rec.pendingEvents = undefined;`（挂起分支，**唯一读取点**）vs `:1562` 无条件清（终态分支）。**唯一可能被误导的是外部消费者**：`AgentLoopResult.eventsDelivered`（`types.ts:337`）随 `rec.result` 落库、在导出面上 | 给 `failedResult` 加 `eventsDelivered` 入参并传 `ctx.eventsDelivered`（低成本如实）；**不当 P1、不必急于修** |
| **E5** | `engine/types.ts:38,73` + `engine/stop-reason.ts:24` | 新增 `stop_reason` 要动**多处**且**无 `never` 穷尽断言**（对比 `http-endpoints.ts` 有 `const _never: never`） | `types.ts:38-65`（11 成员联合）、`:73` `isSuccessStopReason`（二值检查）、`stop-reason.ts:24` 顺序 `if` 链 —— 全文无 `never` | 加穷尽断言；「4 处」是概数，关键是**无守卫** |
| **E6** | `engine/types.ts:96` vs `engine/policy.ts:66` | `budgetTokens` 只估 messages，system/tools schema 不在口径内，却声明为「估算 **input** tokens」 | `types.ts:96` 注释 `预算（估算 input tokens）`；`policy.ts:66` `if (countTokens(messages) <= budgetTokens)` —— 只喂 messages | 改口径文案（「估算 messages 的 tokens」），或把 system/tools 计入 |
| **E7** ⚠️ | `engine/tracer.ts:303` + `engine/turn.ts:464` | `setAttribute` 不受 `maxEvents` 约束（`event()` 过闸、`setAttribute()` 不过） | `tracer.ts:264` `event()` 有 `recordedEvents >= maxEvents` 闸；`:303-307` `setAttribute()` 直接 `span.attributes[key]=value`，无闸。`turn.ts:464-473` `traceContent:'full'` 走 `setAttribute` | **修正表述**：不是「无闸」—— `turn.ts:467-471` 的正文**受 `maxEventChars` 截断**，且 turns 受 `maxIterations` 上限 ⇒ 有界。准确说法是「**属性条数/总字节**不受 `maxEvents`（条数闸）约束」 |
| **E8** ⚠️ | `'tool.input'`/`'tool.output'` 字面量 | 跨 engine→eval→integrations **三层**手写；`tool-events.ts` 只导出载荷构造器不导出名字常量 | 实际 **~12 处**（非 7）：engine `turn.ts:594/724`、`mcp-server.ts:190/234`、`replay.ts:148/149`；eval `harvest.ts:48/204`、`export.ts:119/140`；integrations `report.ts:175`、`metrics-state.ts:556` | 在 `tool-events.ts` 导出 `TOOL_INPUT`/`TOOL_OUTPUT` 常量，全部改引 |
| **T4** | `transport/task-events.ts:219-233` | LRU **只淘汰终态流**；挂起/长跑（非终态）流的缓冲永不淘汰 | `:219-233` `#evictTerminal()` 只收集 `s.done` 的 id 淘汰 | 给非终态流加总条数/总字节上限 |
| **T5** | `transport/async.ts:392-462` | 队列**无深度上限、无背压信号**，`POST /tasks` 永远 202 | `submit(:392)` 无队列计数、无 `maxQueued`；`:459` 直接 `#dispatch` | 加 `maxQueued` + 503 |
| **T6** ⬇️ | `transport/async.ts:438` vs `:1418` | 异步 store 下初始 `save` 不 await 就派发 ⇒ 迟到的 `queued` 快照理论上可覆盖 `running` | `:438` `const saved = this.store.save(rec);`（不 await）；`:1418` `await this.store.save(rec)`。**降级理由**：`redisStore.save(:131-138)` 在首个 `await` 前就 `JSON.stringify(rec)` 定格快照，单连接命令 FIFO ⇒ 写序有保证；**仅在客户端多连接/重试乱序时才可能回退** ⇒ 我判 **P3** | 记录 + 观察，或初始 save 也纳入同一写序 |
| **T7** 🔒 | `transport/scheduler.ts:190-195` | `status !== 'queued' && !== 'running'` ⇒ 挂起视为不占资源 | `:193` `if (!r \|\| (r.status !== 'queued' && r.status !== 'running')) forget(taskId)`；**`:191-192` 注释明写这是有意的**（不放手会让 `maxInFlight` 永久自闭） | **性质改写为「有意为之（代价已认）」** —— 代价是「全挂起时每 tick 仍派发、任务无上限堆积」。若要收，用独立配额而不是改这一行 |
| **S1** | `store/redisStore.ts:153-157` | TTL **无差别过期**，挂起中的记录同样消失；`approvals`/`pendingApprovals` 随记录落库 ⇒ redis+TTL 下等审批的 run 会在人批之前过期 | `:156` `if (this.applyTtl) await this.applyTtl(key);` —— **无条件**，不看 status。`usage-guide.md` 全文无 `ttlSeconds`/`RedisTaskStore` 说明 | 挂起态跳过 `EXPIRE`（或独立 TTL）+ 补文档。**需 `ttlSeconds` 配置**才触发 |
| **S2** ⚠️ | `integrations/openai.ts:585-587`（原报 221/535） | 端点不给 usage ⇒ token/成本**恒 0** ⇒ `maxCostUsd` 静默失效，且返回 `0` 不是 `null` ⇒ 连「算不出成本」的信号都静默 | `:585-587` `usage: { input_tokens: acc.usage?.prompt_tokens ?? 0, output_tokens: acc.usage?.completion_tokens ?? 0 }`。**修正**：框架**已经**在流式请求发了 `stream_options:{include_usage:true}`（`openai.ts:112`），原报告「需 include_usage」暗示没发 → 错。真实风险是**端点忽略该字段**或 `stream:false` 时上游不回 usage | 缺失走 `unpriced`/`usage.missing` 通道出声，不静默填 0 |
| **S3** | `integrations/anthropic.ts:586` vs `openai.ts:428` | `statusOfStreamError` 两份，目的相同，一致**只靠注释** | `anthropic.ts:586-604` 是 `switch(type)` 返 429/529/400/500；`openai.ts:428-443+` 是 `includes` on key 串 | 抽进 `adapter-options.ts` + 加对拍行。**「该抽的就是它」**（`postWithRetries` / `renderOpenMetrics` 则**不该抽**，理由见 §3） |
| **S4** | `integrations/metrics-otlp.ts:78` | 每次 flush 调 `snapshot()` ⇒ 为每条 run/能力/模型各排一次 1024 窗口，而 **OTLP 侧根本不用分位** | `metrics-otlp.ts:78` `const s = state.snapshot();`；`metrics-state.ts:259-262` `percentile()` 每次 `[...this.ring].sort()`；`:578-593/622-623` `snapshot()` 无条件算 `latencyP50/P95`。`grep latencyP50\|latencyP95 src/integrations/metrics-otlp.ts` → **空** | 让 `snapshot()` 分位可选，或 OTLP 用一个不算分位的视图 |
| **S5** | `store/store.ts:99-119` | `compact()`/`close()` 在接口之外 ⇒ 第五套 store 的压实/关闭没有统一出口 | 接口只有 `save/get/byIdempotency/list/listDue?/clear`；`sqliteStore.ts:204 close()`、`fsStore.ts:139 compact()` 是各自私有的 | 提到接口（或定义 `DisposableTaskStore`） |
| **S6** | `integrations/mcp-stdio.ts:76,134` | stdout 缓冲只按 `\n` 切分且**无上限**；server 永不出换行 ⇒ 无界增长 | `:76` `let buf = '';`；`:134-140` `buf += chunk` 后逐 `\n` 切分，无长度上限 | 加缓冲上限（超限即 fail） |
| **K1** | `runtime/context.ts:17` + `runtime/run.ts:198-201` | **整棵嵌套树共用一份 `RunContext` / 一块黑板**；对话历史与 system 都裁剪，**黑板没有** | `context.ts:17` `const store = new AsyncLocalStorage<RunContext>();`；`run.ts:198/201` `const ctx = new RunContext(run)` + `withRunContext(ctx, …)` —— **全仓唯一调用点**（`grep withRunContext src/` 只命中定义与这一处）。子 agent 走 `runAgent` 不新建 ctx ⇒ 继承同一 ALS | 二选一：**文档写明「不隔离」**，或派生子 ctx。我倾向先补文档（spec §2 只写「单次运行内累积」，未提嵌套） |
| **K2** ⚠️ | `toolkit/module.ts`（多处） | 加第五类能力要在同一文件改**多处并行分支**，无编译期护栏 | 分散在 `:289-297`（收集）、`:336-343`（可用名单）、`:362-378`（`buildSlice` 四路展开）、`:395-399`（版本表）、`:418`（重名校验）、`:433`（计数）。**「7 处」是概数**，方向对 | 抽 `capability-slice.ts`（`CAPABILITY_KINDS` 注册表）+ `never` 断言 |
| **K3** | `runtime/run.ts:40-113` | `RunStatus` 承诺 6 态，`Run` 实际只能到 **5** 态（`cancelled` 不可达）；且 `start()` 有守卫而 `finish()` 没有 ⇒ `suspended` 后再 `finish` 会静默翻终态 | `core/run.ts:18-31` 6 成员（含 `cancelled`）；`runtime/run.ts` 无任何方法写 `cancelled`；`:62-66 start()` 有 `!== 'queued'` 守卫，`:79-85 suspend()` 有守卫，**`:68-72 finish()` 无** | 给 `finish()` 加守卫；或明确 `cancelled` 只在 transport 层（`TaskRecord.status` 用同一 `RunStatus`） |
| **K4** | `container/container.ts:116-131` | async 工厂被**静默接受并缓存为 Promise** ⇒ 下游注入到的是 Promise 而非 await 过的值，首次属性访问全 undefined 且零报错 | `:121-125` `useFactory(...deps)` 结果直接赋 `value`；`:130` `this.cache.set(token, value)`；`:131` 原样返回 —— 无 `await`、无 thenable 检查 | 检测 thenable ⇒ 构造期响亮失败（或提供 `resolveAsync`） |
| **K5** | `runtime/run.ts:367-378` | 记忆回写是**无条件全量读改写**，无版本号/CAS、无体积上限 ⇒ 并发 run 共用 `{store,keys}` 时 lost update | `:367-378` `flushMemory` 只做 `entries[key]=ctx.get(key)` 后 `store.save(entries)`（last-write-wins） | 加版本号/CAS，或文档写明「同 keys 并发不安全」 |
| **K6** | `toolkit/subagent.ts:87-98` vs `docs/usage-guide.md:246` | 三态 `system` 的隐性差异（前两形态追加 `REPORT_HINT`、函数形态**不追加**）没进使用者文档 | `subagent.ts:92` `if (typeof spec === 'function') return spec(task);`（**无** hint）；`:93-97` 另两形态追加 `REPORT_HINT`。`usage-guide.md:246` 只列三种形态，未提差异 | 在 usage-guide 的 `system` 一行补「函数形态不追加运行提示」 |

---

## 2. 相比原报告的**修正**（逐条）

| 原报告 | 复核结论 | 改成什么 |
|---|---|---|
| E4「`abortedResult`/`failedResult` 硬写 `eventsDelivered:false` ⇒ 续跑重复注入」 | ⚠️ **可达路径比原文窄** | `suspendedResult`/`finishedResult` **都接了** `ctx.eventsDelivered`；`abortedResult` 唯一调用点在注入点**之前**、当前不可达。**真破口只有 `failedResult`（loop.ts:427 的 catch）** |
| E7「`setAttribute` 不受 `maxEvents` 约束 ⇒ trace 线性膨胀**无闸**」 | ⚠️ **「无闸」不准确** | `setAttribute`（tracer.ts:303）确实不过条数闸，但 `traceContent` 的正文**受 `maxEventChars` 截断**（turn.ts:467-471），turns 又受 `maxIterations` 上限。准确表述：「不受**条数**闸，长度仍受截断闸」 |
| E8「`'tool.input'/'tool.output'` 散落 **7 处**」 | ⚠️ **计数偏小** | 实际 **~12 处**（engine 6 + eval 4 + integrations 2）。方向（跨三层）对 |
| S2「端点不给 usage（**需** `stream_options.include_usage`）」 | ⚠️ **原因说反** | 框架**已发** `include_usage:true`（openai.ts:112）。真实风险是端点**忽略**它、或 `stream:false` 时上游不回 usage ⇒ `?? 0` 静默 |
| K2「`module.ts` 加第五类能力要改 **7 处**」 | ⚠️ **计数是概数** | 是「多处分散分支」（收集 / 可用名单 / `buildSlice` / 版本表 / 重名校验 / 计数），方向对、精确值难钉 |
| C3「5 处手写文案」列 **P1** | ⬇️ **降为 P2** | 不改行为、只影响文案一致性。**5 这个数精确命中** |
| T6「初始 save 不 await ⇒ 状态回退」列 **P2** | ⬇️ **降为 P3** | 单连接 FIFO 下写序有保证；仅多连接/重试乱序才可能，属理论风险 |
| T7「挂起视为不占资源 ⇒ 堆积」列 P2 | 🔒 **改性质** | `scheduler.ts:191-192` 注释明写这是**有意为之**（否则 `maxInFlight` 永久自闭）。保留为「有意取舍 + 已知代价」 |
| C1「`core/timeout.ts:124`、`:185`、`:205-214`（`backoffMs`）**三处 setTimeout**」 | ⚠️ 微修正 | `backoffMs`（`:205-215`）**不调 setTimeout**，它**产出**喂给 `interruptibleSleep` 的值。真站点是 `:124` 与 `:182` 两处（加 `async.ts:1652`） |
| C1「三处站点」 | ⚠️ **站点数偏小** | 真站点 **5 处**（+`anthropic.ts:257`、+`drain-gate.ts:41`）；`awaitTask.timeoutMs` **不是**站点（被 `Math.min(intervalMs, left)` 夹到 ≤250ms） |
| E4（我上一版仍列 P2） | ⬇️ **再降为「如实类」** | 终态分支 `async.ts:1562` **无条件**清 `pendingEvents`，而 `eventsDelivered` 只在挂起分支（`:1537`）被读 ⇒ **当前零行为差异**。修法是「字段如实」，**不是**「救回事件」 |
| T1 修法曾写「判据改『本进程已受理』」 | ⚠️ **修法收窄** | 放开那道闸会触发 spec §10 的变异 **M23**（`#cancelSettled` 只按 `wasQueued` 记账 ⇒ `onFinished` 双发）。第一步**只改文案 + 给可区分信号** |
| 全文「静默钳到 1ms」 | ⚠️ **措辞修正** | Node 会打 `TimeoutOverflowWarning`（stderr 一行）⇒ 不是「静默」。准确说法：**警告落在没人看的 stderr**。修法目标因此是「**拒绝坏值**」，不是「补一个静默语义」。仓库同措辞处：`scheduler.ts:22/77/128`、`spec.md:2095`、`CHANGELOG.md:1254` |

---

## 3. 有意为之 / 刻意不做（复核后**同意**，别当缺陷修）

- 🔒 **`scheduler` 挂起不占执行资源**（`scheduler.ts:191-192`）：注释已认代价。
- 🔒 **`task-waiters` 只覆盖本进程写终态** ⇒ `awaitTask` 的兜底轮询存在：AGENTS.md 明写「不是缺陷」。
- 🔒 **`postWithRetries` 两份不抽**（openai.ts:239-246 头注）：响应消费形态不同，抽了只会得到「参数比逻辑多」的壳子。**该抽的是 `statusOfStreamError`**。
- 🔒 **`renderOpenMetrics` 复用 `renderPrometheus` 文本再改**：刻意逐字节同源，比抽公共件更难漂。
- 🔒 **为 `TaskEventStreams.forget` 写测试**：复核确认它是**未导出的内部死方法**（`task-events.ts:214` 定义，全仓无调用点 —— `grep` 命中的 `forget()` 全是 `scheduler.ts` 的局部函数）⇒ 写测试 = 锁死死代码。
- 🔒 **为 11 个只读访问器补「被调用」用例**：不含分支，断言恒真。
- 🔒 **给 `verify` 加第 9 步**：CI job name 是分支保护的必需检查，写死 8 步。

---

## 4. 复核方法与局限（如实）

- **「成立」的定义**：我打开引用行、确认代码与 claim 一致，并尽量确认路径可达。对**配置相关**的项（T2 / T3 / S1）我标注了触发前提 —— 它们是「条件成立」，不是「默认必现」。
- **我没做的**：没有跑新的运行时实验（唯一 `【实测】` 仍是上一轮的 `setTimeout 2^31` 探针）。因此 `T6` 的写序风险、`S4` 的排序开销都是**静态推断**，若要坐实需跑一次。
- **`E5` 的「4 处」、`K2` 的「7 处」、`E8` 的「7 处」**是原报告的概数，我按源码逐个点名后有增有减（见 §2）——**计数会过期，清单不会**（这也是 `limits.ts:33-37` 自己写下的教训）。
- 本文件**只做只读分析，未改任何生产代码**。

---

## 5. 第二轮（用户独立复核）—— 并入的调整与我对其的核对

复核方读源码 + 亲跑探针独立复核，**两条成立**（① `setTimeout` 2^31 溢出，探针复现；② cancel 409 文案误导），并提了三处收窄。我逐条核过：**三处收窄全部成立**；同时纠正了复核方自己的三处。

| 复核方主张 | 我核到的 | 证据 |
|---|---|---|
| 「三处用户传参口：`awaitTask.timeoutMs` / `drain.timeoutMs` / 工具超时」 | ⚠️ **部分不准**：`awaitTask.timeoutMs` **不是**定时器站点（`Math.min(intervalMs, left)`，缺省夹到 250ms）；真站点 **5 处**，比该清单**多两个**（`anthropic.ts:257`、`drain-gate.ts:41`） | `async.ts:1154`；`anthropic.ts:92/257`；`async.ts:924` |
| 「`#wakeDue` 由 `resumePending` / `poll` 扫描，不自排定时器」 | ✅ **完全成立**：`async.ts:34` 注释原文「到点由 `resumePending` / `poll` 的**惰性**扫描唤醒（不起定时器）」；全仓 `wakeAt` 无任何 `setTimeout` | `async.ts:34`、`wake-policy.ts` |
| 「`E4` 是『如实类』，不是 P1」 | ✅ **成立，且比其说的更弱**：`eventsDelivered` 只在挂起分支（`async.ts:1537`）被读，`failedResult` 只出现在终态分支 ⇒ **零行为差异**；唯一影响面是导出字段对**外部消费者**撒谎 | `async.ts:1537` vs `:1562`、`loop-result.ts:189` |
| 「`T1` 别顺手放开闸」 | ✅ **成立**：放开会触发 **M23**（`onFinished` 双发）；`#cancelSettled` 只按 `wasQueued` 记账 | `async.ts:601/614/1317/1324`、`spec.md:4010-4017` |
| 「2^31 不是『静默』」 | ✅ **成立**（探针同样打出 `TimeoutOverflowWarning`）；两边（我 + 仓库惯用措辞）都已列为待改 | Node 探针输出、`scheduler.ts:22` |

**因此收口**：P1 两条 —— `C1` 定时器**上界校验**（五站点，**拒绝坏值**、别改钳制语义）+ `T1` cancel 409 **文案**（不放开闸）。`E4` → 如实类；`T6` / `S4` 仍是**静态推断**，无读数前不升 P1。
