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
// 落定形态（见 §10 R5）：模块**不是类装饰器** —— `defineModule({ providers, middleware })`
// 返回一个 `AgentModule` 值交给 `createApp({ modules })`；没有 `main` 标记（主 agent 即 app 本身）。
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
- 生产：经 **sink 出口**（见下）导出 —— `createOtlpExporter` 现成、零依赖；「span 与 run 记录**同库**存储」
  只是**一种 sink 配方**（`docs/observability.md`），**不是框架内建** —— 框架只保证出口，落库 / 采样 / 脱敏 /
  按 runId 检索都由宿主用 sink 组合，零 engine 改动。
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
- 2026-09-10：Turn 4 —— **长上下文三策略分清不混**：`trimToolPairs` = **context editing**（整体丢旧 tool_use→tool_result 对，不掉内容、不额外调模型）；`compactMessages` = **compaction**（旧前缀做**服务端摘要**，摘要器由上层注入 —— 框架不替你造 token，真机可接 LLM / `/count_tokens`）；客户端剪裁 = Turn 3 子 agent 的独立上下文。预算决策用 `estimateTokens` 启发式（缺省 **CJK 感知**：CJK ≈1.5 字/token、其余 ≈4 字符/token，明确标注是估算非精确记账）。`createBudgetPolicy` 带滞回（`compactEvery` 防每回合反复压缩）；发生改写时在 run 根上记 `context.budget` 事件。触发点 = `agentLoop` 每回合发送前 `contextPolicy.beforeTurn(messages)`。
- 2026-09-10：Turn 5 —— **三类触发（同步 RPC / 异步任务 / 定时）共用同一份入参契约 `RunInput`**（string / messages / {prompt|text|messages}，`normalizeMessages` 归一），与 agent 装配解耦 —— **换宿主（HTTP/队列/DB）不换语义**。**at-least-once 幂等**：`AsyncRunner.submit` 以 `idempotencyKey` 去重，同键未失败（queued/running/succeeded）直接返回既有记录不重复跑；**失败的同键可重提新任务**。`executeRun` 增加 `rethrow:false`：异步宿主用它接住硬失败、以 `failed` 记录落库而非冒泡。异步耐久 = `TaskStore` 结构接口（v1 `InMemoryTaskStore`），队列/DB 宿主只需实现它。定时层 `Scheduler.every/.at` 依赖 AsyncRunner，周期任务幂等键按 interval 窗口分片。
- 2026-09-10：Turn 6 —— **`@Skill` = 代码控制的流程（脚本式 + `SkillContext.llm()`）**：方法体是确定性脚本，「要不要调模型 / 调几次 / 拿结果怎么算」写死在代码里；模型调用只在显式 `ctx.llm()` 时发生 —— 受限子运行复用 `runAgentScoped`（不自开 run 根），在 skill 自己的 `unit` span（attribute `skill`）下开 llm.turn 记账，中间结果不外泄，**方法返回值即产物/结论，以 tool_result 交回主 agent**。与 `@SubAgent`（模型自主循环 + 裁剪上下文）是可感知区别。**`@Prompt` = 纯文本资产**：编译成菜单里一个无副作用拉取型 AgentTool（模型判定需要时调用、文本以 tool_result 注入上下文 —— 我们现成的唯一「被选中」机制）。**标准装饰器下字段拿不到值/类引用 → `@Prompt` 只支持方法形态**（实例方法沿原型链、每次调用现算 volatile；static 方法表达常量资产），§4 草图的 `static brand = '…'` 字段形态不可行、已改方法。菜单四类单元（tool/skill/subagent/prompt）**共用命名空间**：装配期统一查重、重名即抛（§7 静态校验最小落地）。**异步耐久落地 = `FileTaskStore`（JSONL 一行一快照，last-wins 还原）**：`AsyncRunner`/Scheduler/触发层**零改动**，宿主重启 `new FileTaskStore(path)` 读回记录 + `AsyncRunner.resumePending()` 续跑 queued/running。缺省模型改 `resolveDefaultModel()`：**`AGENTIA_MODEL` env 覆盖**，无则回落 `claude-opus-5`。**确认不拆 npm 包**（core/runtime/transport 拆分后置发布阶段）。
- 2026-09-10：Turn 7 —— **目录约定 + 发现机制 + CLI 落地**。`units/<name>/` 一单元一文件夹：`index.ts` 入口 default export（类 → token=文件夹名的 useClass / Provider / Provider[]），长文本资产放文件夹内 `.md`，`asset(import.meta.url, rel)` 现读不缓存（保 @Prompt volatile 语义）。**发现机制双形态**：运行时扫描 `discoverProviders(dir)` / `createApp({ discover })`（动态 import 决定其为 Promise 返回）与 CLI 维护的 `units.ts` 显式注册表（标记行 codemod，幂等）——可混用，AgentApp 构造期同 token 去重（后注册覆盖先注册，与 Container 语义一致），装配期静态校验（查重/引用/toolSources）对两条路一视同仁。**CLI 独立成包** `@agentia/cli`（npm workspaces，零运行时依赖、纯 Node 内置）：`create` 脚手架项目、`g tool|skill|prompt|subagent <name>` 生成单元文件夹并登记注册表；kebab-case 命名校验，方法名 snake、类名 Pascal。注意双实例危害：消费方必须从同一模块实例 import 框架（装饰器 WeakMap 注册表不跨实例），smoke:turn7 因此统一走 dist。
- 2026-09-11：**R1–R5 一轮落地（v0.1.0）**。**R1 中间件**：`UnitMiddleware` 洋葱链（链序=注册序，`next(newInput)` 可改写、不调 next 即短路），**装配期包裹整个菜单**（`applyMiddleware`），对 engine 零侵入——trace 仍留 engine 层（改写为拦截器的 dogfooding 设想经评审放弃：unit span 生命周期与模型调用纠缠在 loop 内，强行外置反而割裂）；孤儿单元告警定义为「toolSources 收窄时被排除 provider 上的单元」。**R2**：typed 结果走 hidden `submit_result` 工具（engine 内部追加，菜单同名即装配冲突；校验失败回 is_error 让模型自我修正，system 指令追加在 volatile 尾部不污染缓存前缀）；zod 接入 duck-typed（`fromZod` 挂 `__zodValidate`，框架永不 import zod，序列化时自动丢弃函数字段）。**R3**：HTTP 宿主只产 handler 不 listen（/run 同步、/tasks 异步+轮询，失败也 200 带 error 与 rethrow:false 对齐）；`SqliteTaskStore` 用 Node 内置 `node:sqlite`（WAL 天然多进程安全，解 FileTaskStore 单写者限制）；OTLP 用 OTLP/JSON + 全局 fetch，零依赖。**R4**：`ModelClient` 结构面定义在 core（Anthropic SDK 天然满足），`createOpenAIClient` 手写请求/响应双向翻译（非流式模拟、cache token 恒 0、refusal 近似——三处近似边界写入头部注释）；`MemoryStore` 只有 load/save 两个钩子，水合在 contextInit 之后（用户种子优先），成功/失败路径都回写（失败路径 save 异常吞掉防掩盖原始错误）。**R5**：`defineModule` = providers + middleware 打包（模块级在前、应用级可覆盖同 token）；CLI 补 dev（tsx watch 转发信号）/ doctor（纯静态体检，不 import 用户代码）/ add（npm install + 注册表 codemod，解析真实包名含 file: 协议）。**全量验证改为 `npm test`（node:test）+ `npm run e2e`（CLI 端到端）**，老 smoke 脚本删除，唯一盲区 SystemPrompt 缓存布局已补进单测。
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

