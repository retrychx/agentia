# `cancel` API 实施设计（durable 配套 5 的另一半）

> 撰写时刻：**2026-09-28 上午**。上游：`docs/plans/2026-09-27-durable-wake-at.md` §4 配套 5 第 2 点
> （「`cancel` API 今天不存在，本批**不给** —— 独立一件」）、`docs/spec.md` §10 2026-09-28 ② 决策 6。
> 本稿**只设计**，§6 有一处要你拍。
> 立项来源：R8 批次合入 main（`1808418`）后开工的 r9 批次第一件。

## 0. 一句话

给宿主一个**取消**动作：`runner.cancel(taskId)` —— 在跑的**真中断**、在睡的**不许再醒**、
在排队的**绝不入 run**，并且落成一条**说真话**的终态（不是「失败」）。

## 1. 事实基础（逐条核证过，标了 file:line）

| # | 事实 | 出处 |
|---|---|---|
| 1 | **引擎侧早就有「取消」出口**：`abortedError()` = `{ type: 'aborted', message: 'run 已被取消', retryable: false }`；回合门口发现 `signal.aborted` 就**不再发起新回合**，以 `stopReason: 'aborted'` 收尾 | `src/engine/turn.ts:242-243, 261-263` |
| 2 | 结果侧也有具名出口，注释写着口径：`abortedResult` ——「已取消，**带结构化 error**（取消不是失败，但原因要可查）」 | `src/engine/loop-result.ts:19, 128-133` |
| 3 | **唯一会发起中止的是 `runTimeoutMs`**：`const timeoutAc = new AbortController()` → `combineSignals(调用方 signal, timeoutAc.signal)`，到点 `timeoutAc.abort()` | `src/transport/async.ts:1002-1003, 1049-1051` |
| 4 | ⚠️ **落库终态不看意图**：`rec.status = out.run.status` —— aborted 的 run 于是落成 **`failed`**。引擎说「取消不是失败」，宿主把它记成失败 | `src/transport/async.ts:1083`（另有两条 catch 分支写 `failed`：`:1106`、`:1119`） |
| 5 | ⚠️ **`awaitTask` 的终态集合是手写两值**：`if (rec.status === 'succeeded' \|\| rec.status === 'failed') return rec;` —— 加新终态而不改这里，`awaitTask` 会在一条已取消的任务上**永远轮询**（看起来像「取消没生效」） | `src/transport/async.ts:761` |
| 6 | `isTerminalTask` 是三值白名单（非 queued/running/suspended）⇒ 新终态**自动**算终态，事件流收口 / 在飞递减 / 认领释放全部自动正确 | `src/transport/async.ts:123-129` |
| 7 | 内存 store 的淘汰白名单同样三值 ⇒ 新终态**自动**可淘汰（正确：它确实是终态） | `src/store/store.ts:126` |
| 8 | `resume-policy` 对挂起单列原因，其余非 queued/running 报 `'terminal'` ⇒ 取消的记录会被报成 `'terminal'` —— 这**不是**假话（它确实是终态），本批不动 | `src/transport/resume-policy.ts:55-56` |
| 9 | 路由约定：`/tasks/<id>/approve` 与 `/tasks/<id>/stream` **先于**通用 id 分支，且「方法不对」压过「id 坏了」（`DELETE /tasks/%zz/approve` = 405 而不是 400）；未鉴权先 401 | `src/transport/http-route.ts:14-20, 78-89` |
| 10 | 错误类的先例：`TaskApproveError`（带 status，module 级导出、**不进**公共导出面），HTTP 层按它映射状态码 | `src/transport/async.ts:137-141`、`src/transport/http.ts:621` |
| 11 | 今天**全仓没有 `cancel` API**：只有 `runTimeoutMs` 的 abort 与 `drain()`（停机级） | `grep -rn 'cancel' src/`（命中的全是 abort/超时相关，无公共方法） |
| 12 | 两条「唤醒闸」都 gate 在 `status === 'suspended'` 上（审批超时 / 到期唤醒）⇒ 把状态翻成终态，**两条闸自动失效**，不需要额外的「别唤醒」标志 | `src/transport/approval-policy.ts:24`、`src/transport/wake-policy.ts:31` |

