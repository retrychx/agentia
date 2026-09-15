# Agentia —— 规格（v0.1 草案）

状态：讨论收敛后的书面化。锁定的决策在此，后续实现照此推进；契约先行。

## 1. 定位（一句话）

面向应用开发的**声明式 agent 服务开发框架**：TS 装饰器 + DI + 模块；主 agent 作为路由器调度 tool/skill/subagent/prompt 四类能力；**每次 run 产出结构化结果与可观测调用树（trace、成本、指标）**；**交付物是可上线的服务而非对话助手**（trace 是必需品：既是调试表面也是审计记录，见 §9）；运行时自研、参考 Claude 设计，底层调用 Messages API。

> 不是“agent 聊天 SDK”，是“把 agent 做成服务的框架”。文本只是副产品，agent 执行出的活 + 结构化产物才是产品。
> 服务交付靠**事后**调试，所以可观测与能力声明同级：**四类能力决定它能做什么，trace 决定你敢不敢上线**。

## 2. 运行模型：run（一次运行）

对话助手的“会话=聊天”直觉作废。模型是：

```
触发(请求/事件/定时) → 主 agent 作为路由器编排阶段 → typed 结果 + 产物/副作用 出
```

- **run** = 一次任务实例。入参 = 任务 spec；出参 = 结构化结果。
- **run scope 上下文**：在单次运行内累积（blackboard），结束即释放。跨运行记忆是次级问题。
- **主 agent = 路由器**：不确定阶段顺序，而是自主决定调用哪些能力、什么顺序。
- 能力（tool/skill/subagent/prompt）= 服务的**组成阶段**。

## 3. 能力契约（四个装饰目标）

| 能力 | 运行时本质 | 结果回到主 agent 的形态 |
|---|---|---|
| `@Tool(zod)` | 函数调用 | `tool_result`（值或 `is_error`） |
| `@Skill` | 指令 + 脚本，受限子运行 | 产物/结论 |
| `@Prompt` | 纯文本资产（模板/宏/playbook） | 被选中时注入上下文 |
| `@SubAgent` | 独立 agent 循环 + 裁剪上下文 | 跑完的最终报告（隔离，中间产物不污染主上下文） |

统一抽象：这些能力对主 agent 都是“可调用项”，差异只在运行时执行方式。注册 = 把每个能力的 `name + description + 怎么用` 编译进主 agent 的菜单，由 LLM 决定调度谁。

## 4. 装饰器表面（草案）

**已定决策：标准装饰器（ECMAScript Stage 3），不用 `experimentalDecorators` / `emitDecoratorMetadata` / `reflect-metadata`。** 因此不支持构造器参数反射 —— DI 采用模块内显式 `providers` + factory 装配（`useFactory` 式）。框架的元数据一律显式声明（装饰器参数即配置，外加 `WeakMap`/注册表存储），不依赖 `design:paramtypes`。

