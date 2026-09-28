# 深度评审 —— Agentia（`@migor/agentia` v0.9.4）

> 评审对象：`main` @ `25c1983` + 分支 `feat/event-buffer-cap` @ `3c6898f`
> 评审日期：2026-09-28 ｜ 角色：质量专家 / agent 架构（外部视角，独立复核）
> 方法：通读 `src/**` 全部 96 个文件 + 近 12 次提交 + `docs/spec.md` §10/§11 + `docs/guards.md`；
> 实跑测试套件；对两处可疑点写**探针实证**（沿用本仓「修前先实证」的惯例）。

---

## 0. 结论

**这是工程质量处于第一梯队的 TypeScript agent 框架**——架构判断成熟、边界意识罕见地强、
文档与代码互相咬合到「文档就是可执行约束」的程度。测试 1407 条全绿，覆盖率
**行 98.47% / 分支 91.71% / 函数 98.38%**，测试:源码 ≈ **1.86 : 1**。

但本轮独立复核找到 **2 个 P1 级缺陷**（均有实证），它们不是「写得糙」，而是**同一种失效模式**：

> 本仓靠「穷尽枚举 + 文档固化」维持完备性 —— 而枚举是靠**记忆**维护的，不是靠**构造**保证的。
> 状态空间一长（挂起原因、恢复路径、记录上的数组），枚举就会漏项。

两条 P1 都是这个模式的产物：

| 编号 | 缺陷 | 实证 |
|---|---|---|
| **P1-1** | 「停机窗口里先落库再派发」的路径被枚举为**三条**，实际有**四条** —— 漏掉的「审批超时兜底」在 `drain()` 返回 `true` **之后**仍会派发新 run | 探针：`drain()` 返回 `true` → 一次 `GET /tasks/:id` 轮询 ⇒ `app.run` 跑了 1 次 |
| **P1-2** | `TaskRecord.approvals` **没有上限、也不校验 `pendingApprovals`** —— 一次 `approve` 就能把记录从 246 字节撑到 419 KB | 探针：5001 个无关键全部落库，记录 +418 974 字节 |

P1-2 尤其扎眼：**本轮分支刚修的 `pendingEvents` 无界，是同一类**；仓库收了那两个（64 / 256），
第三个漏了。

---

## 1. 架构评估

### 1.1 做得对的（带证据，不是客套）

**① trace 是真正的一等公民，不是外挂。**
`engine/tracer.ts` 的 `TraceRecorder` 有**两条缝**且职责划得干净：`snapshot()` 收尾交付整棵，
`subscribe()` 运行期逐笔（`onTraceEvent` 的底座）。`seq` **每次记账动作都占号、与有无订阅者无关**
——这条判据保证「订阅晚的人」序号不错位（重放正确性的根）。往上：OTLP 导出、metrics exemplars
（指标↔trace 互跳）、`diffTraces`、`traceToMessages`/`forkMessages` 分叉重放、`eval/harvest`
（trace → 评测用例）。**整条闭环齐了**，这在同类框架里很少见。

**② 「旋钮的 0 是什么」有单一真源，且是**可执行**的。**
`core/limits.ts` 把每个旋钮的 0 归入「不限 / 就是不做 / 立即 / 非法」四类之一，
构造期报错文案里那句「（0 = …）」**插的就是表里的 `zeroClause`** —— 口径与实现不可能各说各话。
配 `tests/limits.test.ts` 的穷尽表驱动用例。这是「用构造消灭文档漂移」的正确姿势。

**③ 分层是机器守卫的，不是口头约定。**
`tests/architecture/` 解析 `src` 的 import 图（覆盖 `from` / 副作用 / 动态 import 字面量三种形式），
断言「允许边集合 + 无环 + src 不引 src 之外」，还带**解析计数下限护栏**防「真空变绿」。

**④ 状态语义的取舍有判断力。**
- 挂起 = `suspended` **一个状态 + `suspendedReason` 一个原因**（曾是一个状态兼职两件事，
  后果是审批超时闸去叫醒了等时刻的 run）——这是教科书级的「消除歧义态」；
- `cancelled` 是**状态**不是「失败」（取消不是故障，但带结构化 `error` ⇒ 原因可查）；
- 时间挂起**不起定时器**，惰性判定（「没人读的任务不会自己动」）——部署面极干净；
- 防「吃掉意图」：`deferred` 分支先判 `signal.aborted`，abort 赢过挂起。

