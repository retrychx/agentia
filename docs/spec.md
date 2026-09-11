# Agentia —— 规格（v0.1 草案）

状态：讨论收敛后的书面化。锁定的决策在此，后续实现照此推进；契约先行。

## 1. 定位（一句话）

面向应用开发者的**声明式 agent 服务开发框架**：TS 装饰器 + DI + 模块；主 agent 作为路由器调度 tool/skill/subagent/prompt；**交付物是可上线的 Agent 服务而非对话助手**；运行时自研、参考 Claude 设计，底层调用 Messages API。

> 不是“agent 聊天 SDK”，是“把 agent 做成服务的框架”。文本只是副产品，agent 执行出的活 + 结构化产物才是产品。

## 2. 运行模型：run（一次运行）

对话助手的“会话=聊天”直觉作废。模型是：

```
触发(请求/事件/定时) → 主 agent 作为路由器编排阶段 → typed 结果 + 产物/副作用 出
```

- **run** = 一次任务实例。入参 = 任务 spec；出参 = 结构化结果。
- **run scope 上下文**：在单次运行内累积（blackboard），结束即释放。跨运行记忆是次级问题。
- **主 agent = 路由器**：不确定阶段顺序，而是自主决定调用哪些单元、什么顺序。
- 单元（tool/skill/subagent/prompt）= 服务的**组成阶段**。

## 3. 单元契约（四个装饰目标）

| 单元 | 运行时本质 | 结果回到主 agent 的形态 |
|---|---|---|
| `@Tool(zod)` | 函数调用 | `tool_result`（值或 `is_error`） |
| `@Skill` | 指令 + 脚本，受限子运行 | 产物/结论 |
| `@Prompt` | 纯文本资产（模板/宏/playbook） | 被选中时注入上下文 |
| `@SubAgent` | 独立 agent 循环 + 裁剪上下文 | 跑完的最终报告（隔离，中间产物不污染主上下文） |

统一抽象：这些单元对主 agent 都是“可调用项”，差异只在运行时执行方式。注册 = 把每个单元的 `name + description + 怎么用` 编译进主 agent 的菜单，由 LLM 决定调度谁。

## 4. 装饰器表面（草案）

**已定决策：标准装饰器（ECMAScript Stage 3），不用 `experimentalDecorators` / `emitDecoratorMetadata` / `reflect-metadata`。** 因此不支持构造器参数反射 —— DI 采用模块内显式 `providers` + factory 装配（`useFactory` 式）。框架的元数据一律显式声明（装饰器参数即配置，外加 `WeakMap`/注册表存储），不依赖 `design:paramtypes`。

```ts
@AgentModule({ main: true })              // 模块 = 能力包；main 标记主 agent
export class ProjectModule {
  @SubAgent({ role: 'reviewer', canCall: [] })
  reviewer() { return { model: 'opus', prompt: reviewerPrompt } }

  @Skill({ name: 'regenerate-logo', desc: '…' })
  async regenerateLogo(ctx) { /* 指令 + 调 script */ }

  @Prompt({ name: 'brand-style', desc: '品牌基调资产' })
  static brand() { return '扁平 + 水彩，禁用霓虹色…'; }  // 落定形态：方法（字段形态不可行，见 §10 Turn 6）
}

// 显式装配：token + useFactory，不读构造器参数反射
const providers = [
  ImageTools,
  { token: 'IMAGE', useFactory: (t: typeof ImageTools) => t },
];
```

## 5. 自研运行时：参考 Claude 的机制清单

- 主循环（manual loop）：`while stop_reason == "tool_use"`。
- **并行工具**：一次 assistant 消息可含多个 `tool_use`；**单条 user 消息回全部 `tool_result`**（拆分会抑制并行）；失败回 `is_error`，不丢块。
- **Prompt cache 布局**：顺序 `tools → system → messages`；稳定前缀在前；≤4 个 breakpoint；动态内容放最后；系统提示禁用 `Date.now()` 类隐形 invalidator。命中率用 `usage.cache_read_input_tokens` 验证。
- **长上下文三策略分清楚**：compaction（服务端摘要）/ context editing（清旧工具结果与 thinking）/ 客户端剪裁——三者不同，不混。
- **子 agent = 完整独立循环 + 裁剪上下文 + 报告以 `tool_result` 交回**（隔离是核心）。
- **预算/形态**：task budget、effort 档、流式、strict tools + 结构化输出（`output_config.format`）。
- **别自研黑名单**：token 计数走 `/messages/count_tokens`（不用 tiktoken 近似）；错误分类用 SDK 类型化异常；缓存验证靠 `cache_read_input_tokens`。