- 2026-09-11：**第三轮评审（聚焦 MINOR/NIT，并入 v0.2.2 未发布窗口）**。三路独立复审后逐条回读源码核实：无新增 BLOCKER/MAJOR，全是打磨项，本轮一次性修完（各带用例）。
  **语义 / 契约变更（在此锁定）**：① `TrimOptions.keepRecent` → **`keepToolPairs`**（`trimToolPairs` 的选项按「tool_use→tool_result 对数」命名，与 `createBudgetPolicy.keepToolPairs` 口径统一，彻底消除同名不同义）。② `Scheduler.at()` 校验 `when` 必须是合法 `Date` —— 非法日期原会算出 NaN 延迟并**立即触发**（无提示），现在直接抛错（与 `every()` 的间隔校验对称）。③ HTTP 方法不符的 405 文案由英文改中文（并补 `Allow` 头），与同文件其余错误统一。④ `RedisTaskStore.ttlSeconds` 校验由 `ttl < 0` 改 `!(ttl >= 0)` —— 原写法放过 `NaN`，会静默关闭 TTL。⑤ `InMemoryMemoryStore.load` 改用无原型对象（`Object.create(null)`）—— `{}` 上 `__proto__` 键会走原型 setter 被吞，与该键的 `flushMemory` 回写不对称（静默丢一条跨 run 记忆）；**行为变更**：`load()` 现返回无原型对象（与 `save()` 收到的形状一致），断言需展开后再比。⑥ `SqliteTaskStore.status` 列明确为「反规范化副本，仅供外部/DBA 按状态统计」（本 store 的 SELECT 只读 `json`）。
  **去重 / 死代码**：`core/json.ts` 新增 `truncateWithMark` 供 `engine/loop.limit` 与 `engine/replay` 共用（`asString` 改复用 `stringifySafe`）；`store.ts` 新增模块级 `nextTaskId()` / `isThenable()`（后者原在 `async.ts` 私有、`scheduler.ts` 另写一份鸭子判定）；`withRunContext` 改重载（同步 fn → `T`，async → `Promise<T>`，去掉 `as Promise<T>`）；删除 `DecoratedMethod.fn`（无消费者）、`loop.ts` 恒真的 `stopReason === 'end_turn'`、`trimming.ts` 两个不可达分支、`module.ts` 的 `_tools ?? []`、`async.ts` 的 `this.app = app`；`runAgent`/`runAgentScoped` 的缺省 `64_000`/`40` 提为模块常量；`loop.ts` 补记 `cache_creation_tokens` 属性。
  **文档一致性**：roadmap R7 删去已落地的「InMemoryTaskStore 无界增长」；spec §10 Turn 4 的「缺省字符/4」更正为 CJK 感知启发式；`runtime/memory.ts`、`container/container.ts`、`engine/types.ts` 中指向重构前 `run/*.ts` 的注释改为 `runtime/*.ts`；`usage-guide.md` 的 `g tool fetch_weather`（下划线非法）示例改 kebab-case；`engine/types.ts` 误挂在 `RunAgentOptions` 上的 `ModelClient` JSDoc 归位；`toolkit/asset.ts` 的「每次调用现读」注释澄清（当装饰器 spec 值是加载期读一次）。
  **CLI / 官网**：`doctor` 入口检查改用与框架 `ENTRY_CANDIDATES` 一致的候选集（原只认 `index.ts`，合法 `.js/.mts` 单元被误报）；`add` 的本地路径补 `file:` 协议支持（原注释承诺、代码不认）；`cli.ts` 未知命令复用 `fail()`、用法串改用 `UNIT_TYPES.join`；`dev` 的 `NODE_OPTIONS --import` 路径加引号（含空格安装路径不再静默失效）；`inspector` 的 `text()` 补 `content-length`、body 超限由 500 改 413；脚手架 README 占位链接填真实仓库地址；`trace-view/fromTrace.js` 复用 `view.js` 的 `unitTypeOf`/`UNIT_ICO`；官网 `/llms.txt` 的「已知边界」改为从单源 guide §7 表当场抠出（不再手抄，消除与单源的漂移）；`discover` 对「路径是普通文件」给出明确错误而非原始 ENOTDIR。
  测试 215 → 225 例（框架：loop 四条终止分支、trimming 两条分支、memory `__proto__` 往返、redis `ttlSeconds: NaN`、scheduler `at(Invalid Date)`、discover 非目录）+ CLI 3 → 6 例（`resolvePackageName` 的 `file:` / 版本后缀、doctor 入口候选）。

