# durable 长时程执行 —— 对照调研（R8-P6，只立项不实施）

> 2026-09-27。本文是 `2026-09-27-evolution-r8.md` P6 的交付物：**只调研、不写实现**。
> 结论区在文末「最小语义增量候选」—— 它们是**候选**，任何一条要动代码都必须先回
> spec §10 立决策记录。

## 1. 为什么现在看这件事

agent 任务的时间跨度在变长：从「一次问答」（秒级）到「代码审查一条 PR」（分钟级）再到
「跟进到上线」（天级）。LangGraph 1.0 把 durable execution 当主叙事，Temporal 系的文章
在 agent 圈持续刷屏 —— 这不是巧合：跨度一旦超过「进程大概率还活着」的量级，
**执行状态必须比进程活得久**，这件事就从加分项变成地基。

agentia 现状覆盖到「分钟级」：崩溃续跑（`resumePending`）、HITL 挂起恢复、周期调度
都有，且都有真实测试守。本文回答：往「天级」走，差什么、哪些该补、哪些**不该补**。

## 2. agentia 现状盘点（已有什么，钉到代码）

| 能力 | 落点 | 覆盖的时长量级 |
|---|---|---|
| 异步任务 + 崩溃续跑 | `transport/async.ts`（`resumePending` + `resume-policy.ts` 的认领判定：terminal / own-process / too-fresh） | 分钟~小时（进程重启间隙） |
| 认领语义 | TaskRecord.ownerId + 先落库再派发 | 多进程部署 |
| HITL 挂起/恢复 | `engine/loop.ts` 的 `awaiting_approval`（挂起**不是**失败）+ 审批决定随 TaskRecord 落库，跨进程耐久 | 小时~天（等人审批） |
| 续跑入口 | `engine/resume-input.ts`：识别末尾未决 tool_use，接着跑而不是重跑 | —— |
| 周期调度 | `transport/scheduler.ts`（every/at + maxInFlight 闸门） | 周期触发，非「睡到某时刻继续这条 run」 |
| 优雅停机 | `transport/drain-gate.ts` | 部署窗口 |
| 任务终态等待 | `transport/task-waiters.ts`（事件唤醒 + 兜底轮询） | 同进程 |

一句话：**agentia 已有「任务级」耐久（任务记录比进程活得久、崩溃后认领续跑），
但没有「时间点级」耐久（睡到后天下午三点接着跑）与「事件级」耐久（外部 webhook
到了唤醒一条在睡的 run）。**

## 3. 三个对照系统的 durable executor 模型

### 3.1 Temporal

- **核心模型**：workflow 代码是**事件溯源重放**的 —— 执行历史（event history）落库，
  worker 崩溃后换台机器把代码从头重放，已完成的副作用从历史里直接取结果（不重发），
  跑到断点继续。因此 workflow 代码必须确定性（框架拦 nondeterminism）。
- **durable timer**：`sleep(3 days)` 是历史里的一条 timer 记录，不占进程内存，
  到点由服务端唤醒任一 worker。
- **外部事件**：signal（异步写入历史，workflow 里 await）/ query（只读查询）/
  update（同步读写）。
- **版本兼容**：在飞 workflow 的代码改了 ⇒ 重放时新旧代码对不上历史会炸；
  答案是 `patch()` / versioning API —— **在飞实例按旧分支走**，新实例走新代码。
- **代价**：编程模型侵入（workflow 代码与普通代码两套约束），服务端是重型组件。

### 3.2 Restate

- **核心模型**：durable RPC —— handler 里每个 `ctx.run(...)` 副作用的结果记日志，
  崩溃后从日志恢复（与 Temporal 同族的「重放 +  journaled 结果」，但入口是 RPC
  而不是 workflow DSL）。
- **durable timer**：`ctx.sleep(...)`，同款不占进程。
- **外部事件**：**awakeable** —— 生成一个 id 交出去，外部系统拿 id 回调即唤醒
  （webhook 场景的一等原语）；durable promise 跨 handler 共享状态。
