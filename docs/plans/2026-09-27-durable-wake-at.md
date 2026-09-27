# durable 候选 1 实施设计：`wakeAt` 挂起（含配套 5 / 6）

> 撰写时刻：**2026-09-28 00:3x**（承接同夜的 2026-09-27 批次；正文对「09-27」的引用一律指那一批）。
> 上游：`docs/plans/2026-09-27-durable-execution-research.md` §6 候选 1（`wakeAt` 挂起）、
> 配套 5（挂起的取消 / 排空）、配套 6（挂起期可见性）—— 调研文档 §6 明确要求 **5/6 与 1 同批**，
> 分开做会让每一批都留一个静默口子。
> 本稿**只设计、不写实现代码**；状态：**待定案**（§7 有一处要你拍的设计分叉）。

## 0. 一句话

让一条 run 能挂起到**一个时刻**（而不只是「等一个人」），醒来后从挂起点续跑；
并把「现在有几条在睡、最早什么时候醒、停机时它们怎么办」变成**看得见的读数**。

## 1. 事实基础（逐条核证过，标了 file:line）

| # | 事实 | 出处 |
|---|---|---|
| 1 | `RunStatus = 'queued' \| 'running' \| 'awaiting_approval' \| 'succeeded' \| 'failed'`（五值）；头注已写明挂起语义：非终态、不占并发槽、`resumePending` 不捡走 | `src/core/run.ts:10-14` |
| 2 | 挂起由**引擎**产出：回合收尾 `stopReason === 'awaiting_approval'` 且结果带 `suspendedMessages` ⇒ 宿主写 `rec.status='awaiting_approval'` + `approvalPendingSince` | `src/transport/async.ts:924-929` |
| 3 | 「终态」判定是**三值白名单**：`status !== 'queued' && !== 'running' && !== 'awaiting_approval'` | `src/transport/async.ts:123-125` |
| 4 | ⚠️ `resume-policy.ts:47`：`if (status !== 'queued' && status !== 'running') return 'terminal'` —— **非 queued/running 一律被报成 skip 原因 `'terminal'`**。加第六个状态若不改这里，一条在睡的 run 会被具名成「终态」——**静默说错话**，且这是本仓最反复修的一类病 | `src/transport/resume-policy.ts:47` |
| 5 | 审批超时闸 gate 在状态上：`timeoutMs > 0 && rec.status === 'awaiting_approval' && now - (approvalPendingSince ?? startedAt ?? createdAt) > timeoutMs` | `src/transport/approval-policy.ts:21-27` |
| 6 | ⚠️ 超时到期后的编排**不看有没有待决项**：`#expireAndResume` 只要 `approvalExpired` 为真就 `fillTimeoutDenials` + `status='running'` + 重派（`approvalsComplete` 只在 `approve` 里被用到，见 `async.ts:528` —— 超时这条路完全不问「决定齐没齐」） | `src/transport/async.ts:597-621, 528`、`approval-policy.ts:33-45` |
| 7 | `approve()` 只认 `awaiting_approval`，否则抛 409（`TaskApproveError`） | `src/transport/async.ts:481-540` |
| 8 | `resumePending` → `#redispatch`：`store.list()` **扫全表**，HITL 的惰性超时扫描发生在「跳过判定」**之前**（这是「顺带捞起到期者」可以照抄的位置） | `src/transport/async.ts:678-762` |
| 9 | `drain()` 等 `active === 0`；而 `active++` 只在 `#execute` 里（挂起段已收尾释放）⇒ **挂起的 run 不挡 drain** | `src/transport/async.ts:559-561, 777` |
| 10 | 缺省内存 store 的淘汰白名单同样三值：`queued / running / awaiting_approval` 不淘汰 | `src/store/store.ts:104-116` |
| 11 | **今天没有 `cancel` API**：全仓只有 `runTimeoutMs` 到点 `abort`（run 级）与 `drain()`（停机级）。「用户取消一条在飞的 run」这件事目前**不存在** | `grep -rn 'cancel\|abort' src/transport/async.ts`（9 处，全是 timeout 相关） |

事实 4 与 6 是本稿最重要的两条：它们说明「新增一种挂起」的真实成本**不在状态机骨架，而在那些用 `===` 逐值点名的地方**——漏一处不会编译红，只会**静默地按旧语义走**。

## 2. 设计分叉：`wakeAt` 用什么状态承载（要你拍的一处）

**A. 复用 `awaiting_approval` + 新增 `wakeAt` 字段**（零公共面变化）

