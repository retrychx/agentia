# 巡检服务（patrol）

一个**真的在干活**的可交付 Agent 服务：给它一个目录，它做只读巡检、写出一份有据可查的
Markdown 报告；**任何改动文件系统的动作都要人工审批**。

它和 [`../deploy/`](../deploy/) 的分工：

| | `deploy` | `patrol`（本目录） |
|---|---|---|
| 菜单 | 一个 `echo` | 五个真工具 + 一条人工审批闸 |
| 任务 | 证明接线通 | 真任务：读真文件、写真报告、真挂起等人批 |
| 用途 | 「最小可交付服务」的骨架 | 拿去对拍 [`docs/deployment.md`](../../docs/deployment.md) 的十条上线清单 |

> 上线清单的回答在 `deployment.md`；**这份示例回答的是「照那张清单接线，真跑起来会怎样」**——
> 实测读数见 `npm run drill` 的产出（见下文）。

## 怎么跑

**本地**（需要有模型凭据；框架不读 env，是本进程读）：

```
# DeepSeek（OpenAI 兼容端点）
export DEEPSEEK_API_KEY=sk-...
export PATROL_TOKEN=$(openssl rand -hex 16)
export PATROL_PRICE_IN=1 PATROL_PRICE_OUT=2   # 换成你端点的真实价目

npm install
npm start          # 默认巡 ./sample-workspace，报告写 ./patrol-reports/
```

起来后会打印五行 `[boot]`（第一行就是就绪信号；有续跑任务或占位价目表时会再多打一两行）。然后：

```
curl -H "Authorization: Bearer $PATROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"input":"巡检这份代码库，写报告到 patrol.md。写完对 notes/legacy/2023-brainstorm.md 调用 quarantine_path。"}' \
  http://127.0.0.1:3000/tasks
```

拿到 `taskId` 后轮询 `GET /tasks/<taskId>`：状态会变成 **`suspended`**（模型要改文件系统，等人批），
`pendingApprovals` 里是待决的 `tool_use_id`。批准：

```
curl -H "Authorization: Bearer $PATROL_TOKEN" -H 'content-type: application/json' \
  -d '{"decisions":{"<tool_use_id>":{"approved":true,"reason":"确认废弃"}},"decidedBy":"me"}' \
  http://127.0.0.1:3000/tasks/<taskId>/approve
```

**容器**：

```
docker compose up --build     # 巡检目标由 PATROL_TARGET 指定，只读挂载到 /workspace
```

## 接线怎么对那十条

`src/main.ts` 里带 `§N` 注释的就是对应条目：

| § | 清单要求 | 本示例怎么做 |
|---|---|---|
| 0 | 锁精确版本 | 本目录 `file:../..` 跟工作区；发布版请锁 `^0.10.0` → 精确号 |
| 1 | 密钥不进框架 | `src/model.ts` 显式读 env 后传进 `createOpenAIClient` |
| 2 | 耐久 store + 续跑 | `SqliteTaskStore` + 启动时 `runner.resumePending()` |
| 3 | 鉴权 / `/metrics` 边界 | `authenticate` 校验 Bearer；`/metrics` **不鉴权**（边界，靠反代限制） |
| 4 | 健康检查 | `/healthz` 的 `draining` 就是就绪判据；compose 的 healthcheck 据此摘流量 |
| 5 | 优雅停机 | `SIGTERM → drain(15s) → server.close() → store.close()`；compose `stop_grace_period: 25s` |
| 6 | 四个预算旋钮 | `maxTotalTokens` / `maxCostUsd` / `maxIterations` / `toolTimeoutMs` + **非 Anthropic 端点的 `priceOverrides`** |
| 7 | 观测 | `metricsSink` + `jsonlTraceSink`，都在 `sinks` 上（出口只有一条缝） |
| 8 | 多副本 | 单机多进程可共库；跨机见清单 §8（本示例不演示） |
| 9 | 回滚 | 见清单 §9；本示例未做自动化回滚演练 |

## 演练（`npm run drill`）

把真模型、真任务套进上面这套接线，逐条验：

```
set -a; . ~/.hermes/.env; set +a     # 或自己 export DEEPSEEK_API_KEY
npm run drill
```

它会在 `.drill-out/` 下建一份**示例工作区的干净副本**（隔离动作会真移文件，不能弄脏仓库），
然后按顺序验**十一件事**，每件都打印实测读数并落盘到 `.drill-out/drill-readings.json`：