```ts
// 落定形态（见 §10 R5）：模块**不是类装饰器** —— `defineModule({ providers, middleware })`
// 返回一个 `AgentModule` 值交给 `createApp({ modules })`；没有 `main` 标记（主 agent 即 app 本身）。
export class ProjectModule {
  // 落定形态：SubAgentSpec 的字段全部声明在装饰器参数里（字段表见 usage-guide 的
  // @SubAgent 一节）；被装饰方法体**从不执行** —— 运行时拉起独立循环，方法只是登记锚点。
  //（没有 role/canCall 这类字段：角色走 system，能力边是 provider 粒度的 tools 引用；
  //  canCall 只是 roadmap R7 的未做候选）
  @SubAgent({
    description: '按品牌规范评审设计稿，输出评审报告',
    schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    system: '你是苛刻的品牌设计评审员……',
    tools: ['image-tools'], // 可选：provider token 列表
    model: 'claude-opus-5',
  })
  reviewer() {}

  @Skill({ name: 'regenerate-logo', description: '…' })
  async regenerateLogo(ctx) { /* 指令 + 调 script */ }

  @Prompt({ name: 'brand-style', description: '品牌基调资产' })
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
- **预算/形态**：task budget、effort 档、流式、strict tools + 结构化输出（落地为 engine 内部追加的隐藏 `submit_result` 工具，见 §10 R2）。
- **别自研黑名单**：token 计数走 `/messages/count_tokens`（不用 tiktoken 近似）；错误分类用 SDK 类型化异常；缓存验证靠 `cache_read_input_tokens`。

## 6. 服务层（agent 服务的关键，区别于对话）

1. **run 生命周期状态机**：queued → running → succeeded/failed；运行记录 + 调用树（trace，见 §9）。
2. **结构化结果是一等契约**：收尾产出符合 schema 的 typed 结果 + 明确成败（落地为 engine 内部追加的隐藏 `submit_result` 工具，见 §10 R2）。
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
| Turn 6 | ✅ @Skill / @Prompt 能力 + 文件宿主耐久续跑 + AGENTIA_MODEL env 缺省 | toolkit / run store |
| Turn 7 | ✅ 目录约定（units/<name>/）+ 发现机制（扫描/注册表双形态）+ CLI（create/g） | toolkit / @migor/cli |

> Turn 7 的目录约定（`units/<name>/`）已于 2026-09-13 改为四分类目录（`src/tools` 等），见 §10 对应决策记录。

Trace 自 Turn 0 起内建（每个 LLM 往返都记账），Turn 1 后是完整形态。

## 9. Trace（调用树）—— 一等公民

Agent 服务靠**事后**调试，trace 是调试表面 + 审计记录（对话助手能现场看，trace 对服务交付是必需品）。

### 9.1 模型（对齐 OpenTelemetry 命名，便于接基础设施）

- 一次 run == 一条 trace；v1 里 `traceId == runId`，1:1。
- 树形层级：
  - `run`（根 span）= 整次运行
  - `capability` span = 对 **skill / subagent** 能力的调用（这两类才在内部开子循环、产生子 span）
  - `llm.turn` span = 每次模型往返，挂 usage（model / input / output / cache_read）
  - 普通工具与 `@Prompt` 资产**不建 span**，只记在发起它们的 `llm.turn` 上的
    `tool.input` / `tool.output` 事件（`engine/loop.ts`）
  - 子 agent = 一个 capability span，其内部能力递归成它的子孙
- span 属性：model、input/output/cache tokens、成本估计、状态、错误类型。
- 事件（logs）：工具入参/出参**正文默认截断**（入参/成功出参 2000 字符、失败出参 1000），
  完整正文由 `RunInvocationOptions.maxEventChars: false` 显式开启（缺省关）。截断只在**记账**侧，
  回给模型的 tool_result 不受影响。脱敏**不在框架内**（见 §9.3：那是 sink 缝外的事）。
- 状态：`ok` / `error` + 错误分类（可重试 vs 不可重试）。

### 9.2 上下文传播

- span 句柄**不放 RunContext**（`RunContext` 只有 blackboard）：engine 在每次能力调用时注入
  `ToolRunContext{ client, recorder, parentSpanId, signal, … }`，能力执行体（skill/subagent）
  用它把 `capability` span 挂到发起它的 `llm.turn` 下 —— 不用全局单例，
  并行 tool 调用的父子关系因此是准的。
- trace 记账**留在 engine 层**（`agentLoop` 内联记账），不包 TraceInterceptor ——
  「改写为内置拦截器」的 dogfooding 设想经评审放弃（capability span 生命周期与模型调用
  纠缠在 loop 内，强行外置反而割裂），见 §10 2026-09-11 R1 条。能力调用层的拦截由
  装配层的 `CapabilityMiddleware` 洋葱链承担，与 trace 记账是两条独立的缝。
- 异步化后：trace 上下文要跨队列传播 —— v1 同步先把 header 语义定好，实现后置（仍开放）。

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
- 2026-09-10：Turn 3 —— **主循环抽成 `agentLoop`（不自开 run 根，llm.turn 挂给定 parentSpanId）**；`runAgent` = 开 run 根后调它，`runAgentScoped` = 嵌套能力入口。**子 agent 复用同一循环**：开 `capability` span（挂发起它的 llm.turn 下）→ 独立 messages（只含任务 JSON，裁剪主对话）→ 内部 llm.turn 递归成 unit 子孙 → 仅最终文本以 tool_result 交回（隔离报告）。工具执行注入 `ToolRunContext{client, recorder, parentSpanId}`，recorder 用 `core/tool.ts` 的 `RecorderBackend` 结构面（core 不依赖 engine）。usage 天然跨两级聚合（同 recorder 求和）。
- 2026-09-10：Turn 4 —— **长上下文三策略分清不混**：`trimToolPairs` = **context editing**（整体丢旧 tool_use→tool_result 对，不掉内容、不额外调模型）；`compactMessages` = **compaction**（旧前缀做**服务端摘要**，摘要器由上层注入 —— 框架不替你造 token，真机可接 LLM / `/count_tokens`）；客户端剪裁 = Turn 3 子 agent 的独立上下文。预算决策用 `estimateTokens` 启发式（缺省 **CJK 感知**：CJK ≈1.5 字/token、其余 ≈4 字符/token，明确标注是估算非精确记账）。`createBudgetPolicy` 带滞回（`compactEvery` 防每回合反复压缩）；发生改写时在 run 根上记 `context.budget` 事件。触发点 = `agentLoop` 每回合发送前 `contextPolicy.beforeTurn(messages)`。
- 2026-09-10：Turn 5 —— **三类触发（同步 RPC / 异步任务 / 定时）共用同一份入参契约 `RunInput`**（string / messages / {prompt|text|messages}，`normalizeMessages` 归一），与 agent 装配解耦 —— **换宿主（HTTP/队列/DB）不换语义**。**at-least-once 幂等**：`AsyncRunner.submit` 以 `idempotencyKey` 去重，同键未失败（queued/running/succeeded）直接返回既有记录不重复跑；**失败的同键可重提新任务**。`executeRun` 增加 `rethrow:false`：异步宿主用它接住硬失败、以 `failed` 记录落库而非冒泡。异步耐久 = `TaskStore` 结构接口（v1 `InMemoryTaskStore`），队列/DB 宿主只需实现它。定时层 `Scheduler.every/.at` 依赖 AsyncRunner，周期任务幂等键按 interval 窗口分片。
- 2026-09-10：Turn 6 —— **`@Skill` = 代码控制的流程（脚本式 + `SkillContext.llm()`）**：方法体是确定性脚本，「要不要调模型 / 调几次 / 拿结果怎么算」写死在代码里；模型调用只在显式 `ctx.llm()` 时发生 —— 受限子运行复用 `runAgentScoped`（不自开 run 根），在 skill 自己的 `capability` span（attribute `skill`）下开 llm.turn 记账，中间结果不外泄，**方法返回值即产物/结论，以 tool_result 交回主 agent**。与 `@SubAgent`（模型自主循环 + 裁剪上下文）是可感知区别。**`@Prompt` = 纯文本资产**：编译成菜单里一个无副作用拉取型 AgentTool（模型判定需要时调用、文本以 tool_result 注入上下文 —— 我们现成的唯一「被选中」机制）。**标准装饰器下字段拿不到值/类引用 → `@Prompt` 只支持方法形态**（实例方法沿原型链、每次调用现算 volatile；static 方法表达常量资产），§4 草图的 `static brand = '…'` 字段形态不可行、已改方法。菜单四类能力（tool/skill/subagent/prompt）**共用命名空间**：装配期统一查重、重名即抛（§7 静态校验最小落地）。**异步耐久落地 = `FileTaskStore`（JSONL 一行一快照，last-wins 还原）**：`AsyncRunner`/Scheduler/触发层**零改动**，宿主重启 `new FileTaskStore(path)` 读回记录 + `AsyncRunner.resumePending()` 续跑 queued/running。缺省模型改 `resolveDefaultModel()`：**`AGENTIA_MODEL` env 覆盖**，无则回落 `claude-opus-5`。**确认不拆 npm 包**（core/runtime/transport 拆分后置发布阶段）。
- 2026-09-10：Turn 7 —— **目录约定 + 发现机制 + CLI 落地**。`units/<name>/` 一能力一文件夹：`index.ts` 入口 default export（类 → token=文件夹名的 useClass / Provider / Provider[]），长文本资产放文件夹内 `.md`，`asset(import.meta.url, rel)` 现读不缓存（保 @Prompt volatile 语义）。**发现机制双形态**：运行时扫描 `discoverProviders(dir)` / `createApp({ discover })`（动态 import 决定其为 Promise 返回）与 CLI 维护的 `units.ts` 显式注册表（标记行 codemod，幂等）——可混用，AgentApp 构造期同 token 去重（后注册覆盖先注册，与 Container 语义一致），装配期静态校验（查重/引用/toolSources）对两条路一视同仁。**CLI 独立成包** `@migor/cli`（npm workspaces，零运行时依赖、纯 Node 内置）：`create` 脚手架项目、`g tool|skill|prompt|subagent <name>` 生成能力文件夹并登记注册表；kebab-case 命名校验，方法名 snake、类名 Pascal。注意双实例危害：消费方必须从同一模块实例 import 框架（装饰器 WeakMap 注册表不跨实例），smoke:turn7 因此统一走 dist。
- 2026-09-11：**R1–R5 一轮落地（v0.1.0）**。**R1 中间件**：`CapabilityMiddleware` 洋葱链（链序=注册序，`next(newInput)` 可改写、不调 next 即短路），**装配期包裹整个菜单**（`applyMiddleware`），对 engine 零侵入——trace 仍留 engine 层（改写为拦截器的 dogfooding 设想经评审放弃：capability span 生命周期与模型调用纠缠在 loop 内，强行外置反而割裂）；孤儿能力告警定义为「toolSources 收窄时被排除 provider 上的能力」。**R2**：typed 结果走 hidden `submit_result` 工具（engine 内部追加，菜单同名即装配冲突；校验失败回 is_error 让模型自我修正，system 指令追加在 volatile 尾部不污染缓存前缀）；zod 接入 duck-typed（`fromZod` 挂 `__zodValidate`，框架永不 import zod，序列化时自动丢弃函数字段）。**R3**：HTTP 宿主只产 handler 不 listen（/run 同步、/tasks 异步+轮询，失败也 200 带 error 与 rethrow:false 对齐）；`SqliteTaskStore` 用 Node 内置 `node:sqlite`（WAL 天然多进程安全，解 FileTaskStore 单写者限制）；OTLP 用 OTLP/JSON + 全局 fetch，零依赖。**R4**：`ModelClient` 结构面定义在 core（Anthropic SDK 天然满足），`createOpenAIClient` 手写请求/响应双向翻译（非流式模拟、cache token 恒 0、refusal 近似——三处近似边界写入头部注释）；`MemoryStore` 只有 load/save 两个钩子，水合在 contextInit 之后（用户种子优先），成功/失败路径都回写（失败路径 save 异常吞掉防掩盖原始错误）。**R5**：`defineModule` = providers + middleware 打包（模块级在前、应用级可覆盖同 token）；CLI 补 dev（tsx watch 转发信号）/ doctor（纯静态体检，不 import 用户代码）/ add（npm install + 注册表 codemod，解析真实包名含 file: 协议）。**全量验证改为 `npm test`（node:test）+ `npm run e2e`（CLI 端到端）**，老 smoke 脚本删除，唯一盲区 SystemPrompt 缓存布局已补进单测。
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
  preload 完成（`registerDefaultTraceSink` 为公开扩展点）。**顺带修正 §9.1 口径**：capability span 只由
  skill / subagent 创建，普通工具与 `@Prompt` 走 turn 上的事件（此前描述为四类能力一律建 span，
  与实现不符）。

- 2026-09-11：**第二轮回评修复（并入 v0.2.2 未发布窗口）**。上一轮修的是「辅助操作失败击穿主路径」，本轮把同类缝补完并关闭一处安全缺陷。以下语义变更**在此锁定**：
  **安全 / 正确性**：① `AgentApp` 装配重构——嵌套能力（子 agent / skill）的 `tools` 引用改从**中间件包装后**的每 provider 菜单解析（`wrappedByToken`），原实现取包装前的原始菜单，导致子 agent 内部每一次工具调用整体绕过中间件（鉴权 / 限流 / 审计 / 结果缓存全失效）——spec 曾记档的既知缺陷就此关闭；主菜单仍只取 `toolSources`，被排除的 provider 仅「不进主菜单」，其能力经显式 `tools` 引用仍可调用（孤儿告警文案同步更正）。② `engine/loop.ts` 的 `submit_result` 校验移入 try——畸形 resultSchema 只废掉该次提交（回 is_error），不再让整次 run 以 error 收场而与 trace 记的该回合 ok 自相矛盾。③ `runtime/run.ts` 的 `hydrateMemory` 包 try——与 `flushMemory` 对称，store 故障不再杀死 run。
  **宿主稳定性**：④ `AsyncRunner.submit` 订阅异步 store 的 `byIdempotency` Promise（原实现丢弃返回值，reject 即 unhandledRejection → Node ≥15 终止宿主；同一函数内 `save` 本有 `.catch`，属一防一漏）。⑤ `submit` 初始 `save` 的迟到 reject 仅在任务仍 `queued` 时改判，不再把已成功的 run 覆写成 failed（落库终态与真实结果一致）。
  **契约与资源**：⑥ `Trace.totalUsage` 只累加 `llm.turn` span——capability span 的 usage 语义锁定为「子孙聚合、仅供展示」，不参与求和（否则与子孙重复计数）；`core/trace.ts` 的类型注释同步更正。⑦ `FileTaskStore.compact()` 新增（append-only JSONL 压实为每 task 一行；TaskStore 接口之外的显式能力）。⑧ `InMemoryTaskStore({ maxRecords })` 新增内存闸门：超限从最旧**已终态**记录起淘汰，在飞（queued/running）记录永不淘汰；缺省 Infinity ＝ 不淘汰（旧行为）。⑨ `SqliteTaskStore` 补 `PRAGMA busy_timeout = 5000`——原实现只设 WAL，「多进程安全」的承诺实际不成立（第二个写者立即 `SQLITE_BUSY`，而 `#safeSave` 会把失败静默吞掉 → 记录无声丢失）。
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
  **CLI / 官网**：`doctor` 入口检查改用与框架 `ENTRY_CANDIDATES` 一致的候选集（原只认 `index.ts`，合法 `.js/.mts` 能力被误报）；`add` 的本地路径补 `file:` 协议支持（原注释承诺、代码不认）；`cli.ts` 未知命令复用 `fail()`、用法串改用 `CAPABILITY_TYPES.join`；`dev` 的 `NODE_OPTIONS --import` 路径加引号（含空格安装路径不再静默失效）；`inspector` 的 `text()` 补 `content-length`、body 超限由 500 改 413；脚手架 README 占位链接填真实仓库地址；`trace-view/fromTrace.js` 复用 `view.js` 的 `capabilityTypeOf`/`CAP_ICO`；官网 `/llms.txt` 的「已知边界」改为从单源 guide §7 表当场抠出（不再手抄，消除与单源的漂移）；`discover` 对「路径是普通文件」给出明确错误而非原始 ENOTDIR。
  测试 215 → 225 例（框架：loop 四条终止分支、trimming 两条分支、memory `__proto__` 往返、redis `ttlSeconds: NaN`、scheduler `at(Invalid Date)`、discover 非目录）+ CLI 3 → 6 例（`resolvePackageName` 的 `file:` / 版本后缀、doctor 入口候选）。

