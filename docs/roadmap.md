# Agentia —— Roadmap

状态：v0.2.1 已发布（`@migor/agentia` + `@migor/cli`），R1–R6 已全部落地；本轮完成全量评审修复 + `src/` 目录重构 + 官网响应式 + **官网迁移到 Astro 构建型静态站** + 分层守卫测试 + 官网正式化与动效 + **性能深度审计**（token 估算超线性 / SSE 背压 / `awaitTask` 事件化）（v0.2.2 待发布）。本文档记录规划与落地状态，后续方向见文末「R7 候选」。原文如下（各 R 标题后的 ✅ 为对应版本落地标记）。
与 `docs/spec.md`（已锁定决策）互补：spec 记录"已经怎么定的"，本文记录"接下来往哪走"。

## R1 —— 中间件（拦截器链）✅

**中间件是下一个大块的框架能力**，spec §9.2 已留伏笔（"对齐拦截器：每次能力调用包一层"）。

- **能力调用拦截器链**：`createApp({ middleware: [(call, next) => …] })`，在每次能力（tool/skill/subagent/prompt）
  调用前后执行。框架自带的 trace 记账从 engine 硬编码改写成第一个内置拦截器——
  既落地 spec §9.2 的设想，也用自己验证这套抽象（dogfooding）。
- 用户场景：鉴权（按 blackboard 拒绝调用）、限流（按能力计数）、结果缓存
  （幂等工具直接短路）、调用日志/审计、超时包装。
- 设计约束：链式 `next()` 语义；顺序 = 注册顺序；拦截器只见 `ToolRunContext` +
  能力描述，不碰 engine 内部；异步安全（ALS 上下文天然透传）。

## R2 —— 结构化结果 + 类型打通 ✅

- **typed 结果一等化**（spec §6.2 欠账）：run 收尾产出符合 schema 的结构化结果
  （走 `output_config.format` / 强制 tool 收尾），`result.typed<T>()` 取代纯文本猜解析。
- **schema ↔ TS 类型打通**：可选 zod 接入（`@Tool({ schema: z.object(...) })`，
  从 zod 推导 JSON Schema + 入参类型），裸 JSON Schema 写法保留；不改现有 API。

## R3 —— 宿主与传输 ✅

- **HTTP 宿主**：`createHttpHandler(app)` 一行接入任意 Node HTTP 框架（同步 RPC + 异步任务
  端点契约固化，与 AsyncRunner/FileTaskStore 语义一致）。
- **队列宿主**：TaskStore 的 Redis/SQLite 参考实现，验证"换宿主不换语义"跨进程成立
  （顺带解掉 FileTaskStore 单写者限制）。
- **OTLP 导出**：trace 接 OpenTelemetry 收集器（spec §9.3 生产方向）。

## R4 —— 多模型 + 记忆 ✅

- **provider 抽象**：engine 目前绑死 Anthropic SDK 的 stream 形态，抽一层
  `ModelClient`（stream/finalMessage 结构面，定义在 core，Anthropic SDK 天然满足），
  先适配 OpenAI 兼容端点（`createOpenAIClient`）；换 provider 靠**注入 client**，
  `AGENTIA_MODEL` 仍只管模型名（不做 `provider:model` 路由）。
- **跨 run 记忆**：blackboard 是 run 级；加可选的 `MemoryStore`（按 session/租户键控），
  run 启动时水合、结束时回写——明确"记忆是次级问题"的边界，只做键值与检索两个钩子。

## R5 —— 生态与体验 ✅

- **CLI**：`agentia dev`（watch + 热重装配）、`agentia add <pkg>`（第三方能力包安装
  并登记）、`agentia doctor`（装配体检：未登记 / 悬空能力 / 命名规范 / 重复条目）。
- **模块系统**：`defineModule` 能力包（能力 + providers + 拦截器打包分发），
  spec §4 草图的正式落地；property-injection 便利写法（spec §11 待定项）。
- **官网**：文档站（指南 + API 参考），从单页宣传站演进。

## R6（v0.2.0 已落地 ✅）

- 子 agent typed 结果（runAgentScoped 透传 resultSchema，子 agent 交回 `{ report, result }`）；
- RedisTaskStore（duck-typed RedisLike 客户端，TaskStore 接口放宽为 MaybePromise）；
- trace 重放基底（traceToMessages，spec §9.4 落地）；
- 文档站演进：docs.html + api.html（API 参考）；
- 真实 LLM playground：BYOK 模式（key 只存 localStorage，浏览器直连 Anthropic）。

