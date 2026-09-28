# run 事件投入口（候选 2）+ 到期索引（候选 7②）实施设计

> 撰写时刻：**2026-09-28 上午**，接手 r9 批次（`cancel` 已合入 main `b6413bf`）。
> 上游：`docs/plans/2026-09-27-durable-execution-research.md` §6 候选 2 与 §6 第 7 条。
> 本稿**只设计**：§6 有两处要你拍，§5 主张「先量后做」。
> 立项来源：R8 批次合入后开工的 r9 批次（`cancel` 已完成）→ **r10 批次 = 本稿两件**。

## 0. 一句话

**候选 2**：让外部系统能把一个**事件**投给一条挂起的 run（审批是它的特例），醒来时事件进消息历史 ——
所以它同时是「醒不过来的那些路径」的另一半，也是一条**外部输入进入消息历史的通道**（投毒面）。
**候选 7②**：`resumePending` 的扫描是 O(全表)，上量之后每次重启/每轮扫描都要全表读 ——
本稿主张**先量再决定**，不先长代码。

## 1. 事实基础（逐条核证过，标了 file:line）

| # | 事实 | 出处 |
|---|---|---|
| 1 | 挂起形状**刻意与事件同构**：设计稿 §6 明确写「候选 2 不做，但 §3 的挂起形状刻意与它同构，将来事件到达即可续跑，不必换骨架」 | `docs/plans/2026-09-27-durable-wake-at.md` §6 |
| 2 | **审批就是事件的特例**：`approve()` 把决定写进 `rec.approvals`，恢复段带着它重进引擎循环 | `src/transport/async.ts` `approve` 的文档块 |
| 3 | 恢复段的入口只看两件事：`isResume = rec.approvals !== undefined \|\| rec.suspendedSince !== undefined`，而 `rec.spec.messages` 是挂起段落的**扩展历史**（末尾是含未决 `tool_use` 的 assistant 消息） | `src/transport/async.ts`（`#executeInner` 内） |
| 4 | ⇒ **事件要进历史，最自然的落点是在恢复前把一条消息追加到 `rec.spec.messages` 末尾**（与「审批决定随 record 走」同一个位置），不需要新骨架 | 同上 |
| 5 | ⚠️ **投毒面是真的**：这是外部输入第一次进入消息历史。今天的 `approve` 只接受**布尔 + reason 字符串**（形状由 `parseApproveBody` 白名单化），而事件若允许任意 block 透传，等于把「构造 assistant/tool_use 块」的能力交给外部 | `src/transport/http-shapes.ts`（`parseApproveBody`） |
| 6 | `idempotencyKey` 现在的范围是**任务提交**（同键不重复执行），不是**事件投递** —— webhook 重试 = 同一条 run 被投两次事件 | `src/transport/async.ts` `submit`；研究稿 §6 第 7 条 ① |
| 7 | 挂起读数已经有一套（`#suspended` + `/healthz`）—— 事件到达时它该跟着变（离开挂起态除名） | `src/transport/wake-policy.ts`、`async.ts` `#unmarkSuspended` |
| 8 | **`resumePending` 的扫描是 O(全表)**：`store.list()` 拿全表，再逐条判到期/超时/孤儿 | `src/transport/async.ts` `#redispatch` |
| 9 | store 侧已有「按非主键查」的先例（`byIdempotency`），所以到期索引在接口形状上是**可加的**（可选方法 + 缺省回退） | `src/store/store.ts` |
| 10 | 仓库里已有 bench 先例（`scripts/bench-app-assembly.ts`、`scripts/bench-trace-cost.ts`）⇒ 「先量」有现成形态可抄 | `scripts/` |

## 2. 候选 2 的两处分叉（要你拍）

**A. 事件投入口的形态**