- **virtual object**：按 key 串行化的有状态对象 —— 「同一个用户的所有会话」这类
  并发约束直接由运行时保证。
- **代价**：同样需要 Restate 服务端（自研 binary，单进程可跑，比 Temporal 轻）。

### 3.3 DBOS

- **核心模型**：**Postgres 即运行时** —— workflow/step 的状态全部 checkpoint 进
  Postgres 表，恢复 = 按 step 序号跳过已完成的 step。没有独立服务端，一个库搞定。
- **durable timer / 事件**：`sleep`、recv/send（按 topic 的消息）、`setEvent/getEvent`。
- **版本兼容**：显式要求「改代码时补丁式兼容在飞 workflow」，提供 patch 机制；
  语义与 Temporal 相同、设施更薄。
- **代价**：恢复粒度是 step 边界（不是指令级重放），确定性约束同样在。

### 3.4 三者共识（这才是重点）

剥离实现差异，durable execution 的**最小不变量**是四条：

1. **执行状态外置**：进度在 store 里，进程只是临时工。
2. **副作用恰好一次**：靠「结果落账 + 重放时取账」而不是「不失败」。
3. **时间是第一类输入**：sleep 是 store 里的记录，不是进程里的 setTimeout。
4. **代码版本与在飞实例解耦**：要么 patch，要么钉版本，要么接受「改代码 = 老实例按老逻辑跑不动就失败」。

## 4. 差距清单（agentia vs 四条不变量）

| # | 差距 | 现状 | 严重度 |
|---|---|---|---|
| G1 | **durable timer**（睡到 T 时刻继续这条 run） | Scheduler 只有 every/at 触发**新**任务；run 内部没有可挂起的 sleep | 高（天级任务的硬门槛） |
| G2 | **外部事件唤醒**（webhook/人工输入到达 → 唤醒在睡的 run） | HITL 审批是唯一的外部唤醒通道，且语义专用（approve/reject）；没有通用的「往 run 里投一个事件」 | 高（agent 与现实世界交互的主通道） |
| G3 | **副作用恰好一次** | 工具副作用不重试由引擎保证（工具结果记进 trace/消息历史，续跑不重跑已完成 tool_use —— resume-input.ts 正是这个）；**但**跨进程崩溃时「副作用已发生、结果没落账」的窗口仍在（async.ts:64 的注释自己就写着这个风险） | 中（窗口小但存在） |
| G4 | **代码版本 vs 在飞 run** | 无：续跑用**当前**代码接着跑老任务。agent 场景比 workflow 缓和（循环状态是消息历史，代码更多是「菜单 + 提示词」而非控制流）。⚠️ 但菜单/工具签名变了**不是「没人接」，是降级且不告知**（2026-09-27 实测，见 §4.1）：未决的那个 tool_use 拿到 `unknown tool: <name>` 当出参交回模型（`engine/turn.ts:611-612`），run **照常跑完** | **中高**（静默 ≠ 缓和） |
| G5 | **重放模型** | 不采用也不该采用（见 §5） | —— |

### 4.1 G4 的实测（2026-09-27：把「可能没人接」这句钉死）

做法：`executeRun` 跑一条 run，脚本 client 第一回合要一个菜单里**不存在**的工具
（= 老 run 的未决 tool_use 遇上改过的菜单），第二回合照常收尾。实测：

- trace 上那条：`tool.output{"tool":"ghost_tool","ok":false,"errorKind":"unknown_tool","content":"unknown tool: ghost_tool"}`
  —— 降级**有记账**，但只落在 trace 里；
- 调用方拿到的：`result.error === undefined`（按本仓口径 = 「正常收尾」）、
  `stopReason === 'end_turn'`、`finalText` 是**模型自己编的**那句收尾 —— **没有任何失败信号**；
- 结论：改了菜单，老 run 会拿着一句「没有这个工具」自己往下编，宿主 / 调用方 / 告警**都看不见**。
  唯一看得见的是 trace —— 本仓「trace 决定它敢不敢上线」这条在这里同样成立。