- 2026-09-11：**Phase A 落地（成本与稳定性）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md`（四期，8 个分叉全按建议 A 拍板），任务计划见同目录 `phase-a-cost-and-stability.md`。
  **① 取消传播（行为变更，在此锁定）**：`AbortSignal` 从入口贯穿到 `ModelClient.messages.stream`（`stream` 的 params 加可选 `signal`）。新增 `AgentStopReason: 'aborted'`；中断**不冒泡异常**，run 以 `aborted` 收尾（`status=failed`）。`core/abort.ts` 新增 `combineSignals`（Node 18 无 `AbortSignal.any`）。`ToolRunContext.signal` 让工具自行决定是否尊重（框架不强制中断工具 —— 副作用无法回滚）；`@SubAgent`/`@Skill` 从 `ctx.signal` 透传，取消可传播。**`AsyncRunner.runTimeoutMs` 语义升级：从「放弃等待」变「到点 abort」**（对转发 `signal` 的客户端是真中止，token 不再继续烧；不转发者仍是放弃等待）。`createHttpHandler` 的 `POST /run` 在客户端断开（`res` close 且未写完）时中止在飞 run。
  **② 重试与退避（缺省开启，在此锁定）**：消费 `classifyError().retryable`（此前只产出、无人消费）。`engine/retry.ts`：`RetryOptions` + `DEFAULT_RETRY`（maxAttempts=3、baseDelayMs=500、maxDelayMs=8000、jitter=0.2）+ `resolveRetry`/`backoffDelay`/`sleep`（可中断）。**只重试「本次尝试未产出任何文本」的失败**——已流出的文本无法撤回。每次尝试开**独立 `llm.turn` span**（失败的带 `retry.attempt` 属性 + `llm.retry` 事件），`iterations` 仍只计成功的往返。贯通 `RunAgentOptions` / `RunInvocationOptions` / `AppOptions`（应用级缺省）。⚠️ 与 SDK 内置重试叠加，文档建议二选一调。
  **③ SSE 流式下发**：`POST /run` 内容协商 —— `Accept: text/event-stream` → `text.delta` / `run.end` / `error` 三类事件（`transport/sse.ts` 零依赖写出器，含 15s 心跳注释帧、`x-accel-buffering: no`）。**流开之后的错误只能以 `error` 事件表达**（HTTP 状态已定），流开之前仍用普通状态码。不带 `Accept` 的请求**逐字保持旧行为**。
  新增导出：`combineSignals`、`isAbortError`、`DEFAULT_RETRY`、`RetryOptions`。测试 225 → 254 例。

- 2026-09-11：**Phase B 落地（宿主硬化）** —— 设计见 `docs/plans/2026-09-11-agent-service-hardening.md` §4。
  **① 鉴权缝（只给缝，不给策略）**：`HttpHandlerOptions.authenticate?: (req) => unknown | Promise<unknown>`。
  调用时机锁定为「**读 body 之前**、**除 `/healthz` 与 `/metrics` 外的所有路径**」（含 `GET /tasks/:id` 与未知路径 ——
  不暴露路径是否存在；`/metrics` 是 G4 后来加入的同档豁免，此处按现状表述）。返回任意值即通过（框架**不转交**返回值：per-request 上下文请在钩子自己的闭包里存，
  不为「暂时没有消费点」的东西发明传递通道）；抛 `HttpException` 按其 `status`/`body` 回（想回 403 就抛 403）；
  抛其它错误回 401 `{ error: '未通过鉴权' }`，**原文只进服务端日志**（与 `exposeErrors` 同策略，防内部拓扑外泄）。
  **框架不实现 token/JWT/签名策略、不碰凭据 env** —— 那是宿主或反代的事；不做成 middleware 的理由：
  middleware 拦的是**能力调用**（run 内部），鉴权要拦的是 **run 入口**。
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
  裸工具直进主菜单，且与装饰器能力**完全同等** —— 同过中间件链、同进重名查重（**不是旁路**，两条用例分别钉住）。
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
  **⑤ 多租户配额（不做子系统，给组合范式）**：`middleware`（拦在能力调用前；超限抛错 → 该条 `is_error`、
  **被拦下的能力不执行**、run 不崩）+ `TraceSink`（收尾后按租户记账 —— sink 在 run 的 async 上下文里投递，
  **读得到黑板**）+ `BudgetGuard`（单次 run 上限）三者组合；存储（内存 / Redis / DB）与超限策略是使用者的。
  两条独立：**被拦下的 run 仍然要记账**（模型的钱已经花了）。`usage-guide §6` 里那 20 行示例被单测
  **真跑一遍**（文档的写法必须真能工作，是仓库既有约定）。
  **验证**：新增 `npm run e2e:mcp` —— 真接**第三方 server**（`uvx mcp-server-time` v1.30.0，真 stdio JSON-RPC：
  `initialize` → `notifications/initialized` → `tools/list` → `tools/call`）→ 连接器 → `mcpTools` → `createApp`
  菜单 → 真跑一轮：模型经 MCP 工具拿到**真实时区时间**并写进最终答案；`system.version` / `mcp.tool` 落 trace；
  metrics 从这次 run 派生正确；`agentia doctor` 认到 MCP 能力。无网 / 无 uv 的机器自动回落
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
  **新增 `examples/complete/`**：完整示例（四类能力 + 显式注册表 + 三种触发 + 鉴权缝 + 全观测栈 + 优雅停机），
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
  ⇒ **已于 2026-09-14 发布 v0.2.2 时同步为 `'0.2.2'`**（`check-release.mjs` 四处一致通过）。

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
  「哪个能力慢/贵/爱失败」），调优旋钮虽齐却有**两处「看着有、实际不生效」**。设计文档见
  `docs/plans/2026-09-13-observability-tunability.md`。
  **E 期（观测下沉）** —— E1 在既有 `tool.output` 事件上补 `durationMs` + `errorKind`（普通工具**不建 span**，守住
  `26707ef` 控 trace 体积的决策）；E2/E3 把指标下沉到**能力级**（`tool` 读事件、`skill`/`subagent` 读 `capability` span，
  含 token 与成本）与**模型级**（`llm.turn` 的 span name 即模型 id，另出 `model_unpriced_turns_total`）；
  E4 补 Prometheus 原生 **histogram**（可跨实例聚合），窗口精确分位作为 gauge 并存；E5 让 `export:'otlp'`
  从「构造期抛错」变成**零依赖手写 OTLP/JSON**（与 `createOtlpExporter` 同款做法）。
  **F 期（成本可调优）** —— F1 内置价格表开放为 `priceOverrides`（覆盖/追加，非法单价构造期抛错），
  **且透传进子 agent/skill 的子循环**（`ToolRunContext.priceOverrides`），不再出现「主 agent 有成本、子 agent 恒 0」；
  F2 未定价模型**不再静默**：turn 上记 `usage.unpriced` 事件 + `onUnpricedModel` 回调（每作用域每模型一次、抛错被吞）
  + 指标计数 —— 定价缺失是宿主配置问题，**不改变 run 结局**（否决「让 run 失败」）；F3 成本归因到模型与能力。
  **G 期（调优闭环）** —— G1 `buildRunReport` / `mergeRunReports` / `renderRunReport` 纯函数报告 +
  CLI `agentia report <trace.jsonl>` 薄壳；G2 能力排行视图落在 `@migor/trace-view`（`summarizeTrace` /
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
  另**顺带修一处 doc-vs-code 漂移**：`core/trace.ts` 从第一天就声明「`capability.usage` = 其子孙 `llm.turn` 的聚合，
  仅供展示、不计入 `totalUsage`」，但实现里**从未写入过**该字段；本轮在 `TraceRecorder.end()` 补上就地聚合
  （只累加 `llm.turn`，层层嵌套不双算），E2/F3 的能力 token 与成本才有数据来源。测试 414 → 462（+48），
  CLI 6 → 13，trace-view 6 → 10。

- 2026-09-13：**目录约定去伞形词（四类分置）+ 伞形术语整体替换为 `capability`**。缘起是 `agentia create` 产出的
  `units/` 被指出「命名不太好」；核实后发现不只是名字 —— **仓库里同时跑着两套目录约定**（CLI / 文档 / 官网 / spec
  是项目根 `units/` + 根 `units.ts`；2026-09-13 新增的 `examples/complete`、`examples/deploy` 是 `src/units/` +
  `src/units.ts`），而 `tsconfig.tests.json` 明确 `exclude` 了那两个示例、仓库无 CI，**没有任何一步验证能发现**。
  另有一处同源 bug：脚手架 tsconfig 是 `include: ['src', 'units.ts']`，**漏了能力目录本身** —— 未登记进注册表的
  能力（discover 路线允许不登记）静默不参与类型检查（`tsc --listFiles` 实测可证）。三条一并收口：

  ① **目录约定改为四分类目录，放 `src/` 下**：`src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/` ——
  目录名就是类型（对齐 MCP 的 `tools/resources/prompts`、OpenAI Agents SDK、LangChain 的共同惯例：**不用伞形词**）。
  显式注册表改为 `src/registry.ts`。副作用是三处既存漂移**一次自愈**：示例的 `rootDir:"src"` 不用动、脚手架
  `include` 收缩为 `['src']`（漏 include 的 bug 消失）、示例与新约定自动一致。`agentia create` 会建出四个目录
  （空目录带 `.gitkeep`，让「新能力往哪放」对用户可见）。

  ② **`discover` 放宽为 `string | string[]`**：数组顺序即装配顺序；数组里任一目录不存在**报错**（显式给出的搜索
  路径不该静默落空）；跨目录重名 token 在发现期**留告警**（四个分类目录共用一套 DI token=文件夹名，装配期
  「后者覆盖」会静默吃掉一个）。`agentia g` 在**生成期**直接拦住跨目录同名，`agentia doctor` 报**错误**兜底
  （生成期 + 体检两层），装配期语义不变（不改运行时）。

  ③ **伞形术语整体替换** —— 类型：`UnitType→CapabilityType`、`UnitMiddleware→CapabilityMiddleware`、
  `UnitCall/UnitNext→CapabilityCall/CapabilityNext`、`SkillUnit/SubAgentUnit→SkillCapability/
  SubAgentCapability`、`UnitMetrics→CapabilityMetrics`、`UnitReport→CapabilityReport`、
  `UnitDecoratorContext→CapabilityDecoratorContext`；字段：`maxUnits→maxCapabilities`、
  `droppedUnits→droppedCapabilities`、`labelMode:'unit'→'capability'`、`MetricsSnapshot.units→capabilities`、
  `RunReport.units→capabilities`、`CapabilityReport.unit→capability`、`CapabilityCall.unit→capability`；
  观测面：`agentia_unit_*→agentia_capability_*`、标签 `unit="…"→capability="…"`、**trace span kind
  `'unit'→'capability'`**（`SpanKind` 成员）、trace-view 排行前缀 `unit:→capability:`、`UNIT_ICO→CAP_ICO`。
  内部标识符同步统一。中文侧「单元」一并改称「**能力**」—— 与既有的「能力包」（`defineModule` / `AgentModule`）
  **同族且语义相容**（一个能力包 = 一包能力），不引第二套词汇。

  **兼容性**：**运行时零破坏** —— `discover` 收的是路径，老项目 `discover:'units'` 照跑；只有 `create` / `g` /
  `doctor` 的**约定**变，且它们撞见根 `units/` + `units.ts`（老布局）时会明确提示迁移，不悄悄新建目录。
  **刻意破坏的只有观测面命名**（Prometheus 指标名、`unit=` 标签、trace span kind）—— 上面已逐条列出，便于对着
  改 dashboard。`src/index.ts` 的公共导出**数量不变**（仅改名），官网 api.html 的反向全覆盖计数不受影响。
  设计文档：`docs/plans/2026-09-13-typed-unit-dirs.md`（6 个分叉，F1=A · F4=B · 其余 A · F6=A+B）。

- 2026-09-13：**厂商 SDK 收敛到单一实例化点；依赖形态定为「纯依赖」**。缘起是对标业界后自问
  「`@anthropic-ai/sdk` 是否该做成 peer/optional、让用户不必感知」。三条实测事实锁死了结论：
  ① 公共类型面**直接使用** `Anthropic.MessageParam`（12 个 `.d.ts`、出现 32 次）→ 用户哪怕只走 OpenAI
  兼容端点**也必须**有它，否则类型编译不过、或（`skipLibCheck` 下）静默退化成 `any`；
  ② 既然如此，「可选」不成立，而「让用户单独再装一次」才是真正的奇怪 —— 故**依赖形态 = `dependencies`**
  （纯依赖，npm 自动装，用户零感知），**不做 peer/optional**；
  ③ 但框架内部**不再 `new Anthropic()`**：新增 `integrations/anthropic.ts` 的 `createAnthropicClient()`
  作为唯一实例化点，引擎经它取默认 client。使用者自定义只传 `apiKey` / `baseURL`，**不必直接依赖该 SDK**。
  分层随之调整：`engine` 新增对 `integrations` 的依赖（唯一用途就是取默认 client），`ALLOWED` 与 AGENTS.md 同步。
  **不做鸭子类型**：实测该 SDK 的错误类 `name` 恒为 `'Error'`、`type` 为 null，鸭子类型只能靠
  `constructor.name`（压缩即失效）—— 保留 `errors.ts` 的 `instanceof`（只做类身份判定、不做实例化），
  并把「双副本 → 分类退化为 unknown」记为已知边界。
  **未做（记入 roadmap）**：默认 client 换自研 fetch 实现 + 公共类型自有化 —— 那才是让 SDK 真正可选的正道，
  前置条件是先有「真 API 集成测试」（当前单测与 e2e 全用 mock）。

- 2026-09-14：**示例真跑纳入门禁 + 抖动可疑构造普查**。两件事的共同起因都是「文档指着说可跑/没人看清」。

  **① `examples/complete` 从「类型检查覆盖」升级为「真跑」**。此前 `examples/` 下 **0 个测试**、全仓没有一条脚本
  执行过它，而 usage-guide 与项目 README 都写着「完整可跑写法见 `examples/complete/`」。新增
  `scripts/e2e-examples.ts`（并入 `npm run e2e`，另留 `npm run e2e:examples` 单跑）：按示例**自己的构建脚本**
  真构建 → 真起服务 → 按它 README 逐条打端点（`/healthz` · 无凭据 401 · 同步 `/run` · SSE · 异步 `/tasks` +
  幂等键去重 · `/metrics` · SIGTERM 优雅停机）。模型侧是脚本内置的假 OpenAI 兼容端点（真 SSE，且把
  `tool_calls` 的 `arguments` **拆两片**下发），**不联网**、不需要任何 key。最有价值的一条断言不是响应文本，
  而是**假端点真的收到了 `echo: ping` 这条 tool_result** —— 即「四类能力真装配上、能力真被执行过」。
  过程中修掉两个会骗人的坑：(a) 用 `tsx src/main.ts` 起进程时 **SIGTERM 打在 tsx 的包装进程上**（应用收不到，
  以 143 退出）→ 改跑 `node dist/main.js`（也是部署形态，顺带把「示例能否构建」纳入门禁）；(b) 本地
  `file:../..` 被 npm 装成**快照拷贝**（实测是拷贝而非软链）→ 示例跑的是安装那天的框架，改了 dist 不生效；
  脚本把它换成指向仓库根的链接，本地与 CI 行为一致。

  **② CI 抖动：找到了，是「工具超时」那条 —— 而且根因在引擎，不在测试**。
  先纠正我自己的判断错误：一开始按 roadmap 的三个嫌疑做机制核查，认定它们**都不成立**
  （`SqliteTaskStore` 的 `busy_timeout` 是 5000ms 而测试只持锁 200ms；drain 几条的闸门由测试自己释放，
  超时不可能先到）—— 对这两个成立，但**把 `toolTiming` 一起划掉是错的**：我只看了两条 `>=` 断言
  （`Date.now()` 差值的下界，确实单调只增），漏了这条用例真正的主张是
  「20ms 超时**必须赢过** 60ms 的工具」—— 那是一场**只有 3 倍余量的计时器赛跑**。

  **复现（可重复，不是偶遇）**：8 倍 CPU 超订（64 个忙等 worker 压 8 核）下，
  `tests/engine/toolTiming.test.ts` 单文件 **29 次挂 1 次**（断言 `body.ok === false` 实际为 `true`）；
  PR #19 的 CI（Node 22、2 核 runner）也红了同一条。
  **判定实验**：绕过测试框架、单进程直接用引擎跑该场景 **1200 次 → 翻转 1 次**，样本
  `{ wallMs: 99, durationMs: 99, content: 'late' }` —— 工具那 60ms 的 sleep 实际花了 99ms，
  而 20ms 的超时**没先触发**。
  ⇒ **`withTimeout` 的超时不是硬保证**：事件循环被饿住时，它的计时器可能输给工具，
  于是**一个超出预算的工具被记成成功**（`ok: true`），超时护栏静默失效。
  （对照实验：把 `withTimeout` 单独拎出来跑同样两条 `setTimeout` 赛跑 3000 次 → **0 翻转**，
  说明裸赛跑本身在常规条件下是稳的，翻转需要引擎+验证路径的饥饿叠加。）

  **本 PR 做了什么**：把该用例改成**确定性**形态 —— 工具挂在一个只由测试释放的闸门上，
  断言前它**不可能** settle ⇒ 超时必然先生效，与调度无关（同负载下 **60/60 通过**）。
  原形态是「靠两条计时器定输赢」，改成「靠一个不可能满足的前提」，这是必要的：一个 3% 失败率的
  用例会让每次 CI 红都无从判断。

  **本 PR 没做什么（当日已补，见下条）**：**引擎那层没动**。修法方向是给 `withTimeout` 加**实测耗时兜底**
  （await 之后用 `Date.now() - startedAt >= timeoutMs` 再判一次，超时就记超时），但那是一次
  **语义收紧**——「21ms 完成的工具在 20ms 预算下会被记成超时」与当天的「记成功」不同，
  属于核心路径语义变更，要单独拍板 + 单独决策记录。⇒ **同日单独一单落地，见「2026-09-14 ②」**。

  **顺带**：同一个 PR 把四处「等到某状态」的墙钟预算等待收进 `tests/helpers.ts` 一份
  `waitFor(cond, what, budgetMs = 10_000)`（`host-hardening` 有 4 处默认 1000ms、比出过事的 scheduler
  那个还紧；四处各写各的：两份手搓 `waitFor`、两份「100×5ms 裸轮询再 assert」），超时抛
  **带条件描述 + 实测耗时**的错误，返回 `Promise<void>`（不是 boolean）。预算给足不是「加大余量」——
  这类等待验的是顺序/一致性，没有一处验延迟指标。反向验证：`tests/waitFor.test.ts` 证明条件永不满足时
  它仍会抛错自陈。

### 2026-09-14 ②：`withTimeout` 收紧为**硬保证**（工具级超时不再靠竞速定输赢）

**决定**：超时判定**不看竞速结果，只看实测耗时**。工具 settle 之后若
`settledAt - startedAt >= timeoutMs`，即便 `Promise.race` 已经把工具的返回值交回来了，也记 `TIMED_OUT`。
（`settledAt` 记在**工具 settle 的那个微任务里**，不是 `await` 恢复之后 —— 理由见下。）

**为什么必须改**：`Promise.race` **不是硬保证**。上一单已实测：8 倍 CPU 超订下，单进程直接用引擎跑
「60ms 工具 + 20ms 预算」1200 次 → **翻转 1 次**（样本 `wallMs/durationMs = 99`、`content: 'late'`），
即**一个超出预算的工具被记成 `ok: true`**，超时护栏静默失效。
护栏静默失效比没有护栏更危险 —— 使用者以为设了上限，实际上限会被调度运气吃掉。

**机制层面如实交代**：翻转的**单一起因尚未完全钉死**（「工具与截止计时器在同一毫秒内创建、又同批到期，
由计时器列表顺序决定谁先执行」是**尚未验证的假设**）。本单钉死的是**可能性本身**，且用**确定性**构造，
不靠调度运气：

> 让工具在**自己的回调里 `resolve` 之后同步阻塞**越过截止。微任务虽已排入，但要等本轮回调跑完才执行
> ⇒ 工具先被 `race` 看见，而已到期的截止计时器只能等下一轮 timers 阶段。
> 实测同一构造：**旧实现返回 `'late'`（⇒ `ok: true`）、硬化后返回 `TIMED_OUT`**。

即：竞速可以交回一个**观察时刻已越过预算**的值 —— 这一点是确定的，与成因无关。修法针对的正是这一点。

**为什么在「工具 settle 的微任务」里记时间**：若在 `await` 恢复之后再测 `Date.now() - startedAt`，
宿主在「工具完成 → 恢复」之间被饿住，会把**按时完成**的工具误判成超时（新增假阳性）。
微任务紧跟在 resolve 它那次回调之后跑，`settledAt` 最贴近工具真正完成的时刻 —— 这条差异有专门用例守着。

**代价（如实记）**：**语义收紧** —— `21ms 完成 / 20ms 预算` 由「成功」变「超时」。
判断为可接受且更正确：「预算」是对**实际耗时**的承诺，不是对调度运气的承诺。
**既有用例一条没改**（`verify-all` 8/8 全绿）⇒ 说明此前没人依赖那个边界。

**门禁（此前这条性质没有门禁，本单补上）**：

- `tests/engine/concurrency.test.ts` → `describe('withTimeout：超时是硬保证')`：超预算赢竞速必记超时 /
  预算内不误判（防假阳性）/ 截止计时器先赢 / `reject` 原样抛出 / 非正预算透传。
- `tests/engine/toolTiming.test.ts` → 「超预算才 settle 的工具必须记 timeout」：走引擎 + trace 记账全链。
- **承重性反向验证**：临时把实现回退到旧版 ⇒ **恰好这 2 条挂（18/20）**，恢复后 20/20。
  没有这一步，「新用例通过」可能只是因为它在旧实现上也过。

**顺带**：`concurrency.test.ts` 首次**直接**单测 `withTimeout` 与 `TIMED_OUT` 哨兵
（此前只有经引擎的间接覆盖）；该哨兵的表意（区分「超时」与「工具恰好返回 `undefined`」）由此有了直接门禁。

**测试写法教训（沉淀）**：`setTimeout` 有两层语义 ——「回调被排入」与「微任务被 drain」。
**靠两个计时器先后定输赢的断言都是概率门禁**（余量再大也会翻，只是概率低）。
要确定性，就让「不可能满足的前提」（闸门）或「同步阻塞越过截止」参与构造，而不是加大余量。

### 2026-09-14 ③：真 API 集成验证落地 —— 当场挖出「默认 client 从不转发 signal」

**背景**：全仓测试都走 `tests/helpers.ts` 的 `mockClient`，而 mock 只实现我们**以为** SDK 该有的形状。
于是「SDK 真可选」这件事从没被真端点验过：SDK 的真实行为若与假设不同（SSE 分片形状、`tool_use.input`
的解析、`usage` 字段名、`signal` 中转），**现有门禁全绿也发现不了**。这是「让 SDK 真可选」的前置条件。

**新增**：`scripts/e2e-live.ts`（`npm run e2e:live`）。与仓里其他 e2e 的三点不同，刻意不混：
① **会真花 token** ⇒ 不并入 `npm run e2e`、不进 verify-all、不进 CI；② 无凭据时**跳过并 exit 0**，
但打醒目横幅（静默跳过等于假装验过）；③ 断言只针对**协议契约**，厂商支持度差异**只报告不判失败**。
端点走 `ANTHROPIC_BASE_URL` —— 用 DeepSeek 的 Anthropic 协议兼容端点即可验完主路径，
**不需要 Anthropic key**（这是选择它而非 Anthropic 官方端点做本地验证的原因）。

**六个步骤 + 真端点实测结果**（`deepseek-v4-flash` @ `api.deepseek.com/anthropic`）：

- ① SSE 流式：`on('text')` 分片拼接 == `finalMessage()` 文本，`usage` 有值 ✓
- ② `tool_use`：`id` / `name` / `input`（含 schema 字段）都真解析出来 ✓
- ③ `tool_result` 回灌：模型接着收尾，`stop_reason=end_turn` ✓
- ④ `system` 用 `TextBlockParam[]` 带 `cache_control`：端点接受，且**真回报了缓存计量**
  （`cache_read_input_tokens=384`）—— 兼容端点支持度比预期好 ✓
- ⑤ **signal 转发**：见下 ✓（修好后）
- ⑥ 引擎全链：`runAgent` + 真工具 ⇒ `tool.output.ok=true`、`llm.turn` ≥2、`totalUsage` 有值 ✓

**⑤ 挖出的真 bug（这是本单最重要的产出）**：步骤 ⑤ 一开始**红了**，而且红得有信息量 ——
在飞请求 `abort()` 后**仍跑完了**（收到 599 个分片、跑满 7.6s）。

判定过程（不猜，逐层收窄）：

1. 先排除框架：`createAnthropicClient()` 返回的就是 SDK 实例本身，`signal` 是**直接**进
   `sdk.messages.stream()` 的，框架没有中转层 ⇒ 不像框架吞了它。
2. 再怀疑自己的测试构造：**预中止**的 signal 在 SDK 挂监听器之前就 abort 了，事件不会再触发 ——
   实测预中止的请求确实照常跑完。这一版构造选错了靶子（契约要的是「中止**在飞** run」），
   改成**首个分片到达后**再 abort（用分片事件当触发点，不用墙钟猜）。
3. 改完仍红 ⇒ 查 SDK 类型：`stream(body, options?)`，**`signal` 只在 `RequestOptions` 里认**
   （`internal/request-options.d.ts`），而 `MessageCreateParams` 里**没有** `signal` 字段。
4. 最小对照实验（同一请求，只改 signal 的位置）：

   | signal 位置 | 实测结果 |
   |---|---|
   | **body 内**（= `ModelClient` 契约的形状） | 分片 **599** 个，abort 被吞，请求跑完 |
   | **RequestOptions**（= SDK 0.124 真实入参） | 分片 **2** 个，**1ms** 内 `Request was aborted.` |

**根因**：框架的 `ModelClient` 契约把 `signal` 放在 **params 内部**，而默认实现 `createAnthropicClient`
只是 `return new Anthropic(...)` ⇒ signal 进了 body，被 SDK **静默丢弃**（不报错、不警告）。
即：接口注释白纸黑字写着「实现须转发给底层请求，否则调用方无法中止在飞 run」，而**框架自己的默认实现
就没做到**。`integrations/openai.ts` 是手写 fetch，本来就透传 —— 只有 Anthropic 这条（**恰好是默认路径**）坏着。

**影响面（不是「少个功能」）**：`transport/async.ts` 对 `runTimeoutMs` 的承诺是
「到点真中止、**token 不再继续烧**」，靠的就是这个 signal。旧实现下超时的 run 会在后台
**继续烧 token** 直到模型自己说完 —— 承诺与实际相反。

**修复**：`createAnthropicClient` 包一层，把契约里的 `signal` 搬到 `RequestOptions`
（拆分逻辑抽成 `splitSignal()`，单独导出只为可测）。文件头注释里留了上面那张实测对照表 —— 
这个坑不看数据很难相信。

**门禁（两处，一处在 CI、一处不用 key 也能跑）**：

- `tests/integrations/anthropic.test.ts`：`splitSignal` 的 3 条形态断言 +
  **本地假端点**测「abort 后必须断开」（零 key、零外网）。假端点**故意不响应**把请求挂在飞，
  触发点用「端点真收到请求」而非 sleep。**承重性已反向验证**：临时绕过 signal 搬运 ⇒ 该条挂 3s 后失败。
  这一条的价值在于：把「signal 有没有真到传输层」从「只有真端点能验」变成了 **CI 可跑的零成本门禁**。
- `scripts/e2e-live.ts` 步骤 ⑤（真端点确认，需凭据）。

**顺带**：`core/tool.ts` 的 `signal` 字段注释补了「自定义 client 的常见坑」与参考实现 ——
自定义 client 的同样会撞上这个坑，而它的表现是**完全静默**的。

### 2026-09-14 ④：截止计时器**不得 `unref()`** —— 「超时」是等待的终点，不是兜底 tick

**起因（`# fail 0` 却红了 CI）**：发布 PR 的 `verify` 红了，但红的形状很怪 ——
`# tests 485 / # pass 481 / # fail 0 / # cancelled 4`：**没有断言失败**，是 4 条测试被 runner
**cancel** 了，全在 `tests/engine/toolTiming.test.ts` 的 E1 套件里（第 1–3 条过，4–7 条被取消）。
日志里 runner 自己给了原因（而我们当时的失败抽取把它丢掉了，见下）：