**⑤ 「先落库再派发」贯穿四条恢复路径**（approve / signalTask / #wakeDue / #expireAndResume），
且 `#safeSave` 那个「先包成 Promise 再挂 catch」的写法（避免同步 store 同步抛错导致槽位永久泄漏 +
逃逸成 unhandled rejection）——这是踩过坑才写得出的代码。

**⑥ 事件注入点选在 `engine/loop.ts` 而不是宿主。**
判断依据 `tailToolUses` **只认历史末尾一条**：宿主往 `spec.messages` 末尾追加事件 = 未决 tool_use
不在末尾 = 续跑被判成新对话（同一批工具再跑一遍、花费翻倍）。这个判断非常专业，
且他们把设计稿里写错的做法**如实记为偏差**（spec §10 ⑥ 第 3 条）。

**⑦ 诚实边界写得到位。** `// 已知边界`、`⚠️ 这不是上界保证`（PEM 折行的载荷串照样进摘要器）、
`如实：簿记有界，恰好一次的承诺也就有界` —— 这个仓库对自己的承诺**不注水**。

### 1.2 结构性风险（本轮要指出的）

**R-1：`AsyncRunner` 仍是 1604 行、20+ 处状态、6 个派发点。**
已抽出 8 个纯件（slot-pool / approval-policy / drain-gate / resume-policy / task-waiters /
task-events / wake-policy / http-*），**这个方向是对的**。但编排层反而更厚了：现在
`void this.#execute(...)` 散在 450 / 735 / 827 / 943 / 1038 / 1200 / 1202 七处，
而 `isDraining` 的判据在 4 处各写一次（396 / 734 / 826 / 999 / 1037）。
**P1-1 就是「七处派发点 + 分散的闸」的直接后果**——不是有人疏忽，是结构逼人靠记性。

**R-2：「记录上的无界数组」这一族收了两个、漏了第三个。**
`deliveredEventIds`（256）、`pendingEvents`（64）都有上限与就地注释，
`approvals` 既无上限也无入参校验（P1-2）。

**R-3：长跑 CPU 热点已识别但只做了一半。**
`defaultEstimateTokens` 走正则（profile 占约 46%）、`createTokenCounter` 增量缓存、
`usage()` 刻意不深拷 —— 都做了。但 `usage()` 每次仍是 O(全部 span)，每回合调 2 次，
长 run 下 O(回合 × span)。量级目前没问题（有 `bench-*`），记一笔即可。

---

## 2. 缺陷详述

### P1-1 ｜停机后仍会派发：drain 闸的「三条路径」心智模型漏了第四条

**位置**：`src/transport/async.ts:943`（`#expireAndResumeInner` 的 `void this.#execute(target)`）

**仓库自己的口径**（spec §10 2026-09-28 ② + 提交 `25c1983` 的正文）：

> 「这道闸覆盖**三条**把挂起任务推进起来的路径：到期唤醒 / `approve` / `signalTask`」

**事实是四条**：`#expireAndResume`（**审批超时自动全拒并恢复**）与 `approve` 是**不同触发源、
同一形状**（填决定 → 落库成 `running` → 派发）。它由 `poll()` → `#lazyGates()` 驱动，
而 `GET /tasks/:id` 在停机窗口里是**明确允许**的（`http.ts` 头注：「停机中照常可轮询」）。

`#wakeDueInner` 有这道闸（`:1037`），`#approveInner` 有（`:734`），`#signalInner` 有（`:826`），
**`#expireAndResumeInner` 没有**。

**实证**（`approvalTimeoutMs: 50`，一条挂起 60 s 的审批记录，**全程没有人调 approve**）：

```
[1] drain() 返回            : true （此刻无在飞 → true）
[1] drain 后 isDraining     : true
[1] poll 之后 app.run 次数  : 1 ⇒ 停机后仍派发了新 run
[1] 记录状态                : succeeded
```

**为什么这是 P1 而不是 P3**：
1. `drain()` 返回 `true` 的语义是**「排空干净」**——它是宿主的 SIGTERM 决策依据
   （`handler.drain().then(ok => process.exit(ok ? 0 : 1))` 是最自然的写法）。
   返回 `true` 之后又起了活，等于**对部署面说了假话**，而「不静默 / 不说假话」是本仓第一原则。
