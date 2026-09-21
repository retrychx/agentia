# Changelog

本仓库两包（`@migor/agentia` 与 `@migor/cli`）版本同步发布。
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 SemVer
（0.x 阶段：minor 可含破坏性变更，每个破坏性变更都在对应版本的「迁移」小节里写明）。
决策的完整证据链在 `docs/spec.md` §10（带时间线的决策日志）。

## [0.8.1] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.0 → 0.8.1`，含 #107–#110）：**出站链路传播** —— spec §9.2 那条
> 「出站传播仍开放」的项收口。**无破坏性变更**：只新增一个公开函数；既有 API、trace 形状、
> OTLP 导出值与 id 生成本身全部逐字不变（id 投影只是从 `integrations/otlp.ts` 的私有函数
> **上移到** `core/trace.ts` 成为单一真源，取值一字未改）。

### 新增

- **`currentTraceparent(): string | undefined`**（出站链路传播）：给出**当前调用期** span 的
  W3C `traceparent`（`00-<32位trace>-<16位span>-00`），自己带在出站请求上（`fetch` 头 / gRPC
  metadata）。下游若也是 agentia（或任何认 `traceparent` 的服务），就能把「谁触发了这次调用」
  关联到**具体 span**，而不是只到 run 粒度：

  ```ts
  import { currentTraceparent } from '@migor/agentia';

  const tp = currentTraceparent();
  await fetch(url, { headers: { ...(tp ? { traceparent: tp } : {}) } });
  ```

  粒度：普通工具与 `@Prompt` **不建 span**，取到的是发起它们的那次 `llm.turn`；`@Skill` /
  `@SubAgent` 方法体内取到的是自己的 `capability` span（内层覆盖外层）。入站那一半
  （`traceparent` 头 → run 根 `links`）已随 0.6.2 落地，本版把出站补上，跨服务关联从此双向。

### 已知边界（同时写进 `usage-guide` §7）

- **只给读取器，不替你做注入** —— 框架不创建出站请求，注入那一行是宿主的（与「webhook 用
  sink + 你自己的 `fetch`」同一条既有决策）。
- `run` 根 span 由 `runAgent` 打开 ⇒ 更早的 `contextInit` / 记忆水合取到 `undefined` —— 那时
  确实还没有 span 可指，不编造。
- flags 位恒 `00`：本框架不采样（每次 run 全量记账），不替下游声明「已采样」。
- id 宽度：内部 id 是 UUID，出站与 OTLP 共用**同一份**投影（trace 去横线 32-hex、span 截
  16-hex）⇒ 下游收到的 span id 与 collector 里那个**是同一个数**（各写一份会让同一次调用在
  两个系统里出现两个 span id）。

### 仓库自身（不面向使用者）

- 第七 / 第八轮复审散件沉淀进 `docs/guards.md` 附录 B，并立「多 agent 同仓作业」三条纪律
  （结论钉 commit / 门禁跑隔离导出树 / 不碰别人的未提交改动）。
- 出处链更正：spec §10 的「132 条直接用例」→ **127**（逐文件计数，独立复核不可复现 132），
  全仓口径改引「+140 条（`tests/` 增量）」；覆盖率棘轮分支 85→88 / 函数 92→95。
- 新增两条守卫并入册：id 投影**单源**（OTLP 与出站必须同一个数）、出站**调用期作用域**
  （并行不串 / 内层不外泄），两条都做过承重性反向验证。
- 发布面清单的 lock 项改为**按包名锚定**：裸 `"version"` 计数会被**恰好同版本号的第三方
  依赖**撞网（本次真发生：`@grpc/proto-loader` 恰好 @0.8.1 ⇒ 闸门报「4 处应为 0.8.1，实际
  命中 5 处」，读起来像漏项）。夹具同步加了同版本诱饵，断言它既不被替换、也不进网。

**迁移**：无。既有代码不需要任何改动；要开始用出站传播，就在出站请求上加一行 `traceparent`。

## [0.8.0] - 2026-09-21

### 变更

> 本版主题（窗口 `0.7.2 → 0.8.0`，含 #83–#105）：**CLI 机器可读面 + 脚手架生产路径修复**。
> 框架运行时 API 零变化；窗口内 23 个提交里 13 个是纯结构拆分（AsyncRunner / turn / loop /
> http 外移判定面，零行为变化），其余大多是仓库自身的门禁与测试加固。
> **一条必须看的修复**：用 ≤0.7.2 的 `agentia create` 生成过工程的，
> `npm run build && npm start` 一跑就崩（discover 目录是 cwd 相对写法，生产形态下会去加载
> `src/` 的 `.ts` 源码）。缺陷在**生成出来的工程里**，升级 CLI 不会自动修好已有工程 ——
> 迁移办法见下方「迁移」。

### 新增（CLI）

- **`agentia --version` / `-v`**：打印 CLI 版本（读包自身 `package.json`）。
- **`report` / `diff` / `doctor` 支持 `--json`**：stdout 只输出一个 JSON 文档，可直接进
  管道与 CI；出错仍走 stderr + 退出码 1，且 stdout 保持空。`harvest` 刻意不加
  （它的 stdout 本身就是产物）；`dev` 额外参数原样透传给用户脚本。
- **脚手架把 `@migor/cli` 写进生成工程的 devDependencies**（与框架同 `^` 版本），`dev`
  script 改为 `agentia dev`：`npx agentia …` 走本地 bin —— 离线可用，且版本被 pin 住与
  框架同批（不 pin 的话老工程会被 npx 拉到最新 CLI）。

### 修复

- **脚手架生成工程的 discover 目录按本文件位置解析，不再是 cwd 相对字符串**（本版最高
  优先级）：旧模板生成的工程 `npm run build && npm start` 必崩
  "Invalid or unexpected token"（生产形态下去加载 `src/` 的 `.ts` 源码，而装饰器不是
  可擦除语法），换个 cwd 启动连目录都找不到。**0.7.2 及之前所有版本生成的工程都带此
  缺陷。** 新写法按 `import.meta.url` 相对本文件解析（开发态 `src/`、构建后 `dist/` 都
  成立），并过滤不存在的分类目录（空分类 tsc 不产出 `dist/<分类>/`，「这类暂时没有能力」
  不该让启动失败）。

### 迁移

- **用 ≤0.7.2 的 `agentia create` 生成过工程的**：把工程 `src/main.ts` 的 discover 段
  换成新模板的写法（重新 `agentia create` 一个同名工程对照抄过来即可 —— 核心是目录按
  `new URL(d + '/', import.meta.url)` 解析 + `existsSync` 过滤这两处）。
  框架 API 本身无破坏性变更，`@migor/agentia` 与 `@migor/cli` 升到 `^0.8.0` 即可。

### 内部（不影响使用者）

- 纯结构拆分 13 件：AsyncRunner 五步（SlotPool / approval-policy / DrainGate /
  resume-policy / TaskWaiters）、`turn.ts` 四步、`loop.ts` 三步、`http.ts` 两步 ——
  判定面有名字、编排留在原处，零行为变化（#85–#100）。
- Biome 零告警闸门：93 warnings + 12 infos → 0，verify-all 第 1 步与 CI lint job 翻
  `--error-on-warnings`（#84）。
- 计时断言不再卡预算边界、改用单调时钟量（#102 / #103）。
- 覆盖率棘轮门禁（c8：行 95 / 分支 85 / 函数 92）+ e2e-cli 折入「npm pack → 离线安装 →
  装出来的包真跑最小 run」（#104）。
- CLI 模板从字符串升级为真文件（`packages/cli/templates/`，生成产物逐字节不变）（#105）。

## [0.7.2] - 2026-09-20

### 变更

> 本版主题（窗口 `0.7.1 → 0.7.2`，含 #77–#81）：**第九轮评审收口** —— 一条高优先级的
> **HITL × `sessionStore` 组合破口**（挂起任务恢复后历史翻倍、成功后又把坏会话写回去），
> 外加六条中/低优先级的静默失效修复；其余是纯结构重构、回归测试补课与依赖升级。
> **无破坏性变更，不需要改代码**：所有修复都是「旧行为本来就不该那样」。
> **两处错误归类收紧（记账口径，不是行为变更）**：Anthropic 流内 4xx 不再落成可重试的
> `server`，异步宿主的 `runTimeoutMs` 超时不再落 `unknown`。宿主若按 `error.type` /
> `errorKind` / `retryable` 分支（重试、告警、看板），取值会更准 —— 见下方两条。
> 本条目的多数内容**是在本次发版时回填的**：窗口内 5 个 PR 都没写 CHANGELOG，
> 条目按各提交正文重建。

### 修复（第九轮评审收口）