```
failureType: 'cancelledByParent'
error: 'Promise resolution is still pending but the event loop has already resolved'
```

**复现（不是偶发，也不靠负载）**：Node 22（与 CI 同 major）跑该文件 15 轮 → **14 轮 cancel**；
同机 Node 26 跑 15 轮 → 0 轮。定向复现是唯一有效手段：**单文件 + 指定 Node，比多跑几轮全量强**。

**判定实验（剥掉所有框架代码）**：空事件循环里 await 一个「永不 settle 的 promise + 截止计时器」：

| 计时器 | Node 22.23.2 | Node 26.5.0 |
|---|---|---|
| `unref()` | **进程直接退出**（exit 13，顶层 await 未 settle） | 同左 |
| 不 unref | `settled: TIMED_OUT`，exit 0 | 同左 |

⇒ **与 Node 版本无关**，Node 22 只是让 node:test 把它报成 `cancelledByParent` 而已。

**根因**：该计时器的**触发本身就是「被 await 的 promise 得以 settle」的条件**。一旦 `unref`，
当它是事件循环里唯一的把手时，进程在它触发前就退出 —— 调用方**什么都拿不到**（不是超时值，
是整段 await 静默消失）。旧注释「兜底计时器不该让宿主为它续命」把两类计时器混为一谈：