2. 后果是它们自己在 `PersistFailureInfo` 里点名过的最贵那种：进程退出把在飞 run 硬切 ⇒
   记录停在 `running`（库里说「还在跑」，其实副作用已发生）⇒ 下次启动 `resumePending`
   当孤儿**再跑一遍**，副作用与花费翻倍。
3. 触发条件温和：一条 `approvalTimeoutMs` 到点的挂起任务 + 停机期间任何一次轮询
   （LB 健康检查、前端轮询、K8s preStop 里的收尾调用）就够。

**根因**：不是漏写一行，是「靠枚举维护完备性」——枚举项由人记，新增恢复路径时不会自动出现在清单里。
**建议的修法**（结构级，一次消灭这一类）：把七个派发点收成唯一入口

```ts
// 唯一的派发口：既有的四条「先落库再派发」路径、submit、以及 resumePending 的认领都走它。
// 闸在这里判一次 ⇒ 不存在「哪一支忘了加」的问题。
#dispatch(rec: TaskRecord): void {
  if (this.#drain.isDraining) return;   // 记录已落库，留给下次启动的 resumePending
  void this.#execute(rec);
}
```

含义上的差别要写清：`submit` 的那一处**不能**走静默 return（它对调用方的承诺是「抛错 / 503」，
已有 `#drain.isDraining` 早返回在更前面，语义不变）；其余六处替换即可。
配一条**穷尽守卫用例**：断言 `src/transport/async.ts` 里 `#execute(` 的调用点只出现在 `#dispatch` 内
（源码级 grep 守卫，与 `store/*.ts` 禁 `JSON.parse` 那道守卫同款）——这样第五次新增路径时构建就红。

### P1-2 ｜`TaskRecord.approvals` 无界，且不校验 `pendingApprovals`

**位置**：`src/transport/async.ts:704-714`

```ts
rec.approvals ??= {};
for (const [id, d] of Object.entries(decisions)) {
  if (rec.approvals[id]) continue;   // 逐 id 幂等
  rec.approvals[id] = { ... };       // ← 没有任何「这个 id 是不是本批待决项」的校验
}
...
const complete = approvalsComplete(rec);  // 只判 pendingApprovals ⊆ approvals
```

`approvalsComplete` 只保证「待决的都齐了」，**对多出来的键完全沉默** ——
而多出来的键会被写进记录、随每次 `save` 全文重写落库、并随任务**永久保留**（终态也不清，
注释说「决定保留：审批记录是审计的一部分」）。

**实证**：一条只有 1 个待决项 `t1` 的挂起记录，一次 `approve` 塞 5000 个无关键：

```
调用返回 status      : running
approvals 键数       : 5001
记录 JSON 字节 before : 246
记录 JSON 字节 after  : 419220 (+418974)
```

单次 HTTP 受 `maxBodyBytes`（1 MiB）约束，按 `{"pump-0":{"approved":true},` 约 30 字符/条算，
**单次请求可塞约 3.5 万条、约 3 MB**；反复调用可无限叠加。每个键还会额外带上
`decidedAt / requestedAt / decidedBy` 三个字段。

**为什么算 P1**：这是**认证调用方的资源耗尽**（不是未鉴权攻击面，所以不是更高级别），
且与刚修完的 `pendingEvents` 是**同一类**——同一份记录、同一条「随 trace 落库、每次 save 全文重写」
的写放大路径。仓库为此已经在 `deliveredEventIds` 上写了 256 的判据注释、
在本分支上给 `pendingEvents` 加了 64 的上限，**第三个数组没有**。

**建议的修法**（两件，都要）：
1. **入参校验**：`decisions` 里出现 `pendingApprovals` 之外的 id ⇒ 400/409 拒掉整批
   （与 `parseApproveBody` 的「全有或全无」、`parseEventBody` 的「多一个字段即拒」同一纪律——
   拒掉比半接受安全；调用方本来就知道该批哪些 id，它是从记录的 `pendingApprovals` 读的）。
2. **兜底上限**：即便校验到位，也给 `rec.approvals` 一个常量上限（语义是「非法/异常」而非「用户旋钮」，
   与 `MAX_DELIVERED_EVENT_IDS` 同档，不进 `core/limits.ts` 的 0 语义表），
   并在注释里写清「为什么会超」（否则后人会以为是死代码）。