- **HITL × `sessionStore`：挂起任务恢复后会话历史翻倍 + 成功后毒化会话**（本版最高优先级）：
  恢复段曾把 session 再注入 `app.run`，而挂起段落库的 `suspendedMessages` 已含完整历史 ⇒
  run 层 `loadSession` 又 prepend 一遍（历史翻倍、token 复利）；且成功后 `appendSession`
  会把含未决 `tool_use` 的整段扩展历史写回会话 —— 该会话**下一轮直接撞 API 400**
  （孤立 `tool_use` + 连续 assistant）。现在恢复段不再注入 session，会话回写改由
  `AsyncRunner` 按「本轮用户输入 + 最终回复」补，口径与 `run.ts` 的三条不变量一致。
- **惰性审批超时 `#expireAndResume` 补重入闸 + 进闸后重读 store**：异步 store 下两个并发
  `poll` 各拿到一份 `awaiting` 副本 ⇒ 双双填超时拒绝、**双双派发**（同一任务跑两遍）。
  现在与 `approve` 共用同一把 per-taskId 在飞闸。
- **MCP StreamableHTTP 连接器不再丢弃 `abandoned`**：`tools/call` 把引擎的「放弃等待」
  信号透传到在飞 `fetch`（含会话 404 自愈那次重试）—— 裁判放弃后真能掐掉请求，
  而不是继续在后台烧。stdio 侧 #75 的 `pending` 出簿修复这次补上了回归用例。
- **Anthropic 流内 `error` 事件的 status 反推补 4xx 档**：`invalid_request_error` /
  `authentication_error` / `permission_error` / `not_found_error` → 400（归 `api`、
  **不可重试**），与 `openai.ts` 同口径。此前这些确定性病因落 500 + `retryable:true`，
  引擎会白重试 3 次（3 次网络请求 + 3 倍等待）。
- **异步宿主 `runTimeoutMs` 的超时错误不再落 `unknown`**：改用 `core/timeout.ts` 的
  `TimeoutError`（`code='timeout'`），与引擎工具超时 / MCP 桥兜底同口径。归类由
  `unknown`（`retryable:false`）变为 `timeout`（`retryable:true`）—— 这只是**记账口径**：
  超时按定义属可重试故障，框架**不会**因此自动重跑整个 run，要不要重试仍由宿主决定。
- **`FileTaskStore.save` 改为先落盘、成功后再更新内存**：落盘失败时内存不再推进，
  避免内存与磁盘两本账、重启后静默回退（`get` / `byIdempotency` 查不到未落盘的记录）。
- **Anthropic SSE 组装拦畸形 `content_block_start.index`**：超大 index（如 `1e9`）会造出
  稀疏数组、后续 `for...of` / `reduce` 按 `length` 空转；现在畸形 index（负数 / 非整数 /
  超上限）响亮抛 `AnthropicApiError(500)`。

### 重构（纯结构，零行为变化）

- `integrations/metrics.ts`（1050 行）→ `metrics-state.ts` / `metrics-render.ts` /
  `metrics-otlp.ts` / `metrics.ts`（只留选项校验、定时器与组装）；
  `integrations/mcp.ts`（897 行）→ `mcp-stdio.ts` / `mcp-http.ts` / `mcp.ts`
  （桥 + 共享 helper + re-export 两个连接器工厂）。**公共面与运行时行为不变**。

### 测试

- 补上 #75 遗留的回归用例：stdio MCP 连接器「裁判放弃等待 ⇒ `pending` 记账出簿」的防泄漏
  修复此前**没有任何用例守着**（夹具新增 `silentcall` 模式：握手 / `tools/list` 正常、
  `tools/call` 永不回包）。

### 依赖

- 开发依赖：`@anthropic-ai/sdk` → 0.126.0、`@biomejs/biome` → 2.5.14、
  `@types/node` → 26.6.1、`zod` → 4.6.5（均不影响运行时面）。
- 官网（不随包发布）：`astro` → 7.3.3。

## [0.7.1] - 2026-09-19

### 变更

> 本版主题（窗口 `0.7.0 → 0.7.1`，含 #71–#75）：**HITL 人工审批**（挂起 / 恢复、跨进程耐久）、
> **gRPC 宿主配方与可跑示例**，以及**连续四轮复审收口**（第八轮「时间维度」、外部四路复审、
> 外部复核的复核）。这批改动绝大多数是同一族病灶 —— **「不报错地不干活」**：超时不清簿记、
> 重试不排空响应体、非流式回落零校验、回调通道缺失、幂等键赢家跨重启易主、门禁被 `&&`
> 短路静默跳过。
> **两处使用者会遇到的行为变更**：① OpenAI 兼容端点返回 legacy `function_call` 形态时，
> 不再静默以 `end_turn` 收尾，而是抛 400（确定性不兼容 ⇒ 不重试），见下方
> 「legacy `function_call` 形态响亮失败」；② MCP / 预算护栏 / 异步宿主的若干语义收紧
> （会话过期自愈加互斥、`close()` 超时不挂死、未配 `sessionStore` 时 `submit` 响亮失败），
> **都不需要改代码**。
> **一处破坏性变更（仅类型面，运行时行为不变）**：`RecorderBackend` 新增必填成员 `usage()`；
> `BudgetGuard.check` 入参由 `Trace` 收窄为 `{ readonly totalUsage: Usage }` ——
> 迁移写法见本节末的「迁移」小节。

### 修复（外部四路复审收口：文档承诺了代码没做的事）

- **`AsyncRunner.approve` 补并发重入闸 + 真落库再派发**（HITL 补丁）：并发 approve
  （双击「批准」/两个审批人同时批）曾在 store 往返窗口内各自判「决定齐了」、
  **各派发一次**（同一任务重复执行）；且它用着吞错的 `#safeSave` 却在注释里承诺
  「先落库再派发」。现在并发调用共享在飞那次（第一次决定赢），落库失败 ⇒
  调用方收到 reject、**绝不派发**。
- **MCP StreamableHTTP 连接器：`tools/call` 不再起第二个计时器**（`timeoutMs` 只管
  装配期的握手/`tools/list`，与 stdio 侧对称；工具调用的裁判仍是引擎的
  `toolTimeoutMs`）。顺带修复：非 SSE 响应的 id 改为**等值配对**（原只验「id 是
  number」，串包时会把别的请求的结果当本次的返回）。
- **gRPC 示例 `getTask` 补 try/catch**：grpc-js 不接管 async handler 的 Promise，
  store 抛错会以 unhandledRejection 终止进程。
- **soak 脚本两处假绿**：采样不足时「跳过内存断言」却照打「内存有界」⇒ 采样间隔
  随时长缩放、样本不足硬失败；宽区间失败率断言换成**逐笔对账**（每个不可重试故障
  恰好杀死一个 run：`failed ≥ 注入数` 且超出部分 ≤ 请求的 0.1%）。
- 文档对齐：usage-guide 曾写同步 `/run` 返回「含 `suspendedMessages`」（响应体没有
  该字段）—— 改文档：要审批请走 `POST /tasks` 异步宿主。

### 修复（第八轮复审：时间维度的三处破口）

- **子 agent / skill 被 `toolTimeoutMs` 超时后，capability span 在交付的 trace 里永不收尾，
  且后台继续烧的 token 不进任何观测面**。新增 `ToolRunContext.abandoned`：引擎「放弃等待」
  时 abort 它 —— @SubAgent / @Skill 收到信号即中止子循环（在飞请求被掐掉），capability
  span 立刻以 `error`（`timeout`）收尾（trace 是浅拷交付的，等子循环自己 settle 再关
  就进不了已交付的那份）。自定义工具要「真停」同样监听它。
- **Scheduler 的 `at()` / `every()` 挡 32 位定时器溢出**：超过 2³¹-1ms（约 24.86 天）的
  延迟会被 Node **静默**钳到 1ms —— `at(30 天后)` 变成立即触发、`every(34 天)` 退化成
  每毫秒空转。现在构造期抛错（与 `runTimeoutMs` 同款防线）。
- **skill 方法体 `try/catch` 掉 `ctx.llm()` 失败并降级时，capability span 不再被误标
  error**（旧实现把「子运行失败」提前烙进 span，幂等守卫让整体成功的调用翻不了案）。

### 新增（HITL 人工审批：挂起/恢复，跨进程耐久）

- **审批 = 异步 tool_result**：`@Tool({ approval: 'required' })`（或裸 `AgentTool` 的 `approval`
  字段）声明后，模型每次调用该工具都会把任务**挂起**：run 状态变为 `awaiting_approval`，
  **整个回合一个工具都不执行**（回合级全有或全无 —— 协议要求每个 tool_use 配对 tool_result）；
  完整消息历史（末尾是含未决 tool_use 的 assistant 消息）与待决清单（`pendingApprovals`）
  随 `TaskRecord` 落库，进程重启不丢。