## 评审修复轮（v0.2.2 待发布）

对 v0.2.1 做了一轮全量评审（三个子系统深读 + 官网审计 + 耦合图），结论：**主干质量高，问题全集中在佐助路径**——
落库失败会杀进程、记忆回写失败会毁掉成功的 run、子 agent 绕过鉴权、trace 重放在缺省模型上是 400。

- **`src/` 目录重构**：`run/` 按职责拆为 `runtime/` + `transport/` + `store/` + `integrations/`，
  `engine/context.ts` → `engine/trimming.ts`；`src/index.ts` 导出面逐字不变，与 §11 的包拆分方向对齐；
- **发布阻塞 7 条**：AsyncRunner 落库/槽位容错、`readBody` 限流与中断兜底、`traceToMessages` 末条补 user、
  `@Skill`/`@Prompt` override 动态查表、成功路径 memory 回写不翻 run 状态、OpenAI 兼容端点 `stop`+`tool_calls`；
- **新增公开选项**：HTTP 并发闸门（默认 32）+ body 上限 + `exposeErrors`、AsyncRunner 超时与
  `resumePending` 认领过滤（`ownerId`）、Redis TTL、Scheduler `maxInFlight`；
- **官网全面响应式**：窄机断点（≤420px）+ 汉堡导航，20 组「页面×宽度」零横向溢出；
- 许可证补齐 MIT；测试 142 → 182 例。

### 第二轮回评（并入 v0.2.2 未发布窗口）

第一轮修的缝里还有漏的，且新增一处安全缺陷：**子 agent 内部工具调用整体绕过中间件**（`tools` 引用解析的是中间件包装前的菜单）；
另有「同一函数内一防一漏」（`AsyncRunner` 订阅了 `save` 的 rejection 却丢弃 `byIdempotency` 的）、
异步落库迟到 reject 把成功 run 覆写成 failed、`submit_result` 校验未包 try（畸形 schema 掀翻整次 run）、
水合失败杀死 run（回写却有防护）、`totalUsage` 对 capability 聚合用量双算的口径矛盾、SQLite 只有 WAL 没有 busy_timeout、
`every(0)` 空转、Redis prefix 未转义 glob、`keepRecent` 在编辑与压缩间单位混用、`trimToolPairs` 对畸形历史切出孤立块、
容器重注册不传递失效、`discover` 覆盖显式 provider、OpenAI 空 `choices` 静默记成成功。全部修复，各带回归用例（190 → 210 例）。

- **安全**：嵌套能力 `tools` 引用改从中间件包装后的菜单解析（关闭 spec 记档的既知缺陷）；
- **正确性**：`submit_result` 校验入 try、水合失败不杀 run、迟到 reject 不覆写终态、空 `choices` 抛错；
- **契约**：`Trace.totalUsage` 只累加 `llm.turn`；`createBudgetPolicy.keepToolPairs` 与 `keepRecent` 解耦；
  `discover` 与显式 providers 同 token 时显式优先；`Container.register` 传递失效；`Scheduler.every` 拒绝非正有限数；
- **资源**：`FileTaskStore.compact()`、`InMemoryTaskStore({ maxRecords })`、`SqliteTaskStore` 补 `busy_timeout`；
- **文档**：删掉与代码不符的承诺（roadmap R1「静态校验补全」、spec §7 未实现的检查清单、CLI doctor 的 canCall 环、
  `ToolSpec.strict` 的合规要求、`AgentApp.container` 的「生命周期回调」）。

### DX 与 AI 可编码性（并入 v0.2.2 未发布窗口）

起因是一个真问题：**用框架时编辑器给不给级联提示**。实测（用类型系统把解析结果打进诊断）结论是
「框架 API 的补全没问题，但**你自定义的东西**没有类型链路」—— 黑板键是裸 `string`、`result.typed` 是 `unknown`、
schema 与方法签名双写且默认互不校验。这三点既是人「记不住 API」的原因，也是 AI 猜错 API 的根源。

- **类型链路**（详见 spec §10）：`Blackboard` 声明合并给黑板键补全 + 拼写检查；`fromZod<T>` 让 schema 成为单一事实
  来源并**校验方法签名**；`resultSchema` 自动推导 `typed`。三条都是**可选开启**，不声明则与旧行为逐字一致。