- 省：状态机骨架、`isTerminalTask`、`evict`、`resume-policy`、HTTP 面全部不动；
  「挂起 = 不占槽 / 不被 resumePending 捡走 / 不被淘汰」这份语义**白拿**。
- 代价（全是事实 5/6/7/4 直接推出的，不是猜测）：
  1. **状态名撒谎**：`awaiting_approval` 明明在等时刻。
  2. **`approvalTimeoutMs` 会提前叫醒它**：事实 5 的闸只看状态 ⇒ 配了审批超时的宿主，
     一条纯时间挂起会被判「审批超时」，再经事实 6 的编排**直接重派续跑**（且
     `fillTimeoutDenials` 对它写不出任何决定，`approvalsComplete(空)` 还返回 true）。
     要修就得给事实 5 补第二个条件（`(pendingApprovals ?? []).length > 0`），
     等于把「审批超时」的判据从一处拆成两处。
  3. **`approve()` 能叫醒它**：事实 7 的 409 闸同样只看状态 ⇒ 调用方能用一个空审批
     把 sleep 提前打断（这不是安全漏洞，是**语义漏洞**）。
  4. **`resumePending` 会把它报成 `'terminal'`**（事实 4）。
  5. **可见性分不开**：事实 6 要的「在睡几条」得靠「status 是 awaiting 且 `wakeAt` 在场」
     这种**复合条件**回答，每多一个读者就多一处口头约定。
- 结论：省下的代码量很小（骨架本来就要复用的），付出的是**五处名不副实**。

**B. 新增状态 `awaiting_wake` + 一个单一谓词 `isSuspended(status)`**（**建议**）

- 把「挂起」这件事**从状态名里抽出来**：`isSuspended(s) = s === 'awaiting_approval' || s === 'awaiting_wake'`
  成为唯一真源，事实 3/4/10 的三值白名单全部改走它 ⇒ 将来第三种挂起原因是**加一处**，不是加五处。
- 事实 5 与 7 **自动正确**：两条闸都 gate 在 `awaiting_approval` 上，新状态天然不被审批超时
  误伤、也不能被 `approve` 叫醒（返回 409，语义正确）。
- 代价：`RunStatus` 是**公共导出类型**，这是**加法变更**（不破坏现有代码，但要在
  spec §10 立项 + CHANGELOG + `api.html` 导出面/文档同步）；事实 3/4/10 三处必须改，
  漏一处就是静默错——**所以本批的门禁要专门钉这三处**（§5）。
- 结论：多花的是「一份状态机的登记工作」，换来的是「每一处都能被用例子指出名字」。

**C. 新状态 `suspended` + `suspendedReason: 'approval' | 'timer'`**（**拒绝**）

- 语义上最"干净"（一种挂起，一个理由字段），但要把**既有的 `awaiting_approval` 改名** ⇒
  破坏性变更（宿主、看板、`RunStatus` 的每个读者）。本仓的补丁位纪律（0.7.x 内不做破坏性）
  直接否掉它。记在这里是为了说明「为什么不选最优雅的那个」。

**建议：B。** 一句话理由：`wakeAt` 的病根是「挂起这件事被状态名绑死在人身上」，
B 正好解绑；A 是把新语义塞进旧名字、再打五个补丁；C 方向对但代价错（改名 vs 加名）。

## 3. `wakeAt` 的**请求方**定在哪（本批做哪个形态）

挂起必须由引擎在**回合边界**产出（事实 2：续跑靠 `suspendedMessages`），所以「谁提请求」是
真正的接口设计。三个候选形态：

- **①工具请求延后（建议）**：工具在自己的上下文里说「现在还不是时候，T 之后再问我」——
  引擎把该回合收尾成 `stopReason: 'awaiting_wake'` + `wakeAt`，挂起段与审批**同形**
  （同一批 tool_use 未决、同一份 `suspendedMessages`），醒来后**重跑那一批**。
  与审批完全对称：审批 = 执行前等**人的决定**，延后 = 执行前等**时刻到来**。
  真实用途直白：等批处理作业、等限流窗口、等收盘、等外部系统回填。
- **②run 级「先睡一会儿再开跑」**：`app.run(..., { wakeAt })`。**不做**：它与既有
  `transport/scheduler.ts`（定时起新 run）重叠，是同一个东西的第二种拼法。
- **③两者都要**：留到有人真的需要 ② 再说；本批只做 ①。

形态 ① 的接口细节（本批最小面）：
- 工具侧：在工具上下文上给一个请求口（形如 `ctx.deferUntil(ms | Date)`），
  语义 = 「本回合到此为止，把这一批 tool_use 挂起，T 后重跑」。