- 2026-09-11：**Phase A 落地（成本与稳定性）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md`（四期，8 个分叉全按建议 A 拍板），任务计划见同目录 `phase-a-cost-and-stability.md`。
  **① 取消传播（行为变更，在此锁定）**：`AbortSignal` 从入口贯穿到 `ModelClient.messages.stream`（`stream` 的 params 加可选 `signal`）。新增 `AgentStopReason: 'aborted'`；中断**不冒泡异常**，run 以 `aborted` 收尾（`status=failed`）。`core/abort.ts` 新增 `combineSignals`（Node 18 无 `AbortSignal.any`）。`ToolRunContext.signal` 让工具自行决定是否尊重（框架不强制中断工具 —— 副作用无法回滚）；`@SubAgent`/`@Skill` 从 `ctx.signal` 透传，取消可传播。**`AsyncRunner.runTimeoutMs` 语义升级：从「放弃等待」变「到点 abort」**（对转发 `signal` 的客户端是真中止，token 不再继续烧；不转发者仍是放弃等待）。`createHttpHandler` 的 `POST /run` 在客户端断开（`res` close 且未写完）时中止在飞 run。
  **② 重试与退避（缺省开启，在此锁定）**：消费 `classifyError().retryable`（此前只产出、无人消费）。`engine/retry.ts`：`RetryOptions` + `DEFAULT_RETRY`（maxAttempts=3、baseDelayMs=500、maxDelayMs=8000、jitter=0.2）+ `resolveRetry`/`backoffDelay`/`sleep`（可中断）。**只重试「本次尝试未产出任何文本」的失败**——已流出的文本无法撤回。每次尝试开**独立 `llm.turn` span**（失败的带 `retry.attempt` 属性 + `llm.retry` 事件），`iterations` 仍只计成功的往返。贯通 `RunAgentOptions` / `RunInvocationOptions` / `AppOptions`（应用级缺省）。⚠️ 与 SDK 内置重试叠加，文档建议二选一调。
  **③ SSE 流式下发**：`POST /run` 内容协商 —— `Accept: text/event-stream` → `text.delta` / `run.end` / `error` 三类事件（`transport/sse.ts` 零依赖写出器，含 15s 心跳注释帧、`x-accel-buffering: no`）。**流开之后的错误只能以 `error` 事件表达**（HTTP 状态已定），流开之前仍用普通状态码。不带 `Accept` 的请求**逐字保持旧行为**。
  新增导出：`combineSignals`、`isAbortError`、`DEFAULT_RETRY`、`RetryOptions`。测试 225 → 254 例。

- 2026-09-11：**Phase B 落地（宿主硬化）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §4。
  **① 鉴权缝（只给缝，不给策略）**：`HttpHandlerOptions.authenticate?: (req) => unknown | Promise<unknown>`。
  调用时机锁定为「**读 body 之前**、**除 `/healthz` 外的所有路径**」（含 `GET /tasks/:id` 与未知路径 ——
  不暴露路径是否存在）。返回任意值即通过（框架**不转交**返回值：per-request 上下文请在钩子自己的闭包里存，
  不为「暂时没有消费点」的东西发明传递通道）；抛 `HttpException` 按其 `status`/`body` 回（想回 403 就抛 403）；
  抛其它错误回 401 `{ error: '未通过鉴权' }`，**原文只进服务端日志**（与 `exposeErrors` 同策略，防内部拓扑外泄）。
  **框架不实现 token/JWT/签名策略、不碰凭据 env** —— 那是宿主或反代的事；不做成 middleware 的理由：
  middleware 拦的是**单元调用**（run 内部），鉴权要拦的是 **run 入口**。
  **连接语义（此处锁定）**：鉴权失败时请求 body 未被消费，故 `req.complete` 为假时显式 `connection: close`
  —— 连接不可复用（残留字节会被当成下一个请求，与 413 同理），这也是「不收 body 省资源」的落点。
  **② 优雅停机 + 健康检查**：`AsyncRunner` 新增 `drain({ timeoutMs })` / `inFlight` / `isDraining`；
  `createHttpHandler` 的返回类型由裸函数升为 `HttpHandler`（仍可直接传给 `http.createServer`）——
  额外挂 `drain(opts?)` 与 `runner`，不破坏 `(req,res)` 调用形状。`drain()` 语义：拒新单 →
  等异步任务与在飞同步 run 收尾 → **超时后强制收口仍开着的 SSE 流**（其 run 因 `res` close 中止）；
  返回是否排空干净，超时返回 `false` 且**未完成的任务留在 store 里**（下次启动 `resumePending` 续跑，不是丢弃）。
  停机后 `POST /run`、`POST /tasks` → 503 + `Retry-After: 1`，而 `GET /tasks/<id>` **仍可轮询**
  （否则调用方拿不到在飞任务的结果）。**框架不订阅 `SIGTERM`/`SIGINT`**（不读 env、不做进程级决策）——
  `process.on('SIGTERM', () => handler.drain())` 是宿主的。
  `GET /healthz` → `HealthResponse { ok, inFlight, uptimeMs, draining }`：**不鉴权**（探针带不了凭据）、
  停机中也回 200；`ok` 恒 `true`（能回响应即进程活着），就绪与否看 `draining`。
  **`inFlight` 口径（此处锁定）**：正在处理的同步 run（并发闸门计数，含 SSE 流）**+** 已受理未完成的
  异步任务（queued + running）—— 与 `drain()` 的等待范围一致，使健康检查与停机判断看同一个数。
  **`AsyncRunner.submit` 语义变更（在此锁定）**：`drain()` 之后 `submit` 抛错（此前任何时刻都可提交）。
  新增导出：`HttpException`（值）、`HttpHandler` / `HealthResponse`（类型）。测试 254 → 275 例（+21）。
  真实 HTTP 实测（非仅单测）：`/healthz` 反映在飞数、鉴权先于读 body、SIGTERM → `drain()` 等慢 run 收尾返回 `true`。

- 2026-09-11：**Phase C 落地（能力成色）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §5。
  **① 成本硬管控（补 §6.4 欠账）**：新增 `AgentStopReason: 'budget_exceeded'`（**算失败**，`isSuccessStopReason` 不纳入）。
  `RunAgentOptions` / `AppOptions` 加 `maxTotalTokens` / `maxCostUsd`（先到先算，tokens 优先），贯通 `RunInvocationOptions` →
  `app.run` → `executeRun`。新增 `engine/budget.ts`：`createBudgetGuard({ maxTotalTokens, maxCostUsd, onExceed })`
  → `{ check(trace) }`。触发点是**每回合记账后**（`recorder.end(turnId, {usage})` 之后），口径 = 整个 trace 的
  `totalUsage`（**含子 agent**；input+output+cacheRead+cacheCreation）。
  **两处语义取舍（在此锁定）**：(a) **自然收尾的回合超限不改判失败** —— 只记 `budget.exceeded` 事件；
  只有「循环还要继续（模型要求调工具）」时才以 `budget_exceeded` 停下。理由：那次 run 的任务已经做完了，
  不该因为「最后一回合用超了」被追认成失败（设计里 `budget_exceeded` 的注解正是「run 没跑完」）。
  (b) 超限时**连带不执行本回合的工具**（避免继续产生副作用）。
  **与 `createBudgetPolicy` 的分工（文档并列讲清）**：前者是**发送前**改 messages（防 400 / 过早压缩），
  后者是**记账后**改 run 结局（控制花钱）—— 互补，不是一回事。**不做**：把硬管控塞进 `contextPolicy.beforeTurn`。
  ⚠️ 已知边界：**不是硬实时**（一回合跑完才判，可超一个回合的量）；`maxCostUsd` 依赖模型在价格表内，
  不在表里时成本恒 0、护栏不触发。
  **② 工具级超时 + 并发闸门**：`RunAgentOptions` / `AppOptions` 加 `toolTimeoutMs` / `maxToolConcurrency`。
  新增 `engine/concurrency.ts`：`mapWithConcurrency`（**结果保序**的有界并发 map，`limit` 非正/非有限 = 不限）
  与 `withTimeout`（超时返回 `TIMED_OUT` 哨兵，区分「超时」与「工具返回 undefined」）。主循环的
  `Promise.all(toolUses.map(...))` 换成有界 map。**语义锁定**：工具超时**不杀 run**（该条 tool_result 记
  `is_error`，模型可换路 —— 与「工具抛错不中断 run」同族）；超时 = **放弃等待**，`AgentTool.run` 没有 signal
  参数（想真停的工具自行读 `ToolRunContext.signal`）。缺省 `maxToolConcurrency = Infinity`（= 旧行为）。
  **③ OpenAI 适配器：真流式 + 多模态**：默认 `stream: true` + `stream_options.include_usage`，解析 `data:` 行；
  `delta.content` 逐 token 触发 `on('text')`；`tool_calls` 按 **`index` 归并**累积后再汇成 `tool_use`
  （`id`/`name` 取**首次出现**，`arguments` **拼接** —— 分片与并行交错都是易错点，各带单测）；
  `usage` 取自最后一个 chunk；`[DONE]` 为结束哨兵；畸形分片跳过不毁流；缺 id 补 `call_N`。
  **内容协商（此处锁定）**：**按响应实际形态解析**（`content-type` 含 `event-stream` 才走流式）——
  部分兼容端点会忽略 `stream:true` 直接回 JSON，此时退回一次性（与旧行为一致）。仍保留的近似：
  cache token 恒 0、`content_filter→refusal` 近似。多模态：`renderBlocks` → 文本块 `{type:'text'}`、
  图片块 `{type:'image_url'}`（base64 编 data URL、url 源透传）；**无图时回落纯字符串**（兼容只吃 string 的端点）。
  **顺带修**：适配器此前**未转发 `signal`**（与 guide/spec 一直声称的「内置适配器都转发 signal」不符）—— 现已转发。
  新增 `OpenAIClientOptions.stream`（设 false 退回一次性）。
  **④ 会话持久化**：新增 `runtime/session.ts`：`SessionStore`（`load` / `append`，**append-only**）+
  `InMemorySessionStore`；`ExecuteRunOptions` / `RunAppOptions` 加 `session?: { store, id }`
  （**不放进 `RunInvocationOptions`** —— store 实例不可序列化，transport 不替调用方传）。
  语义：run 前 `load(id)` 拼在传入 messages **之前**；收尾 `append` 本轮消息 + 回复。**三条不变量（在此锁定）**：
  (a) **只有跑成功的轮次才回写**（判据是 run 终态而非「没抛异常」—— error/max_tokens/budget_exceeded/aborted
  同样「没跑完」）；(b) 历史**以 assistant 结尾**（无文本输出时补占位）—— 否则下一轮出现连续两条 user 撞 API 校验；
  (c) 只存**对话轮次**，run 内部 tool 往返不进历史（要完整过程用 `traceToMessages`）。
  **与 `MemoryStore` 正交**（键值黑板 vs 对话历史），可同时用。读/写失败均吞掉（同既有原则）。
  **⑤ 任务完成回调**：`transport/async.ts` 新增 `TaskSink { onFinished(rec) }` + `AsyncRunnerOptions.taskSinks`；
  在 `#execute` 的 finally 里**逐个 await**、**抛错被吞**，且**先通知 sink 再递减在飞计数**（`drain()` 返回时
  保证回调已发完）。传快照副本。webhook 后置（sink + 自家 fetch 即可，不引「出站请求 + 签名 + 重试」）。
  新增导出：`createBudgetGuard` / `mapWithConcurrency` / `InMemorySessionStore`（值）、
  `BudgetGuard` / `BudgetGuardOptions` / `BudgetSnapshot` / `SessionStore` / `TaskSink`（类型）。
  测试 275 → 322 例（+47）。真实端到端实测：本地假 OpenAI 兼容端点（真 SSE 分片）→ 适配器（真流式）
  → HTTP 宿主（A3 SSE）→ 客户端**逐帧到达**（+40/157/279/399ms）；带工具的一轮 `maxTotalTokens=100`
  → `stopReason='budget_exceeded'` 且**工具未被执行**。