## 6. 服务层（agent 服务的关键，区别于对话）

1. **run 生命周期状态机**：queued → running → succeeded/failed；运行记录 + 调用树（trace，见 §9）。
2. **结构化结果是一等契约**：收尾产出符合 schema 的 typed 结果 + 明确成败（`output_config.format`）。
3. **触发三类**：同步请求 / 异步任务（入队→轮询）/ 定时事件。
4. **可观测 + 成本**：每条 run 的调用树、token、超时、task budget。
5. **确定性工程**：幂等键、至少一次触发的去重、清晰失败语义。
6. **v1 边界**：同步 RPC 型；但 run 生命周期（状态机 + 幂等键）从第一天作为抽象存在，异步耐久 = 换宿主（队列 + store），不换语义。

## 7. 静态校验（元数据层的差异化）

运行时抢不过 LangGraph，静态声明 + 校验是 NestJS 路线独有的武器。

## 8. Build order

| 里程碑 | 内容 | 对应框架件 |
|---|---|---|
| Turn 0 | ✅ manual loop + 流式，单主 agent 调工具跑通 | 引擎内核 |
| Turn 1 | ✅ run 生命周期 + 系统提示拼装 + cache 布局 | 容器 / run scope |
| Turn 2 | ✅ 装饰器 → JSON Schema → tool_result 往返 + strict | `@Tool` 容器 |
| Turn 3 | ✅ 子 agent 作为 tool（裁剪上下文 + 隔离报告） | `@SubAgent` |
| Turn 4 | ✅ compaction / context editing / task budget（预算护栏） | 长上下文策略 |
| Turn 5 | ✅ 触发传输（同步 RPC / 异步任务 / 定时）+ run 存储/幂等 | transport 层 |
| Turn 6 | ✅ @Skill / @Prompt 单元 + 文件宿主耐久续跑 + AGENTIA_MODEL env 缺省 | toolkit / run store |
| Turn 7 | ✅ 目录约定（units/<name>/）+ 发现机制（扫描/注册表双形态）+ CLI（create/g） | toolkit / @agentia/cli |

Trace 自 Turn 0 起内建（每个 LLM 往返都记账），Turn 1 后是完整形态。

## 9. Trace（调用树）—— 一等公民

Agent 服务靠**事后**调试，trace 是调试表面 + 审计记录（对话助手能现场看，trace 对服务交付是必需品）。

### 9.1 模型（对齐 OpenTelemetry 命名，便于接基础设施）

- 一次 run == 一条 trace；v1 里 `traceId == runId`，1:1。
- 树形层级：
  - `run`（根 span）= 整次运行
  - `unit` span = 对 **skill / subagent** 单元的调用（这两类才在内部开子循环、产生子 span）
  - `llm.turn` span = 每次模型往返，挂 usage（model / input / output / cache_read）
  - 普通工具与 `@Prompt` 资产**不建 span**，只记在发起它们的 `llm.turn` 上的
    `tool.input` / `tool.output` 事件（`engine/loop.ts`）
  - 子 agent = 一个 unit span，其内部单元递归成它的子孙
- span 属性：model、input/output/cache tokens、成本估计、状态、错误类型。
- 事件（logs）：工具入参/出参**默认截断 + 脱敏**，完整内容 opt-in。
- 状态：`ok` / `error` + 错误分类（可重试 vs 不可重试）。

### 9.2 上下文传播

- 当前 span 句柄放进 **RunContext（DI run scope）**，每个单元调用从上下文拿 child span —— 不用全局单例，因为 agent 并行 tool 调用时父子关系必须准。
- 对齐 NestJS 拦截器：每次“单元调用”包一层 TraceInterceptor，统一开 span / 记 usage / 写 status。
- 异步化后：trace 上下文要跨队列传播 —— v1 同步先把 header 语义定好，实现后置。

### 9.3 产出与导出