3. 顺手补一条**回归用例**（400 + 记录一字不动），并把这条边界记进 spec §10 ——
   现在 `approvals` 在 `docs/usage-guide.md §7 已知边界` 表里**没有任何登记**。

### P2-1 ｜`resumePending()` 认领循环同样没有 drain 闸

`#redispatch` 的 `void this.#execute(rec)`（`:1200` / `:1202`）无 `isDraining` 判定。
实证：`drain()` 返回 `true` 后调 `resumePending()`，孤儿记录照样被派发（`app.run` 跑了 1 次）。
比 P1-1 轻（`resumePending` 的文档定位是「重启续跑」，不是周期任务），但既然
`#wakeDue` / `approve` / `signalTask` 都拦了，这一处不拦就是同一份心智模型里的又一个例外。
建议一并用 `#dispatch` 收口。

### P2-2 ｜缓冲满的 409 对「等审批」的挂起是一条死路

`#signalInner` 的容量 409 文案说「先让它跑起来（这些事件会在下次续跑注入）再投递」——
但对 `suspendedReason === 'approval'` 的任务，**让它跑起来的唯一触发源是「有人批准」**，
而那个动作不在事件投递方手里。于是「认证的投递方」拿到一条自己无法执行的建议。
不是 bug（如实报了 409，没静默丢），但文案可以更诚实：区分两种挂起原因，
对 `timer` 说「等到点或先 approve」，对 `approval` 直接说「这条在等人审批，事件投不进去；
要么等人批，要么 `cancel` 后重新提交」。建议顺带在 `usage-guide` §6.6 点明这是一条**有意为之的死路**。

### P3-1 ｜`traceLimits.maxEvents` 的截断在**增量出口**没有信号

`tracer.ts` 的注释说「增量消费者靠 `droppedEvents > 0` 自己判」，但 `droppedEvents` 只在
`snapshot()` 时被写成 run 根的 `trace.truncated` 事件，**从不经 `emit()` 派出**。
于是：走 `run.end` / `task.end` 的消费者（能拿到终态 trace）没问题；
**纯 `onTraceEvent` 的消费者看不见任何缺口**——它收到的就是一条静默的洞，恰好是本仓最反对的形态。
建议：要么在触发截断的那一刻 `emit` 一条 `{ type: 'trace.truncated', droppedEvents }`，
要么把注释改成真话（「增量消费者看不到，只有终态 trace 里才有」）。

### P3-2 ｜`delivered: true` 记在「推进内存数组」那一刻，而不是「模型真看到」

`loop.ts:95-112` 的 `deliverTaskEvents` 先记 `task.event { delivered: true }` 再 push 消息。
若该段随后在**任何模型请求之前**失败/abort（终态分支无条件清 `pendingEvents`，`:1476`），
事件不会进任何持久化历史，但 trace 上已经写着 `delivered: true`。
已知边界他们写清了（「事件不跨终态重放」），但 trace 这个词**略微超前于事实**。
仓库对「不要把没说清的承诺写进文档」很敏感，trace 属性同理——建议改名或改为在
「该段确实把消息流交给过模型」之后才置位。

### P3-3 ｜`npm test` 在受限环境下的失败不可诊断（环境相关，非仓库缺陷）

在受控执行环境（文件系统垫片拦截 `rmSync` 批量删除）下，`tests/toolkit/discover.test.ts`
的「软链目录」用例会被垫片拒绝（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），
从而让 c8 的 `--check-coverage` 报 `exit 1` —— **症状与「覆盖率低于阈值」完全一样**。
脱离该环境 1407/1407 全绿，所以**不是仓库缺陷**；但 `scripts/test-all.mjs` 的汇总
只说「框架套件 exit 1」，排查成本不低。建议在汇总里区分「用例失败」与「覆盖率门禁/收集失败」
（各自一行），这次我就花了两次全量运行 + 一次裸跑才定位到。

---

## 3. 质量体系评估