- 2026-09-11：**Phase D 落地（生态）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §6。
  **① MCP 桥（duck-typed，框架零依赖）**：新增 `integrations/mcp.ts`（只依赖 core）：结构面
  `McpClientLike { listTools(); callTool(name, args) }` + `mcpTools(client, { prefix, server, timeoutMs }) → AgentTool[]`；
  **不 import MCP SDK、不含任何传输实现**（stdio / StreamableHTTP 归独立可选包，本仓库 `scripts/e2e-mcp.ts`
  留了一份最小连接器供参考）。
  **接入点偏离设计（此处锁定）**：设计写的是「`createApp({ providers })` 里放个 `useFactory` 即可」——
  **落地时不成立**：菜单只从装饰器注册表收集（`useFactory` 的返回值根本不进菜单），且 `Container.resolve`
  是同步的（`await mcpTools(...)` 塞不进去）。零新机制的做法是给 `AppOptions` 加 **`tools?: AgentTool[]`**：
  裸工具直进主菜单，且与装饰器单元**完全同等** —— 同过中间件链、同进重名查重（**不是旁路**，两条用例分别钉住）。
  **语义**：名字 = `prefix + 归一化原名`（非 `[A-Za-z0-9_]` → `_`，连续分隔符收成一个；缺省 `mcp_<server>_`，
  没给 `server` 时 `mcp_`）；归一化后**空名 / 撞名 / 超 64 字符一律装配期抛错**（不静默改名 —— 那会得到一个
  调不回去的名字）；**原名**每次调用写进发起 turn 的 `mcp.tool` attribute（审计 / 回放要还原它才能回调 server）；
  `inputSchema` 原样透传（engine 的子集校验器在 `callTool` 之前先校验）；`callTool` 抛错 → 该条 `is_error`
  且**不杀 run**；**协议层 `isError: true` 框架看不见 —— 必须由连接器转成抛错**（否则模型以为成功）。
  桥自带 `timeoutMs`（缺省 60000）= **放弃等待**（拿不到 server 侧取消句柄），与 engine 的 `toolTimeoutMs`
  **双重计时、谁短谁生效**。**不做**：`sampling`（server 反向请求模型）/ `resources` / `prompts` 原语、连接池。
  **② evals**：新增 `src/eval/`（**叶子消费模块**，只依赖公共面、无反向依赖）：`scriptedClient(steps)`
  与 `defineEval<T>({ name, app, cases, expect })`。**语义锁定**：步骤在 `finalMessage()` **成功返回后才前进**
  （用函数步骤 `throw` 模拟 429 时，重试会**重放同一步** —— 想验重试就这么写）；`scriptedClient`
  **真的把文本块经 `on('text')` 吐出去**（onText / SSE 链路在 eval 里按真实路径走；`tests/helpers` 的 mockClient
  是忽略 `on` 的，两者定位不同）；`run()` **不抛**（用例失败进报告，一次跑完能看到所有回归），只有
  「应用建不起来」才冒泡（那是环境错误不是回归）；`app()` 一轮只调一次（用例间复用装配，避免掩盖装配期状态泄漏）；
  失败 case 带 `trace`，报告含 `stopReason`。**补 `EvalCase.opts`**（透传 `app.run`）—— 没有它就**断言不了
  `result.typed`**：`resultSchema` 是 per-run 的，而 `app` 是不带它的。
  **③ 指标**：新增 `integrations/metrics.ts` 的 `metricsSink(opts)` —— **天然满足 `TraceSink`**，
  `createApp({ sinks: [metricsSink()] })` 即接入，**零新出口**（与 `createOtlpExporter` 同款）；另给
  `snapshot()` / `render()`（Prometheus 文本，手写零依赖）/ `reset()`。**口径锁定**：`tokens` = 四类之和
  （与 `BudgetGuard` 一致），分项在 `render()` 里以 label 给出（信息不丢）；分位是**窗口内精确值**
  （最近 rank 法 + 环形窗口，`windowSize` 缺省 1024）—— **不是** Prometheus 原生 histogram / summary，
  代价是只反映最近 N 条 run，收益是长跑宿主不被无界数组拖住；**根 span 未收尾**（失败路径的半截 trace）
  的 run 不进延迟样本。`export: 'otlp'` **构造期抛错**（OTLP metrics 后置，响亮失败好过给一份空指标）。
  **④ 提示词版本化**：`SystemPromptOptions.version` + 只读 `SystemPrompt.version`；`RunAgentOptions.systemVersion`
  落 **run 根 attribute `system.version`**；`AgentApp.run` 从**当次**的 `SystemPrompt` 实例自动带上
  （单次 `{ system }` 覆盖时版本跟当次走）。**不放进 `RunInvocationOptions`** —— 版本是提示词的属性，
  不该由 transport 负载指定。`system` 传已拼好的 `SystemParam` 时**不写该 attribute**（不写空串冒充实有版本）。
  **不做**：版本库 / 回滚 / A-B 实验平台。
  **⑤ 多租户配额（不做子系统，给组合范式）**：`middleware`（拦在单元调用前；超限抛错 → 该条 `is_error`、
  **被拦下的单元不执行**、run 不崩）+ `TraceSink`（收尾后按租户记账 —— sink 在 run 的 async 上下文里投递，
  **读得到黑板**）+ `BudgetGuard`（单次 run 上限）三者组合；存储（内存 / Redis / DB）与超限策略是使用者的。
  两条独立：**被拦下的 run 仍然要记账**（模型的钱已经花了）。`usage-guide §6` 里那 20 行示例被单测
  **真跑一遍**（文档的写法必须真能工作，是仓库既有约定）。
  **验证**：新增 `npm run e2e:mcp` —— 真接**第三方 server**（`uvx mcp-server-time` v1.30.0，真 stdio JSON-RPC：
  `initialize` → `notifications/initialized` → `tools/list` → `tools/call`）→ 连接器 → `mcpTools` → `createApp`
  菜单 → 真跑一轮：模型经 MCP 工具拿到**真实时区时间**并写进最终答案；`system.version` / `mcp.tool` 落 trace；
  metrics 从这次 run 派生正确；`agentia doctor` 认到 MCP 单元。无网 / 无 uv 的机器自动回落
  `scripts/mcp-fixture-server.py`（同一协议面；夹具的工具名带 `-`，顺带把归一化那条路径也验了）。
  测试 322 → 363 例（+41：MCP 13 / 指标 9 / evals 10 / 配额 4 / 提示词版本 5），另在 `tests/types/dx.types.ts`
  并入 8 处类型断言（`@ts-expect-error` 钉住「应当报错」的场景：缺 `callTool` 的结构面、`tools` 的元素形状、
  `version` 只读、`systemVersion` 类型、`export` 只认两个字面量等）。
  **顺带修官网 API 页（既有漂移，非本次引入）**：`packages/website/src/fragments/api.html` 是**手写**的导出速查
  （不像 `llms.txt` 从 `usage-guide.md` 派生），此前已漂：`SpanKind` 写成含不存在的 `'internal'`、
  `trimToolPairs` 还挂着改名前的 `keepRecent`、A/B/C 三期的导出（`createBudgetGuard` / `mapWithConcurrency` /
  `combineSignals` / `InMemorySessionStore` / `TaskSink` / `HttpException` / `HealthResponse` / `TraceSink` …）
  大量缺失 —— 而 D 期四个新的全没进。本次逐项补齐到**对导出面零缺口**，并新增守卫测试
  `tests/docs/api-page.test.ts`：① 正向（「X 选项」表首列必须是 `X` 的成员含继承链，其余表必须是 `src/index.ts`
  的导出名）；② **反向全覆盖**（导出面的每个导出都必须在页面上出现 —— 防「代码有了、文档没写」）。
  `index.html` 的 hero 数字（「140+ 例单测」）与 `docs.html`（新增「稳定性与流式 / 宿主硬化 / 成本硬管控 /
  生态与观测」四节）同步更新。测试 363 → 367。

