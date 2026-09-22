# Agentia —— 守卫注册表（约定 → 可执行断言）

> **这份文档回答一个问题：这个仓库的哪些承诺是「机器守着的」，哪些只是「写在文档里的」。**
>
> 起因：`spec.md §10` 记录「我们决定了什么」，但**不记录「这个决定由谁守」**。于是同一类
> 缺陷会以不同面貌反复出现 —— 2026-09-18 的第六轮 review 一次挖出 16 条，全部属于
> 「约定写在文档/注释里，但没有任何门禁」的同一缺口。本文件是该缺口的一次性补齐。
>
> **维护约定**（写进 PR 模板）：新增/修改不变量时，必须在下面登记一行。**守卫不是均匀撒的，
> 它是沿着「你写过文档、写过测试的地方」长的** —— 这份表的作用就是让缺口可见。
> 未登记的「待守」条目在 §2，那是下次 review 的靶子清单。

---

## 1. 已挂守卫（按危险类分组）

### 1.1 架构与形状

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/architecture/layering.test.ts` | 分层单向（`core ← engine ← …`）、依赖图无环、`src` 不 import 到 `src` 之外 | 解析 import 图（`from` / 副作用 / 动态字面量三种），断言允许边集合 + 解析计数下限防真空变绿 | `store → runtime` 这类未声明兄弟依赖悄悄存在（真发生过） |
| `tests/integrations/adapter-parity.test.ts` | **同一契约的两条适配器必须对称**：同一 HTTP 状态在 anthropic / openai 上的 `{classifyError.type, retryable, 尝试次数}` 完全一致；`maxRetries` 的**构造期校验也对称**（坏值矩阵 × 两条适配器成对断言） | 一份场景表（408/409/429/500/503/400 + `retry-after` + `maxRetries:0`）`for (const a of ADAPTERS)` 跑两遍；替换 `globalThis.fetch` 作为两侧统一的注入面；`retry-after: 0` 让退避不真 sleep。坏值矩阵：NaN / ±Infinity / -1 / 1.5 一律构造期抛 `TypeError`，`0` 与缺省放行（`0` = 不重试是**有意义的值**，见 §2「`0` 的双重语义」） | 「同一个 429」在 anthropic 打 3 次网络请求、在 openai 打 1 次 —— 成本/延迟随厂商而异却没人发现（真发生过：openai 曾完全没有内层重试）；`maxRetries: NaN` ⇒ `attempt >= NaN` 恒假 = **无限重试**、`Infinity` 永不达到（真发生过，2026-09-21 外部队列复核） |
| `tests/architecture/transport-errors.test.ts` | 传输层适配器抛的错误必须带**数值 `status`**（否则被归类为 unknown → 重试层静默失效） | 扫 `src/integrations` 的裸 `throw new Error(...)`：文案带 HTTP 状态痕迹即违规；构造期配置校验按文案豁免 | OpenAI 适配器吃一个 429 就整轮失败、引擎层 3 次重试一次不发生（真发生过）；本守卫上线当天就抓到 `otlp.ts` 的同类漏网 |
| `tests/architecture/tsconfig-strictness.test.ts` | **承重的 tsconfig 开关不得被关掉**：`exactOptionalPropertyTypes`（显式 undefined ≠ 不传）、`strict`、`types:["node"]` | 读 `tsconfig.json` 断言三个开关。反向验证过：关掉 `exactOptionalPropertyTypes` ⇒ 本测试红，且 `{maxAttempts: undefined}` 赋给 `RetryOptions` 从「编译错」变回「放行」 | 39 处防线无声消失（`retry.ts` 的「显式 undefined 覆盖缺省」重新变成合法代码）；@types/node 缺链导致全仓 Node 类型报错 |
| `tests/types/message-compat.types.ts` | 自有消息类型族 ↔ `@anthropic-ai/sdk` 的结构兼容（双向 assignability） | 针对构建产物 dist 编译的类型断言（`typecheck:types`，node:test 不收） | 使用者手里的 SDK 类型喂不进来；SDK 升级改字段无人发现 |
| `tests/types/dx.types.ts` | 类型链路（`fromZod<T>` 校验方法签名、`result.typed` 推导） | 同上 | DX 承诺（「编辑器给不给提示」）退化成 `unknown` |
| `tests/core/trace.test.ts` · `tests/integrations/otlp.test.ts` | **id 的线缆形态只有一份投影**：OTLP 导出的 spanId 与出站 `traceparent` 的 span 位必须**逐字相等**（两处都等于 `core/trace.ts` 的 `wireSpanId(…)`） | 两条断言各自引用单源（不就地写 `replaceAll().slice(0,16)`）⇒ 任何一边换切法立刻红。反向验证过：otlp 侧改成 `slice(8,24)` ⇒ 结构用例真红 | 同一次调用在 collector 里是一个 span id、下游收到的是另一个 —— 跨系统关联断在最不该断的地方 |

### 1.2 静默失效（最贵的一类）

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/engine/concurrency.test.ts` | **任何 limit 下每个 item 都被处理恰好一次**（含 `0` / `(0,1)` 小数 / `Infinity` / `NaN`） | 边界值矩阵 + 不变量断言 | `Math.floor(0.5)=0` → worker 数为 0 → 工具静默丢弃、run 报成功（真发生过） |
| `tests/timeoutLiveness.test.ts` | 「等待的终点」不得 `unref()`（唯一把手时进程会先退出） | 干净子进程 + 空事件循环验三个往返 | 调用方什么都拿不到、进程 exit 13（真发生过） |
| `tests/engine/retry.test.ts` | 显式 `undefined` 字段**不得**覆盖缺省（`{maxAttempts: undefined}` 不是「关闭重试」） | 逐字段传 `undefined`，断言回落到缺省 | 重试静默关闭，而 trace 记成 `config.retry.maxAttempts: 0`（像是用户主动关的） |
| `tests/toolkit/env.test.ts` | `.env` 解析的分支矩阵（引号 / 引号+行内注释 / 转义 / 不闭合 / 值内含 `#`） | 表格驱动，逐格断言 | 密钥带字面引号进 `process.env` → 每个请求 401，而文件看上去完全正确（真发生过） |
| `tests/toolkit/subagent.test.ts` · `skill.test.ts` | 嵌套能力必须把 `toolTimeoutMs` 等透传子循环（裁判权交接） | 喂带字段的 ctx，断言子循环按该口径记账 | 子循环永不超时 + MCP 桥起自己的兜底计时器 = 双计时器双账本 |
| `tests/toolkit/discover.test.ts` | `asset()` 的 `rel` 必须**真相对 base 解析**：带 scheme（`file:` / `https:`）与**绝对路径**（`/etc/passwd`）都会让 `new URL` 丢掉 base ⇒ 两者都显式拒绝；`../` 仍**放行**（它确实是相对 base 的） | 逐形态断言（scheme / `//` / `\` / `../` 反向对照） | 「以为读了能力目录里的文件，实际读了别处」—— 绝对路径那半此前没人守（`/etc/passwd` 在 macOS 上**真能读到**） |
| `tests/core/sse-text-stats.test.ts` | **「预算非正数 = 机制关掉」在共享原语上一致**：`withTimeout(p, 0)` 不设超时、`interruptibleSleep(0, signal)` 不睡（**即使 signal 已中止也 resolve** —— 非正数判先于 aborted 检查）；到点 resolve 时必须摘掉 abort 监听 | 直接单测原语 + `getEventListeners` 计数（带一个常驻监听做对照，防「计数函数恒 0」的假绿） | 有人把「已中止 + `ms<=0`」当 bug「修」成 reject ⇒ 破坏与 `withTimeout` 的对称性（2026-09-19 外部复核真误判过一次，被这条用例拦下） |
| `tests/engine/tracer.test.ts` | `usage()` 与 `snapshot().totalUsage` **逐字同口径**（预算护栏走前者、trace 交付走后者 —— 漂移就是护栏拿错数） | 同一个 recorder 上 `deepEqual` 两条路 | 预算护栏按错的数字判超限 / 该拦不拦 |
| `tests/engine/spanScope.test.ts` | 出站 `currentTraceparent()` 的**调用期**作用域：粒度到本回合 / capability（不是 run 根）；并行链互不干扰、内层不外泄；run 结束不残留 | 真跑一轮 + 直测原语（内层链与旁支链各读一次，旁支必须在**内层已进入之后**读）。反向验证过：把作用域退化成 run 级单值存储 ⇒ 5 条里 3 条真红（含并行不串那条） | 退回 run 级单值存储 ⇒ 并行工具互相覆盖：下游拿到的 span id 指向**别的**那次调用（spec §9.2 锁定「span 句柄不放 RunContext」正是为此），且没有任何报错 |
| `tests/integrations/otlp.test.ts` | **OTLP/JSON 的 enum 必须整数编码**（`status.code` = 1 / 2、`kind` = 1；规范禁止 enum 名）；且 **HTTP 200 ≠ 全部接收** —— collector 的 `partialSuccess` 必须按失败处理 | ① 断言 payload 里 `status.code` 是整数，并**扫整个 payload 不得出现任何 `*_CODE_*` / `SPAN_KIND_*` 字面量**（假 collector 只做 `JSON.parse`，所以「断言跟着实现一起写错」会假绿 —— 加这条扫是为了堵住形成假绿的机制）；② 假 collector 回 `200 + partialSuccess`：`{}` 与 `rejectedSpans: 0` 算**全部接收**、非空 `errorMessage` 算**拒收**，traces 侧断言走 `onExportError`、metrics 侧断言抛 `MetricsExportError` | 严格的 collector 判非法并**整批拒收** ⇒ 观测数据全丢而框架说一切正常；把 200 的部分接收读成成功 ⇒ 看板少一半数据无人知（真发生过，2026-09-21 外部队列复核；两处都发过字符串 enum、都只查 `res.ok`） |
| `tests/integrations/metrics.test.ts` | **CUMULATIVE 指标的 `startTime` 必须随 `reset()` 前移**（同一 startTime 下 counter 只能单调不减） | 同一个 sink 导出两次、中途 `reset()`，断言值回到 1 **且**窗口起点**严格**前进（含同毫秒连按两次 reset）；窗口内不 reset 时起点逐字不变 | 后端把「新窗口的小值」当成同一区间的分量 ⇒ 算出负增量或丢样本（真发生过：`reset()` 只清计数、起点取 sink 创建时刻的常量，导出值 2 → 1 而 startTime 没变） |
| `tests/integrations/mcpConnector.test.ts` | MCP 连接器**三件只有它能做的事**：spawn 的 `'error'` 是异步事件必须接住 / stdout 必须按 `\n` 攒包 / **协议层 `isError: true` 必须转成抛错**；装配期超时；`close()` **返回即子进程已终止**、且 HTTP 侧 DELETE **挂死时也必须到点返回**（server 半开不得挂住停机路径）；StreamableHTTP 会话过期（`404`）**自愈且只重试一次**、并发 404 共享同一次重握手 | 起**真子进程**夹具（`tests/fixtures/mcp/fake-server.mjs`，env 覆盖 8 种模式，含忽略 SIGTERM 的 `stubborn` + pid 文件）+ HTTP 侧注入 `fetchImpl`；用例本身由 **15 条变异电池**证明会咬 | `isError` 不转抛错 ⇒ 失败的调用被**模型与 trace 一起**记成成功（正好打在本框架「trace 决定你敢不敢上线」的承诺上）；不接 `'error'` ⇒ 命令不存在时未捕获异常把宿主进程带崩；`close()` 不等 reap ⇒ 留孤儿进程；会话过期不自愈 ⇒ 长跑宿主只能重建连接器 |
| `src/core/limits.ts` · `tests/limits.test.ts` | **`0` 的语义只有一份真源**：15 个旋钮各属「不限 / 机制关掉 / 立即执行 / 非法配置」四类之一，全部登记在一张可执行的表里；构造期报错文案里那句「（0 = …）」**直接插表里的 `zeroClause`**（文案与实现不可能各说各话） | 表驱动的**穷尽**用例（`Record<LimitKnob, 探针>`）：逐条**驱动真实站点**（`new AsyncRunner` / `mapWithConcurrency` / `resolveMaxRetries` / `Scheduler.every` / `metricsSink` …）对账，探针必须能把声明的读法与相邻读法区分开；新增旋钮不归类 ⇒ `typecheck:tests` 红。反向验证过：`drain-gate` 的 `<= 0` 改回 `< 0`（**历史事故那个读法**）+ `tracer` 的 `< 0` 改 `<= 0` ⇒ 恰好那两条红、其余 14 条不误伤 | 同一个 `0` 各处理解一遍 ⇒ `drain({timeoutMs: 0})` 跨过 deadline 后**永不返回**（真发生过）；`intervalMs` 在 `Scheduler.every` 里是「必须 > 0」、在 `metricsSink` 里却是「立即导出」—— **同名反义**且此前无人登记 |
| `src/engine/forwarded.ts` · `tests/types/forwarding.types.ts` · `tests/engine/forwarded.test.ts` | **转发不得漏字段**：`ToolRunContext` → 嵌套能力子循环那七个旋钮取自**唯一取值点**（映射类型 `{[K in Key]-?: …}` 要求七个键全必填），且 `ToolRunContext` 的每个键必须在「转发」或「引擎自装配」里**归类** | 调用点只写 `...forwardToolContext(ctx)`（两处手写清单已删）⇒ 没有可漏的地方；类型层断言「未归类键集 `extends never`」+「少一个键必须报错」。反向验证过：给 `ToolRunContext` 加一个未归类字段 ⇒ `typecheck:types` 真红（TS2322）；取值少一行 ⇒ `typecheck` 真红（TS2741） | `runAgentScoped` 漏 `toolTimeoutMs` 跨 engine → toolkit → ctx 三层无人发现，且后果是**反的**：子循环 `withTimeout(p, 0)` 永不超时 + MCP 桥另起自己的 60s 兜底 = 双计时器双账本（真发生过） |

### 1.3 宿主与耐久

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `scripts/e2e-deploy.ts` | 崩溃续跑：`SIGKILL` 后同库重启 `resumePending` 必须续跑 | 真起服务、真杀进程、同库重启、断言终态 | 「耐久」是句空话（在飞任务死半路无人接管） |
| `tests/transport/host-hardening.test.ts` | 鉴权拦在**读 body 之前**、body 上限、并发闸门、`exposeErrors` | 真 HTTP 请求 + 断言状态码与连接行为 | 未鉴权请求也会被读进 body；内部拓扑回吐给未鉴权调用方 |
| `tests/transport/async.test.ts` | 幂等键去重、`resumePending` 认领、迟到 reject 不改写终态；**幂等键的进程内认领**：同键并发提交只执行一次、**终态才释放**（挂起仍在等人 ⇒ 不释放）、释放判据按 `taskId` 而非 `claimed`（HITL 恢复段是另一次 `#execute`、异步 store 交出的还是新副本） | 状态机级用例 + `AsyncCopyStore`（异步 store 交出的记录是**反序列化新对象** —— 内存 store 的引用语义会把这类缺陷掩盖） | 同键任务重复执行；成功的 run 被落库失败覆写成 failed；**挂起过的键永久钉在认领表里**（同键再也不执行 + 表无界增长 —— 反向验证时真复现过：释放判据只看 `claimed` 或只比对象同一性，HITL 用例立刻红） |
| `tests/engine/approval.test.ts` · `tests/transport/approval.test.ts` · `tests/transport/httpApproval.test.ts` | HITL 挂起/恢复（2026-09-19 ①）：未决审批 ⇒ **整回合零执行零 tool_result**（协议配平）；`awaiting_approval` 不占槽、不触发 `onFinished`、`resumePending` 不捡、淘汰跳过；`approve` 逐 id 幂等（第一次赢）+ 先落库再派发；惰性超时自动全拒；挂起段照常 flushSinks、恢复段 link 上一段 | 引擎层 mockClient + 宿主层**真引擎**（executeRun）+ 真 HTTP；含「不做什么」断言（onFinished 不开火、普通工具不提前执行） | 审批闸被绕过（副作用直接发生）；挂起被当终态通知 webhook；恢复丢决定/重复执行 |
| `scripts/e2e-grpc.ts` | **换宿主时最容易静默丢掉的四处语义**：deadline / 取消 → `signal`（要求服务端的 run **真被 abort**，trace 里 `error.type=aborted`，而不是照跑完）、metadata `traceparent` → run 根 link、同 `session_id` 两轮共享历史、同 `idempotency-key` 不重复执行 | 真构建 + 真起宿主（`PORT=0` 由服务自报端口，没有「探空闲端口再交出去」的抢占窗口）+ 用**示例自带的客户端**跑四个 RPC；模型侧假 Anthropic 端点、trace 落 tempdir（不留产物）；**变异电池 8/8 全部由对应断言抓住**（含一条「被抓住但不是被预期断言抓住」的更正记录，见 spec §10 2026-09-18 ⑪） | 客户端已经走了服务端还把 run 跑完（token 白烧）；跨进程链路在服务边界断掉；错误全塌成一个 UNKNOWN（调用方重试策略失效）；RPC 回了结果但「为什么慢 / 贵 / 失败」没有证据 |