- **恢复**：`runner.approve(taskId, decisions, { decidedBy? })` 或
  `POST /tasks/:id/approve`（body `{ decisions: { <tool_use_id>: { approved, reason? } }, decidedBy? }`）。
  **逐 tool_use_id 幂等**（第一次决定赢）；决定齐了整个回合恢复执行：批准的工具正常执行
  （工具体内经 `ToolRunContext.approval` 读到决定），拒绝的得 `tool_result(is_error,
  '审批被拒绝：…')`（理由回给模型，可自行换路）。恢复后再遇未决审批 ⇒ 再次挂起（可等多轮）。
  引擎侧的恢复是**通用**的：任何「assistant 结尾带 tool_use」的消息历史喂给
  `runAgent` / `app.run` 都会先解决这些 tool_use 再调模型。
- **状态语义**：`awaiting_approval` 是**非终态**（`awaitTask` 继续等）、不占并发槽、
  不触发 `TaskSink.onFinished`、`resumePending` 不捡（它不是孤儿，是在等人）、
  InMemory 淘汰跳过、同幂等键重复 submit 返回等待中的任务。挂起段的 trace **照常投递
  sinks**；恢复段是一棵新树，经根 span 的 `links` 挂到上一段 runId。
- **审批超时兜底**：`new AsyncRunner(app, { approvalTimeoutMs })`（缺省 0 = 一直等）。
  **惰性判定、不起定时器**：`approve` / `poll` / `resumePending` 读到过期挂起任务时，
  自动把全部待决项写成「拒绝：审批超时」并恢复执行。
- 新公共面：`ApprovalDecision` 类型；`RunAgentOptions.approvals` / `RunInvocationOptions.approvals`；
  `AgentRunResult.suspendedMessages` / `pendingApprovals`（字段恒在场，未挂起为 `undefined`）；
  `AgentStopReason` 与 `RunStatus` 各增 `'awaiting_approval'`；`AsyncRunner.approve` /
  `approvalTimeoutMs`；trace 事件 `approval.requested` / `approval.decided`（带 waitedMs）。
- 已知边界（详见 usage-guide §7）：超时惰性判定；指标按段计；批准后崩溃 ⇒ at-least-once
  重执行；预算口径在恢复段重新起算；嵌套能力（子 agent / skill 子循环）内的审批工具
  不支持挂起整个 run；同步 `POST /run` 撞上审批会带 `awaiting_approval` 返回（要审批请走
  `/tasks`）。

### 修复（外部复核的复核 + 三条一致性缺口收口）

对上一轮「四路复审」的修复（31 个文件）逐条复核并实测通过；另补三条「守卫没覆盖自己
声称范围」的缺口与一处护栏开销：

- **MCP HTTP `close()` 的 DELETE 现在过 `guard`**：此前直接 `await fetchImpl(...)`，外层
  `catch` 只兜得住**抛错**、兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
  `close()` 就永久挂住，而调用方是**宿主停机路径**（挂住比失败更糟）。fetch 与 body 排空
  一起进 guard（只护住响应头，`readText` 照样能卡）。摘掉修复 ⇒ 新用例在 8s 测试预算下
  被 `cancelledByParent` 取消。
- **`asset()` 拦绝对路径**：守卫此前只拦带 scheme 的 `rel`，但 `/etc/passwd` 与
  `file:///etc/passwd` 是同一类（`new URL` 会把 base 的路径部分整个丢掉）——
  「以为读了能力目录里的文件，实际读了别处」（macOS 上**真能读到**）。`../` 仍放行
  （它是相对 base 解析的，base 没被忽略）。
- **预算护栏改走廉价 usage**：新增 `TraceRecorder.usage()`（只扫 spans 求和、不拷
  attributes/events），`snapshot().totalUsage` 改为调它 ⇒ 两条路不可能漂移。护栏每回合
  要判**两次**（回合入口 + 回合末，是不同决策点，**刻意不合并**），此前每次都全量
  `snapshot()` ⇒ O(回合 × 累计事件量) 的白拷。
- 测试基建：`mcpConnector` 的 stdio 握手缺省预算 5s → 20s（`node --test` 按文件并行，
  重负载下**子进程启动**本身就可能吃掉数秒；断超时行为的那条用例自带 `timeoutMs`）。
- 复核结论一条「查过但不改」：`interruptibleSleep(0, 已中止的 signal)` 仍 **resolve** ——
  它与 `withTimeout(p, 0)` 的「非正数 = 机制关掉」是同一口径，不是缺口（本轮曾误改，
  被既有用例拦下后回退；那条用例的断言已从隐式 `await` 改成显式 `assert.doesNotReject`
  并写明理由，见 spec §10 2026-09-19 ④）。

**迁移（自己实现这两个结构面时）**

- `BudgetGuard.check` 的入参由 `Trace` 收窄为 `{ readonly totalUsage: Usage }`。
  **传整份 `Trace` 的调用方不受影响**（结构上满足）；自己实现 `BudgetGuard` 的代码需把
  签名改宽，且**不得再读 `spans`**（类型上已读不到 —— 「只看 totalUsage」由注释变成约束）。
- `RecorderBackend` 新增必填成员 `usage(): Usage`。自己实现该结构面（或自建 recorder
  替身）的代码需补上。

### 新增（gRPC 宿主配方与可跑示例）

- **不对 Kafka / gRPC 做「服务包」**，但把真缺的那一块做成配方 + 可跑示例：gRPC 宿主必须
  自己接上的**四处**（deadline / 取消 → `signal`、`metadata` 的 `traceparent` → `traceContext`、
  框架错误 → gRPC 状态码、trace → sink），四处漏掉**都不报错**。判别规则只有一条 ——
  客户端是不是标准库（MCP 用 `spawn` + `fetch` 所以能内置，gRPC / Kafka 要引第三方客户端），
  决策见 spec §10 2026-09-18 ⑪。
- `docs/usage-guide.md` §6.2 新增「gRPC 宿主」配方；`examples/grpc-host/` 给了 proto + 宿主 +
  客户端 + README（一元 / 服务端流 / 异步投递 / 查任务，`PORT=0` 自报端口、无抢占窗口）；
  `scripts/e2e-grpc.ts` 真构建真起宿主、用它自带的客户端跑四个 RPC，并入 `npm run e2e` 第四步。

### 修复（OpenAI 兼容端点：legacy `function_call` 形态响亮失败）

- 兼容端点把工具调用放在 `message.function_call` 时，适配器只读 `tool_calls` ⇒ 此前落进
  `default: return 'end_turn'`，**模型要调的工具被丢掉、run 却以成功收尾**（模块头写的正是
  「上游故障绝不映射成成功」）。现在 `function_call` 抛 `OpenAICompatApiError(400)`：这是
  **确定性不兼容** ⇒ 落 `classifyError` 的 `api` / 不可重试（用 500 会被引擎重试三次，每次
  都重复丢弃同一个调用）；也**不做 legacy 兼容**——请求侧只发 `tool_calls`，回灌的
  `role:'tool'` legacy-only 端点同样吃不下，半吊子支持比不支持更糟。`default` 仍是有意的
  `end_turn`（未知值**且有正文**），并补 `eos_token` 用例把这个有意默认钉住，防后人顺手改成抛错。

## [0.7.0] - 2026-09-18

### 变更

> 本版两个主题：**MCP 连接器出厂自带**（新增公共 API：`createStdioMcpConnector` /
> `createStreamableHttpMcpConnector` / `McpConnector` / `MCP_CLOSE_GRACE_MS`），
> 以及一轮复审与「已知边界」收口。**两处行为变更，都不需要使用者改代码**：
> ① StreamableHTTP 会话过期从「抛错、需重建连接器」变成**自愈**（多了个可选的
> `onSessionExpired` 钩子）；② `close()` 从「到点即返回」变成「返回即子进程已终止」。
> **无破坏性变更** ⇒ 不需要迁移动作。

### 修复（MCP 连接器两条「已知边界」收掉）

- **StreamableHTTP 会话过期不再需要人工重建连接器**（`404` 自愈）。带会话 id 收到 `404` 的语义是
  「这个会话我不认识」⇒ **该请求没有被 server 执行** ⇒ 连接器丢会话、重新握手、把**这一次**重试一次
  （**只一次**，第二次再 404 直接抛，不循环）—— 这也是 MCP 规范对客户端的要求。
  此前按不可重试的 `api` 错抛出，长跑宿主的会话一过期就得**重建整个连接器**。
  自愈本身是静默的，所以给了 **`onSessionExpired`** 钩子：不挂它就没人知道恢复发生过 ——
  「静默恢复」和「静默失效」在监控上看不出区别。