- 2026-09-13：**可观测口径对齐 + 生产配方文档 + 部署示例**。修一处 spec 自相矛盾：§9.3 原写
  「生产：OTLP 导出 + span 与 run 记录同库存储」，读起来像框架内建「同库存储」，与本文件「trace 出口缝」
  条目锁定的**只保证出口**口径冲突（frame 只有 `TraceSink`，没有任何存储实现）。已改 §9.3 为
  「同库存储 = sink 配方之一，非内建」。
  **新增 `docs/observability.md`**：把出口边界讲清 + 四条**现成 sink 配方**（按 runId 落库检索 /
  日志关联 / 采样 / 脱敏），全部零 engine 改动、零新增依赖、零新出口 —— 正好兑现 §9.3 那句「同库存储」。
  **新增 `examples/complete/`**：完整示例（四类单元 + 显式注册表 + 三种触发 + 鉴权缝 + 全观测栈 + 优雅停机），
  并把观测栈接成真实链路（metrics 全量 → 采样 → 脱敏 → [落库, 日志]）。**`examples/observability/` 升为本地小包**
  `@migor/agentia-observability`：示例要用这四个 sink，而 `tsc` 的 `rootDir` 不允许跨目录引源码 —— 做成小包
  与仓库对 `packages/trace-view` 是同一套办法（零重复、无 rootDir 取巧）。
  **usage-guide 补「HTTP 端点速查」表**（`POST /tasks` 的 body 形状此前没写；表格格式经确认不会踩到
  `usage-guide.test.ts` 的表格校验 —— 该测试只收「首列是单个反引号标识符」的行）。
  **Docker 修正**：实测 registry 上最新只有 0.2.1，且**缺** `metricsSink` / `mcpTools` / `defineEval` /
  `createBudgetGuard` / `registerDefaultTraceSink` —— 两个示例的 Dockerfile 因此**无法**用 `npm install` 构建
  （上一版是我留下的缺陷）。改为 `dependency: file:../..` + **以仓库根为构建上下文**（镜像里先从源码构建框架），
  发布后改回 `^0.2.2` 即可退回常规单包写法。`.dockerignore` 放**仓库根**（Docker 只认上下文根上那一份）。
  **不改框架实现**（`src/` 零改动）；sink 配方的写法由 `tests/docs/observability.test.ts` 真跑一遍钉住
  （仓库既有约定：文档里的写法必须真能工作）。
  **自查补漏**：`sqliteTraceSink.getSpans()` 此前声明 `Span[]` 却只塞了 `attributes`/`events`
  （`as Span` 硬断言）—— 既骗类型、又丢掉表里全部反规范化列（name/kind/耗时/tokens/errorType）；
  改为返回 `SpanRow[]`（真实列），用例同步加强。官网 hero 单测数 `360+` → `380+`（实际 387），
  `docs.html` 的端点注释补 `/healthz`（两者都是手写、无自动校验，按 AGENTS.md 须人工同步）。
  **跑真机时发现一处没文档的缝**：HTTP 宿主**不持有 model client**（同步 `/run` 走
  `app.run(messages, opts)`，`/tasks` 才经 `AsyncRunner` 的 `client`）—— 想接 OpenAI 兼容端点
  只能靠 `ANTHROPIC_BASE_URL` 或自己包一层 `AppCallable`，而**两者都没写进文档**。已在 usage-guide
  §宿主 补「换 model client 的缝」小节（含 `AppCallable` 包一层的写法），并让 `examples/complete`
  支持 `OPENAI_BASE_URL`（本机用 DeepSeek 真跑验证：OpenAI 协议与 Anthropic 兼容协议两条路都跑通）。
  **不改框架实现**（`src/` 仍零改动 —— 这是组合缝，不是缺功能）。