| `tests/transport/queueConsumer.test.ts` | **队列消费者配方的三条承诺**（usage-guide §6.4 那条二十行样板）：同键重投**不重复执行**、`traceparent` 随 `spec.options` 落库使**他进程续跑**仍带得上同一条 link、失败不 ack 要 nack 重投 | 内存版 broker（at-least-once：交付即「在飞」/ `ack` 才算完 / 未 ack 与 nack 一律重投 / `crash()` 模拟崩溃）+ 真 `AsyncRunner` + 真引擎（`executeRun` + `mockClient`）把三条承诺各跑一遍；断言的是**副作用计数**与 `broker.deliveries`（不只 taskId —— 那才证明重投真的发生过）。反向验证（逐条隔离、可复现）：把 **submit 快路径**的复用判据（`async.ts` 的 `existing.status !== 'failed'`）改成 `!== 'succeeded'` ⇒ ①②④ 红、③ 绿（3/4 —— ④ 红是同一行的另一面：**失败**的键必须允许新任务，否则重投永远拿不到第二次执行；③ 的键全程唯一，不碰幂等判据）。按字面改 **`#executeInner` 的采纳判据**（`async.ts` 的 `existing.status === 'succeeded'`）⇒ 四条全绿：该采纳路径只在「异步 store + 同进程认领表未命中」的窄窗口可达，而本文件用同步内存 store，submit 快路径已把去重做完，根本碰不到它 —— 所以它**不是**本文件的守卫对象（此前「四条全红」的记录是把两处判据混为一谈了） | 配方是宿主侧样板、框架侧无可测实现 ⇒ 「文档承诺可跑」此前没人跑过；生产上表现为重投导致**下单两次**（副作用翻倍），或链路在消费者那一跳断掉（`resumePending` 续跑的那次 run 丢了上游 link） |