- **顺带修**：`FactoryProvider.useFactory` 的形参逆变 bug（`unknown[]` → `never[]`）—— 旧写法连框架自带测试里
  那种正常工厂都编译不过；`app.run` 补上 `resultSchema`（此前根本传不了结构化结果 schema）。
- **AI 可编码性**：`docs/usage-guide.md` 作为**使用者向唯一说明**，三处消费 —— CLI 脚手架写进新项目的 `AGENTS.md`
  （Claude Code / Cursor / Copilot 会自动读）、官网 `/llms-full.txt` 与 `/llms.txt`、人类速查。
- **验证基建**：`tests/docs/usage-guide.test.ts` 把说明里的表格**逐项对源码核**（改名即失败，防「文档承诺了、代码没有」）；
  新增 `typecheck:tests`（此前**测试目录从未被类型检查**，首跑 50 个错误已全修）与 `typecheck:types`
  （`@ts-expect-error` 断言「应当报错」的场景真报错，针对构建产物 dist 编译）。测试 210 → 215 例。

## Dev Inspector（本地调试面板）✅ 已落地

`agentia dev` 内置本地 inspector：左栏 run 列表 + 右栏调用树，展示每个能力（tool/skill/prompt/subagent）
的入参 / 出参 / 耗时 / token / cache / 错误状态（环形缓冲最近 50 条）。

- **框架**：trace 出口缝 `TraceSink` + `AppOptions.sinks` + `registerDefaultTraceSink()`（构造期快照合并）；
  run 成功 / 失败两条路径均投递，sink 抛错吞掉不影响 run。`createOtlpExporter()` 返回值天然满足该接口。
- **共享渲染器** `@migor/trace-view`（零依赖 ESM）：`createTraceView` + `playTrace(真实 Trace)`；
  官网 playground 与 CLI 面板共用同一份 —— **官网自此不再维护第二套渲染**（原 680 行的 playground.js
  收敛到 517 行）。
- **dev 注入**：CLI 侧 `NODE_OPTIONS=--import` preload，从用户项目解析框架并注册 sink；
  **框架不读 env、不含 dev 逻辑**。
- 四项测试基线与验证：框架 190 + trace-view 6 + CLI 3 例；真浏览器实测（本地面板 + 线上 playground）。
- 计划见 `docs/plans/2026-09-11-dev-inspector.md`。

## Agent 服务能力补全（四期）✅ 全部落地

设计见 `docs/plans/2026-09-11-agent-service-hardening.md`（四期 8 个分叉全部按建议 A 拍板）。

- **Phase A（稳定性）** ✅ 取消传播（`AbortSignal` 贯穿到模型请求）/ 重试退避（缺省开启）/ SSE 流式下发。
- **Phase B（宿主硬化）** ✅ 鉴权缝（拦在入口、读 body 之前）/ 优雅停机 `drain()` / `GET /healthz`。
- **Phase C（能力成色）** ✅ 成本硬管控 / 工具超时 + 并发闸门 / OpenAI 真流式 + 多模态 / 会话持久化 / 完成回调。
- **Phase D（生态）** ✅ MCP 桥（duck-typed，框架零依赖；接入点是 `AppOptions.tools` 裸工具缝）/
  evals（`scriptedClient` + `defineEval`）/ 指标（`metricsSink`，天然满足 `TraceSink`，零新出口）/
  提示词版本化 + 多租户配额范式（组合既有缝，不做子系统）。
  真端到端证明 = `npm run e2e:mcp`：真接第三方 MCP server（`uvx mcp-server-time`）走完「映射 → 菜单 → run」，
  无网机器自动回落 `scripts/mcp-fixture-server.py`。

## 可观测 · 可调优（E / F / G 三期）✅ 全部落地（2026-09-13）

设计见 `docs/plans/2026-09-13-observability-tunability.md`（8 个设计分叉全部按建议 A 拍板，落地时的四处修正见 spec §10）。
起因：观测当时只到 **run 级**，答不出「哪个能力慢/贵/爱失败」；调优旋钮虽齐，却有**两处「看着有、实际不生效」**。