- 2026-09-13：**架构自审 → 消除未声明的分层依赖 + 补分层守卫**。用脚本解析 `src/` 全量 import 图，与 AGENTS.md 的
  「分层单向」硬约定对照，发现两处不符：① `store → runtime`（`TaskRecord` 的 `spec`/`status` 需要，属未声明的**兄弟层**依赖）；
  ② 约定里写的 `transport ← toolkit` 实际不存在（toolkit 不引 transport，transport 只被 `index.ts` 转发）。
  修法为**「纯数据下沉 core、共用入参契约下沉 engine」**：`core/run.ts`（`RunStatus`/`RunMeta`）、`core/blackboard.ts`
  （`Blackboard` 类型族）、`engine/spec.ts`（`RunSpec`/`RunInput`/`RunInvocationOptions`/`normalizeMessages`），
  删除 `runtime/types.ts` 与 `runtime/spec.ts`。改完 store 与 transport 都不再引用 runtime，依赖图无环。
  **导出名零增删**（仅换来源文件），故官网导出表、`api-page.test.ts` 的反向覆盖与导出计数均不受影响。
  新增 `tests/architecture/layering.test.ts` 把该约定变成可执行断言（允许边集合 + 无环 + src 不引 src 之外；已验证注入违规会精确失败）。
  **注**：`RunSpec` 不能直接下沉 core —— 它依赖 `engine/types`（`ContextPolicy`）与 `engine/retry`（`RetryOptions`），
  硬塞进 core 会变成 core 反向依赖 engine（比原问题更糟），故落 engine；`AGENTS.md` 的链条描述同步改为实测形状。