- **`close()` 现在保证返回时子进程已终止**（stdio）。此前「到点即 resolve」：SIGTERM → 等
  `MCP_CLOSE_GRACE_MS` → SIGKILL **并立刻返回**，此刻子进程往往还在（未回收）—— 调用方以为
  进程没了，实际留下一个孤儿。现在 SIGKILL 之后**继续等真正的 `'exit'`**（SIGKILL 不可被捕获，
  该事件必达）。
- 验证：`tests/integrations/mcpConnector.test.ts` 27 → 31 例；
  **变异电池 6/6 全部被抓到、0 漏网**（删自愈分支 / 丢掉 `sessionId !== null` 前置 / 重试透传
  `allowReinit`（无限重试）/ 去掉 `onSessionExpired` / `close()` 恢复不等 reap / 夹具不再忽略
  SIGTERM ⇒ 证明那条用例真在测 SIGKILL 路径）。

### 修复（官网手写数字：补上真正没被守的那几个）

- `api.html` 的 `0 个运行时依赖` / `4 类能力` 与 `index.html` 首屏的 `4 类能力` / `0 个运行时依赖` /
  `3 类触发` **此前没有任何断言** —— 加一个运行时依赖、增删一类能力或触发宿主，页面会继续写旧数字
  而没人拦。现在逐条对源码核（`package.json` 的 `dependencies` 数 / 四个能力装饰器 / 三个传输宿主）。
  变异电池 3/3 会咬（改成 1 / 5 / 4 各判红一次）。
  ⚠️ 顺带**更正一处过度声明**：`210 个导出` 与 `9 个层次` **本来就有守卫**
  （`api-page.test.ts` 已有：前者对 `src/index.ts` 导出数、后者对页面 section 数）——
  它们从来不是缺口。首屏 `1:1 run ↔ trace`（真守卫在 `traceLink.test.ts`）与 `0 反射`
  （策略声明，无法从源码计数推导）**刻意不推导**，已在 `guards.md` §2「待守」登记。

### 新增（MCP 连接器**出厂自带**：stdio + StreamableHTTP）

- **`createStdioMcpConnector(cmd, opts?)`** / **`createStreamableHttpMcpConnector(url, opts?)`**
  —— MCP 的两种传输现在随框架发布。此前只有 `mcpTools()` 那条 duck-typed 桥，**连接器要自己写**：
  官方示例只有 `scripts/e2e-mcp.ts` 里一份 94 行的最小参考（还是内联在脚本里的私有副本）。
  公共面另加 `McpConnector`（`McpClientLike` + `close()`）与 `MCP_CLOSE_GRACE_MS`。
  **只用标准库**（`node:child_process` + 全局 `fetch`）⇒ 不新增任何第三方依赖，「零运行时依赖」不变；
  也**没有**放宽「第三方 SDK 对用户不可见」—— 一个 MCP SDK 都没 import，`McpClientLike` 这条缝原样保留
  （接官方 SDK / 远程 server / 自研传输照旧走它）。
- **本条反转了 2026-09-11 的 F7**（「连接器放独立可选包 `@migor/mcp`」）。那个包**从未发布**，
  而仓库里有 5 处注释把它当既成事实引用（含 `src/index.ts` 的公共面注释）—— 现在全部改正。
  为什么反：F7 的理由「守住零运行时依赖」不成立（该口径 = 不依赖**第三方包**；`spawn` / `fetch` 都是
  标准库），且 `store/` 的三层形状里「只用标准库的平台能力」一律内置（`FileTaskStore` / `SqliteTaskStore` /
  HTTP 宿主），独立包才是那个例外。完整论证与可逆性判据见 `docs/spec.md` §10 **2026-09-18 ⑨**。
- **连接器替你兜住三件只有它能做的事**（此前只活在 `scripts/e2e-mcp.ts` 那段内联副本里，无门禁守着）：
  ① spawn 失败的 `'error'` 是**异步事件**，不接住就是未捕获异常（真实宿主进程直接崩，没有 try/catch
  接得住）；② stdout 必须按 `\n` **攒包**（一条报文可能跨多个 chunk）；③ **协议层 `isError: true`
  转成抛错** —— 否则模型收到一条「成功」的结果、trace 也把这次失败的调用记成成功。
- **连接器的 `timeoutMs` 只管装配期**（握手 + `tools/list`）：那两步此前**没有任何裁判**，server 卡住会让
  `createApp` 永久挂起；`callTool` 的裁判仍是引擎 / 桥（延续「一次调用只有一个裁判」）。
- **已知边界**：StreamableHTTP 会话过期（带会话 id 收到 `404`）**不自动重握手**，按不可重试的 `api` 错抛出；
  `close()` 幂等且**有界**（SIGTERM → 2000 ms 后 SIGKILL），但**不保证等到子进程被 reap**。
- 验证：新增 `tests/integrations/mcpConnector.test.ts` 27 例（stdio 侧起**真子进程**）；
  **变异电池 9/9 全部被抓到、0 漏网**；`npm run e2e:mcp` 改为走出厂连接器后真第三方 server 全绿 ——
  此前那条端到端证明测的是它自己那份私有副本，现在测的是用户拿到的东西。

### 修复（第七轮复审收口：三处「不报错地不干活」）

- **Anthropic 适配器：流被截断 / 空流现在抛带 `status` 的错误**（`AnthropicApiError(500)`）。
  此前两处抛裸 `Error` ⇒ `classifyError` 判 `unknown` + `retryable:false`：上游故障被记成「模型的
  协议问题」（排障方向被带偏），且**引擎层重试一次都不会发生**。更糟的是「已吐出半句之后断流」——
  内容非空使旧判据（`!started`）不触发，`stop_reason: null` 落 `unknown_stop_reason`（同样不可重试）。
  现在按 openai 侧同款判据：**既无 `message_stop`、也无 `message_delta` 的 `stop_reason` ⇒ 抛 500 可重试**。
- **OpenAI 适配器：流内 error 分片的 status 反推分三档**（此前只把限流判 429、其余一律 500 + 可重试）。
  `invalid_request_error` / `context_length_exceeded` / `model_not_found` / 鉴权 / `content_filter` 这类
  **改配置才有救**的 4xx 病因现在判 400 且**不可重试**（此前白重试 3 次、trace 记成 `server` 而非 `api`）。
- **OpenAI 适配器：非流式路径的「200 + 空补全」不再记成成功**。`choices[0].message.content = null`
  + `finish_reason: 'stop'` 此前映射成「空文本 + end_turn」成功收尾，而同一响应在**流式**路径上会被判
  失败 —— 两条路径结论相反，且与模块头「上游故障绝不映射成成功」相反。`content_filter` 的合法空回复
  仍豁免（与流式同款例外）。
- **`AsyncRunner.resumePending` 补重入闸**：并发/重入调用现在**共享同一次扫描的结果**（返回在飞那个
  Promise，而不是谎报 0）。「先落库再派发」只堵住了**串行**重扫 —— 认领是异步的，两个并发调用都在任一
  `save` 落地前 `list()` 到旧快照，`ownerId` 过滤双双失效 ⇒ 同一任务被派发两次（副作用与花费翻倍）。
- **`metricsSink`：基数折叠在 `/metrics` 上可见** —— 新增 gauge 家族
  `agentia_dropped_keys{kind="capability"|"model"|"score"}`（Prometheus 与 OTLP 两侧都出，恒定发三个样本）。
  此前 `droppedCapabilities/Models/Scores` 只存在于 `snapshot()`，而文档让用户把 `metricsSink()` 接到
  `GET /metrics`（只消费 `render()`）⇒ Prometheus-only 的部署**完全看不见折叠发生**（静默丢失）；
  对照：同一份文件对「算不出成本的 turn」专门发了 `model_unpriced_turns_total`。
- **`metrics.ts` 的 OTLP 导出失败改抛 `MetricsExportError`（带数值 `status`）**：裸 `Error` 被判
  `unknown`，宿主在 `onExportError` 里拿不到 status，无法区分「collector 拒收（4xx，改配置）」与
  「collector 挂了（5xx，等它回来）」。

### 修复（守卫自身的洞 —— 本版主题是「把没门禁的约定收口」，而守卫自己有洞）