事实 4 与 5 是本稿的重点：**取消今天能发生（超时那条路），但它的落地处处按「失败」写**；
而让宿主认出「这不是失败」的那个新状态，会同时踩到一条手写的终态集合（事实 5）。

## 2. 分叉：取消落成什么状态（要你拍的一处）

**A. 复用 `failed` + `error.type: 'aborted'`（= 今天的现状，零公共面变化）**

- 省：`RunStatus` 不动、`awaitTask` 不动、所有状态消费点不动。
- 代价：**运维读数把「人按的」与「跑挂的」混成一类** —— `GROUP BY status` 只有 `failed`；
  要看是不是取消得逐条翻 `error.type`。而 cancel 的全部价值恰恰是「我知道这是人取消的」。
  这与 ① 那次的病同源：`awaiting_approval` 明明在等时刻，状态名却在说另一件事。

**B. 新增 `RunStatus.cancelled`（**建议**）**

- 加法变更（不是破坏性）：`isTerminalTask` / 淘汰白名单**自动**正确（事实 6/7），
  `resume-policy` 报 `'terminal'` 是实话（事实 8），**必须一起改**的只有一处：
  `awaitTask` 那个手写终态集合（事实 5 —— 它病起来是**静默挂住**，不是编译错误）。
- 公共面：`RunStatus` 已是导出类型 ⇒ 导出**计数不变**（联合多一个成员），但
  `api.html` / usage-guide / spec 要把新状态写清。
- `error` 照旧带 `{ type: 'aborted' }`：**状态说「谁按的」，error 说「怎么收的」**。

**C. 新增 `cancelled` + `cancelledReason`（把超时也算成取消）** —— **拒绝**：超时不是「取消」。
两者机制相同（都是 abort signal）但**意图**不同；把 `runTimeoutMs` 的收尾改判成 `cancelled`
会改掉既有的 `failed` 语义（宿主按 `failed` 写的重试/告警会静默失效）。

**建议：B。** 一句话理由：状态按**意图**落，不按**机制**落（同一条 signal 有三个来源：
调用方、超时、取消）；A 是把新语义塞进旧名字、再用 `error.type` 打补丁，
B 的代价只有一处必须跟着改（`awaitTask`），而那处本来就是个静默挂住的坑。

## 3. 接口面（本批最小）

```ts
// AsyncRunner（宿主）
cancel(taskId: string): TaskRecord | Promise<TaskRecord>   // 与 poll 同款「同步门面 + MaybePromise store」
```

- **语义**：立刻记下**意图**（`cancelled` 由意图决定，**不从 signal 反推** —— 事实 3：
  同一条 signal 三种来源，反推不出谁按的）+ 中断在飞 run + 落终态。
- **不做静默 no-op**：已终态 ⇒ `TaskCancelError(409, …)`（与 `approve` 的 409 同款口径：
  状态不对要说出来，不假装成功）；不存在 ⇒ `TaskCancelError(404, …)`。
- HTTP：`POST /tasks/<id>/cancel`，按事实 9 的约定排（先鉴权、方法检查先于解码，
  `DELETE /tasks/%zz/cancel` = 405）；成功返回与 `/tasks/<id>/approve` 同形状的记录快照。

## 4. 三种「在服」状态的语义（本批都要做，逐条有判据）

1. **running**：abort 在飞 signal ⇒ 引擎以 `stopReason: 'aborted'` 收尾（事实 1/2）⇒
   宿主按**意图**落 `cancelled` + `error: abortedError()`。**尊重 signal 的 client 是真中断**
   （token 不再烧），不尊重者等价于「放弃等待」—— 与 `runTimeoutMs` 同一份契约，照抄措辞。