- 2026-09-13：**性能深度审计 → 三处修复（语义变更在此锁定）**。方法上先纠正自己：读代码猜热点两次都猜错
  （先猜 `recorder.snapshot()` 的 O(n²)、再猜 `contentToText` 里的 `JSON.stringify`），改在**构建产物**上跑 CPU profile
  （tsx 下采样会被转译噪声淹没，采不到真因）才看见事实。
  ① **预算策略的 token 估算超线性**：`beforeTurn` 每回合重估整段历史 → O(回合 × 上下文)；profile 显示占框架 CPU 约 88%，
  160 回合 run 的估算净开销 399ms（10→160 回合增长 ×103）。新增 `engine/trimming.ts` 的 `createTokenCounter`
  （缓存已计前缀、只估新增消息；三重失效判据：换数组 / 长度变短 / **边界元素对象标识变化** —— 第三条覆盖
  「同数组同长度但原地覆写」，只有长度判据会漏），`createBudgetPolicy` 改用它；并把估算器自身的逐码点 `codePointAt`
  循环换成正则扫描（BMP 用 `replace` 数长度差、增补平面用 `.test()` 守卫后再 `matchAll`；**口径逐字不变**，
  6 个样例含非 BMP 汉字与 emoji 结果一致）。合计：同负载吞吐 3411 → 26946 runs/8s（7.9×），估算占比 88% → 45.3%
  且不再有单一热点。**停止点**：剩余最大单项 `stringifySafe`（约 30%）不再优化 —— 框架 CPU 本就亚毫秒级/run，
  相对模型往返是秒级，继续投入对用户零影响。
  ② **SSE 无背压控制**：`res.write()` 的返回值被忽略，下游「连得上但不读」时无界缓冲（代码级定证：下游连续 20000 次
  回报未消费，写入器仍写满 1.28MB）。`sseWriter` 改盯 `res.writableLength`，超过 `SseWriterOptions.maxBufferedBytes`
  （缺省 8 MiB）即收口并回调 `onBackpressure`；`HttpHandlerOptions.sseMaxBufferedBytes` 透出，`createHttpHandler`
  据此 `abort` 对应 run（不再为已不消费的客户端白花 token）。做的是**有界缓冲 + 超限收口**而非静默丢帧 ——
  丢帧会让客户端拿到看起来正常、实则残缺的输出；也不做「等 drain 阻塞」，因为 `onText` 是同步回调 `(delta: string) => void`，
  真阻塞要改公开签名。**保留**：断连处理（`res.once('close')` → abort）、15s 心跳、`drain()` 强制收口 SSE。
  ③ `agentLoop` 的 `messages.splice(0, n, ...next)` 受 V8 实参个数上限约束（实测 12 万项 ok、30 万项抛 `RangeError`），
  抽 `engine/loop.ts` 的 `replaceMessages()` 用循环逐项写，彻底无上限。
  另：`AsyncRunner.awaitTask` 由「每 5ms 轮询 store（等 30s ≈ 6000 次读）」改为**终态事件唤醒**（`#taskWaiters` 在
  `#execute` 的统一出口唤醒）；`intervalMs` 降级为缺省 250ms 的**兜底轮询**，只服务「终态由他进程写入的异步 store」。
  四条均带守卫测试并逐个做**变异自证**（回退修复即失败）。**`AGENTIA_VERSION` 保持 0.2.1 不变** ——
  该常量反映**已发布**版本，0.2.2 发布时再同步（官网 API 页的描述也已写明这条规则）。

- 2026-09-13：**官网正式化 + 动效补齐**。官网是对外产品页，清理四类「开发过程」内容：开发指标（hero 的「380+ 例单测」
  → 产品属性）、版本对比语言（「旧行为逐字不变」）、内部结构描述（「分层单向」「只依赖 core」「`src/index.ts` 是唯一出口」
  「叶子消费模块（零反向依赖）」）、实现状态与设计决策注记（「尚未实现」「不做子系统」「不加新机制」「只给缝、不给策略」）。
  **保留真实 API 语义**（如「超时是放弃等待而非取消，`AgentTool.run` 收不到 signal」），只做措辞正式化；
  并删掉 `playground.html` 里一段会随产物下发到浏览器的开发注释。动效新增：顶部滚动进度条（`Base.astro` 元素 + `nav-collapse.js` 零依赖驱动）、
  hero 终端光标、统计行错开弹入、复制按钮反馈、卡片辉光与侧栏指示条过渡 —— 全部由既有的
  `@media (prefers-reduced-motion: reduce)` 全局规则统一关闭。**CSS 动效块刻意放在 `global.css` 的「API 参考页」标记之前**
  （该标记之后整段被 `tests/docs/website-css.test.ts` 当作 API 页 CSS 校验）。
  **顺带修一个真 bug**：hero 统计行**线上一直不可见** —— `site.js` 的入场 timeline 先把所有 `[data-intro]` 置 `opacity:0`，
  再逐个点亮 5 个选择器，而 `.hero-stats` 也带 `data-intro` 却没被点亮，于是永久停在 `opacity:0 / y:26`
  （真浏览器实测确认；此前访客看不到那行统计数字）。