- **`tests/architecture/transport-errors.test.ts` 的注释剥离会瘫痪整份文件的扫描**（严重）：
  旧实现把每行「截到 `//` 为止」，而 `//` 会出现在**字符串里**（最典型是 URL）。截断会切掉该行闭合的
  `)` 与反引号 ⇒ `bareErrorThrows` 的括号配平一路吃到文件末尾 ⇒ **那一行之后的每一处抛错都再也扫不到、
  且全程不报错**。实测 `src/integrations/metrics.ts`：8 处裸抛错只剩 2 处可见，被吞掉的正好包括
  `OTLP metrics 导出失败: HTTP ${res.status}`（本守卫存在的理由）。改为「整行丢弃注释行」，
  并以合成样本复现该机制作回归钉（旧实现下会红）。
- `tests/docs/guards-registry.test.ts` 的**条目密度下限由 8 提到 24**（实测 32）：旧下限意味着删掉
  注册表 §1.1–§1.3 整整三节仍会绿 —— 防「抽词器退化」的护栏同时替「整节被删」放了行。

### 仍未做（如实标注，下一轮）

- `tests/integrations/adapter-parity.test.ts` 的矩阵**结构上测不到「缺省 `maxRetries` 对称」**：
  `make(maxRetries: number)` 是必填、所有场景都显式 `a.make(2)` ⇒ 把 openai 的缺省改成 0 仍全绿。
  而该矩阵被造出来正是为守这件事（修法：加一条走缺省的场景）。
- `maxToolConcurrency` 是否该随 `ToolRunContext` 透传给嵌套能力（`docs/guards.md` §2 已登记的
  「手写转发列表不得漏字段」形状，历史事故 = `runAgentScoped` 漏 `toolTimeoutMs`）—— 待口径判定：
  转发，或在 `types.ts` 注明「只作用本层循环」。

## [Unreleased]

## [0.6.3] - 2026-09-18

> 本版主题：把第六轮 16 条的共同根因（「约定写在文档里、但没有门禁」）收口 ——
> 守卫注册表 + 三个新架构守卫 + 适配器对拍矩阵；`exactOptionalPropertyTypes` 全量迁移；
> OpenAI 适配器补齐客户端内层重试（与 anthropic 对称）。**无破坏性变更**。

### 新增（守卫基建 + 适配器对齐）

- **守卫注册表 `docs/guards.md`**：「哪类危险由谁守」的单源清单（§1 已挂守卫 → 保护的
  不变量 → 退化后果；§2 待守缺口；§3 写法纪律），配套 PR 模板的「危险类自查 5 问」。
- **两个新架构守卫**：`tests/architecture/transport-errors.test.ts`（`integrations` 的
  传输抛错必须带数值 `status`，否则 `classifyError` 判 unknown、重试层静默失效 ——
  上线当天即抓到 `otlp.ts` 的同形漏网）与 `tests/architecture/tsconfig-strictness.test.ts`
  （`exactOptionalPropertyTypes` / `strict` / `types:["node"]` 三个承重开关不得被关）。
  另有元守卫 `tests/docs/guards-registry.test.ts` 防注册表本身腐化。
- **`OpenAIClientOptions.maxRetries`（缺省 2）**：OpenAI 适配器补齐**客户端内层重试**
  （408/409/429/5xx + `retry-after` 尊重，与 `createAnthropicClient` 逐字对齐）——
  此前同一个 429 在 anthropic 打 3 次网络请求、在 openai 只打 1 次（引擎层那一次）。
  对称性由 `tests/integrations/adapter-parity.test.ts` 守住（一份场景表跑两侧 + 跨侧
  对称断言）。
- **`exactOptionalPropertyTypes` 开启并完成迁移**（39 处 `error TS` 全清）：结果/状态
  记录改必填 `T | undefined`、内部管道 `?: T | undefined`、**公共入参签名不动**（调用点
  条件展开或 `omitUndefined`）。「显式 undefined ≠ 不传」从此是类型级约束 ——
  `retry: { maxAttempts: undefined }` 静默关重试这类写法在编译期就写不出来。

### 修复

- **`createOtlpExporter` 非 2xx 改抛 `OtlpExportError`**（带数值 `status`）：此前裸
  `Error` 会被 `classifyError` 判 `unknown` + 不可重试（与 OpenAI 适配器同形的病，
  由新守卫抓到）。

### 重构

- 两条适配器的 client 层退避（`backoffMs` / `interruptibleSleep`）单源收进
  `core/timeout.ts` —— 此前曾短暂存在 anthropic / openai 两份逐字副本；「不与引擎层
  `backoffDelay` 合并」的例外仍在（±25%+retry-after vs ±20%，策略不同）。

## [0.6.2] - 2026-09-18

> 本版主题：第六轮全量 review 收口 —— 16 条「不报错地不干活」修复（含两处**语义变更**，见下）、
> eval 分数进指标的 `beforeFlush` 时序缝、metrics 三维度基数封顶、trace 跨进程入站关联。
> **无破坏性变更**：两处语义变更（OpenAI 流式截断判据、MCP 桥对显式 `toolTimeoutMs: 0` 的裁判）
> 都是「此前错误的行为被改正」，正常用法不受影响。

### 修复（第六轮全量 review：「不报错地不干活」一次收口）

- **OpenAI 兼容端点的引擎重试此前整体失效**：非 2xx 抛的是裸 `Error`（无结构化 `status`），
  `classifyError` 一律归 `unknown + 不可重试` —— 兼容端点吃一个 429 就整轮 run 失败。
  现在抛 `OpenAICompatApiError`（带数值 `status`，与 `AnthropicApiError` 同形；module 级导出，
  不进公共面），429 → `rate_limit` 可重试；流内 `error` 分片（塞进 200 的流里的故障）按
  `type`/`code` 反推 status（`rate_limit` / `insufficient_quota` / `too_many` → 429）。
- **OpenAI 流式截断不再被记成成功**（**语义变更**）：终止判据从「累积为空」换成
  「既无 `[DONE]` 也无 `finish_reason` ⇒ 上游故障」—— 此前截断发生在已吐出半句之后时，
  半截输出被 `end_turn` 收尾上报。反向也对齐：正常终止但空的流若 `finish_reason=content_filter`
  不再误抛，与非流式路径同样记 `refusal`。
- **Anthropic 适配器的 usage 合并不再被显式 `null` 清零**：网关型端点的 `message_delta`
  带 `input_tokens: null` 时，浅合并会把 `message_start` 的真实计量抹掉，该回合 input/cache
  token 与 `costEstimate` 归零（`maxCostUsd` 护栏随之失效）。现在 `mergeUsage` 跳过
  `null`/`undefined` —— 缺值的语义是「保持已有值」，不是「清空已有值」。
- **`maxToolConcurrency` 的 (0,1) 小数不再静默丢弃全部工具**：`Math.floor(0.5) = 0` 曾意味着
  零 worker、工具一次都不执行。现在正数一律至少 1 个 worker；run 根快照记**生效的整数**
  （不限记 `'off'`，不再把 `NaN` / `-1` 写进 trace）。
- **`.env` 引号值 + 行内注释不再把字面引号写进值**：`A="sk-..." # prod` 曾被解析成含引号的
  `"sk-..."`（每个请求 401，文件看上去完全正确）。引号判定改为「扫到闭合引号为止，其后只允许
  空白或 `#` 注释」；未闭合 / 有残留回退未加引号分支，不猜。
- **`toolTimeoutMs` 现在透传给子 agent / skill 的子循环**：此前嵌套 run 里工具**永不超时**，
  且 MCP 桥找不到引擎预算会另起 60s 兜底 —— 双计时器 + 双账本。
- **MCP 桥裁判判据改为 `!= null`**（**语义变更**）：显式 `toolTimeoutMs: 0`（引擎表态「不限」）
  时桥不再自作主张判 60s —— 说了不限就该不限。
- **异步任务的崩溃恢复不再可能重复派发**：`resumePending` 认领时**先落库再派发** —— 此前认领
  只改内存，对 `list()` 返回反序列化新对象的 store（sqlite/redis），窗口内第二次扫描会把
  同进程正在跑的任务再派发一遍（重复执行、重复副作用、重复花费）。
- **优雅停机不再可能永不返回**：`handler.drain({ timeoutMs })` 在 deadline 已过时直接返回
  `false`，不再把「已到点」透传给 `0 = 不限` 的语义（SIGTERM 容器被强杀、在飞任务硬切）。
- **显式 `undefined` 不再覆盖重试缺省**：`{ maxAttempts: undefined }` 这类透传组装曾把重试
  静默关闭（快照记 0，像用户主动关的）/ 让退避算出 `NaN`。现在显式 `undefined` 回落缺省。