- **A1 只给宿主 API**：`runner.signalTask(taskId, event)`。
- **A2 只给 HTTP**：`POST /tasks/:id/events`。
- **A3 两者都给（建议）**：宿主方法 + 一条路由，关系与 `approve` / `cancel` 完全一样
  （方法承载语义、路由是它的 HTTP 皮）。理由：外部系统（webhook 那条路）只能走 HTTP，
  而「同一个进程里的另一个模块把事件交给 run」不该被迫起一个 HTTP 请求。

**B. 事件进消息历史的形态**

- **B1 结构化事件 → 一条 user 消息（建议）**：入参**白名单**为
  `{ eventId?: string, type: string, payload: string }`（`type` 与 `payload` 都是**字符串**，
  `payload` 有字节上限），续跑前把它渲染成一条 `{ role: 'user', content: '<文本>' }`
  追加到 `suspendedMessages` 末尾。**外部永远不能构造 block**（事实 5）。
- **B2 允许调用方给任意 `MessageParam`** —— **拒绝**：等于把「伪造 assistant / tool_use 块」
  的能力交给外部，投毒面从「内容注入」升级成「协议注入」。审批那条今天只收布尔，正是同一个理由。
- **B3 作为 `tool_result` 回填**（需要 `tool_use_id`）—— 拒绝：事件与工具结果不是一回事，
  且会让「谁在等哪个 tool_use」变成外部要懂的内部细节。

**推荐 A3 + B1。** 一句话理由：事件是**外部输入**，接口必须窄到「只能给文本」；
而「醒」这件事的骨架已经在了（事实 1/3/4），本批的价值在**把入口焊成窄的**，不在新骨架。

## 3. 语义（本批要定的，逐条有判据）

1. **只对 `suspended` 生效**：非挂起 ⇒ `TaskEventError(409)`（与 `approve` / `cancel` 同款
   「状态不对要说出来」）；不存在 ⇒ 404。
2. **投完即续跑**，与 `approve` 的「决定齐了就恢复」同形：**先落库（事件进 `spec.messages` +
   状态回 `running`）再派发** —— 崩在窗口里不能丢事件（与 `#redispatch` 同一条纪律）。
3. **时间挂起收到事件 ⇒ 提前醒**（事件比时刻更早到就是「现在到时候了」），但**不清时钟**：
   重跑那一批时工具可能再次请求延后（`wakeAt` 由新的回合重新落定）。
4. **幂等**：`eventId` 给定时按它去重（同 id 第二次投递不再进历史 ⇒ 409 或 200 + 原记录，
   取 `409 「同 eventId 已投递」` —— 与 cancel 的「已终态」同款：说出来，不静默）；不给
   `eventId` 就**如实文档化**「重复投递 = 重复进历史」，不假装有恰好一次（研究稿 §6 第 7 条 ①）。
5. **鉴权与上限**：走既有 `authenticate`（与其余路由同一档，**不是**免鉴权组）；
   `payload` 有字节上限（与 `maxBodyBytes` 同一处口径），超限 413。
6. **可见性**：事件到达要留痕 —— trace 事件 `task.event{delivered, event_type, event_id?}`
   ＋ 离开挂起态时读数照常除名（事实 7）。投毒面是「看得见」的第一道防线。
7. **不唤醒已终态**、**不给 `cancel` 过的事件**（取消是终态，同 1）。

## 4. 门禁计划（写实现前先定）