- 2026-09-11：**文档漂移审计 + 三处能力边界结论（HITL / 护栏 / 沙箱）**。
  **① 漂移修正** —— roadmap 的 ✅ 段声明了源码里根本不存在的东西，全部改为与源码一致：
  `ModelProvider` 抽象与「`AGENTIA_MODEL` 扩展为 `provider:model`」→ 实际是 `ModelClient`（core 结构面，
  Anthropic SDK 天然满足）且**从无 provider 路由**，换 provider 靠注入 client；`@AgentModule` 装饰器 →
  实际是 `defineModule({ providers, middleware })` 返回值（普通函数，无类装饰器、无 `main` 标记）；
  `app.use((call, next) => …)` → 实际是 `createApp({ middleware: [...] })`。改动落在 roadmap R1/R4/R5、
  spec §4/§10、官网 `docs.html`、`packages/cli/README.md`，并加全仓残留扫描。
  **② 能力边界结论**（三者同为「给缝不给子系统」）：**HITL** —— 闸门层**无需新机制**：`middleware` 返回值
  被引擎 `await`（`Promise.resolve(tool.run(...))`），故审批中间件可 `await` 决策再 `next()`；拒绝 = 不调
  `next()`（短路，副作用不发生），拒绝并让模型改道 = 抛错（记 `is_error`，不杀 run）；`toolTimeoutMs` 缺省 0
  不掐断等待。**真缺口是「跨进程挂起/续跑」**：`RunStatus` 无「待批准」态、循环位置（消息数组）不落库，
  且 `traceToMessages` 重放**有损**（assistant 原文未记录）—— 无法以重放假冒续跑，故**不做**，列为 R7 候选评估。
  **护栏** —— **不做子系统**（同「配额不是框架子系统」）：入参缝（包 `app.run` / `authenticate`）、工具前缝
  （`middleware`）、出参缝（包返回值 / `sinks`）已足，策略差异过大硬编码必错。**沙箱** —— **框架不执行模型
  生成的代码**（`@Skill`/`@Tool` 均用户代码，模型输出只成文本 / `tool_result`），无沙箱可言；代码执行隔离属
  **工具实现内部**（Docker / 子进程 / 微 VM），框架不参与。配方写入 `usage-guide` §6，边界写入 §7 已知边界表。

- 2026-09-13：**可观测 · 可调优（E/F/G 三期落地，8 个设计分叉按建议 A 拍板）**。缘起是框架定位 —— 「要长期使用、
  要能被观测、要能被调优」，而当时观测只到 **run 级**（`metricsSink` 的 label 只有 `{kind}` 与 `{quantile}`，答不出
  「哪个单元慢/贵/爱失败」），调优旋钮虽齐却有**两处「看着有、实际不生效」**。设计文档见
  `docs/plans/2026-09-13-observability-tunability.md`。
  **E 期（观测下沉）** —— E1 在既有 `tool.output` 事件上补 `durationMs` + `errorKind`（普通工具**不建 span**，守住
  `26707ef` 控 trace 体积的决策）；E2/E3 把指标下沉到**单元级**（`tool` 读事件、`skill`/`subagent` 读 `unit` span，
  含 token 与成本）与**模型级**（`llm.turn` 的 span name 即模型 id，另出 `model_unpriced_turns_total`）；
  E4 补 Prometheus 原生 **histogram**（可跨实例聚合），窗口精确分位作为 gauge 并存；E5 让 `export:'otlp'`
  从「构造期抛错」变成**零依赖手写 OTLP/JSON**（与 `createOtlpExporter` 同款做法）。
  **F 期（成本可调优）** —— F1 内置价格表开放为 `priceOverrides`（覆盖/追加，非法单价构造期抛错），
  **且透传进子 agent/skill 的子循环**（`ToolRunContext.priceOverrides`），不再出现「主 agent 有成本、子 agent 恒 0」；
  F2 未定价模型**不再静默**：turn 上记 `usage.unpriced` 事件 + `onUnpricedModel` 回调（每作用域每模型一次、抛错被吞）
  + 指标计数 —— 定价缺失是宿主配置问题，**不改变 run 结局**（否决「让 run 失败」）；F3 成本归因到模型与单元。
  **G 期（调优闭环）** —— G1 `buildRunReport` / `mergeRunReports` / `renderRunReport` 纯函数报告 +
  CLI `agentia report <trace.jsonl>` 薄壳；G2 单元排行视图落在 `@migor/trace-view`（`summarizeTrace` /
  `renderSummary`），`agentia dev` 面板直接消费；G3 每个 run 的根 span 写 `config.*` **生效配置快照**
  （缺省值也记，函数型选项只记「配没配」）；G4 `createHttpHandler({ metrics })` 内建 `GET /metrics`
  （**不鉴权**，与 `/healthz` 同档）。
  **落地时对设计的四处修正**（都朝"更诚实/更少重复"）：① E1 未新增 `status` 字段 —— 既有 `ok` 已是状态，
  改成补 `errorKind`（`invalid_input` / `timeout` / `threw` / `unknown_tool`），信息量更大且无冗余；
  ② F2 的 `usage.unpriced` 事件落在**该 turn span** 而非 run 根（turn 才能准确指出"哪次往返未定价"）；
  ③ G2 的排行**无法**复用 `buildRunReport`（trace-view 零依赖、要能在浏览器里跑；CLI 又零运行时依赖），
  故落成两条口径：`trace-view.summarizeTrace`（展示层，CLI 报告与 dev 面板同源）与
  `buildRunReport`（库层，含未定价/成本语义与跨 run 合并），分工写进 usage-guide；
  ④ **指标 `_count` 语义变更**：`run_duration_ms_count` 从「窗口内样本数」改为**累积观测数**（Prometheus
  直方图语义，可聚合），窗口只再约束分位 gauge —— 旧断言按新语义同步。
  另**顺带修一处 doc-vs-code 漂移**：`core/trace.ts` 从第一天就声明「`unit.usage` = 其子孙 `llm.turn` 的聚合，
  仅供展示、不计入 `totalUsage`」，但实现里**从未写入过**该字段；本轮在 `TraceRecorder.end()` 补上就地聚合
  （只累加 `llm.turn`，层层嵌套不双算），E2/F3 的单元 token 与成本才有数据来源。测试 414 → 462（+48），
  CLI 6 → 13，trace-view 6 → 10。

## 11. 开放项

- npm 包拆分/发布（core / runtime / transport）在发布阶段做；CLI 已独立为 `@agentia/cli`（workspaces），框架本体仍单包，均未发布。
- DI 的 property-injection 便利写法（标准装饰器下可行）待定。
- 模型缺省 `claude-opus-5`（`AGENTIA_MODEL` env 可覆盖），thinking 用 adaptive，流式优先。
- CLI 后续：`add`（接第三方单元包）、注册表与扫描混用时的冲突提示策略（`dev` 已落地并内建 inspector 面板）。