- 引擎侧：`stop-reason.ts` 增一个具名出口（与 `awaiting_approval` 平行）、
  `loop-result.ts` 的结果形状增 `wakeAt`（在场即挂起原因）。
- 宿主侧：`AsyncRunner` 收到后写 `rec.status='awaiting_wake'` + `rec.wakeAt`。
- ⚠️ 与刚收口的候选 3 的交界：醒来时菜单可能已经变了 ⇒ **复用 `detectMenuDrift`**
  （事件 / 属性 / warn 三处信号照旧），不另起一套判据。

## 4. 配套 5（取消 / 排空）与配套 6（可见性）

**配套 5 —— 先厘清三件事，再动代码：**

1. **`drain()` 之后不许被唤醒**（必须定义，否则「停机窗口等一条天级 run = 部署卡死」）。
   事实 9 说明 drain **不会**等挂起的 run（它不占 `active`）——这条是既有语义、白拿；
   要新增的是**「drain 之后 `resumePending` 到期的 sleeping run 不再续跑」**
   （与 submit 在 drain 后回 503 同一纪律：drain = 不再往前推）。
2. **`cancel` API 今天不存在**（事实 11）。本批**不给** —— 它要新增公共面
   （`runner.cancel(taskId)`）、定义「取消一个正在跑的工具」的中止语义、并决定取消算不算
   新增终态（今天是五值，没有 `cancelled`）。这是**独立一件**，与 wakeAt 无因果关系，
   建议单独立项；本批只在文档里如实写明「取消靠宿主自己 abort 在飞请求 + 不唤醒」。
   ⚠️ **这一条会推翻调研文档 §6 候选 5 的一半措辞**（它把「用户取消」当成已存在的动作），
   实施时要回改那半句 —— 不许留一句文档说「用户可以取消」而代码里没有。
3. **拒绝 = 唤醒**：一条在睡的 run 若被 `approve` 打了……不适用（事实 7：新状态返回 409）。
   但「睡着的 run 收到审批决定」这条路径要**用用例钉死**（409，不静默接收）。

**配套 6 —— 读数（最小落点）：**
- `snapshot()` 与 `/healthz` 各加一段 `suspended`：**按原因分组的条数**（`approval` / `wake`）
  + **最早到期时刻**（`nextWakeAt`，无则 `null`）。字段从哪来由 §3 的状态决定 ⇒ 这正是
  调研文档说「6 与 1 同批」的原因。
- 口径：只报**本进程可见**的记录（与 `active` 口径一致，事实 9 的同一张表）；
  跨进程要合并看板就自己聚合 —— 不假装是全局面。
- metrics 侧：本批**不加**新指标（基数与语义都要先有真实需求），只 `/healthz` + `snapshot()`
  —— 与候选 6 的原话一致（「最小落点」）。

## 5. 门禁与反向验证计划（写实现前先定，避免事后凑用例）

必须被**具名用例**钉住的地方（每处一条，且每条配一个变异）：

| 门禁 | 钉什么 | 变异（关掉就红） |
|---|---|---|
| 状态谓词 | `isSuspended` 覆盖两个挂起状态；`isTerminalTask` 认它为**非终态**（流不早关） | 把 `awaiting_wake` 从 `isSuspended` 里摘掉 ⇒ 那几条红 |
| `resume-policy` | 在睡的 run 的 skip 原因**不是** `'terminal'`（事实 4） | 把谓词改回 `=== 'running'` 逐值写法 ⇒ 报 `'terminal'` 那条红 |
| 审批超时不误伤 | 配 `approvalTimeoutMs` + 一条 sleeping run ⇒ **不被**判超时、不重派（事实 5/6） | 把事实 5 的闸改成 `isSuspended` ⇒ 那条红 |
| `approve` 不叫醒 | 对 sleeping run 调 `approve` ⇒ 409，且**状态不变、不重派**（事实 7） | 把 409 闸放宽成 `isSuspended` ⇒ 那条红 |
| 到期续跑 | `wakeAt` 未到 ⇒ 不捡；已到 ⇒ 续跑且**重跑那一批 tool_use**（与审批续跑同形） | 到时判定恒 false ⇒ 那条红 |
| drain 后不醒 | `drain()` 之后再 `resumePending()` ⇒ 到期的 sleeping run **不续跑** | 摘掉那条闸 ⇒ 那条红 |
| 淘汰保护 | 缺省内存 store 超限淘汰时，sleeping run **不被淘汰**（事实 10） | 白名单回退三值 ⇒ 那条红 |
| 可见性 | `/healthz` 的 `suspended` 分组计数 + `nextWakeAt`；空队列给 `null` 不给 `0` | 计数改成恒 0 ⇒ 那条红 |
| 与候选 3 交界 | 挂起期间删掉那个工具 ⇒ 醒来时三处漂移信号照出（复用同一条判据） | 摘掉续跑入口的漂移检测 ⇒ 那条红 |
| 阴性对照 | 没有 sleeping run 时：不报错、`suspended.wake === 0`、无 `wakeAt` 属性 | 无条件报一条 suspended ⇒ 打红该对照 |