| 门禁 | 钉什么 | 变异（关掉就红） |
|---|---|---|
| 只对挂起生效 | 非挂起 ⇒ 409 且记录不动；不存在 ⇒ 404 | 把状态闸放宽成「一律投」 ⇒ 那条红 |
| 事件真进历史 | 续跑时模型**收到的** messages 末尾有那条 user 消息（内容含 payload）；用 `onParams` 快照断言「发出去那一刻」 | 事件只落库不追加进历史 ⇒ 那条红 |
| 先落库再派发 | 崩在窗口里不丢：用一个 save 抛错的假 store 断言「没派发」 | 先派发后落库 ⇒ 那条红 |
| 提前醒 | timer 挂起 + 事件 ⇒ 立刻续跑（不等 `wakeAt`）；且**时钟被重新落定**（工具再请求延后时 `wakeAt` 是新的） | 事件不唤醒 timer 挂起 ⇒ 那条红 |
| 幂等 | 同 `eventId` 第二次 ⇒ 409，历史里只有一条 | 去掉去重 ⇒ 那条红 |
| 投毒面 | 事件体只接受白名单字段（多一个字段 ⇒ 400）；`payload` 超上限 ⇒ 413；**构造 block 的尝试进不了历史** | 放开成任意 `MessageParam` ⇒ 那条红 |
| 路由 | `POST /tasks/x/events` 生效；`GET` ⇒ 405（Allow: POST）；未鉴权 ⇒ 401；`DELETE /tasks/%zz/events` ⇒ 405 而不是 400 | 路由顺序挪到通用 id 之后 ⇒ 405/400 那条红 |
| 阳性对照 | 不投事件时：挂起照旧挂着、到点照常醒 | —— |

## 5. 候选 7②（到期索引）：**先量，再决定做不做**

研究稿写的是「上量之后才现形」。既然如此，本批的诚实做法是**先把那个量测出来**：

- 一个 bench（照 `scripts/bench-trace-cost.ts` 的形态）：N 条记录（其中 M 条 `suspended` 带
  `wakeAt`）× 记 `resumePending()` 的耗时与 `store.list()` 的规模，N 取 100 / 1k / 10k，
  四种 store 里挑两种（file + sqlite —— 前者是纯 JSON 解析、后者是「列 + json」的真实形状）。
- 产出：**一条曲线 + 一句触发条件**（例如「N=10k 时一次扫描 X ms；宿主扫描间隔 Y 秒 ⇒ 只有
  N > Z 时才值得上索引」），写进 spec §10 与 §11。
- 若测出来「真实规模就已经很贵」⇒ 立刻做，形态是 store 侧 **可选** `listDue?(before)` +
  runner 缺省回退 `list()`（事实 9：`byIdempotency` 已是先例，接口可加不破坏）。
- 若测出来「还很便宜」⇒ 如实记触发条件，**不长代码**（这也是一种完成：产出的判据能回答
  「什么时候该做」）。

我的预判（写在前面，便于事后对账）：file store 一次 10k 行 JSON 解析大概在**几十毫秒**量级，
而扫描间隔是秒级 —— 所以**大概率落在「先不做」那一侧**；真正的风险不是扫描本身，而是
「宿主把扫描间隔调得很短 + 挂起量很大」这个组合。数字以实测为准。

## 6. 要你拍的两处

1. **§2 A：事件投入口的形态** —— 建议 **A3**（宿主方法 + HTTP 路由，与 approve/cancel 对称）。
2. **§2 B：事件进历史的形态** —— 建议 **B1**（白名单 `{ eventId?, type, payload }` ⇒ 一条 user
   消息）。B2/B3 我建议**明确不做**（协议注入面 / 外部不必懂 tool_use）。

## 7. 明确的「不做」

- **不做任意消息块透传**（B2）—— 投毒面从内容注入升级成协议注入。
- **不做事件总线 / 订阅**（这是「投一个事件给一条 run」，不是消息队列）。
- **不做跨进程投递保证**（事件落库后由本进程派发；他进程投递见 spec §10 2026-09-28 ④ 已记的
  同类边界）。
- **不提前做到期索引**（§5：先量；测出来再说）。
- **不做事件的历史查询面**（`GET /tasks/:id/events`）—— 事件进了消息历史，读记录即可看到。

## 8. 实施记录（2026-09-28 落地）

**形态**：A3+B1 按定案实施。`signalTask`（`src/transport/async.ts`）+ `POST /tasks/:id/events`
（route/shapes/http 三件套各加一条，排法照抄 cancel）；sqlite `listDue`（派生列 `wake_at` +
`(status, wake_at)` 索引 + 存量库就地迁移回填 + 读时自愈判据扩到两列）；runner 接线
`#redispatch` 的到期唤醒那一半 `due ?? recs`。