- **静态 `@Prompt` 不再被同名实例方法静默撞掉**：静态扫描改为按**解析后的菜单名**去重，
  实例↔静态真重名交给装配期抛「菜单能力重名」（对齐 spec §7「重名即抛」）。
- **`tool_use_no_blocks` 收尾现在带结构化 `error`**（`type:'agent_error'`）—— 此前该分支
  `status:'failed'` 但 `result.error` 是 `undefined`，HTTP body / 任务记录里看不出为什么失败。
- **`POST /tasks` 的 store 落库故障不再回 400 + 内部原文**：新增 `TaskInputError`（module 级，
  不进公共面）区分「调用方参数错」（400 + 原因）与「服务端故障」（500 + 走 `exposeErrors`
  策略）；读 body 期间开始停机的竞态回 503。
- **长上下文压缩不再切出孤儿 `tool_result`**：`compactMessages` 的切点校验换成「保留段工具
  自洽」—— 非相邻工具对（tool_use 与 tool_result 中间隔着普通消息）此前会切出孤儿块、下一次
  请求被 API 400；退无可退时照 `trimToolPairs` 先例整体放弃本次压缩。

### 新增（质量闭环收尾 + 指标基数封顶）

- **`beforeFlush(trace, result)`**（`RunAppOptions` / `ExecuteRunOptions`，可选）：sinks 冲刷
  **之前**的最后一笔 —— 「拿到 run 结果才判得出的结论」（典型是 `defineEval` 的 score）在这个
  时点挂上，`metricsSink` 才聚合得到。**此前 eval 的 score 挂在冲刷之后，永远进不了
  `agentia_score` 指标族**（usage-guide / roadmap 承诺的「eval → trace → 监控」链路是断的）。
  宿主漏透传该字段时 `defineEval` 退回「跑完再断言」：断言照做，不误报全挂，只是分数进不了指标。
- **`metricsSink` 三个维度的键空间都封顶**：新增 `maxModels`（缺省 50）/ `maxScores`（缺省 200），
  与 `maxCapabilities` 同口径 —— 超限键折叠进 `__other__`（**量不丢，只丢标签粒度**），
  snapshot 新增 `droppedModels` / `droppedScores`（各自最多记账 1024 个不同键，满了以后是下界）。
  此前 `models` / `scores` 无上限，与 usage-guide 承诺的内存上界不符。

### 重构（内部去重下沉 core，公共面不变）

- `sseLines` / `percentile` / `capabilityKindOf` / `textOf` / 可中断 `sleep` 各只剩一份
  （`src/core/{sse,stats,trace,text,timeout}.ts`）—— `integrations` 只准依赖 `core`，core 是让
  两处重复合一的唯一合法落点。`textOf(message, separator)` 三个调用点各传各的原值，行为零变化；
  两份 backoff（引擎 ±20% 均匀抖动 vs client ±25% 且尊重 `retry-after`）**刻意不合并** ——
  合并即改行为。

### 新增（trace 跨进程关联：`traceparent` → run 根 span links）

- **入站链路上下文**：`RunInvocationOptions.traceContext`（`{ traceId, spanId? }`）与 HTTP 请求头
  `traceparent`（W3C）现在会记成 run 根 span 的一条 **`links`**（新类型 `SpanLink`），
  `createOtlpExporter` 映射为 OTLP **span links** —— 于是「这条 run 是被谁触发的」在跨进程 / 跨服务
  时也可查。**不改 `traceId == runId` 的 1:1 不变量**：run 仍是自洽的一棵新树，上游是被**链接**
  而不是被**继承**成父 span（理由与取舍见 `docs/spec.md` §10 2026-09-17 ⑤）。
- 新增 `parseTraceparent(value)` 导出：把 `traceparent` 头解析成 `TraceContext`。
  **非法 / 缺失 / 版本 `ff` / 全零 id / 位宽不符一律返回 `undefined`**（不抛）——
  链路是观测行为，不该把业务请求打成 400。`createHttpHandler` 在 `POST /run` 与 `POST /tasks`
  上自动用它；`POST /tasks` 的 body 里显式给的 `options.traceContext` 优先于该头。
- **异步宿主零改动即继承**：`traceContext` 随 `spec.options` 落进 `TaskRecord`，所以另一个进程
  `resumePending` 续跑的那次 run 也带得上（队列消费者场景）。
- `TraceRecorder.addLink()` 记为公共能力；没记 link 的 span **没有 `links` 键**（不是空数组）。
- **已知边界（如实标注）**：只做**入站** —— 框架不生成出站 `traceparent`（运行中没有「当前 span」
  可导出，硬造会给出假 spanId）；link 只落 run 根，不自动跨进程传播（队列场景由调用方把
  `traceContext` 传下去）。

### 文档

- `docs/usage-guide.md`：新增「跨进程关联」小节（含队列消费者配方与「只做入站」的边界）、
  `app.run` 选项表补 `traceContext`、已知边界补一条；官网 API 页补 `TraceContext` / `SpanLink` /
  `parseTraceparent` 三行并把 `Span.links` 写进签名。

## [0.6.1] - 2026-09-17

### 文档（对外文案不再暴露内部流程；使用说明按用途重排）

> 随包发布的 `dist/AGENTS.md`（单源即 `docs/usage-guide.md`，也是 `agentia create` 写进新项目的
> 那份）一并更新 —— 装上本版即可看到，不必等下一次发版。

- **删掉讲本仓库自身流程的内容**：`§9 提交前自检`（它列的是本仓库门禁 —— `typecheck:tests` /
  `test` / `e2e` 三步链 —— 而脚手架生成的项目并没有这些 script，照抄必然失败）、前言里
  「文中 API 名由框架仓库的测试对着源码校验」句，以及散在正文里的内部路线图代号（`（R7）`）。
- **相对上一版的措辞改成陈述句**：「不再混进 connection」「不再静默映射成成功」这类只有用过旧版
  才读得懂的写法，改为直接陈述现状。
- **结构**：加顶层目录；「运行时 API」的 33 个子节按用途拆成六组（运行时上下文与装配 / 触发与宿主 /
  上下文预算与成本 / 观测与调优 / 集成 / 横切缝）；「框架只给缝、不建子系统」的口径集中到一处讲，
  不再逐个标题辩白。
- 官网（不随 npm 包发布）：API 页 `classifyError` 措辞、docs 页侧栏按用途分组、以及**滚到页面底部时
  末条导航不高亮**的修复。
- `@migor/trace-view`（不单独发布，随 CLI 构建期拷贝）README 补齐漏写的 `rawArg` 导出，
  并加一份「README 必须覆盖导出面」的守卫防再漏。


### 变更（超时有了自己的 `errorType`：`connection` → `timeout`）

- `classifyError` 对超时（内建 `DOMException('TimeoutError')` —— `AbortSignal.timeout()` 与默认 client 的
  超时合成信号；以及任何 `code === 'timeout'` 的错误）现在返回 **`type: 'timeout'`**，不再归进 `connection`。
  **`retryable` 保持 `true`** ⇒ **自动重试行为不变**（超时本来就是可重试故障）；变的是**记账**：
  按 `span.error.type` 分流的看板 / 告警会把超时类从 `connection` 挪到 `timeout`，`trace-diff` 比对旧 trace
  时超时会显示为「类型变了」。取证与决策见 `docs/spec.md` §10 2026-09-17 ②。
- 顺带把 `isTimeoutError` 的契约写清（三条判据，全鸭子类型）：框架 `TimeoutError` 实例 /
  `code === 'timeout'` / `name === 'TimeoutError'`；引擎的工具级 catch 用它 ⇒ 工具自判的超时与引擎判的
  超时记同一类账（`errorKind='timeout'`）。
- ⚠️ **更正**：此前一版说明里「模型调用超时在 `span.error` 上是 `type:'unknown'`（不可重试）」是**错的** ——
  它一直判 `connection` + 可重试（`engine/errors.ts` 的 `isConnectionError` 专门认 `name === 'TimeoutError'`）。
  该错误说明已从 `docs/spec.md` 删除，以 2026-09-17 ② 为准。

### 变更（MCP 超时单源化 —— 一次调用只有一个裁判）

- **原语单源**：`TIMED_OUT` / `withTimeout` 下沉到 `src/core/timeout.ts`，`engine/concurrency.ts`
  原样再导出（`import` 路径与名字对使用者与测试都不变）。MCP 桥的 `withDeadline` 改为它的**薄封装** ——
  此前桥自带一份**纯竞速**实现，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥能把**超预算**的
  MCP 调用记成成功（确定性可复现；取证与决策见 `docs/spec.md` §10 2026-09-17 ①）。