- **兜底 tick**（scheduler 的下一拍、SSE 心跳、metrics 刷盘）：**没人 await 它们**，
  unref 是对的 —— 保留了（`transport/scheduler.ts`、`transport/http.ts`、`integrations/metrics.ts`）。
- **等待的终点**（工具级超时、MCP 调用超时、停机 `drain`、`runTimeoutMs`）：**调用方正在等它**，
  unref 等于让「等待」永远不结束。四处的 unref 全部去掉
  （`engine/concurrency.ts`、`integrations/mcp.ts`、`transport/async.ts` ×2）。

**影响面（不止测试）**：`await runAgent({ tools:[挂死的工具], toolTimeoutMs: 20 })` 在普通脚本里
**不会返回超时，而是进程静默退出**。对一个把「工具级超时」当护栏卖给使用者的框架来说，
这比「超时不硬」更严重：护栏连触发机会都没有。

**门禁**：`tests/timeoutLiveness.test.ts` + `tests/fixtures/timeoutLivenessProbe.ts` ——
拿**干净子进程**（`node --import tsx`）在空事件循环下验三个往返：工具级超时回到 `end_turn`、
MCP 调用抛出「调用超时」、`drain` 预算耗尽返回 `false`。
**必须子进程**：本性质的前提就是「进程里没有别的把手」，而同进程跑测试时**测试跑器自己持有把手**，
会把缺陷藏起来（这正是它此前只被 CI 抓到、本地永远绿的原因）。
**承重性反向验证**：把三处 `unref` 加回去 ⇒ 门禁 **3/3 全红**。
`transport/async.ts` 的 `runTimeoutMs` 一并去掉 unref，但**未进门禁**：如实说，它的活性被
`awaitTask` 的兜底轮询（另有 ref'd 计时器）掩盖，探针验不出差别 —— 不假装它被覆盖了。

**顺带补的诊断缺口**：`scripts/verify-all.sh` 的失败抽取只抓 `not ok` / `AssertionError`，
而 cancel 类失败的**原因行**（`failureType` / `event loop has already resolved` / `# cancelled`）
一条都没抓 —— 这就是为什么 CI 上只看到一个 exit 1。已把它们加进抽取清单（沿用 PR #9 的同款修法）。

**这条与 ② 的关系**：同一条用例（`toolTiming` 的「工具超时」）暴露出**两个独立缺陷** ——
② 是「竞速不是硬保证」（超预算被记成功），④ 是「计时器被 unref」（等待干脆结束不了）。
两者都在这个文件里以不同形状现形，也各自有了门禁。

### 2026-09-14 ⑤：`.env` 成为一等配置入口 —— 但框架仍**不自动**读

**起因（使用者视角的一次核对）**：核对「框架配置 AI key 要不要 `.env`」时发现两件事同时成立 ——
框架**从不读** `.env`（全仓 `grep dotenv` 零命中；`dev.ts` 的注释还钉着「框架侧不感知 dev：不读 env」），
而 `agentia create` 生成的脚手架 `.gitignore` **只有 `node_modules` / `dist`**：
用户按习惯建一份 `.env` 写 key，`git add -A` 会把它**连 key 一起提交**。
（反证：仓库自己的根 `.gitignore` 有 `.env`，`examples/*/.env.example` 还写着「`.env` 已 gitignore」——
同一个作者在自家仓库挡住了、在发给用户的模板里没挡。实测 `git check-ignore` 复现。）