- **E 观测下沉** ✅ E1 工具级时序（`tool.output` 事件补 `durationMs` / `errorKind`，普通工具仍不建 span）/
  E2 能力级指标（per-capability 调用数、失败数、耗时、token、成本；`labelMode` + `maxCapabilities` 防标签爆炸）/
  E3 模型级指标（按模型归因；`model_unpriced_turns_total` 显式暴露"成本算不出来"）/
  E4 Prometheus 原生 histogram（可跨实例聚合）+ 窗口精确分位并存 / E5 OTLP metrics 导出（零依赖手写 JSON，`flush()` / `intervalMs`）。
- **F 成本可调优** ✅ F1 价格表可注入（`priceOverrides` + `buildPricing`，**透传进子循环**）/
  F2 未定价模型显式（`usage.unpriced` 事件 + `onUnpricedModel` 回调 + 指标，**不改变 run 结局**）/ F3 成本归因。
- **G 调优闭环** ✅ G1 `buildRunReport` / `mergeRunReports` / `renderRunReport` + CLI `agentia report <trace.jsonl>` /
  G2 `@migor/trace-view` 能力排行（`summarizeTrace` / `renderSummary`）接进 `agentia dev` 面板 /
  G3 run 根 `config.*` 生效配置快照 / G4 `createHttpHandler({ metrics })` 内建 `GET /metrics`。
- **顺带修的 doc-vs-code 漂移**：`core/trace.ts` 声明已久的「`capability.usage` = 子孙 `llm.turn` 聚合」此前**从未写入** ——
  已在 `TraceRecorder.end()` 补上，能力级 token/成本才有数据来源。
- 测试：框架 414 → 462，CLI 6 → 13，trace-view 6 → 10。

## 目录约定去伞形词（四类分置）✅ 落地（2026-09-13）

设计见 `docs/plans/2026-09-13-typed-unit-dirs.md`（6 个分叉：F1=A · F4=B · 其余 A · F6=A+B）。决策记录见 spec §10。
起因：`agentia create` 产出的 `units/` 被指出「命名不太好」—— 核实后发现仓库里**同时跑着两套目录约定**且无验证覆盖，
外加脚手架 tsconfig **漏 include 能力目录**（未登记的能力静默不参与类型检查）。

- **① 四分类目录，放 `src/` 下** ✅ `src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/` —— 目录名就是类型
  （对齐 MCP / OpenAI Agents SDK / LangChain 的惯例：不用伞形词）；注册表改 `src/registry.ts`。副作用是三处漂移一次自愈：
  示例的 `rootDir:"src"` 不用动、脚手架 `include` 收缩为 `['src']`、示例与新约定自动一致。`create` 建出四目录（`.gitkeep`）。
- **② `discover` 放宽为 `string | string[]`** ✅ 数组顺序即装配顺序；任一路径不存在报错；跨目录重名 token 发现期告警 +
  `g` 生成期拦截 + `doctor` 报错兜底。
- **③ 伞形术语整体替换为 `capability`** ✅ 类型 / 字段 / 指标名 / `unit=` 标签 / **trace span kind** / trace-view 前缀；
  中文「单元」改称「能力」（与既有「能力包」同族）。运行时零破坏，刻意破坏的只有观测面命名（已逐条列进 spec §10）。
- 测试：框架 462 → **468**（+6：`discover` 数组 / 跨目录重名 3 条 + 术语守卫 `no-legacy-terms` 3 条），
  CLI 13 → **20**（+7：跨目录同名体检 + 目录约定守卫 + 老布局迁移提示），trace-view 10（仅改名，无新增）。

## 示例真跑纳入门禁 ✅ 落地（2026-09-14）

起因：`examples/complete` 被 usage-guide 与项目 README 指着说「完整可跑写法见这里」，但它此前只被
`typecheck:tests` 覆盖 —— **全仓没有一条脚本执行过它**（`examples/` 下 0 个测试）。

- **`scripts/e2e-examples.ts`** ✅ 并入 `npm run e2e`（第二步），另有 `npm run e2e:examples` 单跑。
  按示例**自己的构建脚本**真构建 → `node dist/main.js` 真起服务 → 按它 README 逐条打端点：
  `/healthz` · 无凭据 401（鉴权缝）· 同步 `/run` · SSE 流式 · 异步 `/tasks` + 幂等键去重 + 轮询终态 ·
  `/metrics`（含能力级非零样本）· SIGTERM 优雅停机（断言 exit 0 + 排空日志）。