- **⚠️ 行为变更（迁移注意）**：引擎设了 `toolTimeoutMs` 时，`mcpTools({ timeoutMs })` **不再参与判定**
  （即使桥的 `timeoutMs` 更短）—— 一次调用只有一个裁判，此前「谁短谁生效」让同一件事在 trace 里
  落成两种账。要收紧某个 MCP server 的时限，请设 `toolTimeoutMs`（或把该工具单独包一层）。
  桥的 `timeoutMs`（缺省 `MCP_DEFAULT_TIMEOUT_MS` = 60000）只在「桥脱离引擎单用」或
  「引擎没设 `toolTimeoutMs`」时作为兜底，且兜底同样走**实测耗时**判定。
- **超时归一类账**：工具自判的超时（抛 `code === 'timeout'` 的错误，桥的兜底超时即是）从
  `errorKind='threw'` + `error(unknown)` 变为 `errorKind='timeout'` + `error(timeout): …`，
  与引擎判的超时同类、同样**不杀 run**。按 `errorKind` 分流看板的查询请知悉这一变化。

### 修复（第五轮 review：三条「功能静默失效」+ 一批边界）

- **`app.run` 丢掉 `signal`（取消全线失效）**：运行期入参是逐字段手抄进 `executeRun` 的，
  唯独漏了从 `RunInvocationOptions` 继承来的 `signal`（TS 不报错）。后果是**三处宿主与三份文档
  都假设的取消全都不生效**：HTTP 客户端断开不中止、`drain` 收口只关流不灭 run、
  `AsyncRunner.runTimeoutMs` 只 race 掉结果而在飞请求继续烧 token。已补上转发 +
  真 `AgentApp` 路径的回归用例（宿主侧测试用的是**假 app**，正好绕过了这一跳）。
- **OTLP 的 `spanId` 宽度错**（`otlp.ts`）：内部 UUID（32 hex）被原样当作 span id，
  而 OTLP 契约里 span id 是 8 字节（**16 hex**，trace id 才是 32）—— 真 collector 会判
  `invalid span_id` 拒收或截断。已按两种宽度分开转换。
- **OTLP 对能力 span 一条 `gen_ai.*` 都不发**：`genAiAttributes` 按 `span.name.startsWith('subagent:')`
  判类型，而生产代码写的是**裸能力名 + `attributes.subagent` / `skill`**（metrics / report /
  trace-view 三个消费者都读 attributes，只有这里读前缀）⇒ 子 agent 的 `gen_ai.agent.name`、
  skill 的 `gen_ai.tool.name` 在生产里从未发出。已改为读 attributes，并把测试夹具改成生产形状。
- **`gen_ai.evaluation.score.name` 不是 semconv 键**（真实 key 是 `gen_ai.evaluation.name`）——
  已修正并同步文档（实测 `@opentelemetry/semantic-conventions` 全量键名里无前者）。
- **`costEstimate` 命中原型链 → NaN**：模型名恰为 `constructor` / `toString` 时
  `pricing[model]` 拿到函数（真值）而 `.in` 为 undefined ⇒ 成本 NaN，`maxCostUsd` 的
  `NaN > x` 恒 false 而静默失效，NaN 还会进 trace / OTLP。改为 `Object.hasOwn` 查找。
- **`mcpTools` 两处**：外部 server 的 `description` 不是 string 时装配期崩 `TypeError`
  （同循环里 name / inputSchema 都有类型防御）；`mcp.tool` 单值 attribute 在同回合并行调多个
  MCP 工具时互相覆盖 ⇒ 新增 `mcp.tool.<菜单名>`，审计 / 回放不再丢原名。
- **`combineSignals` 同源重复时残留监听器**（去重后走单源快路径）；
  **`session.append` 展开传参的 12 万项 RangeError**（同 `replaceMessages` 已规避过的坑）；
  **`harvest` 把缺 `tool` 的事件回填成 `'unknown'`**（会在生成物里造出一个真的、且断言必然
  通过的工具调用 —— 骨架自我自洽、永不报错）与**注释行裸插 name / source**（含换行即破产物）；
  **`replay` 放行数组型 `tool_use.input`**（API 要求对象）。

### 新增

- **脚手架补齐生产构建链**：`agentia create` 生成的项目此前只有 `dev`/`typecheck`，没有
  打包工具（连模板自己的 .env 注释都引用了不存在的 `npm start`）。现在生成
  `build`（tsc → `dist/` + `scripts/copy-assets.mjs` 跟随拷贝 .md 文本资产）与
  `start`（`node dist/main.js`），tsconfig 带 `rootDir`/`outDir`；e2e-cli 新增 4d 步
  真跑这条链（emit + 资产拷贝 + dist 产物断言）。

### 修复（第四轮 review：文档面错到「照抄就坏」+ 边界条件）

- **`app.run` 支持 `memory`（新增选项，非破坏）**：官网手写页与单源指南一直用
  `app.run(messages, { memory })` 演示跨 run 记忆，但 `RunAppOptions` 里**没有**这个字段
  —— 照抄的代码 TS 直接报「对象字面量只能指定已知属性」，硬绕过去则运行期**静默不生效**
  （记忆从不水合、也不回写）。现在与 `session` 完全对称：`app.run` 也水合/回写，
  边界同样只在程序内（store 不可序列化，不进 transport 的 `RunInvocationOptions`）。
- **`compactMessages` 不再劈开「工具对在索引 0」的历史**：回退循环的 `cut > 1` 让它停在 1
  时，`tool_use` 被折进摘要、尾部留下**孤立 `tool_result`**（并与摘要构成连续两条 `user`）
  —— 正是该函数 docstring 明说不产出的两种形态，下一次请求会被 API 400 拒。
  现在回退到 1 仍落在 `tool_result` 上就**放弃本次压缩**（原样返回）。
- **`agentia create` 撞同名普通文件**：此前 `readdirSync` 抛原始 `ENOTDIR` 栈（栈里全是
  `node:fs` 内部帧），那句「目录已存在且非空」的友好文案根本轮不到；现在先判路径类型。
- **子命令 `--help`**：`agentia report --help` 此前把 `--help` 当文件名去读，报
  `读不到文件 --help（ENOENT）`；现在 8 个子命令都回自己的用法串（与 `fail()` 共用同一份常量）。
- **`agentia harvest --out` 默认不覆盖**：产物是「人工核对后再进 CI」的脚手架，重跑一次会
  静默抹掉你手改过的断言与 input；目标已存在时报错，要覆盖显式加 `--force`。
- **`agentia report` 缺 CLI 资源时的报错**：`dist/inspector/summary.js` 缺失时给出人话 +
  补救动作（此前是原始 `ERR_MODULE_NOT_FOUND`，路径全在 dist 内部，用户读不出该做什么）。
- **文档面形状**：官网 `docs.html` 与单源 `usage-guide.md` 的「出参护栏」示例读的是
  `out.finalText`，而 run 输出是 `{ run, result }` —— 判断恒为 `undefined`、**护栏恒不触发**，
  页面上却像在生效；改为 `out.result.finalText`，并新增定向守卫
  `tests/docs/run-output-shape.test.ts`（手写片段此前没有任何东西在编译它）。
  `tests/docs/api-page.test.ts` 的行匹配器同时放宽（`<tr class="…">` 此前整行静默跳过）。

### 修复（发布面与证据可核性）

- **CHANGELOG 进 npm 包**：npm 的「总是包含」只覆盖 README/LICENSE（实测 `npm pack` 不含
  CHANGELOG）——根包 `files` 登记 + CLI 包构建期拷贝到包根，`e2e-cli` 新增两包 pack 内容断言。
- **bump 闸门**：`check-release.mjs` 新增「要发的版本必须高于 npm 已发布版本」（查官方
  registry，E404 首发放行）——此前只验四处一致、不验高低。
- **code-review 证据签入**：真跑 trace 与报告落 `examples/code-review/evidence/`（此前 `out/`
  被 gitignore，README 的数字无从核）；README 表格数字全部改为可从产物复核的值。

## [0.6.0] - 2026-09-17

### 破坏性变更与迁移

- **公共消息类型自有化**：框架不再从 `@anthropic-ai/sdk` 导出/引用类型，`ModelClient` 契约、
  `RunAgentOptions.messages`、`traceToMessages` / `forkMessages` 的入出参等全部改用
  `@migor/agentia` 自有类型（`MessageParam` / `ContentBlockParam` / `Message` / `ToolParam` /
  `MessageUsage` 等 15 个，见 `src/core/message.ts`）。
  **迁移**：代码里写 `import type Anthropic from '@anthropic-ai/sdk'` 并标注
  `Anthropic.MessageParam` 的，改从 `'@migor/agentia'` import 同名类型（`Tool` → `ToolParam`、
  响应 usage → `MessageUsage`）。只传对象字面量（`{ role: 'user', content: '…' }`）的代码**无需改动**——
  自有类型与 SDK 结构兼容（有 `tests/types/message-compat.types.ts` 双向 assignability 门禁），
  SDK 类型的值可直接喂进来。