**判定**：`.env` 需要被生成、也需要被读 —— 但**读的动作不进框架、也不进 CLI**，而是框架提供一个
**显式的** `loadEnvFile()`，由宿主（脚手架的 `src/main.ts` 首行）调用。

- **不塞进 `createApp` 自动读**：读 `.env` 会改 `process.env`，而 `.env` 按 cwd 找。
  隐式生效之后，「同一份代码换个目录跑结果不同」「本地多放了个 `.env`，测试行为悄悄变了」
  都会变成需要排查的悬案 —— 本仓库自己就会先中招（`e2e:live` 的开发者会在仓库根放 `.env`，
  而几乎每个单测都调 `createApp`）。
- **不放 CLI**：`agentia dev` 只是宿主之一。放 CLI 会让 `node dist/main.js`、docker、别的宿主都读不到 ——
  那才是真的「只有 dev 生效」。放在使用者的 `main.ts` 里，所有宿主一致。
- **零依赖**：Node 18 没有 `process.loadEnvFile()`（21.7+）、没有 `--env-file-if-exists`（22.9+），
  而 `--env-file`（20.6+）在 Node 18 上直接报错退出 —— `engines: >=18` 下只能自己解析（约 90 行，含注释）。

**三条语义（都刻意，且都有测试）**：

1. **文件不存在 = 静默返回 `{}`**（首次 clone / CI / 生产靠真实环境变量的正常路径），不制造假依赖；
   但**内容非法直接抛错并指出行号** —— 静默跳过等于让用户以为「配上了其实没配上」；
2. **真实环境变量优先**：`process.env` 里已定义（哪怕空串）的键不被覆盖，`override: true` 才反向。
   ⚠️ 这条的代价要写明：**本机 export 过 `ANTHROPIC_API_KEY` 的人**（如同时用 Claude Code），
   脚手架 `.env` 里的 key 会被**静默压住** —— 已写进使用说明的显眼处，否则这就是下一个「改了没生效」的悬案；
3. **想知道「生效没」看返回值**：被挡下的键不在返回对象里，不用去猜文件有没有被读。

**门禁**：`tests/toolkit/env.test.ts` 12 条（解析边界 / 优先级 / 空串 / 缺文件 / 非法内容）；
`packages/cli/test/templates.test.mjs` 钉「`.env` 三件套」契约（生成 `.env` 却不 ignore = 事故）；
`scripts/e2e-cli.ts` 两条：语法面「生成的 `main.ts` 有一句独立的 `loadEnvFile();`」+
行为面「在脚手架目录里真的把 `.env` 读进了 `process.env`」。

**反向验证抓到的假绿（如实记）**：语法面那条最初写成「文件内容里含 `loadEnvFile()`」，
结果被同文件**注释**里的说明文字满足了 —— 把调用整行删掉，门禁照样绿。改成锚定独立语句行
`^loadEnvFile\(\);$` 后反向验证才变红（另半条 `.gitignore` 断言反向验证一次就红）。
教训与 ④ 同源：**断言要锚在「行为/语句」上，不能锚在「文本里出现过」**。

**影响面**：`docs/usage-guide.md` 新增「环境变量与 `.env`」一节 + 改写两条已知边界
（原「框架不读 env」→「框架不自动读 `.env`」；停机那条去掉「不读 env」的括号理由，免得自相矛盾）；
官网 `api.html` 补 `loadEnvFile` / `LoadEnvOptions` 并把导出计数 175 → 177（反向全覆盖门禁会拦）。

### 2026-09-14 ⑥：事件正文截断开关落地 —— 顺带删掉「脱敏」这个空头承诺

**起因（使用者视角的一次核对）**：核对「调试面板里工具结果能不能展开」时，先查数据侧能不能撑起展开，
结果挖出三件事同时成立，而注释与 spec **只写了前一件**：

- `src/core/trace.ts` 与 `docs/spec.md` §9.1 都写着「工具入参/出参默认截断 + 脱敏，完整内容 opt-in」；
- **「截断」是真的**，但值**硬编码**在 `engine/loop.ts`（`limit(use.input, 2000)` /
  `ok ? 2000 : 1000`）—— **「完整内容 opt-in」零实现**：全仓 grep `opt-in | fullBody |
  captureFull` 只命中那两句措辞本身，没有任何开关；
- **「脱敏」更彻底**：`stringifySafe` 只做序列化，全仓 `redact | 脱敏 | sensitive` 在 `src/` 下
  零命中 —— 而 spec §9.3 **自己**写着脱敏是 sink 缝外的事（`usage-guide` §6「观测」同款口径）。
  也就是说 §9.1 那句是**自相矛盾**：承诺了一件它自己在别处声明不做的事。

**判定**：三件事分头处理 —— 补上缺的开关、改正错的措辞、**不实现脱敏**。

1. **补开关**：新增 `RunInvocationOptions.maxEventChars?: number | false`（`AppOptions` 同款缺省）。
   **数字** = 入参/出参统一用该上限；**`false` = 不截断**；不设 = 保持旧缺省（入参/成功出参 2000、
   失败出参 1000）。
   - **为什么是「数字 | false」而不是一个布尔 `traceFullBody`**：数字同时覆盖「想多看一点」
     与「全都要」，而布尔只能表达后者；`| false` 也延续本仓既有约定（`retry?: RetryOptions | false`
     的 `false` = 关闭）。
   - **为什么不顺手改缺省值**：trace 体积是 sink 落库 / OTLP 导出 / 看板成本的共同分母，
     改缺省等于**静默**改所有既有使用者的观测成本。要全文就显式开。
   - **`false` 的代价写进文档**：工具返回多大就记多大，调试期开、生产期关。
2. **透传给嵌套能力**（`ToolRunContext.maxEventChars` → `runAgentScoped`）。否则调试期开了全文，
   **子 agent** 里的工具事件还是被截断的 —— 同一棵调用树上两种口径，而「子 agent 里的工具
   为什么失败」恰恰最需要看全文。与 `priceOverrides` 的透传理由同源（那边是「否则子 agent 用同一
   模型退化成未定价」）。
3. **删掉「脱敏」**（而非补一个实现）：按 §9.3 的既有分工，它本就不属于框架。**删错的、不补对的** ——
   留着会让使用者以为框架替他挡了密钥泄漏。

**顺带修掉的第二个坑（真浏览器之外看不出来的那类）**：`tool.input` 的正文到得了 trace，
却到不了眼睛 —— `packages/trace-view/src/fromTrace.js` 的 `eventText()` 把入参交给 `fmtArg()`，
而后者**砍到 4 个键 / 每值 21 字符 / 整串 62 字符**。所以「给面板加展开」若只加 UI，展开出来的
仍是那 62 个字符 = **假展开**。⇒ `playTrace` 现在对事件多传一个 `full`（入参取**原文**），
渲染器的 `text` 是摘要、`full` 才是展开内容。

**交互三条（都刻意，且都有测试）**：

- **折叠态一字不变**：`text` 仍是摘要、出参仍由 CSS 省略号收敛；caret 用**绝对定位 + `opacity:0`**，
  不占 flex 宽度 ⇒ 折叠态的排版与加展开之前逐字一致（事件行「比 span 行更轻」的既定语言不破）；
- **展开态活在渲染之外**（`Set`，按事件的稳定 `key` 索引）：渲染是**每次事件全量重建 DOM**
  （`rootEl.innerHTML = ''`），状态放进 DOM 或渲染过程里，实时 run 中刚点开的行会在下一条事件
  到来时自己合上；`reset()` 显式清空（否则新树继承旧展开、且 Set 随 run 无限增长）；
- **选文本时不切换**：鼠标拖选到行外松手会补一次 `click`，不判 `getSelection()` 就会「选完自己合上」。

**合并后补的一条（窄面板挤死 —— 只有真在窄容器里看一眼才会发现）**：上面那条「行内展开」在
宽面板（CLI inspector，行宽 896px）看着没问题，**官网 Playground 的 296px 面板里却不可读**：
那一行的固定项（树前缀 + 事件类型 + 工具名）本身就要 ~280px，正文只分到 **16px**，59 个字符被压成
34 行、行高顶到 60vh 上限（386px）。⇒ 展开态改为 **`flex-wrap: wrap` + 正文 `flex-basis: 100%`**，
正文换到**独立整行**（实测窄面板 16px → 296px、行高 386 → 72）。两处已各自数值复验（窄 9 项 / 宽 9 项）。

> ⚠️ 上面这段的**后半句**（`flex-basis: 100%` = **无条件**换行）已被**下一条**决策取代：现在默认与
> 标签同一行，只在放不下时才换行（`flex-wrap: wrap` 保留）。原文照旧留着当当时的判断记录，不改写。

⚠️ **这一类缺陷任何「溢出检查」都查不出来**：两处都是 `scrollWidth === clientWidth`、
页面无横向滚动、「部署成功」也全绿 —— 只是**读不了**。判定依据必须是**几何**（正文宽度、
行高、`scrollHeight` vs `clientHeight`），不是「有没有溢出」。首轮只验了宽面板就下结论，
代价是一次合并后的返工。

**门禁**：`tests/engine/eventChars.test.ts` 6 条（缺省逐字不变 / 数字统一三类 / `false` 不截断 /
**回给模型的 tool_result 不受影响** / `config.maxEventChars` 记 `'off'` / 子 agent 透传对照）；
`packages/trace-view/test/view.test.js` 7 条（折叠态一致 / 出参切换 / **入参展开是原文而非 62 字符摘要**
/ 跨重渲染存活 / 选区保护 / reset 清理 / 空正文不可展开）。

**顺带修掉的一处测试债**：`fromTrace.test.js` 里同一段 DOM stub 抄了三份，都缺 `addEventListener` ——
渲染器一挂 click 三条用例全红。抽成一个带 `addEventListener` 的 `makeNode()` + `useDom()`，
三处重复消失。（**是 stub 缺能力，不是渲染器的问题**：浏览器里 `addEventListener` 必然存在。）

**影响面**：`docs/usage-guide.md` 两张选项表各加一行 `maxEventChars` + 新增「调用树面板」小节
（含「展开只能展开 trace 里存着的正文」这句关键前提）+ 顺带改正「生效配置快照」那句
（原文写「缺省值也记」，但可选项 `toolTimeoutMs` / `maxToolConcurrency` / `maxEventChars`
其实只在设了才记）；`core/trace.ts` 的假承诺注释与 `spec.md` §9.1 同步改为如实描述。

### 2026-09-14 ②「展开」收尾：版式回摆 + 第二宿主补齐原文 + lint 折进本地链

上一节的数字复验（只验了宽面板、窄面板漏验）之后又量出四件事。四条都是**实测**出来的，不是猜的。

**a. 版式回摆：无条件换行 → 「放不下才换行」**