- v1：内存 trace store，随 run 结果/运行记录返回（结构化输出 / JSONL），便于回放调试。
- 生产：OTLP 导出 + span 与 run 记录同库存储。
- 成本：span 级 usage 聚合自 API usage 字段（`cache_read_input_tokens` 等），run 汇总 = 各 span 求和。
- **trace 出口（sink）**：`TraceSink { export(trace) }` —— run 收尾（成功 / 失败两条路径）后框架把
  完整 trace 交给每个 sink；sink 抛错被吞，不影响 run。装配层 `AppOptions.sinks` 与
  `registerDefaultTraceSink()`（全局默认，构造期快照合并）；`createOtlpExporter()` 的返回值天然满足
  该接口。`agentia dev` 的本地 inspector 即经此出口取数（框架不读 env、不含 dev 逻辑）。

### 9.4 开放问题

- 全量记录成本 vs 截断/采样默认阈值。
- trace 是否作“重放基底”（把完成的 trace 喂回模型做调试）—— 未来，不进 v1。

## 10. 决策记录

- 2026-09-10：TypeScript 用 7.x（native tsgo，npm latest 实测 7.0.2）。
- 2026-09-10：**装饰器走标准（Stage 3）+ 显式 DI（providers/useFactory）**，弃用 `experimentalDecorators`/`emitDecoratorMetadata`/`reflect-metadata` —— 原生编译器已在考虑移除 legacy 元数据发射，新框架不该押其上。
- 2026-09-10：**trace（调用树）为一等公民**，与 run 1:1，自 Turn 0 内建。
- 2026-09-10：**trace v1 范围 = 单次 run 链路追踪 + 每步 usage**（每步 token/成本/成败/耗时）。跨 run 账单报表、预算硬管控 → 后置，不在 trace 内做。
- 2026-09-10：Turn 2 —— **run 作用域上下文用 AsyncLocalStorage 传播**（executeRun 内建 ctx，执行体 `RunContext.current()` 直取），工具/子 agent 执行不把 ctx 作参数层层下传；`@Tool` 只登记「方法→spec」，AgentTool 由 `collectTools(instance)` 对容器解析后的实例生成（此时才绑定 this），零反射、与 tsgo/esbuild 双兼容。
- 2026-09-10：Turn 3 —— **主循环抽成 `agentLoop`（不自开 run 根，llm.turn 挂给定 parentSpanId）**；`runAgent` = 开 run 根后调它，`runAgentScoped` = 嵌套单元入口。**子 agent 复用同一循环**：开 `unit` span（挂发起它的 llm.turn 下）→ 独立 messages（只含任务 JSON，裁剪主对话）→ 内部 llm.turn 递归成 unit 子孙 → 仅最终文本以 tool_result 交回（隔离报告）。工具执行注入 `ToolRunContext{client, recorder, parentSpanId}`，recorder 用 `core/tool.ts` 的 `RecorderBackend` 结构面（core 不依赖 engine）。usage 天然跨两级聚合（同 recorder 求和）。
- 2026-09-10：Turn 4 —— **长上下文三策略分清不混**：`trimToolPairs` = **context editing**（整体丢旧 tool_use→tool_result 对，不掉内容、不额外调模型）；`compactMessages` = **compaction**（旧前缀做**服务端摘要**，摘要器由上层注入 —— 框架不替你造 token，真机可接 LLM / `/count_tokens`）；客户端剪裁 = Turn 3 子 agent 的独立上下文。预算决策用 `estimateTokens` 启发式（缺省**字符/4**，明确标注是估算非精确记账）。`createBudgetPolicy` 带滞回（`compactEvery` 防每回合反复压缩）；发生改写时在 run 根上记 `context.budget` 事件。触发点 = `agentLoop` 每回合发送前 `contextPolicy.beforeTurn(messages)`。
- 2026-09-10：Turn 5 —— **三类触发（同步 RPC / 异步任务 / 定时）共用同一份入参契约 `RunInput`**（string / messages / {prompt|text|messages}，`normalizeMessages` 归一），与 agent 装配解耦 —— **换宿主（HTTP/队列/DB）不换语义**。**at-least-once 幂等**：`AsyncRunner.submit` 以 `idempotencyKey` 去重，同键未失败（queued/running/succeeded）直接返回既有记录不重复跑；**失败的同键可重提新任务**。`executeRun` 增加 `rethrow:false`：异步宿主用它接住硬失败、以 `failed` 记录落库而非冒泡。异步耐久 = `TaskStore` 结构接口（v1 `InMemoryTaskStore`），队列/DB 宿主只需实现它。定时层 `Scheduler.every/.at` 依赖 AsyncRunner，周期任务幂等键按 interval 窗口分片。
- 2026-09-10：Turn 6 —— **`@Skill` = 代码控制的流程（脚本式 + `SkillContext.llm()`）**：方法体是确定性脚本，「要不要调模型 / 调几次 / 拿结果怎么算」写死在代码里；模型调用只在显式 `ctx.llm()` 时发生 —— 受限子运行复用 `runAgentScoped`（不自开 run 根），在 skill 自己的 `unit` span（attribute `skill`）下开 llm.turn 记账，中间结果不外泄，**方法返回值即产物/结论，以 tool_result 交回主 agent**。与 `@SubAgent`（模型自主循环 + 裁剪上下文）是可感知区别。**`@Prompt` = 纯文本资产**：编译成菜单里一个无副作用拉取型 AgentTool（模型判定需要时调用、文本以 tool_result 注入上下文 —— 我们现成的唯一「被选中」机制）。**标准装饰器下字段拿不到值/类引用 → `@Prompt` 只支持方法形态**（实例方法沿原型链、每次调用现算 volatile；static 方法表达常量资产），§4 草图的 `static brand = '…'` 字段形态不可行、已改方法。菜单四类单元（tool/skill/subagent/prompt）**共用命名空间**：装配期统一查重、重名即抛（§7 静态校验最小落地）。**异步耐久落地 = `FileTaskStore`（JSONL 一行一快照，last-wins 还原）**：`AsyncRunner`/Scheduler/触发层**零改动**，宿主重启 `new FileTaskStore(path)` 读回记录 + `AsyncRunner.resumePending()` 续跑 queued/running。缺省模型改 `resolveDefaultModel()`：**`AGENTIA_MODEL` env 覆盖**，无则回落 `claude-opus-5`。**确认不拆 npm 包**（core/runtime/transport 拆分后置发布阶段）。
- 2026-09-10：Turn 7 —— **目录约定 + 发现机制 + CLI 落地**。`units/<name>/` 一单元一文件夹：`index.ts` 入口 default export（类 → token=文件夹名的 useClass / Provider / Provider[]），长文本资产放文件夹内 `.md`，`asset(import.meta.url, rel)` 现读不缓存（保 @Prompt volatile 语义）。**发现机制双形态**：运行时扫描 `discoverProviders(dir)` / `createApp({ discover })`（动态 import 决定其为 Promise 返回）与 CLI 维护的 `units.ts` 显式注册表（标记行 codemod，幂等）——可混用，AgentApp 构造期同 token 去重（后注册覆盖先注册，与 Container 语义一致），装配期静态校验（查重/引用/toolSources）对两条路一视同仁。**CLI 独立成包** `@agentia/cli`（npm workspaces，零运行时依赖、纯 Node 内置）：`create` 脚手架项目、`g tool|skill|prompt|subagent <name>` 生成单元文件夹并登记注册表；kebab-case 命名校验，方法名 snake、类名 Pascal。注意双实例危害：消费方必须从同一模块实例 import 框架（装饰器 WeakMap 注册表不跨实例），smoke:turn7 因此统一走 dist。
- 2026-09-11：**R1–R5 一轮落地（v0.1.0）**。**R1 中间件**：`UnitMiddleware` 洋葱链（链序=注册序，`next(newInput)` 可改写、不调 next 即短路），**装配期包裹整个菜单**（`applyMiddleware`），对 engine 零侵入——trace 仍留 engine 层（改写为拦截器的 dogfooding 设想经评审放弃：unit span 生命周期与模型调用纠缠在 loop 内，强行外置反而割裂）；孤儿单元告警定义为「toolSources 收窄时被排除 provider 上的单元」。**R2**：typed 结果走 hidden `submit_result` 工具（engine 内部追加，菜单同名即装配冲突；校验失败回 is_error 让模型自我修正，system 指令追加在 volatile 尾部不污染缓存前缀）；zod 接入 duck-typed（`fromZod` 挂 `__zodValidate`，框架永不 import zod，序列化时自动丢弃函数字段）。**R3**：HTTP 宿主只产 handler 不 listen（/run 同步、/tasks 异步+轮询，失败也 200 带 error 与 rethrow:false 对齐）；`SqliteTaskStore` 用 Node 内置 `node:sqlite`（WAL 天然多进程安全，解 FileTaskStore 单写者限制）；OTLP 用 OTLP/JSON + 全局 fetch，零依赖。**R4**：`ModelClient` 结构面定义在 core（Anthropic SDK 天然满足），`createOpenAIClient` 手写请求/响应双向翻译（非流式模拟、cache token 恒 0、refusal 近似——三处近似边界写入头部注释）；`MemoryStore` 只有 load/save 两个钩子，水合在 contextInit 之后（用户种子优先），成功/失败路径都回写（失败路径 save 异常吞掉防掩盖原始错误）。**R5**：`@AgentModule` = providers + middleware 打包（模块级在前、应用级可覆盖同 token）；CLI 补 dev（tsx watch 转发信号）/ doctor（纯静态体检，不 import 用户代码）/ add（npm install + 注册表 codemod，解析真实包名含 file: 协议）。**全量验证改为 `npm test`（node:test）+ `npm run e2e`（CLI 端到端）**，老 smoke 脚本删除，唯一盲区 SystemPrompt 缓存布局已补进单测。
- 2026-09-11：**R6 落地（v0.2.0）**。子 agent typed：`runAgentScoped` 透传 resultSchema，交回形态 `{ report, result }`（report 在前保可读性，未提交时行为逐字不变）。**TaskStore 接口放宽为 MaybePromise**：同步实现签名不变（天然子类型），AsyncRunner 内部全 await 化 + 异步 store 的幂等去重推迟到执行前（同步门面 submit 签名不变）；`RedisTaskStore` duck-typed `RedisLike`（get/set/del + keys|scanIterator，框架永不 import redis 包）。`traceToMessages` = trace 重放基底（§9.4 落地）：llm.turn 按 startedAt 稳定排序线性化（含嵌套），tool 对同名优先配对、缺失补 is_error 占位；assistant 原文 trace 未记录，以标注文本占位。**collect 扫描改 `Reflect.ownKeys`**：symbol 命名装饰方法不再被静默忽略（无显式 name 由 unitName 抛错）——修掉「注释承诺但代码不可达」。**website 移入 packages/website**（monorepo 结构统一），官网新增 BYOK 真实模型 playground（key 仅 localStorage，浏览器直连 Anthropic）与 api.html；新增 AGENTS.md 记录仓库结构与协作约定。