- **默认 client 自研化（fetch + SSE 手写，不再实例化 SDK）**：
  `AnthropicClientOptions` 的索引签名保留（旧代码编译不炸），但 SDK 构造参数**不再被消费**，
  只有 `apiKey` / `baseURL` / `maxRetries` / `timeout` 四个已知名生效，多余键静默忽略。
  module 级的 `splitSignal` 随 SDK 包装层删除（它从未进公共导出面）。
  **行为对齐 SDK 缺省**：重试 408/409/429/5xx、缺省 `maxRetries=2`、指数退避 + 抖动、尊重
  `retry-after`；`signal` 直传 fetch（中止语义不变）。
  **迁移**：依赖「SDK 特有的构造参数」（如 `authToken`、`defaultHeaders`）的，改用
  `baseURL` 指向网关或自带 `client`（`RunAgentOptions.client`，契约见 usage-guide「多模型」节）。
- **错误分类改鸭子类型**（`classifyError` 不再 `instanceof` SDK 错误类）：带数值 `status` 的
  错误按 HTTP 语义归类（429→rate_limit、5xx→server，可重试；其余 4xx→api 不可重试）。
  **已知边界**：使用者自装 SDK 并让它把 `APIConnectionError` 抛到引擎时，该错误无 status 可判，
  归类退化为 `unknown`（不可重试）——默认 client 不产生此类错误，仅影响自装 SDK 的场景。

### 新增

- **trace diff**：`diffTraces(a, b)` —— 两条 run 调用树的 A/B 比对（run 级 summary + 逐 span
  字段差；llm.turn 配对忽略模型名，capability 按 `kind:name`；缺省忽略墙钟）。
  CLI `agentia diff a.jsonl b.jsonl`（差异非空 exit 1，可进 CI 挡轨迹漂移）。
- **分叉重放**：`forkMessages(trace, { atTurn, append? })` —— 主循环第 N 回合前截断重放历史、
  拼新消息喂回 `app.run`（新 run，不是续跑；trace 不记 assistant 文本与原始输入）。
- **canCall 能力级能力边**：`@SubAgent` / `@Skill` 的 `tools` 在 provider token 之外接受
  `'token/能力名'` 路径（只引单个能力，装配期校验 + 可用名单报错）。
- **零运行时依赖达成**：`@anthropic-ai/sdk` 退出 dependencies（留 devDependencies 只为类型
  兼容门禁）；`npm i @migor/agentia` 不再连带任何运行时依赖。
- 官网文档站新增「场景指南」区（HTTP 服务上线 / 监控 / 离线评测与回流 / A/B / HITL）。
- **`examples/code-review/` 真实案例**：代码评审 agent 服务（四类能力 + 能力级 tools 路径 +
  预算护栏 + 自定义 file sink 产 trace.jsonl），离线 demo（scriptedClient）与真模型两种跑法；
  已用真端点实跑并在 README 记录真实 token/成本/trace 数据（验证证据）。

### 修复

- CLI Windows：`npmBin` 只加 `.cmd` 后缀在 CVE-2024-27980 后裸 spawn 必 EINVAL —— 改
  `npmSpawn`（cmd.exe 包装 + 逐参数脱敏，不用 `shell:true`）。
- CLI doctor 的 import 识别只认 default import（named/namespace/别名/跨行形态的悬空条目
  静默漏检）——已全形态支持。
- 脚手架模板纳入真 `tsc` 检查（e2e-cli 第 4 步）；CLI 对拍测试在产物缺失时不再静默跳过
  （CI 判失败，本地醒目横幅）。
- 引擎 `agentLoop` 拆分（433 行循环体 → 8 个有名字的函数 + `turn.ts` 独立成文件），纯重构
  零语义变更。
- 官网 playground 单价对齐框架内置价格表；正文链接色统一主题色。

## [0.5.0] - 2026-09-16

### 新增（R7 质量闭环）

- **score 一等公民**：`Score` + `attachScore`（评分挂 run 根 span 的 `score` 事件）；
  `defineEval` 结论自动落 score；metricsSink 聚合 `agentia_score` / `agentia_score_total` 指标族。
- **OTLP 对齐 OTel GenAI semconv v1.37**（additive 保留旧 `usage.*` 键；score 译
  `gen_ai.evaluation.result`）。
- `session.id` 提升为 trace 根属性（OTLP 映射 `gen_ai.conversation.id`）；
  `PromptSpec.version` → run 根 `prompts.versions`。
- **线上 trace 回流 eval**：CLI `agentia harvest <file.jsonl> [--failed] [--limit N] [--out]`。
- `examples/observability/grafana-dashboard.json` 随仓库发布。

## [0.4.2] - 2026-09-15

### 修复（发布后更正）

- `RedisTaskStore` 的 TTL 在 node-redis 上完全不生效（0.4.1 把 TTL 挪到 `SET` 位置参数，
  node-redis 只声明三个形参、多余参数被静默丢弃）—— `set` 只传两参，TTL 一律走
  `expire(key, seconds)`；设了 `ttlSeconds` 却没给 `expire` 时构造期抛错。
- `e2e-deploy` 端口 TOCTOU flake（`EADDRINUSE` 曾被误报为「示例进程启动即退出」）。

## [0.4.1] - 2026-09-15

### 修复（深度审查修复轮，40+ 处，无新公开 API）

- metricsSink 的 Prometheus 文本每个家族只发一次 HELP/TYPE（重复即整次 scrape 硬失败）。
- 预算护栏（`maxTotalTokens` / `maxCostUsd`）经 `ToolRunContext` 真透传到子 agent / skill 循环。
- CLI inspector：SSE 路径 `innerHTML` → `textContent`（XSS）+ Host 头校验。
- `drain` 强制关 SSE 现在真 abort 对应 run；示例 Dockerfile 补 `COPY docs`；新增
  `scripts/e2e-deploy.ts`（崩溃续跑验证）。

## [0.4.0] - 2026-09-14

### 新增

- trace 事件正文可展开：`maxEventChars` opt-in 开关（缺省截断值逐字不变，`false` = 不截断），
  CLI inspector 与官网 playground 两个宿主都真展开。

### 修复

- 默认 client 从不转发 `signal`（中止在飞 run 失效、超时 run 继续烧 token）——
  `splitSignal` 把 signal 搬到 SDK RequestOptions；门禁为本地假端点测试。
- `withTimeout` 收紧为硬保证（只看实测耗时）；截止计时器不得 `unref()`（四处）。
- CI 抖动根因修复（toolTiming 计时器赛跑改确定性形态）。

## [0.3.0] - 2026-09-14

### 新增

- `.env` 一等配置入口：显式 `loadEnvFile()`（框架不自动读），零依赖手写解析，真实环境变量
  优先；脚手架生成 `.env` / `.env.example` 并 gitignore。

## [0.2.2] - 2026-09-14

首个公开发布：`@migor/agentia` + `@migor/cli`（scope `@migor/*`），两包版本同步。
框架本体单包；CLI 独立成包（workspaces）。

[Unreleased]: https://github.com/retrychx/agentia/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/retrychx/agentia/releases/tag/v0.8.1
[0.8.0]: https://github.com/retrychx/agentia/releases/tag/v0.8.0
[0.7.2]: https://github.com/retrychx/agentia/releases/tag/v0.7.2
[0.7.1]: https://github.com/retrychx/agentia/releases/tag/v0.7.1
[0.7.0]: https://github.com/retrychx/agentia/releases/tag/v0.7.0
[0.6.3]: https://github.com/retrychx/agentia/releases/tag/v0.6.3
[0.6.2]: https://github.com/retrychx/agentia/releases/tag/v0.6.2
[0.6.1]: https://github.com/retrychx/agentia/releases/tag/v0.6.1
[0.6.0]: https://github.com/retrychx/agentia/releases/tag/v0.6.0
[0.5.0]: https://github.com/retrychx/agentia/releases/tag/v0.5.0
[0.4.2]: https://github.com/retrychx/agentia/releases/tag/v0.4.2
[0.4.1]: https://github.com/retrychx/agentia/releases/tag/v0.4.1
[0.4.0]: https://github.com/retrychx/agentia/releases/tag/v0.4.0
[0.3.0]: https://github.com/retrychx/agentia/releases/tag/v0.3.0
[0.2.2]: https://github.com/retrychx/agentia/releases/tag/v0.2.2