上一节把展开正文改成**无条件**换到独立整行（`flex-basis: 100%`）。窄面板里这是对的，但它把宽宿主
（CLI inspector 874 / 1223px）「一行一个语义单元」的阅读节奏也一起改掉了 —— 正文明明放得下。
现在的规则：**默认与标签同一行，放不下才整段换行**。判据落在 `flex-basis: 0` + `min-width: 22ch`：

- `flex-basis: auto` ⇒ 换行判据是 **max-content**（正文动辄上百字符）⇒ 等于无条件换行；
- `flex-basis: 0` ⇒ 判据回到 `min-width` ⇒ 放得下就同排、放不下才换行。

实测（构建产物 `dist/`，`content-box` 与 `border-box` 两种宿主都覆盖）：

| 宿主容器 | 行宽 | 固定项（前缀+类型+工具名） | 展开正文宽 | 表现 |
|---|---|---|---|---|
| CLI inspector | 1223px | 246.5px | 976.5px（79.8%） | 与标签**同一行** |
| CLI inspector | 874px | 246.5px | 627.5px（71.8%） | 与标签**同一行** |
| 官网 Playground | 296px | 246.5px | 296px（100%） | **整段换行**（非窄缝） |

三处都 `ioW ≥ 100px`、面板与文档零横向溢出、零 JS 错误。`min-width` 不可省 —— 省了就回到 16px 窄缝。

**b. caret 常显 + 右端窄槽（并且：0.75 是缺陷，不是口味）**

caret 原本 hover 才淡入，「这一行能展开」只有已经知道的人发现得了。改为**常显**。
最初写成静止 `opacity: .75`、悬停 `1`，随后**量出这不能留**：caret 是交互指示器，
WCAG 1.4.11 对非文本 UI 组件要求 ≥3:1 —— 而 0.75 的 `--faint`(`#71717a`) 在官网 `#0c0c0e`
面板上实际绘制成 `#58585f`，只有 **2.77:1**（满不透明度 4.04:1）。⇒ 去掉那一档：静止即满不透明度，
hover 不再改变它（两宿主 `--faint` 同值，不是巧合地只在一个宿主上达标）。

随之必须给右端留一条 12px 内边距的窄槽：不留的话，被截断正文的省略号「…」正好落在 caret 底下，
两个字形糊在一起。判据 `caret.left ≥ io.contentRight`（两种宿主、常显与展开态都不重叠）。
**12px 没有再收紧 —— 这一格是纯取舍，与上一条不同**：caret 字形本身约 6px（10px 等宽字体），
再窄就贴住省略号，省下的 3–4px 在 600–1200px 的行宽上不值得为此冒一次回归风险。

**c. 第二个宿主只喂了摘要（「假展开」）**

`playTrace`（CLI inspector）这条路上「展开给原文」是对的；但**官网 Playground 自己组 trace** 时，
`traceEvent(id, type, tool, text, ok)` 只传了 `fmtArg(...)` 摘要、没传 `full`。渲染器从 62 字符的摘要
反推不出原文 —— 于是**同一个渲染器在一个宿主里真展开、在另一个宿主里点开什么都没多出来**，
而两处共用一份渲染器的全部意义就是不让这种漂移发生。
⇒ 原文口径收进 `view.js` 的 `rawArg`（`fmtArg` 的对偶，两个宿主都调它），
`playground.js` / `playground-real.js` 的 `tool.input` 记录点补上第 6 参。
实测（官网真实运行）：折叠态 59 字符摘要（含 `…`）→ 展开态 73 字符**完整 JSON** 且可 `JSON.parse`，
`differs / longer / parsesAsJson` 三项全 true。

**d. 门禁自身：lint 折进本地链**

`verify-all.sh` 此前**不跑 lint**（lint 只在 CI 的独立 job 里），于是「本地 8/8 全绿、CI 挂 Biome」
是可能的。这次就撞上了：本地全绿，CI 的 `lint` job 在新写的源码/测试上挂了 **3 条格式 error**
（`biome ci` 里「内容与格式化输出不一致」算 error）。
⇒ `npx biome ci .` **折进第 1 步**，不加第 9 步：`verify` job 的 name 就是分支保护的必需状态检查、
写死了「8 步」，加步骤这名成假话、改名又会让 PR 卡死等一个永不出现的检查；折进去还让 lint 落进
**必需**检查里（比另开一个非必需 job 更硬）。结尾写死的「8/8」一并改成算出来的 `${#steps[@]}/${#steps[@]}`。

失败分支**实测**（没跑过的分支就是坏的分支）：注入「真 biome 失败 + 真测试失败」，两类标记都命中，
且**能报出出问题的文件名** —— 这需要一处修正：biome 的诊断首行带 ANSI 颜色码（路径与 `format`
之间夹着 `\033[0m`），锚定「路径 format ━━」会失配，所以抽标记行前先剥色。

**为什么 `import-floor` 与 `e2e:mcp` 仍然不进本地链**（试过，结论是**不该进**，不是漏了）：
`scripts/check-import-floor.mjs` 按**运行中的 Node** 分支 —— ≥22.5 才验 SqliteTaskStore 可用，
否则验「可读报错而非崩溃」。本地（Node 26）跑它只会走「新 Node 可用」那条，对 Node 18/20 的
地板**一个字都没验到**，折进来等于**看起来有覆盖**（比没有更坏）。`e2e:mcp` 默认优先接真第三方
server（需要网络 / uv），而本地链必须离线可跑。⇒ 二者保持 CI 独有，改成在链尾**明确打一行提示**
（「本地绿 ≠ CI 绿：另有 3 个 CI 独有必需检查不在本链」），并留在 `CONTRIBUTING.md` 的坑表里 ——
静默的全绿正是这一整条 d 段要治的东西。

**门禁**（都是**源码级**就能看见的，比开浏览器便宜）：

- `packages/trace-view/test/style.test.js` 4 条：`.tr-open .tr-io` 必须有非零 `min-width`、
  `.tr-row.tr-open` 必须有 `flex-wrap: wrap`、`.tr-caret` **静止必须是满不透明度**（不许调暗，
  理由即 b 段的 2.77:1）、可展开行的正文有 `padding-right`。**逐条反向验证**（把对应那条改坏 ⇒ 各挂 1 条）。
- `tests/docs/website-playground-expand.test.ts` 2 条：两个宿主的 `tool.input` 记录点必须含
  `rawArg(...)`；`traceEvent` 包装器必须把实参**全部**转发给 `view.event`。三种改坏各挂 1 条。
- `packages/trace-view/test/view.test.js` 加 2 条：`fmtArg` 砍到 62 / `rawArg` 给完整 JSON 且两者不等；
  `rawArg` 边界（`null` → 空串、字符串原样、循环引用回落 `String()`）。

**影响面**：`docs/usage-guide.md` 面板小节两句（「该行改为换行显示」「caret 悬停才显形」）改为如实描述；
`AGENTS.md` 的验证顺序与 lint 条目；`CONTRIBUTING.md` 的「提交前必须跑」与坑表。
**已有决策记录保留原样**（上一条里 `flex-basis: 100%` 那半句已被本条 a 段取代，标注而不改写）。

### 2026-09-15（发布后更正）：RedisTaskStore 的 TTL 改走 `EXPIRE` —— 「位置参数形态两者通吃」是错的

**背景**：0.4.1 的 ⑦ 条把 `RedisLike.set` 从对象形态 `set(k, v, { EX: n })` 改成位置参数形态
`set(k, v, 'EX', n)`，理由是「位置参数是 ioredis 与 node-redis 的公共形态」。**后半句不成立**，
而它随 0.4.1 发布出去了。

**证据（拿真包跑它的命令序列化器，不是推断）**：

```
node-redis v6.2.1  @redis/client/dist/lib/commands/SET.js 的 parseCommand
  parseCommand(p,'k','v',{EX:60}) → ['SET','k','v','EX','60']   ✅ TTL 生效
  parseCommand(p,'k','v','EX',60) → ['SET','k','v']             ❌ TTL 被丢
node-redis v4.7.1  同文件 transformArguments（v4 的名字）—— 同样结果
```

**根因**：`SET` 的命令定义只声明 `(key, value, options)` **三个形参**，多出来的位置参数被 JS
直接丢弃 —— **不报错、不警告**。所以对 node-redis 用户，`ttlSeconds` 此前**完全不生效**：键永不过期、
`list()` 无锁增长，且没有任何信号。而**旧的对象形态在 node-redis 上是正常的** ⇒ 这是一次
「修好 ioredis、静默弄坏 node-redis」的回归。

**为什么没被门禁抓到（本条最值钱的一课）**：用例里那个 `NodeRedisFake` 是**照着这个信念写的**
（注释原文「对象选项与 legacy 变参**都**接受」）—— 它断言的是作者的假设，不是库的行为，于是
测试全绿。**fake 只能模拟实测过的形态，并注明出处与版本**；凡「A 与 B 都兼容」的结论，至少对
一个真包执行一次它的序列化/解析路径取 argv 证据。同一课已记入 `focused-review-fix-round` 的坑表。

**更正后的契约**：
- `RedisLike.set(key, value)` —— **只两参**，是两家唯一无歧义的公共形态（尾参形状两家相反：
  ioredis 认 `('EX', n)`、node-redis 认 `{ EX: n }`，取任何一种都会在另一家上失败）。
- `RedisLike.expire?(key, seconds)` —— 两家**同名同形**，TTL 一律走它。
- `RedisTaskStore`：`ttlSeconds > 0` 时 `expire` **必需**，构造期校验、缺失即抛错（静默失效比
  启动期报错难查得多）；不设 TTL 时不要求。
- **取舍（有意）**：`SET` + `EXPIRE` 两条命令、**非原子** —— 两步之间进程被杀会留下一个没有 TTL
  的键（多活一条本该到期的记录），不损坏数据。TTL 只是查询窗口，用这个窗口换「两家客户端都真
  生效」。
- `RedisSetOptions` 保留导出（公共面 + 官网 API 页），但已无人使用 —— 注释改为如实说明历史。
  `RedisSetArgs`（内部类型，从未进 `index.ts`）删除。

**门禁**：`NodeRedisFake` 重写为**照实测**的形态（`set` 只认 options 对象、位置参数按真实行为
丢弃，并逐条记录 argv）；新增 3 条用例（TTL 必须落在 `EXPIRE` 且 `SET` 只两参 / 无 TTL 时不发
`EXPIRE` / 缺 `expire` 时构造期抛错）。**反向验证**：去掉 `applyTtl` 调用、去掉构造期校验
—— 两次都精确挂掉对应用例。