**对 §1 事实 4 的偏差（关键交界）**：事件**没有**「恢复前追加到 `rec.spec.messages` 末尾」——
`tailToolUses` 只认末尾一条，追加 user 消息会把续跑判成新对话（同一批工具再跑一遍）、且
tool_result 不再紧邻 tool_use。实际形态：事件随 record 走（`TaskRecord.pendingEvents`），
引擎在续跑入口、未决 tool_use 解决之后注入；**再挂起的出口不注入**（注入了会毁掉下一次
续跑判定），事件留在 pendingEvents 等跑通的那次。已记入 spec §10 2026-09-28 ⑥ 第 3/4 条。
trace 留痕落点：引擎在注入时记到续跑段 run 根（runner 不持有 recorder；簿记在 record、
留痕在引擎 —— 与 `approval.decided` 同款分工）。

**测试清单**（`tests/transport/task-events-input.test.ts` 9 条 + route/shapes 纯件 +
sqlite 3 条 + runner 探针 2 条）—— 八条门禁逐条有真用例。变异验证读数（关掉实现 ⇒ 恰好红）：

| 变异 | 红的用例 |
|---|---|
| ① 状态闸放宽（去掉 suspended 检查） | 红 2：「running ⇒ 409 且记录不动…」+ HTTP「404 / 409」 |
| ② 事件只落库不进历史（摘掉引擎注入） | 红 4：幂等/trace 留痕、无 eventId 重复进历史、approval 交界、HTTP 真到模型 |
| ③ 同 eventId 不去重 | 红 1：「幂等：同 eventId 重复 ⇒ 409」 |
| ④ listDue 接线回退（`due ?? recs` → `recs`） | 红 1：「listDue 是唯一输入源」（⚠️ 第一版探针只断言「被调用」，没咬住；补了「索引说空 ⇒ 全表里到点的也不捡」的反向用例后才咬住 —— 顺带发现 poll 的读路径惰性闸不经过 listDue，用 poll 断言会亲手把任务叫醒） |

**bench（`scripts/bench-resume-scan.ts`，本机单次读数）**：sqlite 10k 档 —
前：list 36.6ms / resume 32.6ms；后：list 37.8ms / **listDue 0.1ms** / resume 32.4ms。
**`resume(ms)` 没有显著下降**（与 §5 的预判不同，如实记）：`resumePending` 的其余三条职责
（读数重建 / 审批超时 / 孤儿认领）仍以全表 `list()` 为输入，它主导成本；listDue 只把
「到期唤醒」那一半的输入降到 O（到期数）。这笔节省要兑现到 `resume(ms)` 上，需要拆开扫描
职责或引入 `listActive` 式的窄查询 —— 记为开放项，不在本批。
（bench 已加 `due` 列，口径注释写进脚本头。）

**候选 7② 结论修正**：设计稿 §5 的选项是「做 / 不做」；实测落地后的诚实结论是「**缝焊对了、
扫描还没变快**」——sqlite 侧触发条件成立所以做了，但触发条件里「宿主扫描间隔 ≲ 1s ⇒ 固定
开销可观」的那笔账，在扫描职责拆开之前仍挂在全表 list() 上。spec §10 ⑤ 已补落地记。

**复审补记（父 agent 复核，同日）**：探针实证抓到一处真缺陷 —— 续跑段注入事件后、正常
循环里再次挂起（新一轮 approval/defer）时，`pendingEvents` 按「再挂起就留」保留 ⇒
下次续跑同一事件**重复注入**（模型看到两条）。修法：引擎出口新增 `eventsDelivered`
位（`AgentLoopResult` / `AgentRunResult`，结果记录类字段在场），runner 清/留簿记的判据
从「是不是挂起出口」改成「注入过没有」。回归用例（runner 级全链）+ 变异复验（挂起分支
不清 ⇒ 恰好该用例红）。另顺手订正 usage-guide 时间挂起小节里「没有 cancel API」的
过时措辞（cancel 已随 #157 落地）。