| 维度 | 评价 |
|---|---|
| 测试规模 | `tests/` 36 560 行 vs `src/` 19 693 行（**1.86 : 1**），目录镜像 `src` |
| 覆盖率 | 行 **98.47%** / 分支 **91.71%** / 函数 **98.38%**（c8 棘轮，非 node 内建——后者在 `--import tsx` 下是整个失灵的，他们实测过并写进注释） |
| 变异验证 | 提交正文普遍带「**修前实证红 N 条**」「摘掉该判定 ⇒ 用例具名复红」——**这是同行里少见的纪律** |
| 架构守卫 | import 图允许边集合 + 无环 + 不外引 + 解析计数下限（防真空变绿）；`0 反射`、`零运行时依赖`、CLI 结构 W1/W2/W3 |
| 文档守卫 | `docs/**` 引用的提交必须真在主干（配 CI `fetch-depth: 0`）；`usage-guide` 表格逐项对源码核；`api.html` 导出表**正向核 + 反向全覆盖**；`no-legacy-terms` |
| 已知边界 | §7 七十七条登记 + 守卫；`§11 开放项` 显式列「未做 + 两条候选 + 倾向」 |
| 依赖卫生 | 运行时**零第三方依赖**（`node:sqlite` / `node:child_process` / 全局 `fetch` 全走标准库），`@anthropic-ai/sdk` 只在 devDependencies 做兼容门禁 |

**这是本仓最强的一面**，也是我认为它「不靠人盯也能守住」的原因。唯一要提的是：
守卫覆盖的是**已枚举**的约定（`ALLOWED` 边集合、`§7` 边界表）——守卫能防「已登记的承诺被违反」，
防不了「该登记没登记」（P1-2 的 `approvals` 就不在任何一张表里）。这与 §1.2 的 R-1/R-2 是同一个根。

---

## 4. 建议的下一步（按性价比排序）

1. **【半天】P1-2 修掉**：`approve` 校验 `pendingApprovals` + `approvals` 兜底上限 + 回归用例 +
   §7/§10 登记。改动面小、收益明确、与刚做的 `pendingEvents` 同款，能顺势把「记录上的无界数组」
   这一族**一次收干净**（顺带 grep 一遍 `TaskRecord` 上还有没有第四个数组：`deliveredEventIds`、
   `pendingEvents`、`approvals` —— 我核对过，就这三个，但值得写进守卫）。
2. **【一天】P1-1 + P2-1 用 `#dispatch` 收口**：七个派发点 → 一个入口 + 一道闸，
   配一条源码级守卫（`#execute(` 只许出现在 `#dispatch` 内）。这不止修 bug，
   它把「枚举完备」换成「构造完备」——**下一次新增恢复路径时不会再漏**。
3. **【半天】P2-2 / P3-1 / P3-2 文案与信号收口**：都是「如实」类的小修，
   与本仓一贯口径一致，适合并进同一次复审提交。
4. **【可选】R-1 的下一步拆分**：`AsyncRunner` 剩 1604 行，下一步拆的应是**编排**而非纯件——
   比如把「派发 + 闸 + 在飞计数 + 认领释放」收成一个 `TaskLifecycle` 协作件，
   `AsyncRunner` 只留对外门面。⚠️ 这一步风险高于前三条（那份 `#execute` 的 finally 里有
   五件必须同生共死的事：槽位释放 / 认领释放 / sinks / 流收口 / 等待者唤醒），
   建议先补一层用例再动。

---

## 5. 附：复现方式

两处 P1 的探针各 ~40 行，`node --import tsx` 直接跑即可（未依赖任何 mock 基建）：

- P1-2 探针：种一条 `pendingApprovals: ['t1']` 的挂起记录，调
  `runner.approve(id, {...5000 个无关键, t1: {approved:true}})`，比对调用前后的
  `JSON.stringify(rec).length`。
- P1-1 探针：`new AsyncRunner(app, { store, approvalTimeoutMs: 50 })`，种一条
  `suspendedSince: now - 60_000`、`suspendedReason: 'approval'` 的记录，
  `await runner.drain()` → `await runner.poll(id)` → 断言 `app.run` 的调用计数。
  阳性对照：把 `suspendedReason` 换成 `'timer'` 且 `wakeAt` 已到 ⇒ 不派发（证明是闸缺失，不是任务本来跑不起来）。

> 报告为外部独立复核产物，未改动仓库任何文件；探针脚本位于 `/tmp/probe-approvals.ts`、
> `/tmp/probe-drain.ts`。