**影响面**：`docs/usage-guide.md` 的 `RedisTaskStore` 表行（改成如实口径）、`packages/website`
的 API 页 `RedisLike` 行（结构面补 `expire?`）、`src/store/redisStore.ts` 的类注释与
`RedisSetOptions` 注释。本轮不改任何行为缺省：不设 `ttlSeconds` 时依旧只 `SET`、依旧不过期。

**附：同轮修掉 `e2e-deploy` 的端口 TOCTOU flake**（本轮跑全链时当场撞上）。
`freePort()` 是「`listen(0)` 探到端口 → `close()` → 子进程再 `bind`」，两步之间那个临时端口
可能被系统分给别的连接 —— 实测报 `EADDRINUSE: ::53174`，而症状被包成**「示例进程启动即退出」**，
读起来像示例或实现坏了。修法：新增 `startExampleRetrying()`，**只对端口争用**换端口重试（3 次），
其他启动失败原样抛出（不许被重试掩盖成「多试几次就好」），并在诊断里点明是端口占用。
**证明**：占住一个端口 + 把 `freePort()` 注入成第一次返回它 → 观察到位「端口 45999 被占用
（TOCTOU 抖动），换端口重试」→「换到端口 53242 后启动成功」→ `E2E-DEPLOY PASS`。
⚠️ 这条**没有**仓内守卫（要有就得把「制造端口冲突」的注入器写进脚本，不值），靠 e2e 自身运行覆盖。

- 2026-09-15：**全量评审修复轮（预算透传 / 策略按 run 隔离 / 装配期校验与观测面修正）**。
  本轮以「护栏要在嵌套结构里同样成立」与「启动期响亮失败」两条主线收口，语义变更**在此锁定**：
  **① 成本护栏真透传子循环**：`ToolRunContext` 新增 `maxTotalTokens` / `maxCostUsd`，
  `@SubAgent` / `@Skill` 的子循环经 `runAgentScoped` 拿到同一份上限 —— 各级循环共享同一
  recorder 的累计账单，**每回合各自检查**；子循环超限以 `budget_exceeded` 收尾（该次能力调用记
  `is_error`，capability span 上记 `budget.exceeded` 事件），主循环在下一回合**入口**再判一次、
  不再发出新请求，整条 run 以 `budget_exceeded` 收尾。旧实现子循环拿不到上限，护栏在子循环
  期间整体离线（最坏多烧一整个子 run）。**两处同轮取舍**：超预算的回合仍照常处理
  `submit_result`（纯内部的结构化提交、零副作用 —— 模型已把最终结果交出来，连同回合丢弃等于
  白烧这一回合，与「自然收尾不因超预算改判失败」同口径）；同回合**并行**多个 `submit_result`
  先到先得（首个校验通过的生效），不 guarded 则 `typed` 由并发完成顺序竞态决定。
  **② `ContextPolicy.forRun?(): ContextPolicy`（可选契约）**：引擎每条 run 开始调一次拿
  **本 run 专用**的策略实例；`createBudgetPolicy` 已实现（滞回计数与增量 token 缓存都是
  per-run 状态 —— 不隔离会让「run A 刚压缩过」卡住「run B 前 compactEvery 回合不压缩」，
  并发 run 还会互相打回计数缓存）。不实现的自定义策略按**单例复用**（状态跨 run 共享，
  注释已写明后果自负）。
  **③ per-run `tools` 覆盖过同一条中间件链**：`AgentApp.run` 对 `opts.tools` 现包一次装配期
  那条链（`wrapTools`）—— 此前是旁路，per-run 覆盖会绕开鉴权/限流/审计，与 2026-09-11 修复的
  「子 agent 绕过中间件」同族。
  **④ 能力名装配期校验**：四类装饰器能力名（`name` 或缺省的方法名）必须匹配
  `^[A-Za-z0-9_-]{1,64}$`（与 MCP 桥同口径），非法名 `createApp` 即抛错 —— 含空格/点/中文的
  名字会让模型 API 400，「首次模型调用才暴露」不如启动期拦住。
  **⑤ metricsSink 渲染修正**：分位 gauge 改名 `*_duration_ms` → `*_duration_ms_last`
  （histogram 保留原名 —— 同名指标只允许一种 TYPE，混发会被 expfmt 判硬错误、整次 scrape
  失败）；`render()` 每个指标家族只发一次 HELP/TYPE（此前同家族多 label 样本各自带家族头，
  同样是硬错误）；label 值做 `\` / `"` / 换行转义（含引号的能力名此前会损坏整页 exposition）。
  **OTLP 侧**：成本指标走 `asDouble`（asInt 是 int64 字符串编码，塞浮点会被 collector 整批
  拒收）；histogram `bucketCounts` 改**非累积**（OTLP 语义；Prometheus 文本的累积语义不变）。
  **⑥ `OtlpExporterOptions.timeoutMs`**（缺省 10000，非正数 = 不限）：裸 fetch 没有超时，
  collector 半开连接会让 run 收尾永久挂起；超时按导出失败处理（上层吞掉，不击穿 run）。
  `MetricsSinkOptions` 同款 `timeoutMs`（同缺省同语义）—— metrics 的 OTLP flush 此前也是裸
  fetch，`intervalMs: 0` 模式下会被同样吊住。
  **⑦ `RedisLike.set` 改位置参数形态** `set(key, value, 'EX', seconds)`：对象形态 `{EX}` 是
  node-redis **独有**，ioredis 会把它字符串化成 `"[object Object]"` 发给服务端（报语法错）；
  位置参数形态两者通吃（node-redis v4 保留 legacy 变参）。`RedisSetOptions` 保留导出但已
  `@deprecated`（不破坏公共面）。不设 TTL 时**只传两参**（显式 undefined 会被 ioredis 序列化
  成空串参数）。
  ⚠️ **本条判断已被更正** —— 「位置参数形态两者通吃」是**错的**：node-redis 的 `SET` 只声明
  三个形参，位置参数会被**静默丢弃**。更正与证据见下方 `### 2026-09-15（发布后更正）`。
  **原判断与理由保留在此，不改写**（谁在什么时候为什么想错了，比一个干净的结论更有用）。
  **⑧ 构造期校验补齐**：`AsyncRunner` 的 `runTimeoutMs` 必须 ≥ 0 的**有限**数（NaN/Infinity
  都会被 `setTimeout` 钳到 1ms，等于每个任务立即超时）；`createHttpHandler` 的
  `maxConcurrentRuns` 必须 > 0 或 Infinity（NaN 会让并发闸门静默失效、0/负数全部 503）。
  **⑨ drain 强制关 SSE 连带 abort run**：只 close 不 abort 时 `res.end()` 让
  `writableEnded` 同步变 true，断连守卫（`!writableEnded` 才 abort）永不触发，run 会在后台
  继续烧 token（实测复现）——收口函数现在先 abort 再 close。
  **⑩ OpenAI 流式两处假成功收口**：流中 `error` 分片（上游把故障塞进 200 的流）即抛错；
  流「正常」结束却无文本无 tool_calls 同样抛错 —— 不再静默映射成「`end_turn` + 空文本 +
  usage 全 0」的成功空回复（与非流式空 choices 守卫同口径）。
  **顺带（语义收紧，各带用例）**：`max_tokens` / `pause_turn` / `max_iterations` 收尾补结构化
  `error`（此前这类 run「失败却没有原因」）；`onText` / `onRetry` 回调抛错被吞（观测是辅助
  动作，与 `onUnpricedModel` 同口径）；`TraceRecorder.snapshot()` 浅拷 span 的
  attributes/events（交付后仍在记账的残尾不再事后变异已交付的 trace），`totalUsage.costEstimate`
  与 capability 聚合统一 1e-6 美元取整口径；schema 校验 `in` → `Object.hasOwn`（原型键
  `constructor`/`toString` 不再被当成「已声明」）；`FileTaskStore.compact()` 改临时文件 +
  rename 原子重写（写崩不丢旧文件）；`combineSignals` 补 `releaseCombinedSignal()`（run 正常
  收尾时摘掉挂在长寿源 signal 上的监听器，不再按任务数累积触发 MaxListenersExceededWarning）；
  MCP 工具名**归一化后为空**（原名不含任何 ASCII 字母/数字/下划线，如全 emoji）显式抛错
  （此前只剩前缀也能注册成功）；静态 `@Prompt` 沿构造函数原型链收集（父类静态资产不再静默
  丢失）；`.env` 的 `__proto__` 键显式抛错（会走原型 setter 被静默吞掉）；`discover` 入口
  候选按序回落（`.ts` 加载失败回落 `.js` 并 warn —— 命中的可能是陈旧编译产物）；`asset()`
  拒绝带 scheme 的 rel（`file:`/`https:` 会让 base 被整个忽略；`../` 越出能力目录有意放行）。
  **门禁**：`scripts/e2e-deploy.ts` 新增并挂进 `npm run e2e`（第三步：examples/deploy 真构建、
  真起服务、崩溃续跑）—— `examples/deploy` 此前与 complete 同款「文档说可跑、无门禁真跑」。
  CLI：`dev`/`add` 支持 Windows（`npmBin` 的 `.cmd` 处理）；CLI build 自给自足
  （copy-assets 在 trace-view 未构建时就地补跑，`prepublishOnly` 只跑 build）；
  inspector 加 Host 头校验（非 localhost 403）与 trace 入站校验。
  layering 守卫加强：解析覆盖 from/副作用/动态 import 字面量三种形式，带解析计数下限护栏
  （防解析器空转 vacuously 变绿），BARREL 豁免只认 `src/index.ts` 本身（src 根下新文件不再
  白嫖豁免），`ALLOWED.eval` 补 BARREL（与 AGENTS.md「依赖 toolkit 与公共面」对齐）。

## 11. 开放项

- npm 包拆分（core / runtime / transport）仍待做；CLI 已独立成包（workspaces），框架本体仍单包。
  ⇒ 发布进度：v0.2.2（2026-09-14，框架包 + CLI 包，scope 为 `@migor/*`）→ v0.3.0（`.env` 一等入口）
  → v0.4.0（trace 事件正文可展开）→ v0.4.1（深度审查修复轮，无新公开 API）
  → v0.4.2（发布后更正：Redis 的 TTL 在 node-redis 上静默失效）；`AGENTIA_VERSION = '0.4.2'`。
- DI 的 property-injection 便利写法（标准装饰器下可行）待定。
- 模型缺省 `claude-opus-5`（`AGENTIA_MODEL` env 可覆盖）；两个内置客户端（Anthropic / OpenAI 兼容）默认走流式。
- CLI 剩余：注册表与扫描混用时的冲突提示策略（`dev` 已落地并内建 inspector 面板；`add` 已落地，见 §10 R5）。