2. **queued（还没起跑）**：直接落终态。同时要挡住「认领时起跑」那一步 —— 认领判据是
   `status === 'queued'`，翻转后自然不入 run；**这条要有用例钉**（最容易漏的一格）。
3. **suspended（两种原因都算）**：**不唤醒**就是它的全部语义 —— 两条唤醒闸都 gate 在
   `status === 'suspended'`（事实 12）⇒ 翻转即失效；另需清掉挂起痕迹
   （`suspendedReason` / `wakeAt` / `suspendedSince`；`pendingApprovals` 按既有终态口径保留为审计）
   与挂起读数。⇒ 这条同时收口了配套 5 的另一面：**取消是「在睡的 run 收到审批决定」的合法出路**。

## 5. 门禁计划（写实现前先定，避免事后凑用例）

| 门禁 | 钉什么 | 变异（关掉就红） |
|---|---|---|
| 在跑取消 | `cancel` 后：引擎以 aborted 收尾、记录落 `cancelled`、`error.type === 'aborted'`、槽位释放 | 落库那处不按意图判 ⇒ 落成 `failed` |
| 排队取消 | 取消一条 queued ⇒ **一次都没起跑**（app 调用计数 0）、落 `cancelled` | 认领判据改成不看状态 ⇒ 「取消后仍然跑了一次」 |
| 在睡取消 | 两条闸都失效：到点/审批超时都不唤醒、落 `cancelled`、`/healthz` 的 `suspended` 读数除名 | 去掉「翻转状态」那步 ⇒ 到点仍被唤醒（**这是真缺陷的写法**） |
| 终态集合 | `awaitTask` 在 `cancelled` 上**立刻返回**（不轮询到超时） | 摘掉新状态 ⇒ 用例走满超时（红成「挂住」，也算被抓住） |
| 409 / 404 | 已终态 ⇒ 409 且**状态与 `finishedAt` 都不动**；不存在 ⇒ 404 | 把 409 闸放宽成 no-op ⇒ 那条红 |
| 路由 | `POST /tasks/x/cancel` 生效；`GET` ⇒ 405（`Allow: POST`）；`DELETE /tasks/%zz/cancel` ⇒ 405 而不是 400；未鉴权 ⇒ 401 | 把 cancel 分支移到通用 id 分支之后 ⇒ 405/400 那两条红 |
| 阳性对照 | 不取消时：到点**照常**唤醒、正常 run 落 `succeeded`（防「把闸焊死」也变绿） | —— |

纪律照旧：先提交再跑变异（还原靠 `git checkout`）；每条变异要**具名**用例红；收口
`scripts/verify-all.sh` 8/8 + `npm run e2e:mcp` + 导入下限 18/20。

## 6. 要你拍的一处

**§2 的落库状态：A（复用 `failed`）还是 B（新增 `RunStatus.cancelled`）？**

我的建议是 **B**，理由见 §2 末。若你更看重「公共面零变化」，A **也能做对** ——
代价是每一处想知道「是不是人取消的」都得去翻 `error.type`，而 `GROUP BY status` 这类运维读数
会永远把两件事混在一起；另外 A 下 `awaitTask` 那个手写终态集合的坑**不会**暴露，
它会留到将来某次真正加状态时才咬人。

## 7. 明确的「不做」

- **不做工具级取消**（取消批次里某一个工具、保留其余结果）—— 与整批作废的协议配平冲突，
  且没有真实需求。
- **不给 `cancelledReason`**（§2 分叉 C）—— 超时不是取消。
- **不做批量 / 按条件取消**（`cancelAll`、按标签）—— 公共面先只开一个点。
- **不删记录**（取消 ≠ 删除；记录是审计）。
- **不改 `runTimeoutMs` 的落库语义**（仍是 `failed` + `error.type === 'timeout'`）。