- 2026-09-11：**全量评审修复轮 + src 目录重构 + 官网响应式（v0.2.2）**。评审结论：**主路径有纪律，佐助路径没有**——所有问题集中在同一条缝上（落库失败杀进程、记忆回写失败毁掉成功的 run、子 agent 绕过鉴权、replay 产物在缺省模型上 400），修复原则统一为「辅助操作失败不得击穿主路径」。
  **目录重构（先做、零行为变更）**：`src/run/` 按职责拆为 `runtime/`（run 生命周期与调用契约）+ `transport/`（触发宿主）+ `store/`（任务存储）+ `integrations/`（外部系统适配）；`engine/context.ts` → `engine/trimming.ts`（消除与 `runtime/context.ts` 的同名异层）；`tests/` 同步镜像；`src/index.ts` 导出面逐字不变（仅 re-export 路径 + 新增 `isSuccessStopReason`）。
  **七条发布阻塞**：`AsyncRunner` 私有 `#safeSave`（先包再调，同步抛出也变 rejection，槽位 `try/finally` 必达）；`readBody` 加 `maxBytes`（默认 1 MiB → 413）并监听 `close` 兜底未 `end` 即中断的请求；`traceToMessages` 末条为 assistant 时补一条 user（否则是 prefill，缺省模型 400）；`@Skill`/`@Prompt` 的 override 改 `Reflect.apply` 动态查表（与 `@Tool` 对齐）；成功路径 `flushMemory` 包 try/catch（辅助回写失败不得把成功的 run 翻成 failed）；`mapStopReason(finish, hasToolCalls)` 以 `tool_calls` 非空为准（兼容 DeepSeek/vLLM/Ollama 等回 `stop` 的端点）。
  **新增公开选项（均带向后兼容默认）**：`HttpHandlerOptions.maxConcurrentRuns`（32，超限 503 + `Retry-After`，`Infinity` 复旧）/ `maxBodyBytes`（1 MiB）/ `exposeErrors`（false，500 只回通用文案）；`AsyncRunnerOptions.runTimeoutMs`（0＝不限；`Promise.race` 超时即标 failed 并回收槽位，注释写明是「放弃等待」非「终止执行」）与 `resumePending({staleAfterMs})` + `TaskRecord.ownerId`（跳本进程记录）；`RedisTaskStoreOptions.ttlSeconds`；`ScheduleEveryOptions.maxInFlight`（1）。
  **语义变更（此处锁定）**：`POST /run` 默认并发闸门 32；新增 `stop_sequence`（视为正常完成）与 `unknown_stop_reason`（保留文本但标 error）两个 `AgentStopReason`；replay 产物末条必为 user。
  **次要修复 14 处**：fsStore 载入截断残行自愈、tool 事件带 `tool_use_id` 且 replay 按 id 配对、`iterations` 就地累加、`validateJsonSchema` 移入 try、redis 空 `prefix` 抛错、`Object.hasOwn`、`normalizeMessages('')` 抛错、`decodeURIComponent` 容错、`Container.register` 清缓存、`discover` 软链、middleware `next` 守卫等。
  **许可证**：仓库根 + 两包补 MIT。**官网**：全面响应式（≤420 断点 + 汉堡导航，20 组「页面×宽度」零横向溢出）。测试 142 → 182 例。

