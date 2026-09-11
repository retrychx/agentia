# Agentia —— Roadmap

状态：v0.2.1 已发布（`@migor/agentia` + `@migor/cli`），R1–R6 已全部落地；本轮完成全量评审修复 + `src/` 目录重构 + 官网响应式 + **官网迁移到 Astro 构建型静态站**（v0.2.2 待发布）。本文档记录规划与落地状态，后续方向见文末「R7 候选」。原文如下（各 R 标题后的 ✅ 为对应版本落地标记）。
与 `docs/spec.md`（已锁定决策）互补：spec 记录"已经怎么定的"，本文记录"接下来往哪走"。

## R1 —— 中间件（拦截器链）✅

**中间件是下一个大块的框架能力**，spec §9.2 已留伏笔（"对齐拦截器：每次单元调用包一层"）。

- **单元调用拦截器链**：`app.use((call, next) => ...)`，在每次单元（tool/skill/subagent/prompt）
  调用前后执行。框架自带的 trace 记账从 engine 硬编码改写成第一个内置拦截器——
  既落地 spec §9.2 的设想，也用自己验证这套抽象（dogfooding）。
- 用户场景：鉴权（按 blackboard 拒绝调用）、限流（按单元计数）、结果缓存
  （幂等工具直接短路）、调用日志/审计、超时包装。
- 设计约束：链式 `next()` 语义；顺序 = 注册顺序；拦截器只见 `ToolRunContext` +
  单元描述，不碰 engine 内部；异步安全（ALS 上下文天然透传）。

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
  `ModelProvider`（stream/finalMessage 结构面），先适配 OpenAI 兼容端点；
  `AGENTIA_MODEL` 语义扩展为 `provider:model`。
- **跨 run 记忆**：blackboard 是 run 级；加可选的 `MemoryStore`（按 session/租户键控），
  run 启动时水合、结束时回写——明确"记忆是次级问题"的边界，只做键值与检索两个钩子。

## R5 —— 生态与体验 ✅

- **CLI**：`agentia dev`（watch + 热重装配）、`agentia add <pkg>`（第三方单元包安装
  并登记）、`agentia doctor`（装配体检：未登记 / 悬空单板 / 命名规范 / 重复条目）。
- **模块系统**：`@AgentModule` 能力包（单元 + providers + 拦截器打包分发），
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
水合失败杀死 run（回写却有防护）、`totalUsage` 对 unit 聚合用量双算的口径矛盾、SQLite 只有 WAL 没有 busy_timeout、
`every(0)` 空转、Redis prefix 未转义 glob、`keepRecent` 在编辑与压缩间单位混用、`trimToolPairs` 对畸形历史切出孤立块、
容器重注册不传递失效、`discover` 覆盖显式 provider、OpenAI 空 `choices` 静默记成成功。全部修复，各带回归用例（190 → 210 例）。

- **安全**：嵌套单元 `tools` 引用改从中间件包装后的菜单解析（关闭 spec 记档的既知缺陷）；
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

`agentia dev` 内置本地 inspector：左栏 run 列表 + 右栏调用树，展示每个单元（tool/skill/prompt/subagent）
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

## R7 候选（下一轮）

- trace 改写为内置中间件的二次评估（v0.1.0 评审放弃的理由见 spec §10）；
- Workers 代理版 playground（免 BYOK 的托管演示）；
- 文档站内容扩充（指南按场景组织）；
- canCall 单元级能力边（当前 tools 引用粒度为 provider）。

## 原则（约束所有 R）

1. 运行时核心（core/engine/run）语义稳定，新能力走 toolkit/新层接入；
2. 每块能力落地必带：单测 + e2e + spec 决策记录更新；
3. 不引入重依赖——可选能力（zod、OTLP、队列）全部 peer/可选接入。
