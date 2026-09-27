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
| G4 | **代码版本 vs 在飞 run** | 无：续跑用**当前**代码接着跑老任务。agent 场景比 workflow 缓和（循环状态是消息历史，代码更多是「菜单 + 提示词」而非控制流），但工具签名/菜单变了，在飞 run 的未决 tool_use 可能没人接 | 中 |
| G5 | **重放模型** | 不采用也不该采用（见 §5） | —— |

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
   工具菜单签名摘要；续跑时发现菜单变了 → 响亮失败或降级策略可配置，**不静默接着跑**。
4. **G3 的窗口收窄**（可选）：工具结果「先落账再执行副作用」不可行（副作用在工具内），
   现实增量是：工具结果落库与执行之间的窗口加幂等键指引（`idempotencyKey` 已有，
   文档化「工具作者怎么把副作用做成幂等」）。**这条大概率停在文档层。**

## 7. 明确的「不做」

- 不做通用 workflow 引擎（DAG / 重放 / 确定性沙箱）—— 那是 Temporal 的生态位，
  agentia 的定位是 agent 服务框架（spec §1），重放模型对消息历史型状态是错抽象（§5）。
- 不引入独立服务端组件（Temporal server / Restate server 那种）；agentia 的耐久
  继续以「store 后端可换」（memory / file / sqlite / redis）为边界。
- 本轮不写任何实现代码；候选 1/2 若要启动，各自单独立项 + 评审（同样走
  「规划文档 → 逐条核证 → 实施」的流程，2026-09-27 这轮就是这么跑的）。

## 8. 参考

- Temporal 文档：workflow 重放 / timers / signal-query-update / patching（temporal.io/docs）
- Restate 文档：durable RPC / awakeables / virtual objects（docs.restate.dev）
- DBOS 文档：Postgres checkpoint / steps / recv-send（docs.dbos.dev）
- agentia 侧现状出处见 §2 表格的文件引用；挂起/恢复语义见 spec §10 的 HITL 条目。