- 2026-09-11：**官网迁移到 Astro（构建型静态站，v0.2.2）**。动机：四页纯 HTML 无模板层，`<nav>`/`<head>` 各抄四遍、改一处要动四处；playground 两脚本靠全局变量 + 标签顺序串联；GSAP/Lenis/字体全走 CDN（违背「资源本地化」）；且无构建产物，`wrangler pages deploy public` 直接传源码。选型**刻意不引 SPA 框架**——静态宣传站上 React/Vue 会带来 hydration 与 SEO/LCP 倒退，取 Astro：默认零客户端 JS，交互页按 island 挂载，现有 vanilla JS 几乎原样平移。
  **结构**：`src/layouts/Base.astro`（head/背景层/Nav/slot/Footer/共享脚本）+ `src/components/{Nav,Footer}.astro` 消除 ×4 重复；四页降为 `src/pages/*.astro`，正文抽到 `src/fragments/*.html` 经 `?raw` + `set:html` 注入；`src/scripts/` 收拢脚本（`scrollspy.js` 由 docs/api 逐字重复的内联脚本合并而来，`site.js` 的 GSAP/Lenis 由 CDN 全局改为打包 import）。
  **两处 Astro 陷阱（此处锁定）**：① frontmatter 的 import 只在构建期（Node）执行，**客户端脚本必须写在 `<script>` 标签里**才会下发；② 模板中 `{` 是表达式起始，而正文含大量 TS 代码块，故正文走 `?raw` 片段注入而非内联。
  **验证标准是零回归**：`build.format: 'file'` 保持 `*.html` 既有 URL；CDP 探针在 11 档宽度 × 4 页比对迁移前后——文档高度逐像素一致（除下述修复项）、渲染文本逐字节一致，gsap/lenis/canvas/marquee、窄屏导航折叠、docs/api scrollspy、playground 完整回放全绿，运行时零外部请求。
  **顺带修复（迁移前既有，非本次引入）**：`.table-wrap` 的 `overflow-x: auto` 原本只写在 ≤560px 断点内，导致 861–1050px 区间（侧栏仍在、内容列被压窄，而内容列是 `minmax(0,1fr)` 不会撑开）表格 min-content 直接顶破页面——900px 溢出 57px、861px 溢出 96px。提升为全局规则，并把表格纵向 margin 挪到容器上（overflow 容器会阻断子元素 margin 折叠，否则每张表多出约 36px 空隙）。副作用：≤560px 的表格间距与宽屏统一（移动端此前多出的空隙属非预期行为）。