- **P0** 服务启动并打印就绪信号
- **P1** 未带 token 的入口被拒（401）；已鉴权但体不合法是 400 —— 两件事
- **P2** `/metrics` 不鉴权（**边界是真的**，需反代限制）
- **P3** `/healthz` 的 `ok/ inFlight / draining`
- **P4** 提交异步任务
- **P5** **审批挂起 → 人批 → 恢复收尾**（HITL 全链路）
- **P6** 产物与副作用**真的落在盘上**（看文件系统，不看模型自述）
- **P7** trace sink 落盘
- **P8** **崩溃演练**：任务在飞时 SIGKILL → 同库重启 → `resumePending` 续跑**到成功**
- **P9** **预算保险丝**：单次任务钉一个很小的 `maxTotalTokens` → 断言以 `budget_exceeded` 收尾、状态是 `failed`
- **P10** **优雅停机**：SIGTERM → drain → 退出码 0

> **这条演练刻意不进 CI**：它要连真模型、要花钱、耗时是分钟级 —— 与 `scripts/bench-*` 同款
> 理由（「计时/计费类只制造抖动」）。它是**手动设备**，跑法与读数都在本文件里；
> 仓库门禁能覆盖的是它**不花钱的那部分**（类型检查、lint、`examples/README.md` 的表与目录一致）。

### 验的到底是源码还是产物

`npm run drill` 缺省跑 **源码**（`tsx src/main.ts`）；而 **Dockerfile 的 CMD 跑的是编译产物**
（`node dist/main.js`）。「源码能跑」推不出「产物能跑」—— 入口路径、`exports`、构建配置
任何一处错都只会在产物那条路上暴露。所以入口可切，**十一条断言一字不改地复用到产物上**：

```
npm run build
PATROL_DRILL_ENTRY=dist npm run drill
```

- 只认 `src` / `dist` 两个值，**拼错立刻响**（不是静默回落到源码 —— 那会让人误以为
  「产物验过了」）；
- 读数里 `P0.entry` 记下本次验的是哪一个，读数文件脱离上下文后能自证。

### P8 为什么最值钱

P8 是这套里最值钱的一条：它验的是「进程突然没了，在飞的任务会不会变成死任务」。
判据不看日志怎么说，看**重启后那条记录有没有走到 `succeeded`** ——
这里断言刻意收严到「成功」而不是「到达终态」：`failed` 会把预算/模型/工具的原因混进来，
那样这条就不再是在验「续跑」了。

## 边界（本示例自己划的）

- **单机单写者**。store 用 SQLite 共库语义，多副本写路径协调见清单 §8 —— 本示例不演示。
- **价目表是占位值**，除非你设了 `PATROL_PRICE_IN/OUT`。占位值下 `maxCostUsd` 的读数不可信
  （但 `maxTotalTokens` 仍然有效）。启动时会打一行警告。
- **巡检根是只读面**，写面只有产出目录 —— 这条边界由 `src/workspace.ts` 守，**不交给模型**。
  判定分两道：词法道（`resolve` + `relative` 挡 `..` / 绝对路径）+ 真身道（root 与待读路径
  都过 `realpathSync` 再比界，挡「根内软链指向根外」；不存在的路径与成环软链落成同一个
  「不可读」错误）。容器里由 `:ro` 挂载在物理层再兜一道。
- **`search_text` / `list_files` 的目录遍历不跟随软链**（`lstat` 判定，软链表项如实标 `link`
  或直接跳过）：更安全也更简单，代价是根内指向根内的合法软链目录不会被搜到 ——
  其中的内容仍可由 `read_file` 按路径点名读取（走 realpath 校验）。
- **已知边界：TOCTOU**。realpath 校验与实际读/移之间存在竞态，示例不防这一层，
  生产上靠挂载层（`:ro`、独立 uid）兜底。
- **`quarantine_path` 是移动不是删除**，刻意可逆：演示审批闸不该顺手真毁数据。
- **工具输出有宿主侧上限**（`read_file` / `search_text` 各自截断并标注）。框架层没有这个闸，
  这是使用指南 §7 的已知边界，长跑宿主得自己兜。
- **没写自动化回滚演练**（清单 §9 那条）。要验的话：拿 store 导出在新版本上 `agentia report` 一遍。

## 文件

```
src/main.ts              服务装配 + 十条接线（注释标了 §N）
src/model.ts             DeepSeek/OpenAI 兼容端点 + 价目表
src/workspace.ts         路径边界（读面 = 巡检根，词法 + realpath 真身两道校验；写面 = 产出目录）
src/registry.ts          DI 注册表（工作区按构造注入）
src/tools/*/index.ts     五个工具（四个只读 + 一个带审批闸）
drill.ts                 上线演练（十一条断言，入口可切 src/dist）
sample-workspace/        默认巡检目标（刻意留了几处会过期的东西）
```