### 1.4 文档与发布面

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/docs/usage-guide.test.ts` | `usage-guide.md` 的表格**逐项对源码核**（字段名/默认值/类型） | 解析文档 + 断言与源码一致 | 文档承诺了、代码没有（本仓库最主要的对外风险面） |
| `tests/docs/api-page.test.ts` | 官网 `api.html` 对导出面的**反向全覆盖**（每个导出都必须在页面出现）；以及**页面上所有手写数字**对源码核（`N 个导出` → `src/index.ts` 导出数、`N 个层次` → 页面 section 数、`N 个运行时依赖` → `package.json` 的 `dependencies` 数、`N 类能力` → 四个能力装饰器、`N 类触发` → 三个传输宿主） | 读导出清单 / 计数 + 扫页面文本（两个 fragment 的 chips 与首屏统计行都覆盖） | 新增导出在文档里缺席；「0 个运行时依赖」变成 1、加一类能力后页面继续写 4 —— 这类数字此前靠人眼改（`1 个运行时依赖 → 0 个` 真漂过） |
| `tests/docs/no-legacy-terms.test.ts` | 面向使用者的表面（文档 / 官网 / 包 README / CLI `--help` 与报错）不得出现旧伞形术语 | 文本扫描 + 允许标记块（有行数上限） | 一次改名漏扫几处，读者看到两套术语 |
| `tests/docs/run-output-shape.test.ts` | `run` 返回结构的文档形状与实际一致 | 扫描 + 断言 | 结构化结果的对外契约漂移 |
| `tests/scripts/release-scripts.test.ts` | `release.mjs bump` 的**每项替换计数断言**本身可靠 | 直接测护栏（护栏失灵会写坏整棵树，且发生在发版当天） | 一次 bump 把仓库写坏却没人拦 |
| `scripts/e2e-cli.ts` 第 8 步 | 两包 tarball 必须含 `CHANGELOG.md` | `npm pack --dry-run` 断言（临时 npm cache，不依赖宿主缓存健康） | 迁移指南写了但用户看不到（真发生过） |
| `scripts/e2e-cli.ts` 第 4d / 4d-bis 步 | **重复构建不得留下已删除能力的产物**：产物自己的 `npm run build` 必须先清 `dist/`，删掉一个能力再建 ⇒ 旧产物必须消失、本次该有的产物仍在。**命令字面来自生成物 `package.json`**（测试不复刻那三步） | 真删（能力目录 + 注册表那两行都删）→ **真跑 `npm run build`** → 断言旧产物消失 + `dist/main.js` 仍在。反向验证过：把模板 build 里的清 dist 那一步摘掉 ⇒ `SMOKE FAIL: 重复构建后仍留着已删除能力的产物`（真跑过） | 生产入口按自身位置 discover `dist/<分类>/` ⇒ **删掉的能力继续被加载进菜单**（源码里找不到、进程里却能调；tarball 里的幽灵产物同理）—— 这一条不是清理癖，是行为正确性 |
| `packages/cli/test/templates.test.mjs` | **模板目录 ↔ CLI 源码双向引用**：模板目录里每个文件都被源码引用；`templates.ts` 的每个 accessor 都有**调用方**（除访问层本体）；每个 `renderTemplate` 路径真实存在 | 扫模板目录 + 读 `src/*.ts`（掐掉 import 语句后再判「有没有人调」—— `import { cleanMjs }` 也算名字出现过，放行它就等于放行「导入了但从不写」）。反向验证过：删掉 create 里那行 write ⇒ 红；删掉模板文件 ⇒ 红两条 | 模板写了却没被 `create` / `g` 写出去 ⇒ **生成的项目缺文件**（真发生过 2026-09-21：模板目录有 `packages/cli/templates/scripts/clean.mjs`、build 脚本引用它，`create` 忘了写 ⇒ 新工程 `npm run build` 第一步 MODULE_NOT_FOUND） |
| `scripts/verify-all.sh` 第 1 步 | lint 与类型检查折进同一条链（本地链 == CI 链） | Biome + `tsc` | 「本地 8/8 绿、CI 挂 Biome」（真发生过） |
| `packages/cli/test/dist-guard.mjs` | CLI 去类型移植副本与框架真源的**逐字对拍**不得静默跳过 | 产物缺失时 CI 判失败、本地醒目警告 | 对拍变成空断言（「逐字守护」名不副实） |
| CI `import-floor` job（`scripts/check-import-floor.mjs`） | 包在 Node 18/20 上可导入（`engines: >=18` 的声明） | CI 实跑导入 | 旧 Node 上整包加载即崩 |
| `packages/cli/test/panel-logic.test.mjs` | **面板逻辑可在 Node 里直测**（`panel-logic.ts` 零 DOM 引用），且各条口径逐条钉住：全选/空集 ⇒ `undefined`（`toolSources: []` 是收窄到**空菜单**的陷阱值）、收窄按**字典序**（不是点击序）、多轮初始值 = 所选能力声明的 **OR** 且带来源、**失败轮**靠 run 根的 `session.id` join 回对话流、**`runDoneNotice` 的判别顺序**（先 `stopReason` 后 `ok` —— 中止的 run `ok` 也是 false，反了就把「我按的中止」显示成「run 失败」）、**`nextSessionId` 的轮换与正则转义**。另含 watch 判据：`WATCH_EXT` 允许清单含 `.md`、`WATCH_SKIP` 排除 `dist`/`.agentia`（`shouldWatch` 与 `watchTree` 从 `dev.ts` 导出专供测试，`nextSessionId` 同理），其中**一条用例专测「启动之后才出现」的跳过目录**（`dist/` 与 `.agentia/` 各自一轮、中间等过去抖窗口 —— 不让 `flush` 只报第一条的合并掩盖被测行为），测的是 `watchTree` **自己的**契约「跳过判据对**初始递归**与**动态新增**两条路都成立」；另有 `watchRootEnvFiles`（**项目根**的 `.env` / `.env.local`）：改它必须回调，而项目根的 `README.md` / `package.json`（扩展名**都在** `WATCH_EXT` 里）必须被**名字过滤**挡掉。⚠️ 这两条都只测函数**自己的**契约 ——「调用点接上了没有」只能由 `e2e-dev` 真跑守（根是**调用点**决定的） | 面板 JS 抽成模块、单测 import `dist/` 产物；watch 用例起**真 tempdir** 写真文件（含新建子目录的动态纳入）。反向验证过：`nextSessionId` 改成不轮换 ⇒ 2 条红（`expected 'dev-2' actual 'dev'`）；去掉 base 的正则转义 ⇒ 红（`expected '.dev-2' actual '.dev-5'` —— 未转义时 `.` 变成「任意字符」，`Xdev` 会被当成 `dev` 的下一号）；把 `runDoneNotice` 的两个分支对调 ⇒ 红；把目录跳过判据**只留在初始递归那个调用点**（即摘掉本轮修复）⇒ 恰好那条红（`dist/ 是启动后才出现的跳过目录，里面的写入不该触发重启`），其余 15 条保持绿；把 `watchRootEnvFiles` 的**名字过滤**换成 `shouldWatch`（丢掉「只认名字」）⇒ 恰好那条红（`项目根的非 env 文件不该触发`），其余 16 条保持绿。**2026-09-22 复核这一轮又长四组**（都在同一份纯逻辑里，各带单测）：**在飞 trace 的折回**（`emptyTraceAccumulator` / `applyTraceEvent` / `partialTrace`：手写一段事件流与它对应的收尾 spans，断言「按 `seq` 折回 == 收尾的整棵 trace」—— 复刻框架 `tests/engine/trace-events.test.ts` 那条不变量；边界三条各有用例：`seq` 不前进即丢、指向未知 spanId 即丢、重复 `span.begin` 原地刷新不重复挂树）、**回复归属**（`replyBelongsTo`：同一条 trace 才保留）、**`浏览…` 的目标**（`browseTarget`：永远优先输入框里的值）、**选文件后的 prompt**（`promptAfterFilePick`：只在 prompt 为空时填）。反向验证过：把折回里 `span.end` 那支掐掉 ⇒ 红（`折回结果必须逐字等于收尾的 spans`） | 面板成为仓库里**唯一没有测试的复杂逻辑**（它已是这批工作里最大的一块，比 `dev.ts` 的进程管理还大）；`.md` 掉出允许清单 ⇒ 改 `system.md` **静默无感**（G3b 实测过）；`.agentia/` 进 watch 范围 ⇒ dev 环每轮往 `session.json` 写一次 ⇒ **每次 run 重启一次子进程**的自噬循环。⚠️ 但要说清**两层**：真跑时的第一层是**监视根**（`devServer` 只 `watchTree(<projectRoot>/src)`，而 `.agentia/` 与 `dist/` 在项目根、根本不在范围内），`WATCH_SKIP` 是**第二层**，防的是「哪天有人把根改成项目根」；两条路（初始递归 / 动态新增）都判才叫「判据成立」，只判一条叫「碰巧打不到」（见 §2 尾注 ⑤） |
| `packages/cli/test/markdown.test.mjs` | 面板的 Markdown **解析器**（`packages/cli/src/markdown.ts`，纯逻辑、零依赖）：块级六种（标题 / 围栏码 / 列表 / 引用 / 分隔线 / 段落）+ 行内四种（码 / 粗 / 斜 / 链接）逐条钉住；其中两条是**安全断言** —— ① 整棵树里只可能出现白名单里的 token 类型（`p`/`h`/`code`/`list`/`quote`/`hr`/`text`/`strong`/`em`/`link`），「HTML 透传」这一类一旦被加进来立刻红；② 不合法协议（`javascript:` / `data:` / 大小写变体）的链接**整条降级成字面文本**（含 `[]()` 一起显示 —— 使用者看得出「这里有个链接我没渲染」）。健壮性另有：空串 / `null` / CRLF / 光秃记号 / 50k 单行 / 1 万行围栏（防回溯爆炸，2 s 上限） | 直接 import **构造产物** `dist/markdown.js`（未构建则 skip 并响亮警告，与其它 CLI 测试同款）；用例里的 `flat()` 只压「类型 + 文本」，不钉 token 树的枝形（改内部结构不该红） | 面板要把**模型可控内容**当文档渲染 ⇒ 直接吃 XSS：`<script>` / `<img onerror>` / `javascript:` 链接都是模型输出。引第三方解析器 + 消毒器还会把两份**本仓单测验证不了**的产物塞进 dev 链路（与「零运行时依赖」的承诺直接冲突）。反向验证过**两条**：把 `isSafeHref` 放开成恒真 ⇒ 红（`整条降级成字面文本`）；让解析器产出一个非白名单 token 类型 ⇒ 红（`白名单外的 token`）—— ⚠️ 这个变异体必须用**双重断言**绕过 tsc（直接写 `type: 'html'` 会编译失败 ⇒ 门禁根本没跑到，第一版就空跑了一次） |
| `packages/cli/test/inspector.test.mjs`（dev 环 HTTP 面） | ① **鉴权**：`Origin` **缺失放行** / `Origin: null` **拒绝** / 跨源拒绝，per-session token 在**每个**端点生效、三种载体（`?t=` → `Set-Cookie` 带 `HttpOnly`+`SameSite=Strict` / `x-agentia-token` 头 / cookie）都验；② `POST /run` 的入参校验与**状态码透传**（409 在飞 / 400 目录不存在 / 500 兜底 —— 4xx 不得被吞成 500）；③ `/api/fs` 只列目录、跳过点目录、路径不存在时**响亮报错**；④ SSE 的 `dev` 命名事件与既有 run 汇总帧共存；⑤ `POST /run/abort`（没有 runner ⇒ 503、没在飞 ⇒ 钩子的 409 原样回、`escalated` 两态都 202 透传、**`GET` 不落钩子**）；⑥ `POST /session/clear`（503 / 409 / 200 + 新 id 透传）；⑦ **面板 import 名单的反向全覆盖** —— 页面 `import {...} from './panel-logic.js'` 里每个名字都必须是该模块的真导出 | 真 HTTP + 假钩子（本文件不知道子进程 / tsx / runner 的存在）；伪造 `Host`/`Origin` 一律走 `node:http` 的 `request` —— **fetch 把这两个列为禁改头、会静默丢掉**，用 fetch 写这组用例会**假绿**。⑦ 的机制是「从页面 HTML 里正则抠出 import 名单 → 逐名 `in mod`」：浏览器里 import 一个不存在的导出是**整块模块求值失败**（面板白屏），而 node 侧各用例各自 import 自己要用的名字，**照样全绿** | 未鉴权的本机进程能驱动 agent（任意 prompt × 任意工作目录 = 让 agent 读你整个盘）；面板把「你手快点了两下」显示成「服务器炸了」，真实原因被 500 掩掉；⑤⑥ 的路由若只写在面板里而不在服务端（或反之），点下去**看着像成功了**却什么都没发生 —— 反向验证过：把 `/run/abort` 改成「忽略钩子、一律报 202/不升级」⇒ 红；`/session/clear` 同理 ⇒ 红；⑦ 往页面 import 名单里塞一个不存在的名字 ⇒ 红（`panel-logic 必须导出「runDoneNoticeTypo」`）。**2026-09-22 复核这一轮又长三条**：⑧ `POST /ingest-event` 的入站校验（形状不合法 ⇒ 400、没有 dev 钩子 ⇒ 503）与**原样广播**（接到的就是 `traceEvent` 钩子收到的那个对象）；⑨ `/api/fs` 的**三组**返回（`dirs` / `dotDirs` / `files` + `filesTruncated` 明示截断，点文件名要能拿到它所在的目录）；⑩ 三条**接线**判据（抽进 `panel-logic` 了、页面必须真的走它：`!replyBelongsTo(` / `browseTarget(` / `promptAfterFilePick(` / `kind === 'trace-event'` / `applyTraceEvent(` / `state.live = null`）—— 抽出来不接上等于没抽，而浏览器里没人替你发现。**2026-09-22 第三轮（Markdown / 滚动 / 折叠）**：⑦ 的反向全覆盖从「只查 `panel-logic.js`」扩到**所有自建模块**（`panel-logic.js` + `markdown.js`：逐文件 `curl` 200 + 逐名 `in mod`），并新增四条**页面级不变量** —— ① 全页对 `innerHTML` 的**赋值**只准一处且必须是 `renderSummary(`（模型正文一个字节都不许进 innerHTML —— 这条比「某个变量名没出现」强得多）；② `body` 必须 `overflow: hidden`（整页不滚）；③ `#trace` 必须是那个滚动区；④ 窄屏必须有单列回退；另 ⑤ 被服务的 `markdown.js` 里不许出现 `document.` / `innerHTML`（解析器是纯逻辑，渲染不许塞进它）。反向验证过：把滚动分层的 `body` 改回 `overflow: visible` ⇒ 红（`整页不该滚`）；把正文渲染改成 `body.innerHTML = text` ⇒ 红（`innerHTML 的赋值只该有`） |
| `packages/cli/test/templates.test.mjs`（能力名一致性） | 模板里被装饰的方法名**就是模型看到的工具名** ⇒ 生成物必须统一 snake_case（占位符 `__METHOD_NAME__` 由 `kebabToSnake` 渲染，逐例断言；框架侧只**建议** snake_case、不强制，所以这条守的是本仓生成物的**自洽**） | 扫 `templates/**/*.ts` 的 `@Tool/@Skill/@SubAgent/@Prompt`：按**括号配平**（并跳过字符串字面量 —— 描述文案里一个孤立的 `(` 就再也配不平）跳过装饰器实参，再跳过注释读方法名；`seen >= 5` 防抽词器退化成空断言。反向验证过：`read_file` 改回 `readFile` ⇒ 恰好那条红（15/16 通过） | 同一份生成物里 `doc_reviewer` 与 `readFile` 混着来 ⇒ 使用者在 `dev.config.ts` 的 `multiTurn` 与面板的能力选择器里得先**猜**写法，猜错就是静默不生效（真发生过：本轮模板写成 `readFile`，模板单测全绿，是 `e2e-cli` 的整菜单断言抓出来的） |
| `scripts/e2e-dev.ts` | **`agentia dev` 整条链真跑**（此前**零覆盖**：`rg -ln "agentia dev\|dev-runner" scripts/*.ts` 返回空，`e2e-cli` 只断言了生成物 `package.json` 里有 `dev` 这个 script 名）。前四条都是**行为**断言：① 能力菜单非空且**精确等于** `["hello","read-file"]`（菜单是 runner 经 IPC 报回来的，父进程在 `ready` 前拿的是初值 `[]` ⇒ 非空才等于 IPC 通了）；② 一次 run 成功且 `finalText` 来自假端点；③ 收窄 `toolSources` 后**假端点收到的请求体真的变窄**（收窄前含 `read_file`、之后不含）；④ 改一个 `.md` 触发重启、且重启后能再跑通。另含鉴权边界（无 token ⇒ 403）与 `runner-ready` 广播。**⑤ 中止在飞 run**（第 10 步）：先让假端点**挂住不回复**（否则窗口只有几毫秒，测到的其实是 409 那条分支），再断言「在飞时 `running=true`」「在飞时第二次 `POST /run` ⇒ 409」「`POST /run/abort` ⇒ 202 且 `escalated=false`」「`run-done.stopReason === 'aborted'` 且**带 traceId**」「该 trace 真的出现在 run 列表里」「中止后 `running` 回 false **且 `lastError` 仍是 null**」。**⑥ 清空对话**（第 11 步）：`POST /session/clear` 换 id → 断言 id 已**落盘**且与 `/api/dev` 报的一致 → 再跑一次多轮 → 断言会话写进**新**那本账、**没写进**旧 id，且 `/api/session` 跟着新 id 走。**⑦ 重启次数总账**（第 12 步）：全程只该有 4 次重启（收窄 `toolSources` / 改 `.md` / **改项目根 `.env`** / 回到全量菜单），且每条理由都不得提到 `.agentia` 或 `dist/`。**⑧ 改项目根的 `.env`**（第 9-bis 步）：真改一次 `<工程根>/.env`，必须触发重启且理由里带 `.env` —— 守的是 `WATCH_NAMES` 这条判据的**可达性**（`shouldWatch` 的单测只证明它「认得」，证明不了「够得着」，见下）。**⑨ 实时右栏**（第 7-bis 步）：在飞期间必须真收到增量记账帧、且**先于** `run-done`；折回用的是 **CLI 自己的 `dist/panel-logic.js`**（不在这里重写一遍折回规则），折回的 spans 与 `/api/runs/:id` 的整棵 trace 必须 `isDeepStrictEqual`（要**等链路静默**再比：收尾那份被 await，逐笔那份是 fire-and-forget，最后几笔可能还在路上 —— 轮询到一致为止） | 起真 `agentia dev`（`node <cli> dev`，cwd = 生成工程）+ 本进程内的假 Anthropic 端点（`ANTHROPIC_BASE_URL`）+ SSE 收 `dev` 帧。**凭据只写进工程 `.env`，进程环境里显式 `delete` 掉 `ANTHROPIC_*`** —— 不删的话，本机 export 过 key 的人会拿到一条假绿。全程 `spawn` + await（假端点在本进程里，`spawnSync` 会死锁）；被挂住的响应由 `finally` 收掉（否则 `fake.close()` 的回调永不触发）；第 12 步要**等过「重启延后到 run 结束」的窗口**（`afterRun()` 紧跟在 run-done 之后）再数 | 这一整块（`dev.ts` / `dev-runner.ts` / `inspector-page.html`）重新变成没有守卫的最大块。反向验证过**六条**：`npx tsx` 塞回链路 ⇒ 红（`runner 装配失败："dev runner 退出（code=0）…"`）；把 `loadEnvFile()` 从 `app.ts` 摘掉 ⇒ 红（run 打到真端点、403）；去掉 `runner-ready` 广播 ⇒ 红（`等第 1 条 dev/runner-ready 超时`）；把 runner 的 `run-abort` 处理去掉 ⇒ 红（`escalated:true` —— 顺带证明 5 s 升级重启那条兜底真的在工作）；让 runner 把会话 id 写死 `'dev'` ⇒ 红（`实际 keys：["dev"]`）；把 `!ok` 判据恢复成不排除 `aborted` ⇒ 红（`实际 "run 已被取消"` —— 告警条上会永远挂一条红字）；**摘掉 `watchRootEnvFiles` 的接线**（`.env` 又变回一条够不着的判据）⇒ 红（`等第 4 条 dev/runner-restart 超时（只收到 3 条）` —— 帧转储里那次 `.env` 写入**一条事件都没有**）。⚠️ **第 12 步（重启总账）的反向验证是反例**：把 `WATCH_SKIP` 修复摘掉 ⇒ **e2e 照样绿** —— 不是断言错，而是这条缺陷在 e2e 里**不可达**（监视根是 `<projectRoot>/src`，而 `.agentia/` 在项目根）。所以第 12 步守的是「**监视根保持 `src/`**」，**不守**「`WATCH_SKIP` 判据完整」（后者由 `panel-logic.test.mjs` 的单测守）。两件事都值得守，但**必须说清哪条守哪件**。第 7-bis 步反向验证过：摘掉 runner 的 `onTraceEvent` 接线 ⇒ 红（`run 在飞期间应收到增量记账帧（trace-event），实际 0 条`） |
| `packages/cli/test/templates.test.mjs`（`.env` 接线**成对**断言） | `loadEnvFile()` 必须在 `app.ts` **且不在** `main.ts`（dev 环只 import app.ts、从不执行 main.ts）。同一条断言在 `scripts/e2e-cli.ts` 里也成对写（该在哪 + 不该在哪 —— 只写一半就还能被搬到错的一侧） | 锚**精确形态**（`^loadEnvFile\(\);$` 独立调用 + `import {...loadEnvFile...} from`）而不是裸标识符：`main.ts` 的报错文案里就有 `loadEnvFile()` 这个词，裸判会误红 | 搬错一侧 ⇒ `npm run dev` 静默读不到 `.env`、`npm start` 读得到；用户看到的是「没配 key」，然后去怀疑框架（真发生过：2026-09-22 拆分 app.ts/main.ts 时，而当时那条断言指着 `main.ts`，所以一路绿到真跑探针才发现） |

---

## 2. 待守（已知缺口 —— 下一次 review 从这里开始）

这些是**已经踩过、但还没有机器守卫**的形状。不是「都要立刻建守卫」，而是**改到相关代码时，
必须用手工清单核对**（见 `.github/PULL_REQUEST_TEMPLATE.md` 的自查问）。

| 待守形状 | 历史事故 | 为什么还没有守卫 | 可能的守卫形状 |
|---|---|---|---|
| **首屏 `0 反射` 这类策略声明** | —（尚未漂过） | 页面上写了「0 反射」（= 显式 DI，不用装饰器元数据反射），但源码里本来就有 `Reflect.ownKeys` 这类**正当**用法 ⇒ **无法从源码计数推导**。`api-page.test.ts` 只钉「别被悄悄删掉」 | 若要真守，得先能给出「反射式 DI」的可判定定义（例如「除 `Reflect.ownKeys` 外不得使用 `Reflect.*`，且不得读 `Symbol.metadata`」）—— 那是一条**可写的守卫**，但需要先确认这条口径值不值得当门禁 |

> 已在本轮补上守卫、从本表移入 §1 的：**成对实现对称**（`tests/integrations/adapter-parity.test.ts`）、
> **浅合并被 `null` 覆盖**（`anthropic.test.ts` 的 usage 用例）、**同步 vs 真实异步 store**
> （`tests/transport/async.test.ts` 的 `AsyncCopyStore`）、**解析器分支矩阵**（`tests/toolkit/env.test.ts`）、
> **`0` 被 `Math.floor` 压成 0 worker**（`tests/engine/concurrency.test.ts`）、
> **`exactOptionalPropertyTypes`**（本轮第七轮迁移，见 §1 与 spec §10 2026-09-18 ⑦）；
> 2026-09-21 双模型复核这一轮又移入 §1 四条：**OTLP enum 整数 + 200 partialSuccess**
> （`tests/integrations/otlp.test.ts`）、**CUMULATIVE 窗口起点随 reset 前移**
> （`tests/integrations/metrics.test.ts`）、**模板重建清 dist**（`scripts/e2e-cli.ts` 4d-bis）、
> **幂等键的进程内认领**（`tests/transport/async.test.ts` 那一行）。
> 2026-09-21 ⑧ 这一轮又移入三条（本表因此只剩一行）：**`0` 的语义真源**
> （`src/core/limits.ts` + `tests/limits.test.ts`，含伴随行「零/负/非有限值的语义统一」）、
> **穷尽转发**（`src/engine/forwarded.ts` + `tests/types/forwarding.types.ts`）、
> **队列消费者配方**（`tests/transport/queueConsumer.test.ts`）。
> 2026-09-22 ②（dev 调试环）又移入三条：**面板纯逻辑可测 + watch 允许清单**
> （`packages/cli/test/panel-logic.test.mjs`）、**dev 环鉴权与 HTTP 面**
> （`packages/cli/test/inspector.test.mjs`）、**生成物能力名一致性**
> （`packages/cli/test/templates.test.mjs` 的能力名用例）。本表**仍只剩一行**。
> 2026-09-22 ③（真跑探针抓出两个缺陷后）再移入两条：**`agentia dev` 整链真跑**
> （`scripts/e2e-dev.ts` —— 上面那三条都拦不住这次的两个缺陷，因为它们是**单元**面：
> 一个问「模板函数返回了什么」、一个拿假钩子测 HTTP，谁都不起真进程、谁都不 import
> 用户的 `app.ts`）与 **`.env` 接线成对断言**（`templates.test.mjs` / `e2e-cli.ts`）。
> 本表**仍只剩一行**。教训记在这里：**「门禁全绿」只覆盖门禁问过的形状** ——
> 本轮改动里最大的一块（dev 环）此前一条守卫都没有，而它一次真跑就露了两个洞。
> 2026-09-22 ④（拿功能文档逐项对照做审计后）**没有新移入 §1 的行**，而是把三条已有守卫
> **扩了面**（同一个文件、同一类断言，只是多了几条口径）：
> `panel-logic.test.mjs` 增 `nextSessionId` / `runDoneNotice`；`inspector.test.mjs` 增
> `POST /run/abort` · `POST /session/clear` · **面板 import 名单的反向全覆盖**；
> `scripts/e2e-dev.ts` 增第 10/11 步（真在飞的中止 + 清空后换账）。
> 这一轮真正的收获不是「又补了测试」，而是**同一条事实的第三个影子**：
> 中止的 run `ok` 是 `false`（引擎的 `abortedResult()` 刻意带结构化 error）——
> 于是面板的反馈语、`dev.ts` 的 `lastError`、终端的日志三处都把它当成了「失败」。
> 判别顺序因此被抽进 `panel-logic.ts` 并配单测（顺序是语义，不是渲染）。
> ⇒ 补一条可复用的自查问：**「一个值有几种写法」查完之后，还要查「它被几个地方各自判过一次」**。
> 2026-09-22 ⑤（追一次瞬时红 → 抓出 `WATCH_SKIP` **半实现**）**没有新移入 §1 的行**，而是把
> `panel-logic.test.mjs` 又扩了一条用例。事故形状：`watchTree` 的目录跳过判据此前只在
> **初始递归**那个调用点执行，watcher 回调里动态 `addDir` 那条路漏了 ⇒「启动时就存在的
> `dist/` 不看、**启动后才出现**的 `dist/` 看」。修法是把判据收进 `addDir` 内部（唯一一处），
> root 由调用方显式豁免（项目根本身叫 `dist` / `.foo` 是合法的，判据只看**目录名**）。
> **更值钱的是验证侧的教训**：我先给 e2e 加了一条「重启次数总账 + 理由里不许出现 `.agentia`」
> 的断言，反向验证时**单测红了、e2e 照样绿**。逐条排除三种解释（修复没生效 / 断言错 /
> **缺陷在这里不可达**）后落到第三种：`devServer` 的**监视根是 `<projectRoot>/src`**，
> 而 `.agentia/` 与 `dist/` 在**项目根**，从来不在范围内 ⇒ 那条 e2e 断言真正守的是
> 「**监视根保持 `src/`**」，它**碰不到** `WATCH_SKIP` 那条路。
> ⇒ **两件事都要守，但必须说清哪条守哪件** —— 否则下一个人看到「有 e2e 钉着」就以为
> 漏判被覆盖了。这正是本仓一直在猎的**假守卫**：断言是真的、绿的、也是对的，
> 只是它守的是**另一件事**。改法是把 dev.ts 的 `WATCH_SKIP` 注释改写成「**第二层**」、
> 把「第一层是监视根」写进注释，e2e 那段注释也照实写明它**抓不到**什么。
> ⇒ 补一条可复用的自查问：写完一条守卫，问「**它在什么形状下才可能红**」；
> 若答案里含一个当前架构下不可达的前提，它就不是这条修复的守卫 —— 要么换个能红的形状，
> 要么**改名**（说清它守的那件事）并注明它不守什么。
> 2026-09-22 ⑥（拿 ⑤ 那条「监视根是 `src/`」去核**每一条**判据 → 又照出一条）**没有新移入 §1
> 的行**，而是把 `panel-logic.test.mjs` 与 `e2e-dev.ts` 各再扩一条。
> 事故形状：`WATCH_NAMES = {'.env', '.env.local'}` 把这两份列进**允许清单**、`usage-guide`
> 也把 `.env` 写进「看什么」，但 `watchTree` 的根是 `<projectRoot>/src`，而 `.env` 在
> **项目根** ⇒ 这条判据**没有任何一个 watch 够得着**（改 `.env` 静默无感，与 G3b 同类；
> `dev.ts` 顶部那张结构图当时写的还是 `fs.watch(src/**, **.md)` —— 连图里都没有 `.env` 的位置）。
> 修法：单开 `watchRootEnvFiles(projectRoot, …)` —— **不递归**且**只认名字**；**不能**把
> `watchTree` 的根抬到项目根（那会让「改任何文档也重启」）。两处 watch 共用抽出来的
> `makeNotifier()` 去抖器。
> ⇒ 可复用的自查问：⑤ 查的是「判据有没有在**每条路**上执行」，⑥ 查的是「判据有没有
> **任何人**执行」—— **判据的正确性**（`shouldWatch` 有单测、写得也对）与**可达性**
> （调用点的根）是两件事，各要各的守卫：前者单测，后者**只能真跑**。
> ⚠️ 附带一条**探针自身**的教训：第一版探针用 `waitDev('runner-restart', …, 2)`（写死等第 3 帧），
> 而它前面已经有一条 `runner-restart`（回到全量菜单）⇒ **立刻拿到旧帧**，报错文案与
> 「`.env` 根本没触发」一模一样，差点据此下错结论。改成「先数当前帧数 N，再等第 N+1 帧」才分辨得开。
> ⇒ 断言「某事件发生了」时，**别用与事件总数耦合的绝对序号**：先取基线、再等增量。

> §2 的存在方式很重要：**它是活的**。每轮 review 挖到的形状，若暂时建不了守卫，就登记到这里；
> 建成了就移到 §1 并注明守卫位置。「未登记的形状」= 下次必然重犯。

---

## 附：`exactOptionalPropertyTypes` 迁移（2026-09-18 第七轮，已完成）

**它守什么**：`{foo: x}`（`x: T | undefined`）**不是**合法的 `foo?: T` —— 「不传这个键」与
「传了个 undefined」被区分开。`retry.ts` 的「显式 undefined 覆盖缺省」事故（重试被静默关闭、
退避算出 NaN）正是这条区分缺失造成的。开启后这类写法在**类型上就写不出来**。

**迁移规模（实测）**：39 处 `error TS`（TS2379 ×19 / TS2375 ×10 / TS2412 ×8 / TS2322 ×2），
分布 `transport/` 15、`engine/` 12、`runtime/` 5、`toolkit/` 4、`eval/` 1。

**采用的规则**（后来者照此办理，别反过来）：

| 类型角色 | 修法 | 例 |
|---|---|---|
| **结果/状态记录**（框架总是把字段写进对象字面量） | 必填 `T \| undefined` —— 字段在场、值可无 | `AgentRunResult` / `AgentLoopResult` / `RunMeta` / `RunHttpResponse` / `TurnOutcome` / `ToolEventIO` / `SpanDiff` |
| **内部管道**（缺省与显式 undefined 语义等价） | 可选 `?: T \| undefined`（缺省或显式都给） | `AgentLoopArgs` / `LoopContext` / `Job` / `Record` 类（`TaskRecord` / `RunSpec`）/ `BudgetGuardOptions` / `SseWriterOptions` / `CapabilityCall` |
| **公共入参**（`foo?: T` 的「不提供 = 用缺省」必须有意义） | **保持 `?: T` 不动**，在**调用点**处理：条件展开 `...(x !== undefined ? { x } : {})`，或集中 `omitUndefined({...})` | `RunAgentOptions` / `RunInvocationOptions` / `ExecuteRunOptions` / `RetryOptions` / 各 client options |

**`omitUndefined`**（`src/core/object.ts`）用于「一次转交十几个可能 undefined 的字段」的场景
（如 `AgentApp.run` → `executeRun`）：把 undefined 键摘掉，类型上就能安全赋给 `?: T`，
比十几处条件展开可读。**只过滤 undefined**（`null`/`0`/`''` 保留）。

**门禁**：`tests/architecture/tsconfig-strictness.test.ts` 钉住开关本身（关掉 = 39 条防线无声消失）。
反向验证：关掉开关 ⇒ 该测试红；且 `{maxAttempts: undefined}` 赋给 `RetryOptions` 立刻从
「编译错」变回「放行」（实测 ON=1 错 / OFF=0 错）。


---

## 附 B：两次复审的沉淀（2026-09-20 / 09-21）

原始复核散件已随本附录落盘即删除；此处只留**可复用的结论**，不留过程。

### B.1 「产物存在 ≠ 产物能跑」—— discover 必崩的五层失效分析（09-21，已闭环）

模板曾生成 `discover: ['src/tools', …]`（cwd 相对）：开发态被「cwd 恰好对 + tsx 恰好能吃
`.ts`」两个恰好掩住，生产态 `node dist/main.js` 去 import `.ts` 源码 ⇒ 装饰器不是可擦除
语法，必崩。**≤0.7.2 生成的所有工程带病。** 当时五层门禁逐层失效：

| 门禁 | 为什么抓不到 |
|---|---|
| CLI 单测 | 模板是字符串，不过编译器，对静态检查不可见 |
| e2e tsc 检查生成物 | `'src/tools'` 是合法 string —— 路径是数据，类型检查管不到运行时解析 |
| e2e 真构建 | 只断言「产物存在」，从未执行产物 |
| e2e 装配 + mock run | 测 discover 用的路径是测试脚本自己算的，模板那句有病的表达式根本没被执行 |
| examples e2e | 示例手写、不走脚手架模板 |

**根因一句话：被测形态 ≠ 发布形态，被测输入 ≠ 产物自己的代码。** 闭环（均为 #104/#105）：
e2e-cli 真跑 `dist/main.js` + AGENTS.md「承诺过的 script 必须真跑，且测产物要用产物自己的
输入」硬约定 + 模板从字符串升级为真文件（纳入 typecheck/lint 面）+ 「npm pack → 离线安装 →
装出来的包真跑最小 run」。

### B.2 覆盖率在本仓库的定位：棘轮，不是目标

- 棘轮门禁：`scripts/test-all.mjs`（c8：行 95 / 分支 88 / 函数 95，实测水位
  行 ~98.8 / 分支 ~91.7 / 函数 ~98.3 —— 阈值是防退化的下界，留 ~3pt 防抖余量，
  **别追 100%**；分支/函数曾从 85/92 抬到 88/95：余量 6pt+ 时删掉一整个模块的测试都不触发）。
- **为什么不追**：近几周所有真 bug（HITL×session 毒化、审批竞态、Windows spawn、discover
  必崩）都发生在 100% 覆盖的行上或 e2e/交互层面 —— 覆盖率量「执行过没有」，这个仓库的病
  是「执行了但不对」。追数字只会逼出「执行不断言」的凑数测试 = 真空变绿。
- **它的真实价值**：① 棘轮防退化；② 一次性死角审计 —— 09-21 那次审计靠它挖出两条
  「修复了但承重路径没测到」的真缺口（skill `onAbandoned` 超时收尾 / anthropic 超时链，已补）。
- **工具结论**：node 内建 reporter 的**逐行归属**在 tsx 下漂移（把 interface 声明标成
  未覆盖）不可信，分支 % 与 c8 互证一致（±2pt）可用；审计一律用 c8。工程坑：
  `NODE_OPTIONS='--import tsx'` 会泄漏进测试 spawn 的子进程 —— 覆盖率 flag 只能加在
  `test-all.mjs` 自己的 node 调用上，不可用环境变量注入。
- **刻意不设防清单（审计别再上报、别补测）**：`mcp.ts` 观测记账的 catch 吞错（设计如此）、
  `mcp-stdio.ts` 的 EPIPE 吞掉（次生现象）与 SIGKILL 的 catch（进程已死竞态）、以及所有
  「辅助动作不击穿主路径」的 catch 族。

### B.3 「纯结构拆分」复核清单（09-20，11 件拆分全忠实的核查法）

「搬运」类改动测试抓不住，必须看代码。六条高危点，按踩坑概率排序：

1. **被搬走的状态有没有别的读者** —— grep 旧文件全文，确认没有第二个读写点（拆分最容易
   出事的一类）。
2. **指标名 / 字符串字面量机械对拍**（多重集比对，不靠人眼）—— 静默丢一个指标 = 观测
   能力无声消失，测试几乎不可能发现。
3. **模块级可变状态有没有被复制成两份** —— 拆分特有的静默翻倍风险；闭包状态应收进一个
   实例、常量定义一次各处 import。
4. **循环 import 的 TDZ 风险** —— 被 import 的绑定只在函数体内引用则安全，顶层有读-写
   依赖则炸。
5. **参数化外移的值各调用点有没有传错** —— 方法变自由函数后，逐个调用点核对实参。
6. **旧侧用真实父提交（`git show <sha>^`），不用固定基线** —— 夹在中途的提交会造成假差异。

---

## 3. 守卫的写法（本仓库已验证有效的三条纪律）

1. **宁可窄，不要误报。** 守卫应当断言「**允许集合**」而非「禁止某个写法」（`layering.test.ts`
   的 `ALLOWED` 就是这个形状）。误报的门禁最终会被人加 ignore 关掉，等于没有。
2. **必须能反向证伪 —— 而且是逐条。** 守卫写完要**回退实现、确认它变红**再恢复（见 PR 模板自查第 5 条）。
   没做过反向验证的守卫，很可能是永远绿的空断言 —— 本仓库已有「真空变绿」的教训，
   `layering.test.ts` 的「解析计数下限」就是为它加的。
   ⚠️ **一个用例文件里 N 条承重断言要 N 次反向验证**（摘一处实现只证明一处会咬）：
   用一次性脚本跑**变异电池**（逐条改回坏版本 → 跑测试 → 还原并逐字复核源码），验收标准是
   **0 漏网**。`mcpConnector.test.ts` 的 9 条变异就是这么过的；只做「随便摘一处看它红」
   照样会漏掉一条永远绿的断言。
3. **失败信息必须能定位。** `assert` 消息里带**文件:行号**与修法（`layering.test.ts` /
   `transport-errors.test.ts` 都是这个形状），否则 CI 只留一个 exit 1。