- 2026-09-11：**trace 出口缝（Dev Inspector 前置）**。`TraceSink { export(trace) }` 升格为框架一等出口
  （形状复用 `OtlpExporter`，`createOtlpExporter()` 返回值天然满足）；`executeRun` 成功 / 失败两条路径
  均投递，sink 抛错吞掉不影响 run。装配层 `AppOptions.sinks` 与 `registerDefaultTraceSink()`
  （全局默认，构造期快照合并）。框架**不读 env、不含 dev 逻辑**——dev 注入由 CLI 侧 `--import`
  preload 完成（`registerDefaultTraceSink` 为公开扩展点）。**顺带修正 §9.1 口径**：unit span 只由
  skill / subagent 创建，普通工具与 `@Prompt` 走 turn 上的事件（此前描述为四类单元一律建 span，
  与实现不符）。

- 2026-09-11：**第二轮回评修复（并入 v0.2.2 未发布窗口）**。上一轮修的是「辅助操作失败击穿主路径」，本轮把同类缝补完并关闭一处安全缺陷。以下语义变更**在此锁定**：
  **安全 / 正确性**：① `AgentApp` 装配重构——嵌套单元（子 agent / skill）的 `tools` 引用改从**中间件包装后**的每 provider 菜单解析（`wrappedByToken`），原实现取包装前的原始菜单，导致子 agent 内部每一次工具调用整体绕过中间件（鉴权 / 限流 / 审计 / 结果缓存全失效）——spec 曾记档的既知缺陷就此关闭；主菜单仍只取 `toolSources`，被排除的 provider 仅「不进主菜单」，其单元经显式 `tools` 引用仍可调用（孤儿告警文案同步更正）。② `engine/loop.ts` 的 `submit_result` 校验移入 try——畸形 resultSchema 只废掉该次提交（回 is_error），不再让整次 run 以 error 收场而与 trace 记的该回合 ok 自相矛盾。③ `runtime/run.ts` 的 `hydrateMemory` 包 try——与 `flushMemory` 对称，store 故障不再杀死 run。
  **宿主稳定性**：④ `AsyncRunner.submit` 订阅异步 store 的 `byIdempotency` Promise（原实现丢弃返回值，reject 即 unhandledRejection → Node ≥15 终止宿主；同一函数内 `save` 本有 `.catch`，属一防一漏）。⑤ `submit` 初始 `save` 的迟到 reject 仅在任务仍 `queued` 时改判，不再把已成功的 run 覆写成 failed（落库终态与真实结果一致）。
  **契约与资源**：⑥ `Trace.totalUsage` 只累加 `llm.turn` span——unit span 的 usage 语义锁定为「子孙聚合、仅供展示」，不参与求和（否则与子孙重复计数）；`core/trace.ts` 的类型注释同步更正。⑦ `FileTaskStore.compact()` 新增（append-only JSONL 压实为每 task 一行；TaskStore 接口之外的显式能力）。⑧ `InMemoryTaskStore({ maxRecords })` 新增内存闸门：超限从最旧**已终态**记录起淘汰，在飞（queued/running）记录永不淘汰；缺省 Infinity ＝ 不淘汰（旧行为）。⑨ `SqliteTaskStore` 补 `PRAGMA busy_timeout = 5000`——原实现只设 WAL，「多进程安全」的承诺实际不成立（第二个写者立即 `SQLITE_BUSY`，而 `#safeSave` 会把失败静默吞掉 → 记录无声丢失）。
  **语义修正**：⑩ `createBudgetPolicy` 拆出 `keepToolPairs`（context editing 按「对数」），`keepRecent` 只管 compaction 的「条数」——同一值套两种单位的隐含 bug 消除。⑪ `trimToolPairs` 前置 `toolBlocksPaired` 校验：非严格交替历史（连续两条 assistant 带 tool_use 等）整体放弃裁剪，不再切出孤立 `tool_use` / `tool_result` 让后续请求 400。⑫ `createApp({ discover })` 与显式 `providers` 同 token 时**显式优先**（显式放发现结果之后）——原实现让 `units/` 下同名文件夹悄悄顶掉调用方手写的 provider。⑬ `Container.register` 传递失效缓存：依赖它的下游一并重建，不只失效 token 自身。⑭ `Scheduler.every` 拒绝非正有限数（`every(0)` 不再退化成忙轮询空转）。⑮ `RedisTaskStore` 的 MATCH 模式转义前缀 glob 元字符（前缀含 `[` 等会查错 key）。⑯ OpenAI 兼容适配器对 200 但空 / 缺 `choices` 的响应抛错（原实现静默映射成空文本 + usage 全 0 + `end_turn`，把上游故障记成成功）。
  **测试** 190 → 210 例（上述每条各带一个「移除修复即失败」的回归用例）。

