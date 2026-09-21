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
| `tests/integrations/adapter-parity.test.ts` | **同一契约的两条适配器必须对称**：同一 HTTP 状态在 anthropic / openai 上的 `{classifyError.type, retryable, 尝试次数}` 完全一致 | 一份场景表（408/409/429/500/503/400 + `retry-after` + `maxRetries:0`）`for (const a of ADAPTERS)` 跑两遍；替换 `globalThis.fetch` 作为两侧统一的注入面；`retry-after: 0` 让退避不真 sleep | 「同一个 429」在 anthropic 打 3 次网络请求、在 openai 打 1 次 —— 成本/延迟随厂商而异却没人发现（真发生过：openai 曾完全没有内层重试） |
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
| `tests/integrations/mcpConnector.test.ts` | MCP 连接器**三件只有它能做的事**：spawn 的 `'error'` 是异步事件必须接住 / stdout 必须按 `\n` 攒包 / **协议层 `isError: true` 必须转成抛错**；装配期超时；`close()` **返回即子进程已终止**、且 HTTP 侧 DELETE **挂死时也必须到点返回**（server 半开不得挂住停机路径）；StreamableHTTP 会话过期（`404`）**自愈且只重试一次**、并发 404 共享同一次重握手 | 起**真子进程**夹具（`tests/fixtures/mcp/fake-server.mjs`，env 覆盖 8 种模式，含忽略 SIGTERM 的 `stubborn` + pid 文件）+ HTTP 侧注入 `fetchImpl`；用例本身由 **15 条变异电池**证明会咬 | `isError` 不转抛错 ⇒ 失败的调用被**模型与 trace 一起**记成成功（正好打在本框架「trace 决定你敢不敢上线」的承诺上）；不接 `'error'` ⇒ 命令不存在时未捕获异常把宿主进程带崩；`close()` 不等 reap ⇒ 留孤儿进程；会话过期不自愈 ⇒ 长跑宿主只能重建连接器 |

### 1.3 宿主与耐久

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `scripts/e2e-deploy.ts` | 崩溃续跑：`SIGKILL` 后同库重启 `resumePending` 必须续跑 | 真起服务、真杀进程、同库重启、断言终态 | 「耐久」是句空话（在飞任务死半路无人接管） |
| `tests/transport/host-hardening.test.ts` | 鉴权拦在**读 body 之前**、body 上限、并发闸门、`exposeErrors` | 真 HTTP 请求 + 断言状态码与连接行为 | 未鉴权请求也会被读进 body；内部拓扑回吐给未鉴权调用方 |
| `tests/transport/async.test.ts` | 幂等键去重、`resumePending` 认领、迟到 reject 不改写终态 | 状态机级用例 | 同键任务重复执行；成功的 run 被落库失败覆写成 failed |
| `tests/engine/approval.test.ts` · `tests/transport/approval.test.ts` · `tests/transport/httpApproval.test.ts` | HITL 挂起/恢复（2026-09-19 ①）：未决审批 ⇒ **整回合零执行零 tool_result**（协议配平）；`awaiting_approval` 不占槽、不触发 `onFinished`、`resumePending` 不捡、淘汰跳过；`approve` 逐 id 幂等（第一次赢）+ 先落库再派发；惰性超时自动全拒；挂起段照常 flushSinks、恢复段 link 上一段 | 引擎层 mockClient + 宿主层**真引擎**（executeRun）+ 真 HTTP；含「不做什么」断言（onFinished 不开火、普通工具不提前执行） | 审批闸被绕过（副作用直接发生）；挂起被当终态通知 webhook；恢复丢决定/重复执行 |
| `scripts/e2e-grpc.ts` | **换宿主时最容易静默丢掉的四处语义**：deadline / 取消 → `signal`（要求服务端的 run **真被 abort**，trace 里 `error.type=aborted`，而不是照跑完）、metadata `traceparent` → run 根 link、同 `session_id` 两轮共享历史、同 `idempotency-key` 不重复执行 | 真构建 + 真起宿主（`PORT=0` 由服务自报端口，没有「探空闲端口再交出去」的抢占窗口）+ 用**示例自带的客户端**跑四个 RPC；模型侧假 Anthropic 端点、trace 落 tempdir（不留产物）；**变异电池 8/8 全部由对应断言抓住**（含一条「被抓住但不是被预期断言抓住」的更正记录，见 spec §10 2026-09-18 ⑪） | 客户端已经走了服务端还把 run 跑完（token 白烧）；跨进程链路在服务边界断掉；错误全塌成一个 UNKNOWN（调用方重试策略失效）；RPC 回了结果但「为什么慢 / 贵 / 失败」没有证据 |