- **不联网、不需要 key**：模型侧是脚本内置的假 OpenAI 兼容端点（真 SSE；`tool_calls` 的 `arguments`
  **拆两片**下发，顺带把框架的分片累积逻辑放进真实链路跑一遍）。
- **断言的关键不在响应文本**：假端点必须**真的收到 `echo: ping` 这条 tool_result** —— 证明四类能力
  （`echo` / `house_style` / `outline_writer` / `researcher`）真装配进菜单且能力真被执行过。
- 顺带修掉两个会骗人的坑（详见 spec §10）：`tsx` 起进程时 SIGTERM 打在包装进程上（应用收不到）→ 改跑 dist；
  本地 `file:../..` 被 npm 装成**快照拷贝** → 示例跑的是安装那天的框架，脚本改为指向仓库根的链接。

## R7 候选（下一轮）

- trace 改写为内置中间件的二次评估（v0.1.0 评审放弃的理由见 spec §10）；
- **HITL 跨进程挂起 / 续跑**（`awaiting_approval` 状态机 + 循环位置落库）—— 闸门配方已覆盖同步审批，
  此条仅当「审批跨重启」是硬需求时立项（见 spec §10 与 usage-guide §6）；
- **默认 client 自研化 + 公共类型自有化**（让 `@anthropic-ai/sdk` 真正可选）—— 前者 = 用 fetch 重实现
  Anthropic Messages（SSE / `cache_control` 缓存断点 / `tool_use` / `strict` / thinking），后者 = 在 `core`
  定义 agentia 自己的 `Message` / `ContentBlock`，只在 `integrations` 边界适配成厂商形状。
  **前置条件：先补「真 API 集成测试」** —— 当前单测与 e2e 全用 mock，直接换主路径 = 让最关键的一条路
  失去与真实服务的对照（见 spec §10「厂商 SDK 收敛到单一实例化点」）；
- Workers 代理版 playground（免 BYOK 的托管演示）；
- 文档站内容扩充（指南按场景组织）；
- canCall 能力级能力边（当前 tools 引用粒度为 provider）。
- **维护：CI 抖动 —— 已定位并修掉（`toolTiming` 的「工具超时」，见 spec §10 2026-09-14）**。
  v0.2.2 窗口内 main 曾红一次（PR #8 那棵树），同树**重跑即绿** ⇒ 抖动而非回归。
  具体用例当时**无法定位**：`verify-all.sh` 把步骤输出捕获后只 `tail -30`，恰好冲掉 node:test 的 `✖ <名字>` 标记行，
  CI 上只剩一个 exit 1。已修诊断可达性（PR #9：失败分支先 grep 标记行再补尾部上下文）——**这次就是靠它一眼定位的**。
  **本轮结论**：真凶是 `tests/engine/toolTiming.test.ts` 的「工具超时」用例（原形态靠「60ms 工具 vs 20ms 超时」
  的计时器赛跑定输赢，只有 3 倍余量）：8 倍 CPU 超订下单文件 **29 次挂 1 次**，PR #19 的 CI 也红了同一条。
  已改成确定性形态（工具挂在只由测试释放的闸门上，断言前不可能 settle）。
  原记的三个嫌疑里 `sqliteStore` 抢锁与 `transport` drain 经核查确实不成立。
- **待决：`withTimeout` 的超时不是硬保证**（同一条用例暴露的引擎级问题）。判定实验：单进程直接用引擎跑
  「60ms 工具 + 20ms 预算」1200 次 → **翻转 1 次**（样本 `wallMs/durationMs = 99`，超时计时器没先触发），
  即事件循环被饿住时**超出预算的工具会被记成 `ok: true`**，超时护栏静默失效。
  修法方向：`await` 之后用**实测耗时**再判一次（`Date.now() - startedAt >= timeoutMs` → 记超时）。
  属**语义收紧**（「21ms 完成的工具在 20ms 预算下」由「成功」变「超时」），需单独拍板 + 决策记录。

## 原则（约束所有 R）

1. 运行时核心（core/engine/run）语义稳定，新能力走 toolkit/新层接入；
2. 每块能力落地必带：单测 + e2e + spec 决策记录更新；
3. 不引入重依赖——可选能力（zod、OTLP、队列）全部 peer/可选接入。