- 2026-09-11：**DX（类型链路）与 AI 可编码性**。动机：框架 API 的编辑器补全本来就好（`app.` / `createApp({` /
  各 spec 对象都有字段补全、导出面都有 JSDoc），但**「你自定义的东西」没有类型链路** —— 黑板键是裸 `string`、
  `result.typed` 是 `unknown`、schema 与方法签名双写且默认互不校验。这三点正是「记不住 API」与「AI 猜错 API」的根源。
  以下语义变更**在此锁定**：
  **① 黑板类型化（可选，声明合并）**：新增导出 `Blackboard`（空接口）/ `BlackboardKey` / `BlackboardValue` / `BlackboardSeed`。
  `RunContext.get/set/has/delete/keys` 的键类型改为 `BlackboardKey`，值类型由键推导。未声明 `Blackboard` 时
  `BlackboardKey = string`、值为 `unknown`（**与旧行为逐字一致**）；声明后键有补全、拼写错误编译期报错、
  `run({ blackboard })` 种子也有键校验。**签名变更（轻微破坏）**：`get` 的第一个类型参数从「值类型」变成「键」——
  旧写法 `ctx.get<string>('k')` 在未声明 `Blackboard` 时仍能编译（键 `string`）但返回值退化为 `unknown`；
  要显式值类型改用断言 `ctx.get('k') as string | undefined`。动态键走文档逃生口 `ctx.get(key as BlackboardKey)`。
  **② schema 即单一事实来源**：新增导出 `TypedSchema<T>` / `SchemaType<S>` / `SchemaInput<S>`；`fromZod<T>()` 返回
  `TypedSchema<T>`（幻影字段，运行时不出现）；`ToolSpec<S>` / `Tool<S, O>` 的方法入参类型改为 `SchemaInput<S>` ——
  于是 `fromZod<T>` 之后**方法签名与 T 不一致直接编译期报错**，不用手写泛型。**签名变更（明显破坏）**：
  `Tool` 的第一个泛型从 `I`（入参）变成 `S`（schema），旧写法 `@Tool<{city:string}, string>` 会因 `S` 不满足
  `extends JsonSchema` 而**响亮报错**（不静默）；改用 `fromZod<T>` 或裸 schema。裸 `JsonSchema` 与
  `fromZod` 未给 `<T>` 时入参回落 `any`（不校验），保持向后兼容。
  **③ 结构化结果类型化**：`AgentRunResult<T = unknown>` / `AgentLoopResult<T = unknown>` 泛型化；新增
  `SchemaType<S>`（`unknown` 回落，与旧 `typed: unknown` 一致）；`RunAgentOptions<S>` / `ExecuteRunOptions<S>` /
  `RunAppOptions<S>` / `AgentRunOutput<T>` 随之泛型化，`app.run` / `executeRun` / `runAgent` 的返回值从 `resultSchema`
  **自动推导** `typed`。**补齐**：`RunAppOptions` 新增 `resultSchema`（此前 `app.run` 根本传不了结构化结果 schema ——
  该能力只从 `executeRun`/`runAgent` 可达，属漏接）。
  **④ 顺带修 `FactoryProvider.useFactory` 逆变 bug**：形参由 `(...deps: unknown[]) => T` 改为 `(...deps: never[]) => T` ——
  函数参数逆变，旧写法会拒掉一切带类型形参的正常工厂（`(cfg: Config) => T` 不可赋值），与 `ClassProvider.useClass`
  的 `new (...args: never[])` 对齐。
  **⑤ 文档与验证基建（本轮新增，此后是硬约定）**：`docs/usage-guide.md` 为**使用者向唯一说明**（API 速查 + 类型链路 +
  已知边界 + 反例），三处消费：`packages/cli` 构建拷成 `dist/AGENTS.md` 并由 `agentia create` 写进新项目、
  官网 `/llms-full.txt` 与 `/llms.txt`（导出清单同源派生）。`tests/docs/usage-guide.test.ts` 把说明里的**表格逐项**
  对源码核（成员容器/导出面），改名即失败。新增 `typecheck:tests`（src+tests 一起类型检查 ——此前**测试目录从未被
  类型检查**，首跑 50 个错误，已全修）与 `typecheck:types`（`tests/types/` 用 `@ts-expect-error` 断言「应当报错」的
  场景真报错，**针对构建产物 dist 编译** —— 模块增强在同一编译程序内全局生效，与 src 混编会污染框架自身）。
  测试 210 → 215 例（+ 类型断言测试与 e2e 的 AGENTS.md 内容校验）。

## 11. 开放项

- npm 包拆分/发布（core / runtime / transport）在发布阶段做；CLI 已独立为 `@agentia/cli`（workspaces），框架本体仍单包，均未发布。
- DI 的 property-injection 便利写法（标准装饰器下可行）待定。
- 模型缺省 `claude-opus-5`（`AGENTIA_MODEL` env 可覆盖），thinking 用 adaptive，流式优先。
- CLI 后续：`add`（接第三方单元包）、注册表与扫描混用时的冲突提示策略（`dev` 已落地并内建 inspector 面板）。