### 1.4 文档与发布面

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/docs/usage-guide.test.ts` | `usage-guide.md` 的表格**逐项对源码核**（字段名/默认值/类型） | 解析文档 + 断言与源码一致 | 文档承诺了、代码没有（本仓库最主要的对外风险面） |
| `tests/docs/api-page.test.ts` | 官网 `api.html` 对导出面的**反向全覆盖**（每个导出都必须在页面出现）；以及**页面上所有手写数字**对源码核（`N 个导出` → `src/index.ts` 导出数、`N 个层次` → 页面 section 数、`N 个运行时依赖` → `package.json` 的 `dependencies` 数、`N 类能力` → 四个能力装饰器、`N 类触发` → 三个传输宿主） | 读导出清单 / 计数 + 扫页面文本（两个 fragment 的 chips 与首屏统计行都覆盖） | 新增导出在文档里缺席；「0 个运行时依赖」变成 1、加一类能力后页面继续写 4 —— 这类数字此前靠人眼改（`1 个运行时依赖 → 0 个` 真漂过） |
| `tests/docs/no-legacy-terms.test.ts` | 面向使用者的表面（文档 / 官网 / 包 README / CLI `--help` 与报错）不得出现旧伞形术语 | 文本扫描 + 允许标记块（有行数上限） | 一次改名漏扫几处，读者看到两套术语 |
| `tests/docs/run-output-shape.test.ts` | `run` 返回结构的文档形状与实际一致 | 扫描 + 断言 | 结构化结果的对外契约漂移 |
| `tests/scripts/release-scripts.test.ts` | `release.mjs bump` 的**每项替换计数断言**本身可靠 | 直接测护栏（护栏失灵会写坏整棵树，且发生在发版当天） | 一次 bump 把仓库写坏却没人拦 |
| `scripts/e2e-cli.ts` 第 8 步 | 两包 tarball 必须含 `CHANGELOG.md` | `npm pack --dry-run` 断言（临时 npm cache，不依赖宿主缓存健康） | 迁移指南写了但用户看不到（真发生过） |
| `scripts/verify-all.sh` 第 1 步 | lint 与类型检查折进同一条链（本地链 == CI 链） | Biome + `tsc` | 「本地 8/8 绿、CI 挂 Biome」（真发生过） |
| `packages/cli/test/dist-guard.mjs` | CLI 去类型移植副本与框架真源的**逐字对拍**不得静默跳过 | 产物缺失时 CI 判失败、本地醒目警告 | 对拍变成空断言（「逐字守护」名不副实） |
| CI `import-floor` job（`scripts/check-import-floor.mjs`） | 包在 Node 18/20 上可导入（`engines: >=18` 的声明） | CI 实跑导入 | 旧 Node 上整包加载即崩 |

---

## 2. 待守（已知缺口 —— 下一次 review 从这里开始）

这些是**已经踩过、但还没有机器守卫**的形状。不是「都要立刻建守卫」，而是**改到相关代码时，
必须用手工清单核对**（见 `.github/PULL_REQUEST_TEMPLATE.md` 的自查问）。

| 待守形状 | 历史事故 | 为什么还没有守卫 | 可能的守卫形状 |
|---|---|---|---|
| **`0` 的双重语义（不限 vs 已到点）** | `handler.drain({timeoutMs:1})` 跨过 deadline 后永不返回 | 已有单点用例（`host-hardening.test.ts`），但**没有**统一的「limits 语义对照表」——`mapWithConcurrency` / `drain` / `runTimeoutMs` / `maxIterations` 仍各自解释 `0` | 建一份「limits 语义」单一真源 + 集中用例（`limits.test.ts`） |
| **零/负/非有限值的语义统一** | 同上一行（`mapWithConcurrency` 已修，其余散在） | 分散在多个模块，无单一真源 | 同上，与上一行合并做 |
| **手写转发列表不得漏字段** | `runAgentScoped` 漏 `toolTimeoutMs`（跨 3 层：engine → toolkit → ctx） | `exactOptionalPropertyTypes` 已开（见 §1），堵住了「显式传 undefined」这一半；但**「spread 转发时漏掉一个键」TS 结构类型仍不报**（`{...opts}` 少了字段照样过） | 穷尽转发类型（把可转发字段抽成 `Pick<…, ForwardableKey>` 并要求逐项出现）；或改成显式 `omitUndefined({...})` + 一处集中清单 |
| **首屏 `0 反射` 这类策略声明** | —（尚未漂过） | 页面上写了「0 反射」（= 显式 DI，不用装饰器元数据反射），但源码里本来就有 `Reflect.ownKeys` 这类**正当**用法 ⇒ **无法从源码计数推导**。`api-page.test.ts` 只钉「别被悄悄删掉」 | 若要真守，得先能给出「反射式 DI」的可判定定义（例如「除 `Reflect.ownKeys` 外不得使用 `Reflect.*`，且不得读 `Symbol.metadata`」）—— 那是一条**可写的守卫**，但需要先确认这条口径值不值得当门禁 |
| **队列消费者（Kafka / RabbitMQ / SQS）配方没有门禁** | —（尚未漂过） | 它是**宿主侧的二十行样板**，框架侧没有可测的代码。配方真正依赖的两条地基已各有守卫（`runner.submit` + 幂等键 → `tests/transport/async.test.ts`；`traceContext` 随 `spec.options` 落库 → `tests/transport/http.test.ts`），但**配方本身**（消费者循环 + 提交位移的时机）没有任何 gate 真跑过 | 要守得起一个真 broker 或内存版 mock，成本不低；先如实标出。gRPC 那条同理，只是它已有 `scripts/e2e-grpc.ts` |

> 已在本轮补上守卫、从本表移入 §1 的：**成对实现对称**（`tests/integrations/adapter-parity.test.ts`）、
> **浅合并被 `null` 覆盖**（`anthropic.test.ts` 的 usage 用例）、**同步 vs 真实异步 store**
> （`tests/transport/async.test.ts` 的 `AsyncCopyStore`）、**解析器分支矩阵**（`tests/toolkit/env.test.ts`）、
> **`0` 被 `Math.floor` 压成 0 worker**（`tests/engine/concurrency.test.ts`）、
> **`exactOptionalPropertyTypes`**（本轮第七轮迁移，见 §1 与 spec §10 2026-09-18 ⑦）。

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
