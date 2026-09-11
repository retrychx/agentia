# Agentia —— Roadmap

状态：v0.2.1 已发布（`@migor/agentia` + `@migor/cli`），R1–R6 已全部落地；本轮完成全量评审修复 + `src/` 目录重构 + 官网响应式 + **官网迁移到 Astro 构建型静态站**（v0.2.2 待发布）。本文档记录规划与落地状态，后续方向见文末「R7 候选」。原文如下（各 R 标题后的 ✅ 为对应版本落地标记）。
与 `docs/spec.md`（已锁定决策）互补：spec 记录"已经怎么定的"，本文记录"接下来往哪走"。

## R1 —— 中间件（拦截器链）+ 静态校验补全 ✅

**中间件是下一个大块的框架能力**，spec §9.2 已留伏笔（"对齐拦截器：每次单元调用包一层"）。

- **单元调用拦截器链**：`app.use((call, next) => ...)`，在每次单元（tool/skill/subagent/prompt）
  调用前后执行。框架自带的 trace 记账从 engine 硬编码改写成第一个内置拦截器——
  既落地 spec §9.2 的设想，也用自己验证这套抽象（dogfooding）。
- 用户场景：鉴权（按 blackboard 拒绝调用）、限流（按单元计数）、结果缓存
  （幂等工具直接短路）、调用日志/审计、超时包装。
- 设计约束：链式 `next()` 语义；顺序 = 注册顺序；拦截器只见 `ToolRunContext` +
  单元描述，不碰 engine 内部；异步安全（ALS 上下文天然透传）。
- **静态校验补全**（spec §7 剩余项）：`canCall` 能力边声明与环检测、孤儿单元告警、
  `@Tool` schema 合法性深度检查（strict 模式约定）——全部装配期完成。

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
  并登记）、`agentia doctor`（装配体检：孤儿单元、canCall 环、命名规范）。
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

## R7 候选（下一轮）

- `InMemoryTaskStore` 无界增长（长期驻留进程需上限/淘汰策略）；

- trace 改写为内置中间件的二次评估（v0.1.0 评审放弃的理由见 spec §10）；
- Workers 代理版 playground（免 BYOK 的托管演示）；
- 文档站内容扩充（指南按场景组织）；
- canCall 单元级能力边（当前 tools 引用粒度为 provider）。

## 原则（约束所有 R）

1. 运行时核心（core/engine/run）语义稳定，新能力走 toolkit/新层接入；
2. 每块能力落地必带：单测 + e2e + spec 决策记录更新；
3. 不引入重依赖——可选能力（zod、OTLP、队列）全部 peer/可选接入。