⚠️ 这条路径此前**一个用例都没有**：`grep -rn unknown_tool tests/` 零命中（只在源码的
类型联合 `tool-events.ts:27` 与分支 `turn.ts:611` 里）；唯一提到它的是
`tests/engine/eventChars.test.ts` 的一句**注释**（解释子 agent 为什么要写 `tools: ['inner']`，
防的正是走到这条路径）。静默到连我们自己都没盯过 —— 这也是 G4 定级从「中」提到「中高」的理由。

> **2026-09-27 同日追加**：上面的「零覆盖」已经补上了 —— `tests/engine/toolTiming.test.ts`
> 的「未决 tool_use 遇上没有它的菜单」三条用例（trace 记账 / run 照常收尾+调用方零信号 /
> 归类与审批无关 / 同回合混合不拖垮其他工具）。
> ⚠️ **那组用例钉的是「现状」，不是「期望」** —— 它防的是**无意改动**（分支被重排、归类被
> 改掉），**没有**把静默收口。结论不变：候选 3 要做的事仍然是「把这件事变成调用方看得见的
> 东西」，详见该用例的块注释（那里写明了「不要悄悄把断言改成期望 run 失败」）。

## 5. 关键判断：agent 的 durable 与 workflow 的 durable 不是一回事

Temporal 系的重放模型对 **agent 主循环是错的抽象**：

- workflow 的状态是**调用栈 + 局部变量**，所以必须重放才能重建；
- agent 主循环的状态是**消息历史**（messages）—— 它天然就是可序列化、可断点续传的
  数据，agentia 的续跑（trace/messages → 接着跑）已经是「外置状态」的正确形态，
  **不需要事件溯源重放**。

所以差距清单里 G5 是「确认不做」：不引入 workflow DSL / 重放 / 确定性约束。
要补的是 G1/G2（时间与事件两个唤醒维度）和 G3/G4 的**收窄**（不是消灭 —— 
消灭意味着变成 Temporal）。

## 6. 最小语义增量候选（本轮不定案，动代码前回 spec §10 立项）

按「语义增量 / 实现成本」排序：

1. **`wakeAt` 挂起**（G1）：run 可以挂起到一个**时间点**（store 里一条 `wakeAt` 记录，
   resumePending 的扫描顺带捞起到期者）。语义是 `awaiting_approval` 的推广：
   挂起原因从「等人」推广到「等时刻」。复用面：挂起/恢复状态机、store 字段、
   惰性判定（不起定时器，读时判 —— 与 approvalTimeout 同款纪律）。
2. **run 事件投入口**（G2）：`POST /tasks/:id/events`（或 `signalTask(id, event)`）——
   外部系统往一条挂起的 run 投一个事件，run 续跑时事件作为新的 user/tool 消息进
   消息历史。审批是它的特例（审批决定就是一种事件）。⚠️ 要定义事件类型白名单与
   鉴权纪律，这是外部输入进入消息历史的通道，投毒面要守住。
3. **菜单/提示词版本钉住**（G4 收窄）：run 落库时记 `prompts.versions`（已有）+
   工具菜单签名摘要；续跑时发现菜单变了要有动作。⚠️ **判据不是「有没有降级策略」，而是
   §4.1 实测出来的那个静默** —— 今天菜单变了会把 `unknown tool: <name>` 当出参交回模型、
   run 照常收尾、调用方零信号。所以这条的最小形态是「**菜单签名对不上时，把这件事变成
   调用方看得见的东西**」（响亮失败，或至少一条可查询的标记），菜单摘要只是拿到那个判据的手段。
4. **G3 的窗口收窄**（可选）：工具结果「先落账再执行副作用」不可行（副作用在工具内），
   现实增量是：工具结果落库与执行之间的窗口加幂等键指引（`idempotencyKey` 已有，
   文档化「工具作者怎么把副作用做成幂等」）。**这条大概率停在文档层。**

以下三条是 2026-09-27 复读本轮实现时补出来的 —— 它们都是上面候选的**配套**，不是新目标：
候选 1/2 只写了「怎么醒」，没写醒不过来的那些路径。**建议与 1/2 同批立项，不单独立项**
（分开做会让每一批都留一个「静默」的口子，而那正是本仓最反复修的一类病）。