纪律照旧：变异脚本 `trap` 还原 + 还原后复绿自检；先提交、再跑变异电池
（未提交树上 `git checkout` 会擦掉改动）；收口 `scripts/verify-all.sh` 8/8 +
`npm run e2e:mcp` + `npx node@18 scripts/check-import-floor.mjs`。

## 6. 明确的「不做」

- 不做「先睡一会儿再开跑」（§3 形态 ②）—— 那是 `Scheduler`。
- 不给 `cancel` API（§4 配套 5 第 2 点）—— 独立一件。
- 不做「事件唤醒」（候选 2）—— 但 §3 的挂起形状**刻意与它同构**，将来事件到达即可续跑，
  不必换骨架。
- 不做到期索引（候选 7②）—— 本批如实标注 `#redispatch` 是 **O(全表)**（事实 8），
  给出触发条件（挂起数上量后每次重启/每轮扫描的全表读实测）与候选实现（store 侧
  `listDue(before)`，`byIdempotency` 是「按非主键查」的先例），不提前做。
- 不引入任何新组件（调研文档 §7 的边界：store 后端仍可换）。

## 7. 要你拍的一处

**§2 的状态分叉选哪个。** 我的建议是 **B（新增 `awaiting_wake` + 单一 `isSuspended` 谓词）**，
理由是 A 的五个代价全在「名不副实」这一类，而 B 的代价只是一份登记工作、且能被用例逐处点名。
如果你更看重「公共面零变化」，A 也**能做对**——但那要在 `approvalExpired` / `approve` /
`resume-policy` 三处各加一个复合条件，等于把「挂起」这个概念从一份拆成四份。

（§3 的形态 ① vs ② 我直接建议 ①；若你另有想法，说一声即改。）

## 8. 定案（2026-09-28，用户已拍）

- **§2 状态分叉：选 C**（「一个状态 + 一个原因」：`RunStatus.suspended` + `suspendedReason`
  `'approval' | 'timer'`），接受随之而来的**破坏性改名**。理由记录：A 的五条代价全在
  「名不副实」这一类，而 B 只是把谓词当补丁；C 是把「挂起」这个概念从状态名里解绑，
  代价是一次登记工作（§11 里那三处逐值点名的地方 + 文档面）。
- **§3 请求方形态：维持 ①**（工具侧「请求延后」），不做 ②（run 级「先睡再开跑」——那是
  `Scheduler`）。
- **已落地（2026-09-28 ①，spec §10 同名条目 / commit `aaaadc0`）**：C 的状态模型与两条
  「原因闸」（`approvalExpired` / `approve`），含用例与两条变异反向验证。
- **仍未落地**：§3 的 `wakeAt` 本体（工具侧请求口、时间挂起的产出、到期续跑）、
  §4 的配套 5（drain 后不唤醒）与配套 6（`/healthz` + `snapshot()` 的挂起读数）。
  ⚠️ 现在 `src/` 里 `timer` **没有生产者**：类型与闸都在，还没有任何东西会挂起成 timer ——
  这是本稿的待办，不是已完成项。
- **§4 配套 5 的一条核证结论要回改上游文档**：调研 §6 候选 5 把「用户取消」当成已存在的动作，
  而全仓**没有 `cancel` API**（只有 `runTimeoutMs` 的 abort 与 `drain`）—— 实施配套 5 时按
  本稿 §4 的写法回改那半句，别让文档说一件代码里没有的事。
- **§5 门禁表的一处失效（定案为 C 之后）**：表里「状态谓词（`isSuspended`）」那一行属 B 的
  形态 —— C 下只有一个挂起状态，不需要谓词，判据由**原因闸**承担；实际执行的门禁以
  spec §10 2026-09-28 ① 那两条（`approvalExpired` / `approve` 的原因闸）为准。
- **新增记录（2026-09-28 实施时发现，写进 §11 开放项）**：旧持久化值 `awaiting_approval`
  在本版成了陌生值 ⇒ 升级前停在挂起的记录会成孤儿；本版只文档化（CHANGELOG「迁移」），
  垫片的六个落点与 `sqlite` 的 status **列**问题记在 §11。