5. **挂起的取消 / 排空语义**（G1 的**必配项**，不是后续优化）：候选 1 只定义了「怎么醒」，
   没定义「**不许醒**」。一条睡了 3 天的 run 遇到 `drain()` / 用户取消 / 审批拒绝，今天的
   状态机没定义 —— 是等它到点，还是立刻判终态？这直接撞 `transport/drain-gate.ts` 那个
   等待闸：**停机窗口等一条天级 run = 部署卡死**。严重度：高（它会反过来吃掉候选 1 的收益）。

6. **挂起期的可见性**（可观测口径没延伸到「在睡」这一态）：今天没有任何读数回答
   「现在有多少条 run 在睡、最早到期的 `wakeAt` 是哪个时刻」—— `/healthz`、metrics、
   看板都看不到。**沉默的挂起队列与「本来就没跑」不可区分**，这正是本仓反复修的那类病。
   最小落点：`snapshot()` 与 `/healthz` 各加一段 `suspended`（条数 + 最早到期时刻），
   与候选 1 同批（字段从哪来由候选 1 决定）。严重度：中（候选 1 一旦落地，它是必备读数）。

7. **事件投递的幂等 + 到期索引**（G2 / G1 的两个洞，候选 2 只提了「投毒面」）：
   ① **重复投递**：webhook 重试 = 同一条 run 被投两次事件，而 `idempotencyKey` 现在的
   范围是**工具副作用**，不是**事件投递** —— 把它的口径扩到事件是自然的落点（否则
   「恰好一次」在事件这一路上是空的）。
   ② **到期检索的扩展性**：候选 1 说「`resumePending` 扫描顺带捞起到期者」，但没说这条
   扫描怎么随挂起量增长 —— 每条 pending 都读一遍是 O(挂起数)，天级挂起积攒起来之后
   每次重启/每轮扫描都要全表读。需要在 store 上有**到期索引**（或时间轮），
   而这与 `TaskStore` 的接口形状有关（`byIdempotency` 已是「按非主键查」的先例）。
   严重度：中（① 是语义洞、② 是量的洞，两者都会在上量之后才现形）。

## 7. 明确的「不做」

- 不做通用 workflow 引擎（DAG / 重放 / 确定性沙箱）—— 那是 Temporal 的生态位，
  agentia 的定位是 agent 服务框架（spec §1），重放模型对消息历史型状态是错抽象（§5）。
- 不引入独立服务端组件（Temporal server / Restate server 那种）；agentia 的耐久
  继续以「store 后端可换」（memory / file / sqlite / redis）为边界。
- 本轮不写任何实现代码；候选 1/2 若要启动，各自单独立项 + 评审（同样走
  「规划文档 → 逐条核证 → 实施」的流程，2026-09-27 这轮就是这么跑的）。
- 候选 5/6/7 同样**不引入新组件**：取消/排空是既有挂起状态机的收口、可见性是读数、
  到期索引是 `TaskStore` 接口内的事 —— 都还在「store 后端可换（memory / file /
  sqlite / redis）」这条边界内，不破 §7 的前两条。

## 8. 参考

- Temporal 文档：workflow 重放 / timers / signal-query-update / patching（temporal.io/docs）
- Restate 文档：durable RPC / awakeables / virtual objects（docs.restate.dev）
- DBOS 文档：Postgres checkpoint / steps / recv-send（docs.dbos.dev）
- agentia 侧现状出处见 §2 表格的文件引用；挂起/恢复语义见 spec §10 的 HITL 条目。
- §4.1 实测的复现方式（无脚本、手工可跑）：`executeRun({ messages, client: 脚本 client, tools: [] })`
  —— 第一回合要求一个**不在菜单里**的工具、第二回合 `end_turn`；看 trace 上的 `tool.output`
  事件与 `result.error` / `stopReason` / `finalText` 三个字段（注意 `AgentRunResult` **没有**
  `status` 字段，判「正常收尾」看 `error === undefined`）。
