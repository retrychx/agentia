# Agentia —— 规范（持续修订）

状态：讨论收敛后的书面化，此后随实现持续修订（当前发布 v0.5.0）。**阅读口径**：§1–§9 是规范快照，
§10 是带时间线的决策日志 —— **两者冲突时以 §10 较新的决策为准**（快照只在新决策落地时回填，
回填滞后以日志为准）。

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

## 4. 装饰器表面（已落定）

**已定决策：标准装饰器（ECMAScript Stage 3），不用 `experimentalDecorators` / `emitDecoratorMetadata` / `reflect-metadata`。** 因此不支持构造器参数反射 —— DI 采用模块内显式 `providers` + factory 装配（`useFactory` 式）。框架的元数据一律显式声明（装饰器参数即配置，外加 `WeakMap`/注册表存储），不依赖 `design:paramtypes`。

```ts
// 落定形态（见 §10 R5）：模块**不是类装饰器** —— `defineModule({ providers, middleware })`
// 返回一个 `AgentModule` 值交给 `createApp({ modules })`；没有 `main` 标记（主 agent 即 app 本身）。
export class ProjectModule {
  // 落定形态：SubAgentSpec 的字段全部声明在装饰器参数里（字段表见 usage-guide 的
  // @SubAgent 一节）；被装饰方法体**从不执行** —— 运行时拉起独立循环，方法只是登记锚点。
  //（没有 role 字段：角色走 system；能力边 = tools 引用 —— provider 整片引用，
  //  或 'token/能力名' 能力级路径，2026-09-16 落地，见 §10）
  @SubAgent({
    description: '按品牌规范评审设计稿，输出评审报告',
    schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    system: '你是苛刻的品牌设计评审员……',
    tools: ['image-tools'], // 可选：provider token 列表，或 'image-tools/resize' 能力级路径
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
- **别自研黑名单**：token 估算用内置启发式（CJK 感知、带增量缓存，见 §10 Turn 4 与 2026-09-13 性能审计；要精确计数由上层注入 `/messages/count_tokens`，框架不替你造 token），不用 tiktoken 近似；错误分类靠鸭子类型（数值 `status` / errno `code` / 带 `cause` 的 TypeError，见 §10 2026-09-17 —— SDK 类型化异常那套已随 client 自研化退役）；缓存验证靠 `cache_read_input_tokens`。

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
- **跨进程关联（2026-09-17 入站 / 2026-09-21 出站，见 §10）**：入站 `traceparent` 头（W3C）或
  `RunInvocationOptions.traceContext` → run 根的一条 **span link**（`SpanLink`），OTLP 导出映射为
  span links。形态选 link 而**不是**继承上游 traceId —— `traceId == runId` 的 1:1 不变量不变，
  run 永远是自洽的一棵新树。**出站已落地（2026-09-21，决策见 §10 当日条）**：
  `currentTraceparent()` 给出当前**调用期** span 的 W3C 串（`src/engine/span-scope.ts` 的
  per-call 作用域，三层由粗到细：run 根 → 本回合 `llm.turn` → `capability`），宿主把它带在
  自己的出站请求上；框架只给读取器、不替宿主做注入（它不创建出站请求）。
  队列宿主侧已验证：`traceContext` 随 `spec.options` 落进 `TaskRecord`，所以另一个进程
  `resumePending` 续跑的那次 run 也带得上。
  ⚠️ 本节原先写的「缺的前置件是『`RunContext` 暴露当前 span』」是**错的**，与上一段自相矛盾
  （span 句柄刻意不放 `RunContext`）：run 级只存一个值，并行工具会互相覆盖；真实前置件是
  **另开一条调用期作用域**。另：出站 id 宽度走 `core/trace.ts` 的**同一份投影**
  （`wireTraceId` / `wireSpanId`，OTLP 导出也用它）—— 各写一份会让同一次调用在两个系统里
  出现两个 span id。

### 9.3 产出与导出

- v1：内存 trace store，随 run 结果/运行记录返回（结构化输出 / JSONL），便于回放调试。
- 生产：经 **sink 出口**（见下）导出 —— `createOtlpExporter` 现成、零依赖；「span 与 run 记录**同库**存储」
  只是**一种 sink 配方**（`docs/observability.md`），**不是框架内建** —— 框架只保证出口，落库 / 采样 / 脱敏 /
  按 runId 检索都由宿主用 sink 组合，零 engine 改动。
- 成本：span 级 usage 聚合自 API usage 字段（`cache_read_input_tokens` 等），run 汇总 = 各 span 求和。
- **trace 出口（sink）**：`TraceSink { export(trace) }` —— run 收尾（成功 / 失败两条路径）后框架把
  完整 trace 交给每个 sink；sink 抛错被吞，不影响 run。
- **增量出口（2026-09-21，与 sink 并列为第二条缝）**：`onTraceEvent`（单次 run 一个 + 应用级缺省）
  在 run **进行中**逐笔回调记账事件（`span.begin` / `span.end` / `span.event` / `span.attribute` /
  `span.link`，各带单调 `seq`），消费者是**等不了收尾**的那一类（终端面板 / SSE / 异步任务流）。
  机制只有一处：`TraceRecorder.subscribe()` —— 记账点唯一，engine 零改动。
  两条缝的分工写死为：**sink = 收尾拿整棵且会投递**（有兜底语义）、**事件 = 运行期逐笔且
  `不保证送达`**（宿主自己的流断了就断了）。传输层两个出口都用它：`POST /run` 的 SSE 追加一族
  `trace.event` 帧（既有三帧逐字不变）、`GET /tasks/:id/stream`（重放 → 实时 → 终态收口）。
  不变量：把一次 run 的全部事件按 `seq` 折回，必须**逐字等于** `snapshot()`（不丢 / 不重 /
  顺序 / 同源四件事一条用例钉住）。装配层 `AppOptions.sinks` 与
  `registerDefaultTraceSink()`（全局默认，构造期快照合并）；`createOtlpExporter()` 的返回值天然满足
  该接口。`agentia dev` 的本地 inspector 即经此出口取数（框架不读 env、不含 dev 逻辑）。

### 9.4 记录成本与采样（2026-09-21 已决定，不再是开放问题）

**结论：默认全量记账 + 截断默认开 + 采样不内建（是配方）+ 代价可数。**

实测依据（`npm run bench:trace`，零 token 零网络，可复现）：

- 成本 **90%+ 是事件正文**：0 次工具调用的底噪 1.2 KB（span 骨架），
  之后每次工具调用 **+1.3~1.8 KB**（缺省截断）。
- 真正会失控的是宿主**显式打开**的两件事：`maxEventChars: false`
  （大出参下 **13.66×**：5 次 37 KB 出参 17 113 → 233 797 字节）与**长跑**
  （线性：100 次工具调用 ≈ 250 KB）。
- 因此默认值不动：`maxEventChars` 默认仍收敛（2000 / 成功出参 2000 / 失败出参 1000），
  `traceLimits` 默认**不设**（全量是我们对外的承诺）。上限是给「长跑 + 大出参」的显式闸。

三项落地（都不是「默认改小」，而是「让代价可见 / 可算」）：

1. **数量上限 + 丢弃计数**：`traceLimits.maxEvents` 超限即停止记账，交付时在 run 根写
   `trace.truncated{droppedEvents, limit}` —— 与 OTLP `partialSuccess` 那条同因：
   「少了一半数据」必须有人能收到。**不做**环形缓冲（中间空洞比尾巴截断难解释得多）。
2. **采样留在缝外**（`docs/observability.md` 2.3，实现见 `examples/observability`）：
   本轮补的是**可算**（容量换算表）与**可数**（`sampleSink(...).dropped()` + `onDrop`）——
   不数的话「被采样掉」与「本来没跑」在监控上无法区分。
3. **可复现的证据**：`scripts/bench-trace-cost.ts` 进仓（与 `e2e:live` / `e2e:soak` 同档，
   不进 verify-all）——阈值这类问题的答案必须是数字，不是印象。

**未采纳**：框架内建 `samplingSink`（与 §9.3「采样是宿主职责」冲突，且示例已有实现 ⇒
同一件事两份实现）；事件落 store 的真跨进程实时流（写放大：实测事件数 = 2 × 工具调用、
正文 KB 级）；动态采样率；OTEL SDK 兼容层。

> 「trace 作重放基底」已落地，不再是开放问题：`traceToMessages` 把 trace 线性化为 messages
> （R6 / v0.2.0，见 §10 2026-09-11），`forkMessages(trace, { atTurn, append? })` 支持在主循环
> 第 N 回合截断分叉、拼新消息喂回 `app.run`（2026-09-16，见 §10）。两者同源有损
> （trace 不记 assistant 原文）：产物跑的是**新 run**，不是接着原 run 续跑。

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
  > ⚠️ **后话（2026-09-18 ⑨）：本条后半句已作废** —— 连接器改为**内置**（那个「独立可选包」
  > 从未发布）。上文保留为当时的决策记录；理由见 §10 2026-09-18 ⑨。
  **接入点偏离设计（此处锁定）**：设计写的是「`createApp({ providers })` 里放个 `useFactory` 即可」——
  **落地时不成立**：菜单只从装饰器注册表收集（`useFactory` 的返回值根本不进菜单），且 `Container.resolve`
  是同步的（`await mcpTools(...)` 塞不进去）。零新机制的做法是给 `AppOptions` 加 **`tools?: AgentTool[]`**：
  裸工具直进主菜单，且与装饰器能力**完全同等** —— 同过中间件链、同进重名查重（**不是旁路**，两条用例分别钉住）。
  **语义**：名字 = `prefix + 归一化原名`（非 `[A-Za-z0-9_]` → `_`，连续分隔符收成一个；缺省 `mcp_<server>_`，
  没给 `server` 时 `mcp_`）；归一化后**空名 / 撞名 / 超 64 字符一律装配期抛错**（不静默改名 —— 那会得到一个
  调不回去的名字）；**原名**每次调用写进发起 turn 的 `mcp.tool.<菜单名>` attribute（每次一条，并行调用互不覆盖；另留 `mcp.tool` 记最近一次，兼容既有查询）—— 审计 / 回放要还原它才能回调 server；
  `inputSchema` 原样透传（engine 的子集校验器在 `callTool` 之前先校验）；`callTool` 抛错 → 该条 `is_error`
  且**不杀 run**；**协议层 `isError: true` 框架看不见 —— 必须由连接器转成抛错**（否则模型以为成功）。
  桥自带 `timeoutMs`（缺省 60000）= **放弃等待**（拿不到 server 侧取消句柄），但它是**兜底**、不是第二裁判：
  **引擎设了 `toolTimeoutMs` 时本项不参与判定**（一次调用只有一个裁判 —— 此前的「双重计时、谁短谁生效」
  会让同一件事在 trace 里落成两种账，2026-09-17 收口，见本文件 §10 同日 ①）。
  **不做**：`sampling`（server 反向请求模型）/ `resources` / `prompts` 原语、连接池。
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
  > ⚠️ **后话（2026-09-19 ①）**：跨进程挂起/续跑**已落地** —— 关键解锁是「审批 = 异步 tool_result」
  > （不落「循环位置」、落**消息历史**：assistant 结尾的未决 tool_use 就是断点本身），见下。
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
  ⚠️ **本条结论已被 2026-09-17 决策取代**（client 自研化后 `errors.ts` 改认数据属性的鸭子类型，
  「压缩即失效」的论据反而成了**必须**鸭子类型的理由，见下）。原判断与理由保留在此，不改写。
  **未做（记入 roadmap）**：默认 client 换自研 fetch 实现 + 公共类型自有化 —— 那才是让 SDK 真正可选的正道，
  前置条件是先有「真 API 集成测试」（当前单测与 e2e 全用 mock）。
  ⇒ **两半均已于 2026-09-17 落地**（前置条件「真 API 集成测试」= `e2e:live`，2026-09-14 已就位），见下两条。

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

- 2026-09-16：**R7 质量闭环落地（score 一等公民 / gen_ai 对齐 / 回流 / 版本与 session 上 trace）**。
  设计取舍**在此锁定**：
  **① Score 契约与事件形态**：`Score { name; value; source?; comment? }`（value 约定 0–1，
  布尔结论用 0/1）+ `attachScore(trace, score)`，两者公共导出。评分挂 run 根 span 的
  **`score` 事件**（body 即 Score）而**不是 span 字段** —— 评分来自 run **之外**（run 跑完
  才由 LLM-judge / 人工 / eval 产生），span 字段在收尾时已定型，事件是「事后补充事实」的
  现成通道；多次调用即多条事件（不同维度各记各的），找不到根 span 静默忽略（观测不击穿业务）。
  **② gen_ai 对齐钉 v1.37 基准、映射集中单模块**：OTLP 导出 **additive** 追加 `gen_ai.*` 键
  （旧 `usage.*` 键一律保留 —— 既有看板/告警已消费它们，双发成本极低）。选 v1.37 是因为该版
  `gen_ai.client` 侧（chat / execute_tool / request.model / usage.*）已 stable，agent 侧
  （invoke_agent / agent.name / conversation.id / evaluation 事件）仍 experimental —— stable
  键优先、experimental 键补齐 agent 语义，下游（Datadog / Axiom 等）已按 1.37+ 识别这批键。
  约定仍在漂移（此前 v1.37 就把 `gen_ai.system` 改 `gen_ai.provider.name`），故**全部映射集中在
  `otlp.ts` 的 `genAiAttributes` / `mapEvent` 两处**，升级基准版本只改本模块。`score` 事件译为
  `gen_ai.evaluation.result`（维度名用 semconv 的 `gen_ai.evaluation.name`，**不是** `gen_ai.evaluation.score.name` —— 后者不存在）；`source` / `comment` 是 semconv 未定义的维度，走自有
  `agentia.score.*` 键，不占用 gen_ai.* 命名空间。
  **③ `prompts.versions` 拼接形态**：`PromptSpec.version` 声明后，装配期沿主菜单同一条收集路径
  （`toolSources` 收窄同样生效）收集 `{ 最终菜单名: 版本 }` 表，engine 拼成 **`name@ver` 逗号串、
  按名排序**落 run 根单个 attribute（对照先例 `system.version`；排序让同一菜单的产物字节一致、
  可直接做等值筛选），**空表不记**（不写空串冒充实有版本，与 `system.version` 同口径）。
  内核 `collectPromptEntries` 收「工具 + 版本表」两份，是 **module 级 export 不进公共面**；
  `collectPrompts` 公共签名不动。
  **④ session.id 上 trace**：`executeRun` 给了 `session` 就自动把 id 写进 run 根 `session.id`
  attribute（OTLP 侧映射 `gen_ai.conversation.id`，thread 维度聚合），不用手填。
  **⑤ defineEval 自动 score**：每个用例跑完把 `{ name:'eval', value:0|1, source: eval 名,
  comment: 失败原因 }` attach 到该用例 trace —— eval → trace → 监控一次打通；`app.run` 抛错
  （环境错误）拿不到 trace 时不挂。
  **⑥ harvest 刻意不进公共面 + CLI 双实现对拍**：`harvestEvalCase`（trace → eval 用例 TS 骨架）
  是 **module 级 export**（进公共面就得为「生成代码字符串」这种工具性 API 长期背书，且
  `tests/docs/api-page.test.ts` 的反向全覆盖会逼官网同步）。CLI `agentia harvest` 侧是
  **去类型移植副本**：CLI 零运行时依赖不能 import 框架，而构建期拷贝会让 CLI build 依赖框架
  dist 的存在、复杂化 publish 流程 —— 双实现是有意决策，由 `packages/cli/test/harvest.test.mjs`
  的**逐字对拍**守护（改生成格式必须两边同步）。已知边界如实写进生成物注释：trace 不记
  assistant 文本（脚本 text 块是占位）、只重建主循环回合、预填 expect 是抄录的实际轨迹。
  **⑦ 在线评估采样**按调研结论落为 **recipe**（usage-guide §6：sampleSink + judge + attachScore
  + metricsSink 拼装），不进框架 —— 评什么、采样率多少是业务策略，与「护栏/配额只给缝」同口径。

- 2026-09-16：**trace diff 与分叉重放落地（`diffTraces` / `forkMessages`）**。
  设计取舍**在此锁定**：
  **① trace diff 落 `diffTraces(a, b, opts?)`（engine，纯函数，公共导出）**：不发起请求、
  不改 trace，产出 `TraceDiff { equal; summary; spans }` —— run 级 summary（status /
  totalUsage.* / 根 span attributes）+ 逐 span 字段级差异（`SpanDiff { path; a?; b?; fields }`，
  字段差逐条 `DiffEntry { field; a; b }`）。**配对键决策**：llm.turn 的配对键**只有 kind、
  忽略 name** —— name 是模型 id，而「换个模型重跑」正是 A/B 主用例，按 name 配对会把两侧
  所有 turn 都报成缺失；模型差异降格为配对 turn 的 `name` 字段差。capability span 按
  `kind:name` 配对（`skill:foo` vs `skill:bar` 是不同能力，不该配上）。同键孩子按 startedAt
  稳定排序后按下标一一配对；**缺侧子树不下钻** —— 一条缺侧 SpanDiff（fields 为空、path 照给）
  即代表整支。**默认忽略墙钟**（`ignoreTiming` 缺省 true：span startedAt/endedAt、event time
  缺省不比；`false` 时改比 span 时长 endedAt-startedAt，绝对时间戳永不比）；traceId 是身份
  不是行为，永不比。**根 attributes 差同时进 summary（第一眼视图）与根 SpanDiff（完整视图），
  重复是有意的** —— A/B 模型第一眼就看 `attributes.model`，而完整下钻视图不该少这一块。
  **② 分叉重放落 `forkMessages(trace, { atTurn, append? })`（公共导出）**：在主循环第 N 回合
  （0-based）之前截断，只重放分叉点前的真实历史，再拼上调用方给的新消息（通常是改写过的
  新 user 消息）。锚点 = **主循环回合**（`parentSpanId === rootSpanId` 的 llm.turn，子 agent
  嵌套回合不算 —— **与 harvest 口径一致**），越界抛可读错误（带回合总数）。**不做「真续跑」**：
  trace 不记 assistant 文本 / run 原始输入 / blackboard —— 产物是喂回 `app.run` / `runAgent`
  的 messages（assistant 文本为标注占位、首尾说明性 user 为合成），跑的是一条**新 run**，
  不是接着原 run 的循环位置；黑板的分叉种子由调用方经 `RunInvocationOptions.blackboard` 自带。
  **③ 为什么不做图形 diff / UI**：对照 R7 调研结论（不建看板 / CMS，框架内建 trace + 零后端
  导出）—— diff 给**结构化数据**（`TraceDiff`）与命令行出口即可，渲染复用既有 trace-view /
  inspector 生态，不新建 diff 看板。
  **④ CLI `agentia diff`（同批落地）**：trace.jsonl 直比，
  **有差异时 exit code 1**（diff(1) 语义，可直接进 CI 挡「换 prompt 后轨迹漂移」）；实现按
  harvest 同模式 —— CLI 零运行时依赖不能 import 框架，故为**去类型移植副本 + 逐字对拍**守护
  （改 diff 语义必须两边同步）。
- 2026-09-16：**canCall 能力级能力边落地（`token/能力名` 路径语法）**。`SubAgentSpec.tools` /
  `SkillSpec.tools` 的元素此前只能是 provider token（整片菜单引用）；现在同时接受
  `'<provider-token>/<能力名>'`，只引该 provider 菜单里的单个能力。决策：**字符串路径语法**
  （不引入对象形态）—— 类型 `string[]` 不变、向后兼容，能力名经 collect 校验不含 `/`
  （`^[A-Za-z0-9_-]{1,64}$`），按第一个 `/` 切分无歧义。校验在**装配期**（createApp 即抛）：
  token 未注册沿用原文案（既有测试锁定），能力名不存在则报错并附**排序后的可用名单**；
  可用名单与运行时菜单同口径（@Tool + 该 provider 的 skill/subagent/prompt 工具四份合集
  —— 只用 @Tool 菜单会误拒 `'skills/helper'` 这类合法点名，校验面与解析面必须一致）。
  解析从 `wrappedByToken`（**中间件包装后**的菜单）按名 filter —— 嵌套能力绕不过中间件，
  2026-09-11 ① 的防绕过教训对本路径同样成立。粒度收窄全部发生在装配层产出菜单时，
  engine 分发点零改动。MCP 裸工具仍不可被引用（没有 provider token，边界不变）。

- 2026-09-17：**默认 client 自研化落地 —— fetch + SSE 手写实现，engine 对 SDK 零运行时 import**。
  `integrations/anthropic.ts` 手写 `POST {baseURL}/v1/messages` + 逐行 SSE 组装，**不再实例化
  `@anthropic-ai/sdk`**；引擎经 `createAnthropicClient()` 取默认 client，使用者自定义只传
  `apiKey` / `baseURL`，不必直接依赖该 SDK（2026-09-13「未做」两半中的前半落地）。
  **错误分类随之改为鸭子类型**：`engine/errors.ts` 不再 `instanceof` SDK 错误类，改认数值
  `status`（429→rate_limit、5xx→server、其余 4xx→api）、带 `cause` 的 TypeError / errno `code`
  （→connection）—— 反转 2026-09-13「不做鸭子类型」的结论：当日实测的「SDK 错误类 `name` 恒为
  `'Error'`、`type` 为 null、靠 `constructor.name` 压缩即失效」此时不再是拒绝鸭子类型的理由，
  反而是**必须只认数据属性**的理由（自研 client 抛的是自有 `AnthropicApiError` 与 fetch 原生
  网络错误，同套判法对第三方 SDK 错误同样适用）。已知边界：SDK 的 `APIConnectionError` 无
  status/code 可判，若使用者自装 SDK 并让它抛到引擎，该类错误落 unknown（该重试的不再重试）。

- 2026-09-17：**公共类型自有化落地，`@anthropic-ai/sdk` 退出运行时依赖（零运行时依赖达成）**。
  新增 `src/core/message.ts` 自有消息类型族（请求侧 `MessageParam` / `ContentBlockParam`
  （text / image / tool_use / tool_result + 兜底）/ `ToolParam`，响应侧 `Message` /
  `ContentBlock`（text / tool_use / thinking + 兜底）/ `MessageUsage`），字段口径与 SDK
  逐字对齐（snake_case）。**这条是 2026-09-13「依赖形态 = 纯 dependencies」结论的反转与消解**：
  当日论据①（公共类型面直接用 `Anthropic.MessageParam`，用户必须装 SDK）因类型自有化不再成立，
  SDK 随之从 `dependencies` 移入 `devDependencies` —— 留下的唯一理由是类型兼容门禁
  （`tests/types/message-compat.types.ts` 钉双向/单向 assignability：SDK 的
  `MessageParam` / `Message` / `TextBlockParam` / `ToolUseBlockParam` / `ToolResultBlockParam` /
  `Tool` / `CacheControlEphemeral` → 自有类型整体可赋；自有具体块可赋回 SDK；
  `@ts-expect-error` 钉住「兜底块不回赋 SDK 精确联合」等不该过的方向）。配套决策：
  ① **命名避让** —— `Tool` 已被 @Tool 装饰器占用、`Usage` 已被 trace 聚合用量占用，
  消息侧对应物命名 `ToolParam` / `MessageUsage`；
  ② **兜底成员是 `{ type: string }`，刻意不带索引签名** —— 实测 SDK 的块类型全是
  interface（无隐式索引签名），带 `[key: string]: unknown` 的兜底会让
  「SDK `MessageParam[]` → 自有 `MessageParam[]`」整体赋值编译失败，方向一承诺当场破产；
  只有 `type` 的最小面两个方向都通，未知块原样携带（读字段自行收窄）；
  ③ **`Role` 含 `'system'`** —— SDK 0.124 的 `MessageParam.role` 逐字如此，
  方向一要求对齐（引擎自身只产出 user/assistant）；
  ④ **`tsconfig` 显式 `"types": ["node"]`** —— 全仓 `@types/node` 此前竟是靠
  「import SDK 类型 → SDK internal/types.d.mts 引 undici-types → `/// <reference types="node" />`」
  这条传递链偶然进编译程序的，移除 SDK import 后全局类型（AbortSignal / process / setTimeout…）
  整片消失（117 个错误）；显式声明后这条隐性依赖被根除。
  实证：`npm pkg get dependencies` 输出 `{}`；`e2e:live` 真端点 6/6。
- 2026-09-17：**外部 review 驱动的修复批**（DeepSeek 通读全仓后的指认，逐条核实后修）：
  ① **CLI Windows 支持修复** —— `npmBin` 只加 `.cmd` 后缀，CVE-2024-27980 后裸 spawn `.cmd`
  直接 EINVAL（「dev/add 支持 Windows」曾是超前宣称）。改 `npmSpawn`：win32 走
  `cmd.exe /d /s /c` 包装 + 逐参数脱敏（cross-spawn 算法；不用 `shell: true`——它把参数
  空格 join 零转义，`add` 的包名/路径是用户输入，含 `&` 即成命令注入）；非 win32 原样直传。
  ② **doctor import 识别**不再只认 default import（named / namespace / 别名 / 双引号 / 跨行
  都认）——此前这些形态命中「无法定位 import，跳过」，悬空条目**漏检**（静默跳过）。
  ③ **脚手架模板纳入类型检查**：e2e-cli 新增 4c 步（生成项目在临时目录跑真 `tsc`，
  `@migor/agentia` 解析到 dist .d.ts 即发布形态）——此前模板类型错误要等用户
  install 后才暴露。折进既有 e2e 步骤，不加 verify-all 第 9 步。
  ④ **对拍守护排响**：`distReadyOrLoud` —— 产物缺失时本地醒目横幅 + skip（裸跑场景），
  CI 里（产物恒在）直接判失败；harvest 对拍升到 diff 同款（六组夹具逐字相等），
  report/templates/inspector 的静默 skip 同批消除。
  ⑤ **agentLoop 拆分（纯重构，零语义变更）**：433 行循环体拆成 8 个有名字的函数
  （编排骨架 82 行），教训注释随代码块搬迁；全部 699 例测试一行未改全绿 +
  e2e:live 6/6 复验。
  ⑥ **官网对外口径**：正文链接默认蓝 → 主题色（--ice）；playground 两处单价
  {3,15}/{0.8,4} 对齐 usage.ts 真源（{5,25}/{1,5}）；playground-real 的「trace 原样
  产物」措辞改诚实（浏览器侧按 trace 形状构造的演示数据）；docs 页补 h1。
  ⑦ **文档对账**：spec 标题去「v0.1 草案」（规范快照 vs §10 时间线的阅读口径写明）、
  §9.4 replay「不进 v1」等过期断言改写为现状、被取代条目按体例加标注不改写历史。
  未采纳项及理由：`agentLoop` 未拆新文件（动分层 ALLOWED 集合，收益不抵成本）；
  executeOneTool 的 submit_result 分支未再拆（共享局部态）。

- 2026-09-17：**第四轮 review（文档面 + 边界条件）**—— 逐条回源码核实后修，全部带回归用例：
  ① **`app.run` 补 `memory` 选项**（公共 API 增项，非破坏）：`RunAppOptions` 与实际能力不一致 ——
  官网 `docs.html` 与单源 `usage-guide.md` 都写 `app.run(messages, { memory })`，而该字段只存在于
  `ExecuteRunOptions`；`session` 早已转发、`memory` 漏了，属漏项而非设计取舍（两者同为
  「store 实例不可序列化 ⇒ 只在程序内可用」的边界）。修法 = 按 `session` 同款转发 + 用例
  `tests/runtime/memory.test.ts`（水合 + 回写两条断言，变异自证：去掉转发即红）。
  ② **`compactMessages` 回退边界差一**：`while (cut > 1 …)` 在「工具对的 `tool_use` 在索引 0、
  且 `length === keepRecent + 1`」时停于 `cut = 1` ⇒ 摘要吃掉 `tool_use`、尾部留孤立
  `tool_result`（且与摘要构成连续两条 `user`），下一次请求 400 —— 两条都违反该函数自己的
  docstring 承诺。**行为变更**：这种历史改为**放弃压缩、原样返回**（宁可少压一次）。
  ③ **CLI 错误路径三处**：`create` 撞同名普通文件从裸 `ENOTDIR` 栈改为可读报错；
  8 个子命令支持 `--help`（此前被当成文件名去读，且用法串三处重复 → 收成常量单源）；
  `harvest --out` 默认**拒绝覆盖**已存在产物（新增 `--force`）——产物是人工核对的脚手架，
  静默覆盖等于毁掉那份人工成果。
  ④ **文档面形状守卫**：新增 `tests/docs/run-output-shape.test.ts` —— `.finalText` 的接收方
  必须是 `result`（`AgentRunOutput = { run, result }`）。这类手写代码片段此前**没有任何门禁**
  （api.html 只被表格守卫盯着），两处 `out.finalText` 因此活过多轮全绿；`api-page.test.ts` 的
  行匹配器同时放宽（带属性的 `<tr>` 不再整行静默跳过）。
  证据：6 处修复各配一条回归用例，**变异电池 6/6 咬人**（逐条改坏 → 只跑对应用例 → 全红）；
  全链 `verify-all.sh` 8/8。

- 2026-09-17：**第五轮 review（全覆盖缺陷清扫）** —— 三轮子代理候选逐条回源码 / 探针核实后修，
  三条 MAJOR **同时**实证 + 修好 + 加真路径用例：
  ① **`app.run` 漏转发 `signal`**（`RunInvocationOptions` 17 个字段只漏这一个；TS 因继承不报错）：
  HTTP 断开 / `drain` / `AsyncRunner.runTimeoutMs` 三处取消静默失效。根因是**「假边界挡住真边界」**：
  三处宿主测试都用**假 app** 断言「signal 交到了 app」，真 `AgentApp` → engine 那一跳无人测。
  修法：补 `signal: opts.signal` + 用例（已中止的 signal ⇒ `aborted` 且不打模型）。
  ② **OTLP `spanId` 宽度**：两种 id 共用一个 `hexId`（32 hex），而 OTLP 要求 span id 16 hex。
  修法：`traceHex` / `spanHex` 分开；既有用例把错宽度写成了期望，一并纠正。
  ③ **OTLP 能力 span 的 `gen_ai.*` 从未发出**：按 `name.startsWith('subagent:')` 判类型，
  而生产是裸名 + `attributes.subagent` / `skill`（另三个消费者都读 attributes）。**错形状还被抄进
  四处测试夹具**（otlp / harvest / tracer / trace-diff），所以一直是绿的。修法：改读 attributes +
  夹具改生产形状。同一批还修了 `gen_ai.evaluation.score.name`（不存在，应为
  `gen_ai.evaluation.name`，以真 semconv 包取键名证据）、`costEstimate` 原型链 → NaN、
  `mcpTools` 的 description 类型防御与 `mcp.tool.<菜单名>` 并行不覆盖、
  `combineSignals` 同源去重、`session.append` 展开传参、`harvest` 缺 tool 伪造 `unknown` 与注释注入、
  `replay` 数组型 input。
  证据：13 处修复**变异电池 13/13 咬人**（含一次「M12 没咬住」→ 查出是**我的用例断言写错**，
  改成按行首判后咬人）；`verify-all.sh` 8/8；派生产物同一 sha。
  **教训（写进本仓库口径）**：凡「宿主/消费方测试用假实现」的边界，必须有一条走**真实现**的用例 ——
  三条 MAJOR 全部活在这类缝里。

### 2026-09-17 ①：MCP 超时**单源化** —— 一次调用只有一个裁判（桥不再自判）

**背景**：`engine/concurrency.ts` 的 `withTimeout` 自 2026-09-14 ②（本文件）起是「不看竞速、只看实测耗时」
的硬保证；但同一判定在 `src/integrations/mcp.ts` 里有**第二份实现**（`withDeadline`，纯 `Promise.race`），
而 ② 那次收紧只改了 engine 那一份（`git show --name-only 1ceb372` 的文件清单里**没有** `mcp.ts`）。

**取证（先证再改，三档）**：

- **确定性构造**（② 证明 `withTimeout` 有病时用的**同一个**构造：预算 20ms、工具 5ms resolve 后在同一回调里
  同步阻塞 30ms）：桥返回 `'late'`（= `ok: true`，实测 wallMs **79**）、engine 返回 `TIMED_OUT`
  ⇒ **超预算的调用被记成成功**。
- **800 次扫描（8× CPU 超订）**：`预算20/工作20` 一档 **桥 800/800 记成功**（样本 elapsed 20/21/22 > 预算），
  同档 engine 799 超时 + 1 次 19ms 合法返回；`预算20/工作21` 两实现都 800 全超时；3× 余量档 **0/800 未复现**
  （与 ② 记的 1/1200 稀有度一致）—— **不据此下结论**。
- **真引擎路径**（`runAgent` + `mcpTools`，读 trace 的 `tool.output`）：
  `引擎20/桥20/工作20` → 40/40 `errorKind=timeout`；**`引擎20/桥20/工作21` → 40/40 `threw` + `error(unknown)`**；
  `引擎5000/桥20/工作21` → 40/40 `threw`；`引擎20/桥5000/工作21` → 12/12 `timeout`；
  `引擎不限/桥20/工作20` → 40/40 `ok:true`（durationMs 21）
  ⇒ **同一个物理事件，账目取决于「谁先到」**。

**根因**：同一个承诺两份实现，且桥那份是竞速判定；engine 的 catch 又把桥的普通 `Error` 交给 `classifyError`，
而它**没有 timeout 这一类** ⇒ 同一事件裂成 `timeout` / `threw`+`unknown` 两种账。常见配置
（引擎预算 ≤ 桥预算）下 engine 的实测耗时兜底**掩盖**了桥的缺口，这正是它一直没被发现的原因。

**决定**：

1. **原语单源**：`TIMED_OUT` + `withTimeout` 下沉到 `src/core/timeout.ts`（core 是叶子、零 import，且
   `integrations` 只能依赖 core ⇒ 落点唯一）；`engine/concurrency.ts` **原样再导出**，`turn.ts` 与既有测试零改动。
2. **一次调用只有一个裁判**：`ToolRunContext` 新增 `toolTimeoutMs`（engine 在 `executeOneTool` 注入）；桥在
   「引擎设了预算」时**不再启动自己的计时器**。`McpToolsOptions.timeoutMs`（缺省 60000）退化为**兜底**，
   只在「桥脱离引擎单用」或「引擎没设 `toolTimeoutMs`」时生效。
3. **超时是一类账**：新增 `TimeoutError`（`code='timeout'`）与 `isTimeoutError`（认鸭子类型）；引擎的工具级
   catch 把任何 `code==='timeout'` 的错误记成 `errorKind='timeout'` + `error(timeout): …`。对使用者可见的
   契约是 **`code` 字段**，不需要 import 那个类。
4. **兜底路径也用硬判定**（不是只搬代码）：桥的 `withDeadline` 变成共享原语的薄封装 —— 同一条实测耗时规则
   对两条路径都成立，不存在「哪条路靠运气」。

**代价（如实记）**：

- **行为变更 1**：引擎设了 `toolTimeoutMs` 时桥的 `timeoutMs` **不再生效**（即使桥更短）。「谁短谁生效」
  作废 —— 想收紧某个 MCP server 的时限请设 `toolTimeoutMs`。
- **行为变更 2**：桥自判的超时从 `errorKind='threw'` + `error(unknown)` 变为 `errorKind='timeout'` +
  `error(timeout): MCP 工具 "x" 调用超时（超过 20ms）`。**按 `errorKind` 分流看板的查询需知悉。**
- 边界语义收紧（同 ②）：耗时刻到预算即算超时。

**门禁**（均为**确定性**构造，不拿余量赌概率）：

- `tests/core/timeout.test.ts`（新）：共享原语直接单测（哨兵区别 `undefined` / 非正预算透传 /
  `TimeoutError.code` / `isTimeoutError` 只认那一个 code）。
- `tests/integrations/mcp.test.ts`：兜底超时**记 `errorKind=timeout`**（旧断言只看了 `ok=false` 与文案）；
  「单一裁判」两条（引擎 5000 + 桥 20 ⇒ 必须成功；引擎 60 + 桥 5000 ⇒ 记引擎的账与文案）；
  **兜底路径的确定性构造**（resolve 后同步阻塞越过截止 ⇒ 必须记超时）。
- `tests/engine/toolTiming.test.ts`：工具抛 `code='timeout'` ⇒ `errorKind='timeout'`。
- **变异电池 7/7 咬人**：桥不交出裁判权 / 桥退回纯竞速 / 去掉实测耗时兜底 / `isTimeoutError` 恒 false /
  引擎不认自判超时 / 不注入 `toolTimeoutMs` / 桥丢掉 `code` —— 每条都指名了变红的用例。
- **顺序**：既有 39 条（concurrency / toolTiming / mcp / timeoutLiveness）在**单源化那一步之后**先跑一遍全绿
  ⇒ 证明「提取零行为变化」，**然后**才做行为变更（两件事分开验，免得把重构错判成回归）。

**未坐实 / 未做（如实标注）**：

- 3× 余量下的桥翻转未复现（0/800）；本条证据是确定性构造与边界档，不依赖它。
- 「同批到期、计时器表顺序决定谁先」仍是**假说**（② 同样保留）。

### 2026-09-17 ②：超时是**自己一类** —— `errorType` 由 `connection` 改为 `timeout`

**先更正记录**：① 里那条「`classifyError` 仍不认 `timeout` ⇒ 模型调用超时在 `span.error` 上是
`type:'unknown'`（不可重试）」**整条写错了，已删除**（不写修正版）。事实相反 —— `engine/errors.ts` 的
`isConnectionError` 有一条专门认 `name === 'TimeoutError'` 的判据（注释写明就是给 `AbortSignal.timeout` /
默认 client 的超时合成信号用的）⇒ 超时一直落 `type:'connection'` + `retryable: true` ⇒ **缺省就在自动重试**。

**证据（端到端，不是读判据）**：真路径 `runAgent` + 真 trace，第一次尝试抛
`DOMException('Anthropic 请求超过 100ms', 'TimeoutError')`、第二次成功：

```
calls=2   onRetry=[{attempt:1, type:'connection', retryable:true}]
turnCount=2  turnStatuses=['error','ok']   最终 end_turn + finalText='重试后成功'
firstTurnError={type:'connection', message:'Anthropic 请求超过 100ms', retryable:true}
```

**为什么误判**：只读了 `classifyError` 的 status 分支与 `instanceof Error` 兜底，漏读了下面
`isConnectionError` 的第三条；而且断言「这条行为没有用例守着」时用的 `grep … | head -12` 把
`tests/engine/errors.test.ts` 的匹配**截断**了 —— 那条断言就在那里（「无 status 的网络型错误」条目的最后
一段，钉的是 `TimeoutError → connection`）。**「我没看到」不等于「不存在」。**

**决定**：超时不再混进 `connection`，它是自己一类。

1. `core/timeout.ts` 的 `isTimeoutError` 扩成三条判据（**全是鸭子类型**）：框架 `TimeoutError` 实例 /
   `code === 'timeout'` / `name === 'TimeoutError'`（内建 DOMException 的规范 name）。分类与工具级记账
   共用同一条判据，口径一致。
2. `classifyError` 新增显式分支 → `{ type: 'timeout', retryable: true }`；`isConnectionError` 里原来的
   TimeoutError 判据**删除**。分支放在 status 分支**之后** ⇒ 带数值 status 的错误仍优先按状态归类
   （优先级与改动前逐字一致）。
3. **`retryable` 保持 `true`**：超时一直是可重试故障，本单**不改重试行为**（缺省 `maxAttempts=3` 照旧），
   只改记账口径 —— `span.error.type` / `trace-diff` / 看板现在能把「超时」与「连不上」分开。

**代价（如实记）**：**`errorType` 取值变更** —— 按 `span.error.type` 分流的看板 / 告警，超时类会从
`connection` 变成 `timeout`；`trace-diff` 比对旧 trace 时超时显示为「类型变了」。**重试行为不变。**
`tests/engine/errors.test.ts` 里那条旧期望（`TimeoutError → connection`）是**有意改掉**的（错的契约被钉成了
期望），被改坏的原断言与理由写在用例注释里。

**门禁**：`tests/engine/errors.test.ts`（超时三类形态同判 + status 优先级不变）、
`tests/engine/retry.test.ts`（缺省 `isRetryable` 认超时）、`tests/engine/loop.test.ts`（端到端：
超时 → 重试 → 成功，断言 `onRetry`、两个 turn，且失败 turn 的 `error.type='timeout'`）。

### 2026-09-17 ③：发版面**单源化** + 闸门扩到全发布面；tag 体例回到 annotated

**先更正一处错**：本仓库的发布约定一直写「这四个同步点」与「发版步骤：bump 四处」。**「四处」是错的** ——
刚发布的 v0.6.1 一次 bump 真实动了 **17 个文件**，而漏点全在「四处」之外：`examples/` 的 `^旧版` pin
（含两个 Dockerfile **注释**里那份）、`.github/ISSUE_TEMPLATE/bug_report.yml` 的版本占位、README 版本行、
`docs/roadmap.md` 状态行、`docs/spec.md` §11 进度链、CHANGELOG 的 compare 基线与链接引用、
`package-lock.json` 的 4 个 version 字段。这些不是假想风险：上一次发版就出现过「只在 README 改了 pin、
Dockerfile 注释没改」，lock 的 version 字段也整轮跳过而全链全绿。

**决定**：

1. **发布面清单单源**：`scripts/release-surface.mjs` 定义 18 项替换面（每项带 `count` 期望值与「漏了会
   怎样」）+ 3 项结构面（本版**必须新增**的：CHANGELOG 条目、CHANGELOG 链接引用、spec §11 链段）。
   `--list` 给人看、`--json` 给测试。闸门与 bump 共用这一份，免得「闸门认一套、bump 又认一套」。
2. **闸门扩到全发布面**（`scripts/check-release.mjs`，仍挂两包 `prepublishOnly`）：除原有的发布面一致性
   与「必须高于 npm 已发布版本」，新增「本版 CHANGELOG 条目存在且不是空骨架」。命中口径是「一个匹配里的
   **所有**捕获组都等于版本号才算命中」—— lock 里那 343 个第三方版本号一个都不算。
3. **`scripts/release.mjs bump`**：逐项替换，每项对着 `count` 断言；**任何一项不符即全部中止、一个字节
   都不写**（先算完所有文件的新内容，再统一落盘）。两个散文位（CHANGELOG 正文 / spec §11 链说明）只插
   骨架并带 `TODO(发版)` 标记，由人填；未填时严格闸门会拦（`--allow-pending` 是 bump 自己复检时用的降级）。
4. **`npm publish` 不进脚本**：它是唯一不可逆的一步 —— 版本号一旦花掉收不回；把它放在「重写十几个文件」
   旁边等于放大一次笔误的爆炸半径。它仍是两条显式命令，由 `bump` 打印，且**顺序固定为 发布 → 合并 →
   打 tag**（反过来的话 main 上会挂着「已发布」而 registry 还没有）。
5. **tag 一律 annotated**，由 `scripts/release.mjs tag` 创建：消息**写文件 + `-F` 传入**，建完
   `git cat-file tag` 回读。理由是**踩过的坑**：`git tag -a v1.2.3 -m "…<反引号>@migor/agentia<反引号>…"`
   里的反引号会被 shell 当**命令替换**执行 —— 消息里的词当场消失、bash 还会先打一行
   “No such file or directory”，而 tag 照样创建成功。
6. **打 tag 前核对「产物 ↔ 树」**：单源文档 `docs/usage-guide.md` 与 registry tarball 内
   `dist/AGENTS.md` 的 sha256 必须相等；另加产物里的 `AGENTIA_VERSION`、CLI 包零 `@migor/*` 依赖、
   `dist/inspector/` 在场。判据取单源文档，是因为它串起了这份文档被消费的四个面（不是逐文件 diff）。
7. **存量 lightweight tag 用 `retag` 显式转换**（默认只演练，`--apply` 才真改）：本仓库最早五个 tag
   （v0.2.2–v0.4.2）是 annotated，v0.5.0 起退成了 lightweight —— 所以这条是**回到仓库自己的老体例**，
   不是引入新体例。脚本不自动改已推送的 tag（force-push 是外部可见动作）。

**为什么闸门仍在 `prepublishOnly` 而不进 `verify-all`**：未发布窗口内 `AGENTIA_VERSION` 是**有意落后**的
（包版本先行），放进主链会让每次本地运行与 PR 为一种有意状态变红。

**门禁**：`tests/scripts/release-scripts.test.ts` —— 夹具是**合成**的（不拿当前树做快照，否则未发布窗口会让
它假红），钉的是护栏本身：计数不符即中止且**零写盘**（用 `git status --porcelain` 为空作证）、版本号只能
往前走、lock 的第三方版本号不被改、闸门能逐项点出不同步的那一面。变异电池 4/4 咬人。

### 2026-09-17 ④：官网首屏换成**真 trace 自播**（背景 canvas 降级共存）

**先更正一条我自己给出的成本账**：评估时我把「落地页 135KB JS」和首屏那块 canvas 摆在一起说，
暗示删掉 canvas 能省流量 —— **错的**。那 135KB 是 `gsap` 73 + `ScrollTrigger` 45 + `lenis` 19，
canvas 是手写的、**一行库都不引**（删它省的是每帧全屏重绘与注意力，字节数是 0）。
账要按真实归属记，否则决策会站在一个不存在的收益上。

**问题**：落地页文案把 trace 标成「**核心**」（`02 FEATURES` 第一张卡带 `feature--flag 核心`），
但首屏此前只有一层通用节点网络 canvas（hub + 7 卫星 + 沿线脉冲 + 鼠标视差）—— 每家 AI 创业公司
首屏都有这个，它不说本框架的任何独特之处。而产品真正的证据（`runId == traceId`、每次模型往返与
能力调用逐条记账、子 agent 递归成树、token/成本/耗时逐 span 落账）只出现在文案里。

**关键前提：证据本身早就写好了。** `@migor/trace-view` 渲染器（CLI inspector 与官网 playground
共用）＋ `/playground` 的「模拟演示」回放引擎已经在演「run 长成调用树 + token/成本往上跳」。
缺的只是把它搬到首屏 —— 所以这一单**不新增渲染能力**，只做接线。

**决定**：

1. **首屏加一块只读的 trace 自播面板**（980px 宽、296→272px 高、内部滚动），复用三样既有资产：
   渲染器（`@migor/trace-view`）、场景脚本（抽到 `packages/website/src/scripts/scenarios.js`）、
   回放游标（抽到 `trace-player.js`）。**节奏与 `tool.output` 的 LIFO 配对只有一份定义** ——
   playground 的 `runScenario` 改为调用共享游标，只保留终端面板与外层状态。
2. **背景 canvas 共存而非删除**：它是 `position:absolute` 的全屏层，面板在文档流里 `z-index:2`，
   叠放不需要改层级。但**要退半步**（三项一组：`opacity` 1→0.6、脉冲生成概率 0.06→0.03、
   鼠标视差 18/14→10/8）—— 两个都在动的画面里，背景不压就变成两处动效互相抢注意力。
3. **面板标明「录制回放」**：脚本数据参照真实 trace 结构，但**不发起任何真实模型调用**；
   页面不能让它看起来像 live。
4. 沿用站内既有的三条动效约定：`prefers-reduced-motion` ⇒ 不播动画、直接把每个 `wait` 归零跑完
   （脚本一个字不改）落**完整静态终态**；自播一次就停、不无限循环；离屏 / 切后台取消
   （`IntersectionObserver` + `visibilitychange`）。

**代价与边界（如实记）**：首屏高度变成「文案 556 + 面板 358 + 间距内边距 152 ≈ 1066px」，
于是面板在 900 高的视口里只露出 208px、在 375×812 的机器上要往下滚一格才看得到。
压面板高度与首屏内边距把底边从 901 收到 1050/692（1280×900 下可见 208px ⇒ 正在长树的那段在屏内），
手机上「滚动一格」判为**正常形态**：要把它挤进一屏就得砍标题或缩字号，那是拿首屏说服力换位置。
不做「两栏（文案左 / 面板右）」变体 —— 那会改掉首屏的居中气质，留作后续选项。

**门禁**：`tests/docs/website-playground-expand.test.ts` 的「两个宿主各一处 `tool.input` 记录点」
随之更新（模拟宿主那处从 `playground.js` 挪到 `trace-player.js`，覆盖面不变、变异仍咬人）。
浏览器侧证据：控制台零错误；行数 1→10 在长；计数器 0 → `7,250 / 738 / $0.0547`；自播 ~6.5s 后静止；
9 个宽度无横向溢出；`reduced-motion` 下加载即终态；首屏内入场元素 `opacity` 全为 1；
**`/playground` 与改动前逐字对拍相同**（10 行树 / 11 个终端块 / 计数器 / 菜单高亮）；
canvas 中心区采样 `ink≈3,600`、8/8 采样值互不相同（确实在动）、backing 尺寸 == CSS 尺寸（不糊）。

**2026-09-17 ⑤ —— trace 跨进程关联：入站 `traceparent` → run 根 span links**

**要解决的问题**：定位（§1）说「**trace 决定你敢不敢上线**」，而审计的第一要求是**能追溯来源**。
此前一条 trace 是孤岛：看不到「这次 run 是被哪个网关请求 / 哪条队列消息触发的」，
审计链在服务边界上断掉。

**决策（形态）**：用 **OTLP 风格的 span link**，**不是**父 span。入站给一个
`TraceContext { traceId, spanId? }`（HTTP 宿主认 W3C `traceparent` 头），run 根记一条 `links`；
`traceId == runId` 的 1:1 不变量**不变**。三条理由：
① 继承上游 traceId 会让一次 run 的调用树**依赖上游是否还活着 / 是否被采样掉**，树就不再自洽；
② 审计要的是「可查的因果」，不是「同一个 traceId」—— `links` 正是 OTLP 为跨 trace 因果定义的；
③ 跨服务时上游通常在另一进程、另一套采样策略下，继承会把两个系统的采样决策绑死。

**决策（只做入站，出站如实不做）**：框架**不生成**出站 `traceparent`。运行中没有「当前 span」
这个概念（`RunContext` 只有 `runId` 与 blackboard），要生成就得替调用方编一个 spanId —— 那是**假数据**，
后端会据此挂出一棵错的树，比不做更糟。出站的前置件是「`RunContext` 暴露当前 span」，列为后续项。

**为什么先做这条**（同批候选 B 增量 trace 出口 / A 无损档 / D 属性面）：
只有 C 被定位**直接要求**（审计 = 可追溯来源）。B 兑现的是长任务进度可见性，属**宿主 / 服务能力**
那条线（它解锁的是被后置两次的 `GET /tasks/:id/stream`），不该当观测方向排期；A 是已发布功能
（replay / fork / harvest）的保真度债，触发条件是「有人抱怨重放结果不一致」；D 不是产品决策，
随碰到该模块的 PR 顺手补。而 spec §9.4 的开放问题里，只有这条是**连语义都没定**的
（§9.2 原文「v1 先把 header 语义定好，实现后置（仍开放）」，而全仓 `traceparent` 零命中）。

**关键实现选择**：
- `parseTraceparent` 对非法头**返回 `undefined` 而不抛、不打 400** —— 与「sink 抛错被吞」同一条口径：
  链路是观测行为，一个畸形头不该把业务请求打成 400。被拒形态：版本 `ff`、trace/span 全零、
  位宽不符、非 hex；版本非 `00` 按 W3C 前向兼容接受。
- 通道选 **HTTP 头**而非 body 字段：`POST /run` 的 body 是 `RunInput`（改形状即破坏性变更），
  且 W3C 头是既有网关 / OTel 自动化的通用形态。`POST /tasks` 另外允许 body 里的
  `options.traceContext` 显式覆盖（JSON 调用方方便），优先级：body > 头。
- HTTP 宿主**两条路径都要带**（SSE 与一元）：只给一元路径传 = SSE 场景静默丢链路
  （与仓库里 `signal` 曾静默掉那次同型的坑）。
- **`AsyncRunner` 零改动**：`traceContext` 在 `spec.options` 里，随 `TaskRecord` 落库 ——
  所以另一个进程 `resumePending` 续跑的那次 run 也带得上。这正是**队列消费者**的场景
  （`runner.submit(input, { idempotencyKey: msg.key, options: { traceContext } })`），
  也是为什么「框架内建 Kafka 集成」没必要：缝已经够。
- `snapshot()` 对 `links` 也拷一层（同 attributes / events 的既有规则），
  且「**没记 link 的 span 没有 `links` 键**」—— 不制造 `undefined` 与 `[]` 两种空形态。

**门禁**：`tests/engine/traceLink.test.ts` 5 条（link 落点 / 无 `spanId` 时不带该键 / 不传则无该字段 /
**`app.run` 透传这一跳** / 只落 run 根）、`tests/engine/tracer.test.ts` 2 条（`addLink` + snapshot 拷贝）、
`tests/transport/http.test.ts` 4 条（`/run` 头 → `app.run`、畸形头不打 400、`/tasks` 落
`TaskRecord.spec.options`、body 优先于头）、`tests/integrations/otlp.test.ts` 1 条
（links 的 hex 宽度规则 + 无 link 不发键）、`parseTraceparent` 4 组边界；
e2e：`scripts/e2e-examples.ts` 的 `/run` 步骤带真 `traceparent` 头并断言 run 根 links
（真 HTTP 栈 + 真装配，不只单测）。

### 2026-09-18 ①：第六轮全量 review —— 把「功能静默失效」一次收口

**背景**：对 `src/` 58 文件 / 11,338 行 + tests + packages 做第六轮全量 review（前五轮：`a706ded`
/ `19b33a6` / `bded0a1` / 两轮发布后更正）。产出 10 条正式发现 + 6 条超上限确认项。**病灶与第五轮
同型**：绝大多数不是「算错」而是**不报错地不干活**（配置写错、错误形态不对、超时裁判权没交接），
说明上一轮只清了症状、没除根。逐条取证后的共同形态：**失败被记账成成功，或配置被静默忽略**。

**取证（每条都跑到了「现状 → 后果」）**：

1. `integrations/openai.ts` 非 2xx 抛裸 `Error`（无 `status`）⇒ `classifyError` 的鸭子类型读不到数值
   status ⇒ 全部落 `type:'unknown'` + `retryable:false` ⇒ **引擎那 3 次重试一次都不发生**：DeepSeek
   这类兼容端点吃一个 429 就整轮 run 失败。流内错误分片（HTTP 200）同样丢 `code`。
2. `engine/concurrency.ts` 的 `Math.floor(limit)` 把 `(0,1)` 的小数压成 0 ⇒ 零 worker ⇒ `fn` 一次
   都不调、`results` 全 `undefined`，调用方却拿到「成功」的空结果 ⇒ **工具被静默丢弃**。
   `maxToolConcurrency: cpus().length / 8`（文档推荐的写法）在 <8 核机器上正落在这个区间。
3. `toolkit/env.ts` 的引号判定 `startsWith('"') && endsWith('"')` 被行内注释打断 ⇒
   `A="sk-..." # prod` 把**含字面引号**的值写进 `process.env` ⇒ 每个请求 401，而 `.env` 看着完全正确。
4. `openai.ts` 的流截断守卫挂在「累积为空」上 ⇒ 截断发生在**已吐出半句话之后**时不触发 ⇒ 半截输出
   被 `end_turn` 收尾上报；而合法的 `content_filter`（无 content）反被当成上游故障 —— 同一个响应在
   流式与非流式两条路径上得到两种结论。
5. `anthropic.ts` 的 `usage = {...usage, ...event.usage}`：`RawUsage` 允许显式 `null`，于是
   `message_delta` 的 null **覆盖** `message_start` 的真实值，末尾 `?? 0` 再归零 ⇒ 该回合
   input/cache token 与 `costEstimate` 一起塌成 0，**`maxCostUsd` 护栏随之失效**。
6. `toolkit/subagent.ts` / `skill.ts` 漏了 `toolTimeoutMs: ctx.toolTimeoutMs` —— 它是
   `ToolRunContext` 9 个字段里唯一一件「主循环注入、两个嵌套能力都没下传」的。后果不是「少一层保险」
   而是**反的**：子循环里 `withTimeout(p, 0)` 直接返回原 promise（`core/timeout.ts` 的 `!(t > 0)`）
   = 永不超时，同时 MCP 桥找不到引擎预算、又起自己的 60s 兜底 = **双计时器 + 双账本**，正是
   2026-09-17 ① 声称已消除的状态。
7. `transport/http.ts` 把 `remaining() === 0`（deadline 已过）当「不限」传给 `runner.drain`，而
   `async.ts` 的 `timeoutMs <= 0` 语义是**无限等** ⇒ 优雅停机永不返回、SIGTERM 宽限期后被强杀。
8. `transport/async.ts` 的 `#redispatch` 只在内存改 `status`/`ownerId`，真正落库晚于
   `#acquireSlot`：对 `list()` 返回**反序列化新对象**的 store（sqlite/redis），窗口内第二次
   `resumePending()` 能通过 `ownerId` 过滤、把同进程正在跑的任务再派发一遍 ⇒ 重复执行、重复副作用、
   重复花费。`InMemoryTaskStore` 因存对象引用掩盖了它（既有用例只测内存版）。
9. `engine/retry.ts` 的 `{...DEFAULT_RETRY, ...o}` 让**显式 `undefined`** 覆盖默认（tsconfig 未开
   `exactOptionalPropertyTypes`，`{ maxAttempts: cfg.retries }` 这类透传组装能带着 undefined 过类型
   检查）⇒ 重试被静默关闭（快照记成 0，看着像用户主动关的）/ `backoffDelay` 返回 NaN。
10. `toolkit/prompt.ts` 的静态 `@Prompt` 去重用**实例方法 key** 播种 ⇒ 静态资产被按 key 跳过而静默
    丢弃，且 `module.ts` 按**菜单名**查重永远看不到它（丢的正是「本来不可能重名」的那类资产）。

**决定（分四组）**：

**A. 静默失效 —— 一律改成「响亮地失败或响亮地记账」**

1. `openai.ts` 新增 `OpenAICompatApiError`（带 `readonly status`，鸭子类型即可被 `classifyError` 认），
   非 2xx 与截断响应都经它抛出；流内错误分片按 `type`/`code` 反推 status（含
   `rate_limit`/`insufficient_quota`/`too_many` → 429），并把 `code` 带进文案。
2. `mapWithConcurrency`：正数一律 `Math.max(1, Math.floor(limit))`；非正/非有限仍视为不限。公开入口
   的快照同批收口 —— `config.maxToolConcurrency` 记**生效的整数**，不限记 `'off'`（同 `maxEventChars`
   约定）：`NaN` 过不了 JSON/OTLP 序列化（到看板是 null），`-1` 读起来像「卡在负数个并发」。
3. `.env` 引号值改为「扫到闭合引号为止」：闭合引号之后只允许空白或 `#` 注释，未闭合/有残留则回退
   未加引号分支（**刻意不猜**）。
4. 流截断判据换成「既无 `[DONE]` 也无 `finish_reason` = 上游故障」；空载荷守卫加 `refusal` 豁免，
   与非流式 `mapStopReason` 对齐。**语义变更**。
5. `mergeUsage(base, delta)` 跳过 `null`/`undefined`：缺值的语义是「保持已有值」，不是「清空已有值」。
6. `toolTimeoutMs` 下传两个嵌套能力（子 agent / skill 的 `runAgentScoped`）。**裁判权**语义。
7. drain：有限 deadline 且已过 → 直接 `false`，不把「已到点」透传给「0 = 不限」。
8. `#redispatch` 认领时**先 `await store.save(rec)` 再派发**（签名保持 `number | Promise<number>`，
   它已在 `.then()` 里被调用，不必强制 async）。
9. `resolveRetry` merge 前用 `definedOnly` 剔除显式 `undefined`。
10. 静态 `@Prompt` 改为按**解析后的菜单名**去重（仅供父子类静态覆写用）；实例↔静态真重名交给
    `module.ts` 抛「菜单能力重名」—— 对齐 §3「装配期统一查重、重名即抛」。

**B. 上限、结构化 error 与那处「缝」**

11. `metrics.ts` 三个维度的**键空间都封顶**（`dropped` Set 改计数器；`maxModels`/`maxScores` 新增，
    默认 50 / 200；超限折叠进既有的 `__other__` 桶）。上限是给**内存**封顶，不是给**账本**封顶 ——
    turn/token/条数照记，只损失标签粒度；snapshot 增 `droppedModels`/`droppedScores`。
12. `turn.ts` 的 `tool_use_no_blocks` 补齐结构化 `error`（`type:'agent_error'`），兑现
    `loop.ts` 的「非正常收尾都带结构化 error」不变量 —— 此前该分支 `status:'failed'` 但
    `result.error === undefined`，HTTP body 与任务记录里看不出**为什么**失败。
13. `POST /tasks` 的 store 落库故障改走与 500 同一套 `exposeErrors` 策略（不再 400 + 内部原文）；
    并补一条「停机闸门与 `submit` 之间隔着 `await parseJsonBody`」的 503 分支（新增
    `TaskInputError` 区分「调用方参数错」与「服务端故障」）。
14. **`beforeFlush` 缝**（本轮唯一的公共面新增）：`ExecuteRunOptions` / `RunAppOptions` 增可选
    `beforeFlush(trace, result)`，在 `run.finish` 之后、`flushSinks` **之前**调一次，可 await、抛错被
    吞（同 sink / 记忆回写：收尾动作失败不得击穿 run）。理由：`flushSinks` 发生在 `executeRun` 内部，
    `defineEval` 的结论若在 `app.run()` 返回后才挂，`metricsSink` 早在 `export()` 那一刻聚完账 ——
    分数**永远进不了指标**，而 usage-guide 承诺「eval 的 trace 自带质量结论、可直接聚合通过率」。
    判官必须拿到 `result`（它存在早于冲刷），所以缝的位置只能是这里，不能是「run 之后的钩子」或
    「异步 gate」（后者会与 `app.run` 的调用栈死锁）。`defineEval` 另有鸭子类型兜底：宿主漏透传时
    断言照做（不误报「全挂」），只是分数进不了指标。
15. `compactMessages` 的 cut 校验改成「tail 内每个 `tool_result` 的 id 都能在 tail 内找到对应
    `tool_use`」—— 非相邻工具对（`tool_use(A) @k`、user 文本 `@k+1`、`tool_result(A) @k+2`）此前会切出
    孤儿 `tool_result` ⇒ API 400。退无可退时照 `trimToolPairs` 先例整体放弃压缩。
16. **去重重构**：`sseLines` → `src/core/sse.ts`；`percentile` / `capabilityKindOf` →
    `src/core/stats.ts` / `core/trace.ts`；`textOf` 三份两种语义 → `src/core/text.ts` 的
    `textOf(message, separator)`，三个调用点**各传各的原值，行为零变化**；可中断 `sleep` 下沉
    `core/timeout.ts`（abort 文案参数化，`engine` 是 `'run 已被取消'`、`anthropic` 是 `'请求已被取消'`）。
    这些下沉不是整洁度：`integrations` 只准依赖 `core`，所以 `core/` 是让那两份合一的**唯一**合法落点。
    **两份 backoff 刻意不合并**并在原地写明理由：`engine/retry.ts` 是 ±20% 均匀抖动，
    `anthropic.ts` 的 `backoffMs` 是 ±25% 且优先尊重 `retry-after`（秒数 + HTTP-date）—— 合并即改行为。
17. MCP 桥的判据由 `engineBudget > 0` 改为 `!= null`：`toolTimeoutMs: 0` 的文档语义是「引擎不设超时」，
    那同样是**引擎的表态**。用 `> 0` 的话，用户显式写下不限、桥却自作主张判 60s —— 与
    「一次调用只有一个裁判」相反，也把「说了不限」变成假的。**语义变更**。
18. `docs/roadmap.md` 的 score 形状补上 `comment` 字段（实现会条件附加，usage-guide 已写）。

**代价（如实记）**：

- **公共面新增两处**（用户已批准）：`RunAppOptions`/`ExecuteRunOptions` 的 `beforeFlush`（可选，不传
  行为不变）；metrics 的 `maxModels`/`maxScores` 与 snapshot 的 `droppedModels`/`droppedScores`
  （**新增**键，既有键的形状不变）。`docs/usage-guide.md` 与官网 `api.html` 已同步。
- **`dropped*` 计数自身封顶 1024**（`MAX_DROPPED_TRACKING`），超出后它是**下界**：计划里写的
  「零语义损失」只对上限之内的键空间成立，超出部分连「丢了多少」都只能是下界。已写进注释与
  `usage-guide` 的取值说明。
- **`tool_use_no_blocks` 现在带 `result.error`**：该分支一直是 `status:'failed'`，按
  `result.error === undefined` 分流「是不是失败」的调用方不受影响；把它当唯一判据的日志会多一行。
- **`RawUsage` 与 `MessageUsage` 没有拉齐**（原计划提到）：两者是**不同层**的语义 —— 前者是原始分片、
  允许显式 `null` 表示「这次不报」，后者是归一后的产物（`?? 0` 已兜过底）。拉齐会同时弄错一头，
  已在 `anthropic.ts` 就地写明「别把它们拉齐」。
- `#redispatch` 未强制改成 `async`；`textOf` 落在 `src/core/text.ts` 而非 `core/message.ts`
  （`message.ts` 是纯类型层，加运行时函数会把它从类型模块变成实现模块）；`TaskInputError` 是
  **module 级** export，**不**进 `src/index.ts`（进了就触发官网 API 页的反向全覆盖要求）。

**门禁**：`tests/integrations/openai.test.ts`（非 2xx 带 status → `classifyError` 分类 + 429 真触发引擎
重试的闭环）、`tests/integrations/openaiStream.test.ts`（错误分片反推 status / 截断必抛 / `refusal`
不抛）、`tests/engine/concurrency.test.ts`（`(0,1)` 小数仍有 1 个 worker + 快照记生效整数）、
`tests/toolkit/env.test.ts`（引号 + 行内注释 / 未闭合 / 残留）、`tests/integrations/anthropic.test.ts`
（`message_delta` 的 null 不清真实值）、`tests/toolkit/subagent.test.ts` 与 `skill.test.ts`
（`ctx.toolTimeoutMs` → 子循环按超时记账）、`tests/transport/host-hardening.test.ts`（截止已过 → 立即
false，时钟前跳构造，不赌毫秒）、`tests/transport/async.test.ts`（异步 store 下 `resumePending`
不重复执行）、`tests/engine/retry.test.ts`（显式 undefined 回落缺省）、`tests/toolkit/prompt-versions.test.ts`
（静态资产不丢 / 真重名交装配期抛）、`tests/integrations/metrics.test.ts`（三个维度封顶 + 折叠后账总量
不变 + 标签不被切成乱码）、`tests/engine/loop.test.ts`（`tool_use_no_blocks` 带结构化 error）、
`tests/transport/http.test.ts`（store 故障走 `exposeErrors`）、`tests/eval/defineEval.test.ts`
（score 在冲刷前落定 → `metricsSink` 真聚合得到 + 宿主漏透传的兜底）、
`tests/engine/trimming.test.ts`（非相邻工具对不切出孤儿 `tool_result`）、
`tests/integrations/mcp.test.ts`（引擎显式 `toolTimeoutMs: 0` ⇒ 桥不自判）、
`tests/core/sse-text-stats.test.ts`（下沉三件套的语义对拍）。
每条修复都用「临时把修复废掉 ⇒ 新用例必须变红」验过判别力，再从备份还原。
e2e：`npm run e2e`（CLI / EXAMPLES / DEPLOY / GRPC 四关全绿）、`npm run e2e:mcp`（真第三方 MCP server → 桥 →
菜单 → 真跑一轮，metrics 输出里可见 `droppedModels`/`droppedScores`）。

### 2026-09-18 ②：给「约定」补**守卫注册表** —— 上一条 16 条的共同缺口是「没有门禁」

**背景**：第六轮 review（上一条）的 16 条缺陷，逐条追根后是**同一个缺口的不同面貌**：
约定写在 AGENTS.md / spec / 代码注释里，但**没有任何门禁**。而已有门禁（`layering.test.ts`、
`api-page.test.ts`、`usage-guide.test.ts`、`no-legacy-terms.test.ts`）恰恰守住了它们覆盖的面 ——
说明**守卫是沿着「写过文档、写过测试的地方」长的**，没写的地方就是空白。

**决策**：把「哪类危险由谁守」变成仓库的一份**单源清单** `docs/guards.md`，并补一条新的
架构守卫。三件事：

1. **`tests/architecture/transport-errors.test.ts`（新增）** —— 扫 `src/integrations` 的裸
   `throw new Error(...)`：文案里出现 HTTP 状态痕迹（`HTTP` / `res.  status`）而对象没有数值
   `status` 即违规，因为 `classifyError` 是鸭子类型、丢了 status 就落 `unknown` + 不可重试
   （上一条第 1 条的病根）。判定**刻意做窄**：构造期配置校验（文案含「必须 / 只支持 / 收到 / 非法」）
   一律豁免 —— 宁可窄不要误报（误报的门禁最终会被人 ignore 掉）。另两条：`*ApiError` 命名即承诺
   （必须有 `readonly status: number`）、解析器合成样本 + 全覆盖计数下限（防真空变绿）。
2. **`docs/guards.md`** —— §1 列「已挂守卫 → 保护的不变量 → 退化了会怎样」，§2 列**待守缺口**
   （成对实现不对称 / 转发漏字段 / 浅合并被 null 覆盖 / 同步实现掩盖真实异步 / `0` 的双重语义…），
   §3 记三条守卫写法纪律（宁可窄、必须能反向证伪、失败信息带文件:行号）。
3. **`.github/PULL_REQUEST_TEMPLATE.md`** —— 加「危险类自查 5 问」（成对对称？转发漏字段？
   错误可分类？边界值走过？是静默失效吗？）+「新增/修改的守卫必须做反向验证」勾选 + 登记 `guards.md`。
   **问对比写规则便宜，且能覆盖规则没预见到的形状。**

**实证（守卫上线当天就抓到真货）**：新守卫第一次跑就报 `src/integrations/otlp.ts` 的
`throw new Error(\`OTLP 导出失败: HTTP ${res.status} …\`)` —— 与上一条第 1 条**完全同形**的漏网之鱼
（上一轮 16 条没覆盖到 otlp）。已修：新增 `OtlpExportError`（带数值 `status`），与
`AnthropicApiError` / `OpenAICompatApiError` 同形。**这条守卫的价值不在「守住已修的」，在「抓住没修的」。**

**未做（登记为待守，见 guards.md §2）**：`exactOptionalPropertyTypes` 实测会让现有源码报
**39 处**（TS2379 ×19 / TS2375 ×10 / TS2412 ×8 / TS2322 ×2，集中在 `transport/` 15、`engine/` 12），
是**独立的一轮迁移**而非无害开关 —— 机械修法（给每个可选属性加 `| undefined`）会放松
`RunAgentOptions` 等公共契约；正确修法是逐调用点条件展开（`...(x !== undefined ? { x } : {})`，
`loop.ts` 已在用这个形状）。实测过「只改一个类型文件只消掉 1/39」，证明它不是局部修补。
**不在本轮硬开**：实测分布与四步迁移方案记在 `docs/guards.md §2` 的专门条目。
（**后话：已由 2026-09-18 ⑦ 单独一轮完成**，该专门条目随之迁入 `guards.md` 附录。）

**同轮补齐的另一半（对拍矩阵）**：`tests/integrations/adapter-parity.test.ts` ——
「同一契约的两条适配器必须对称」的可执行版本，**一份场景表跑两遍**（不是把两侧测试写成镜像）。
**写它的当天就抓到一处真不对称**：`anthropic.ts` 有客户端内层重试（`postWithRetries`，
缺省 `maxRetries=2`），`openai.ts` **完全没有** —— 同一个 429：anthropic 打 3 次网络请求、
openai 打 1 次（引擎层那一次）。两侧各自的测试都通过，因为它们只断言「最终成功」，
**从不比较尝试次数**。已修：`openai.ts` 加同语义的 `postWithRetries`（同状态码集合、同退避曲线、
同 `retry-after` 尊重），`OpenAIClientOptions` 加 `maxRetries`（缺省 2，与 anthropic 逐字对齐）。
反向验证：把 openai 的内层重试改回 `0` ⇒ 矩阵 11 条红（含跨侧对称那条），恢复即绿。
**顺带暴露的可用性瑕疵（未修，记下）**：`anthropic.ts` **没有 `fetchImpl` 注入缝**（openai 有），
而它的索引签名让错传的参数**静默通过** —— 矩阵因此改用替换 `globalThis.fetch` 做统一注入面。

### 2026-09-18 ⑦：`exactOptionalPropertyTypes` 迁移完成 —— 「显式 undefined ≠ 不传」成为类型级约束

**背景**：上一条把这条开关登记为「待守缺口」（实测 39 处，判为独立一轮）。本轮单独做掉。

**它守什么**：`{foo: x}`（`x: T | undefined`）**不是**合法的 `foo?: T` —— 「不传这个键」与
「传了个 undefined」被区分开。`retry.ts` 的「显式 undefined 覆盖缺省」事故（重试被静默关闭、
`backoffDelay` 算出 NaN）正是这条区分缺失造成的。

**迁移规则（三类角色，后来者照此办理）**：
1. **结果/状态记录**（框架总是把字段写进对象字面量）→ **必填 `T | undefined`**：
   `AgentRunResult` / `AgentLoopResult` / `RunMeta` / `RunHttpResponse` / `TurnOutcome` /
   `ToolEventIO` / `SpanDiff`。「字段在场、值可无」是这些记录的真实语义。
2. **内部管道**（缺省与显式 undefined 等价）→ **可选 `?: T | undefined`**：
   `AgentLoopArgs` / `LoopContext` / `Job` / `TaskRecord` / `RunSpec` / `BudgetGuardOptions` /
   `SseWriterOptions` / `CapabilityCall`。
3. **公共入参**（「不提供 = 用缺省」必须有意义）→ **签名不动**，在**调用点**处理：
   条件展开 `...(x !== undefined ? { x } : {})`，或集中 `omitUndefined({...})`（新增
   `src/core/object.ts`，用于 `AgentApp.run` → `executeRun` 那种一次转交十几个字段的场景）。
   **这一条是重点**：前两类的机械修法若套到公共入参上，等于把开关要守的东西自己放掉。

**代价与结果**：39 处 `error TS` 全清（TS2379 ×19 / TS2375 ×10 / TS2412 ×8 / TS2322 ×2），
另连带修好测试/示例里的若干处（`RunSpec` 夹具补字段、`retry.test.ts` 的显式 undefined 改用
`as unknown as` 并注明「模拟动态拼装绕过类型检查」、`examples/complete` 的条件展开）。
**测试 836 例全绿**，`verify-all` 8/8。

**门禁（防止有人把开关关掉）**：`tests/architecture/tsconfig-strictness.test.ts` 断言
`exactOptionalPropertyTypes` / `strict` / `types:["node"]` 三个开关在场，各带「退化了会怎样」。
反向验证：关掉开关 ⇒ 该测试红，且 `{maxAttempts: undefined}` 赋给 `RetryOptions` 立刻从
「编译错」变回「放行」（实测 ON=1 错 / OFF=0 错）。

**未覆盖（如实记）**：`exactOptionalPropertyTypes` 堵的是「显式 undefined」这一半；
**「spread 转发时漏掉一个键」TS 结构类型仍然不报**（`{...opts}` 少字段照样过）。
该缺口留在 `docs/guards.md §2`。

**2026-09-18 ⑧ —— 第七轮复审收口：适配器错误分类对齐 / 指标面可见 / 续跑重入闸（+ 守卫自身的洞）**

**缘起**：三路并行复审 `9f1dcd8..HEAD`（第六轮那 16 条）后逐条回读源码，发现四类残留。其中最有价值的
不是任何单条 bug，而是一个模式：**这一轮的主题是「把没有门禁的约定收口」，而守卫自己有洞** ——
① `transport-errors` 的注释剥离被字符串里的 `//` 打断（见下）；② `adapter-parity` 的矩阵结构上测不到
「缺省值对称」；③ `guards-registry` 的密度下限（8）远低于实测（32），删整节仍绿。①③ 本轮修掉，
② 如实留在 CHANGELOG 的「仍未做」。

**决策（错误分类必须「同故障同结论」）**：`anthropic` 与 `openai` 在同一个上游故障上给出相反结论，
是比任何单条分类错误更坏的事（两条适配器都叫「默认 client」）。本轮统一三处：
- **截断判据两侧同款**：既无终止标记（`message_stop` / `[DONE]`）、又无 `stop_reason` / `finish_reason`
  ⇒ 抛 500 可重试。**判据不能挂在「累积为空」上**（两侧都踩过）：已吐半句后断流时内容非空，
  于是落 `unknown_stop_reason`（**不是**重试判据）⇒ 引擎一次都不重试 + trace 误诊成「模型协议异常」。
- **流内 error 分片的 status 反推不照抄**：anthropic 协议只有三种 type（默认 500 合理），
  OpenAI 兼容生态有 `invalid_request_error` / `context_length_exceeded` 这类**改配置才有救**的 4xx 病因 ——
  判 400 不可重试。照抄 anthropic 的三档会让引擎白重试 3 次。
- **非流式与流式同结论**：`content_filter` 的合法空回复两侧都豁免；其余空补全两侧都抛。

**决策（`resumePending` 重入：共享在飞那次，而不是返回 0）**：并发重入时返回 0 是**谎报**
（「本次没派发任何东西」，而实际派发了）。返回在飞那个 Promise，调用方拿到的始终是本次扫描的真实结果。
闸门用 `Promise<number> | null` 而非 boolean，正是为了让重入方拿到同一个数。

**决策（指标名刻意不嵌在既有前缀里）**：基数折叠的 gauge 定为单家族
`agentia_dropped_keys{kind="capability"|"model"|"score"}` —— 与既有 `tokens_total{kind=…}` 同形。
初版曾命名 `agentia_model_dropped_keys` 等三个家族，**被既有测试的 `agentia_score` 子串断言当场抓到**：
嵌在 `agentia_model_*` / `agentia_score_*` 前缀里会让「按前缀匹配」的看板与断言无端把折叠计数算进去。

**守卫的洞（本轮最值钱的发现，记清机制）**：`transport-errors.test.ts` 的 `stripLineComments` 把每行
「截到 `//` 为止」—— 而 `//` 会出现在**字符串里**（URL 是最常见的形态）。截断切掉该行闭合的 `)` 与
反引号 ⇒ `bareErrorThrows` 的括号配平一路吃到文件末尾 ⇒ **该行之后的每一处抛错都被并进同一个「throw」
片段，再也判不出违规，且不报错**。实测 `src/integrations/metrics.ts`：8 处裸抛错只剩 2 处可见，
被吞掉的恰好包括 `OTLP metrics 导出失败: HTTP ${res.status}`（本守卫存在的理由）。改为「整行丢弃
注释行（`//` / `*` / `/*` 开头）」两头都对：块注释说明行不误报，字符串里的 `//` 不再破坏扫描。
**反向验证**：新回归样本在旧实现下「捕获 1 处 / 判违规 0 处」、新实现「2 处 / 1 处」——断言要求 2 处 ⇒ 会红。
密度下限同时由 8 提到 24（实测 32，留 ~25% 余量）。

**门禁**：`tests/architecture/transport-errors.test.ts` 新增回归钉；`tests/integrations/anthropic.test.ts`
+3（空流 / 截断 / 正常流不误伤）、`openaiStream.test.ts` +3（4xx / 429 / 5xx 三档）、`openai.test.ts` +2
（非流式空补全 / refusal 豁免）、`metrics.test.ts` +2（折叠数对得上 snapshot / 恒定发三个）、
`tests/transport/async.test.ts` +1（并发重入）。**三处承重性反向验证**：摘掉重入闸、短路截断判据、
把注释剥离改回旧实现 —— 对应新用例分别变红。

**2026-09-18 ⑨ —— MCP 连接器改为**内置**（反转 2026-09-11 的 F7「独立可选包 `@migor/mcp`」）**

**决策（连接器内置，不发独立包）**：`src/integrations/mcp.ts` 新增 `createStdioMcpConnector` /
`createStreamableHttpMcpConnector`，公共面加 `McpConnector` 与 `MCP_CLOSE_GRACE_MS`。
**同时作废**「连接器在独立可选包 `@migor/mcp`」这个说法 —— 它出现在 `src/index.ts`、
`src/integrations/mcp.ts`、`scripts/e2e-mcp.ts`、`tests/integrations/mcp.test.ts`、
`docs/plans/2026-09-11-agent-service-hardening.md` **共 5 处**（另加 §10 里 2026-09-11 那条原始记录本身，
已就地加「后话」指针），而那个包**从未存在**
（registry 返回 404，`packages/` 下只有 cli / trace-view / website）：等于 5 处注释指向一个空落点。

**为什么反（F7 给的理由站不住，且与仓库自己的先例相反）**：
- F7 的理由是「守住零运行时依赖」。**那条口径指的是不依赖第三方包**（`package.json` 的
  dependencies / peerDependencies / optionalDependencies 三个字段全空），不是「不 import node 内建」——
  `src/` 早已直接 import 10 处 `node:` 内建（`node:http` ×2 / `node:crypto` ×4 / `node:fs` ×4 /
  `node:path` ×3 / `node:sqlite` / `node:module` / `node:async_hooks` / `node:url`）。
  `spawn`（`node:child_process`）与 `fetch`（Node 18+ 全局）都是标准库 ⇒ **内置连一个第三方依赖都没加**。
- **仓库自己的两份先例**（`store/` 的三层形状）：只用**标准库**的平台能力**直接内置**
  （`FileTaskStore` = `node:fs` / `SqliteTaskStore` = `node:sqlite` / HTTP 宿主 = `node:http`）；
  需要**第三方客户端**的才只留 duck-typed 缝（`RedisTaskStore` = `RedisLike`）。
  MCP stdio 连接器属于**前者**。⇒ 内置才是与既有形状一致的那个选择，独立包是例外。
- F7 的同文档下一节（§8 风险 D1）写的是真理由：「MCP 协议演进快 → 协议细节推给连接器包」。
  但**这个问题的答案仓库已经有了**：`integrations/otlp.ts` 同样是外部 churn 协议（OTel GenAI
  semconv，至今 experimental），它内置，对付 churn 的手法是「映射集中在单模块 + **钉住基准版本**」
  （`otlp.ts:15` 对齐 v1.37，升级只改本模块）。若 OTLP 可以内置，MCP stdio 没有原则性理由在外面。
- **可逆性**（拍板用的判据）：先内置，将来真被协议变更拖痛了，把这段挪进新包、旧路径 re-export 即可
  ——**可逆**；先发包则用户已装第二个包，再收回来是破坏性的 ——**不可逆**。

**结构面不变（本次的关键约束）**：`McpClientLike` 仍是最小缝 —— 接官方 SDK / 远程 server / 自研传输
照旧。出厂连接器只是**默认件**，与 `FileTaskStore` / `SqliteTaskStore` 之于 `TaskStore` 完全同构。
「第三方 SDK 对用户不可见」那条口径**没有**被放宽：一个 MCP SDK 都没 import。

**顺带收掉三处非显然的坑**（此前只活在 `scripts/e2e-mcp.ts` 内联的 94 行私有副本里，没有任何门禁守着）：
① spawn 失败的 `'error'` 是**异步事件**，没有监听器就是未捕获异常（真实宿主进程直接崩，没有 try/catch
接得住）；② stdout 必须按 `\n` **攒包**（一条报文可能跨多个 chunk）；③ **协议层 `isError: true` 必须
转成抛错** —— 否则模型收到一条「成功」的结果、trace 也把这次失败的调用记成成功，正好打在本框架
「trace 决定你敢不敢上线」的承诺上。

**超时口径（延续「一次调用只有一个裁判」）**：连接器的 `timeoutMs` **只作用于装配期**
（握手 + `tools/list`）—— 那两步此前**没有任何裁判**，server 卡住会让 `createApp` 永久挂起；
`callTool` 的裁判仍是引擎 / 桥，连接器**不再起第二个计时器**。实现复用 `core/timeout.ts` 的
`withDeadline`，**不用 `AbortSignal.timeout`**：后者内部 unref，正是 2026-09-14 ④ 明令禁止的形状。

**已知边界（如实标注；两条已在同日 ⑩ 收掉）**：StreamableHTTP 的会话过期（带会话 id 收到 `404`）
~~**不自动重握手**，按不可重试的 `api` 错抛出~~ ⇒ **已由 ⑩ 改为自愈**；`close()` ~~不保证等到子进程
被 reap~~ ⇒ **已由 ⑩ 改为保证**。

**覆盖升级（不只是重构）**：`scripts/e2e-mcp.ts` 此前只能 `import type` 桥的类型、自己再写一份连接器
⇒ 那条端到端证明测的是**它的私有副本**。现在它 import 出厂连接器 ⇒ 门禁测的就是用户拿到的东西。

**门禁**：新增 `tests/integrations/mcpConnector.test.ts`（27 例）。stdio 侧起**真子进程**
（夹具 `tests/fixtures/mcp/fake-server.mjs`，env 覆盖 7 种模式：normal / split / logline / noinit /
die / iserror / badtools）—— 要验的三件事只存在于真子进程世界里，用假 client 验等于没验；
HTTP 侧注入 `fetchImpl`（与 `openai.test.ts` 同款）。
**变异电池 9/9 全部被抓到、0 漏网**：摘掉 spawn 的 `'error'` 监听器、stdout 分帧丢包、
两侧 isError 不转抛错、握手不 memoize、会话 id 被后续响应清空、SSE 当 JSON 解析、
HTTP 失败不挂数值 `status`、`tools` 非数组静默成空菜单。
`npm run e2e:mcp` 改为走出厂连接器，真第三方 server（`uvx mcp-server-time`）全绿。
文档面：`usage-guide` 新增 `StdioMcpConnectorOptions` / `StreamableHttpMcpConnectorOptions` 两张选项表
（并把这两个类型登记进 `tests/docs/usage-guide.test.ts` 的 `MEMBERSHIP_TYPES`，否则会被
「标题未点名类型的表 ⇒ 首列必须是导出名」那条规则误判）；`api.html` 导出面 204 → 210；
`McpToolsOptions` 的用法示例此前还写着 `providers: [{ useFactory: … }]`（spec §10 2026-09-11 已记
那条路不成立）—— 一并改成 `AppOptions.tools`。

**2026-09-18 ⑩ —— 收掉 ⑨ 留下的两条「已知边界」：会话过期自愈 + `close()` 保证 reap**

**① StreamableHTTP 会话过期改为自愈（反转 ⑨ 的「不自动重握手」）**：带会话 id 收到 `404` ⇒
丢会话 → 重新握手 → 把**这一次**重试一次（**只一次**）。

- **为什么可重试是安全的**：`404` 在 MCP 规范里的含义是「这个会话我不认识」⇒ **该请求没有被
  server 执行**。所以重试不会重复执行副作用（这点必须先确认，否则重试一个 `tools/call` 就是赌博）。
  规范本身也要求客户端此时新建会话（不带会话 id 重新 `initialize`）。
- **⑨ 当初的理由是「自动重建会掩盖 server 侧会话策略」** —— 解决方式是**别让它静默**，而不是别修：
  新增 `onSessionExpired` 钩子（要计数 / 告警 / 打日志就挂它）。「静默恢复」与「静默失效」在监控上
  看不出区别，所以「不静默」是这条修复的**组成部分**，不是可选项。
- **只重试一次**：第二次再 `404` 说明对面不是「会话过期」，直接抛（不循环 —— 无界重试会把一次
  故障放大成请求风暴）。`404` 之外的失败仍按 `classifyError` 分流抛出，**不重试**。
- 未触发条件：`sessionId === null` 时的 `404` 不当作过期（没有会话可过期，重试毫无意义）。

**② `close()` 改为「返回即子进程已终止」（反转 ⑨ 的「不保证 reap」）**：SIGTERM → 宽限期后
SIGKILL，然后**继续等真正的 `'exit'`/`'close'`**（SIGKILL 不可被捕获，该事件必达）。
⑨ 写的是「有界返回比等到确认更值」—— 那条取舍当时图的是「close() 一定不挂」，
代价是**调用方以为进程没了、实际留一个孤儿**，且无从知晓（静默的错，正是本仓库最贵的一类）。
现在保证的是**已回收**；「close() 会不会挂」的答案变成「只有在进程不可中断（D 状态）时才会等」——
那是 OS 层面的事实，不该由 API 用一个谎去掩盖。

**验证**：`tests/integrations/mcpConnector.test.ts` +4 例（27 → 31）：自愈成功（断言新会话 id、
`onSessionExpired` 恰好一次）、只重试一次（断言 `initialize` 恰好 2 次）、无会话时不重试、
`close()` 返回即已回收（夹具新增 `stubborn` 模式忽略 SIGTERM + 写 pid 文件，断言 `kill(pid, 0)`
报 `ESRCH`）。**变异电池 6/6 全部被抓到、0 漏网** —— 其中「夹具不再忽略 SIGTERM」一条是用来证明
那条用例**真的在测 SIGKILL 路径**（而不是碰巧快）。HTTP 假端点同时改为「会话显式开启」，
免得默认路径悄悄带上会话、把「无会话」这个场景测没了（这个坑当场被一条既有用例抓到）。

**2026-09-18 ⑪ —— 宿主接入（gRPC / Kafka 这类）不打包：先配方 + 示例，升级为包要有触发条件**

**问题**：「Kafka / gRPC 要不要包成成熟的工具暴露出来让用户用，降低使用成本？」→
「是不是起一个服务包，把 grpc 和 Kafka 这几个都做了？」

**决策（不做「服务包」）**：判别规则只有一条 —— **客户端是不是标准库**。
MCP stdio 只用 `spawn`（`node:child_process`）+ 全局 `fetch` ⇒ 内置**零新增第三方依赖**；
gRPC 要 `@grpc/grpc-js`、Kafka 要 `kafkajs` ⇒ 落在「可选能力一律 duck-typed / peer」那一侧
（AGENTS.md 硬约定 + roadmap「可选能力（zod、OTLP、队列）全部 peer/可选接入」）。
所以「MCP 内置、gRPC / Kafka 不内置」**不双标**：差别只有那一条。反向的路（把协议细节推给独立包）
上一次刚被否过 —— 2026-09-18 ⑨ 反转了 F7 的「独立可选包 `@migor/mcp`」。

**决策（粒度）**：若真拆包，是**一个第三方客户端一个包**，不是一个大「服务包」。三条硬理由：
① peer/可选 变矩阵（只要 gRPC 的人也被要求配 kafkajs，或退化成一堆 dynamic import + 运行时报缺）；
② semver 取最大值（Kafka 一个 bugfix 要发一个带 gRPC 宿主的新版本）；
③ 弃用无法分离（kafkajs v3 迁移不该碰到 gRPC 用户）。发布成本本来就是 per-package 的
（`release-surface.mjs` 18 项里每包各占 package.json 版本 + lock 版本字段 + check-release 条目 +
prepublishOnly 闸门 + CHANGELOG），合成一个大包只省下一个 `package.json`，却把上面三条全买下来。
唯一可辩护的「一个包」是**瘦门面**（自身零依赖、只 re-export 那几个包），前提是 ≥2 个包已存在
且发现有测量到的「找不到」痛点 —— 现在做等于先建空壳。

**决策（Kafka 侧不做）**：配方已在（§6.4「跨进程关联」的队列消费者形态，含那条真坑 ——
**位移提交点与 run 终态不是一个时刻**）。而 consumer 包里唯一非平凡的部分（offset commit 时机、
rebalance、shutdown flush）全是**进程级决策**，正是框架声明不碰的东西（不读 env、不订阅信号）。
2026-09-17 ⑤ 已记「框架内建 Kafka 集成没必要：缝已经够」，本条不推翻它，只把理由补全。

**决策（gRPC 侧做配方 + 示例，本轮落地）**：gRPC 与 Kafka **不同类** —— 它是**第 4 个宿主**，
与 HTTP 并列的一等概念；而宿主接入里有四处是**框架语义**、不是样板：deadline / 取消 → `signal`、
metadata `traceparent` → `traceContext`、框架错误 → gRPC 状态码、trace → sink。这四处漏掉
**都不报错**（本仓库最贵的一类故障）。落点仍是 `examples/`（不随 npm 包发布），
因为 gRPC 必须引第三方客户端。交付：`examples/grpc-host/`（proto + 宿主 + 客户端 + README）
+ `docs/usage-guide.md` §6.2 配方 + `npm run e2e:grpc`。

**升级为独立包的触发条件**（写死，免得下一个人重新论证）：出现**第二个**真实使用方要同一份逻辑；
或配方在 e2e 里证明样板已压不下去（即需要框架内语义：deadline→signal、状态码映射、流式记账）。

**验证**：`npm run e2e:grpc` 真构建、真起宿主、用**示例自带的客户端**跑四个 RPC；
**变异电池 8/8 全被抓、0 漏网** —— 逐个拆掉四处翻译 + `NOT_FOUND` 分支 + trace sink + SIGTERM 处理，
每条都由**它该触发的那条断言**报红。诚实记一笔过程：第一轮里「拆掉 NOT_FOUND 分支」那条是被
**构建失败**抓住的（我的变异把类型也改坏了），不是被状态码断言抓住 —— 换成纯行为变异
（`NOT_FOUND` → `INTERNAL`）后才由断言抓住。**「被抓住」不等于「被那条断言抓住」**，
变异电池的记录必须区分这两者，否则它会高估断言的判别力。

**2026-09-18 ⑫ —— OpenAI 适配器：legacy `function_call` 形态改为**响亮失败**（原为静默 `end_turn`）**

**怎么发现的**（记下来，因为入口是一次「看着像纯风格问题」的 lint 注解）：`biome ci` 一直挂着一条
`noUselessSwitchCase`（`openai.ts:672` 的 `case 'stop':` 落进 `default`，同一个返回值 —— 纯冗余）。
顺手把这张映射表的**完整性**也核了一遍：`stop` / `length` / `tool_calls` / `content_filter` 都覆盖，
但 `default: return 'end_turn'` 会吞掉**任何**未知值 —— 其中 `function_call`（legacy `functions` 形态）
是唯一一个「吞掉就有害」的：调用在 `message.function_call` 里，而适配器只读 `tool_calls`。

**取证**（假端点喂真适配器，不改仓库）：legacy 响应 ⇒ `stop_reason = end_turn`、
`content = [{"type":"text","text":"好的，我查一下。"}]`、**工具调用没了且没有任何报错**。
即「模型要调工具、工具没执行」以成功收尾 —— 本仓库最贵的那一类（模块头写的就是
「上游故障绝不映射成成功」）。

**决策**：`case 'function_call':` **响亮失败**，不做 legacy 兼容、不静默降级。
- **不做兼容**：请求侧只发 `tool_calls`（`buildMessages`），回灌的 `role:'tool'` legacy-only 端点
  同样吃不下 ⇒ 半吊子支持比不支持更糟（与「一个第三方客户端一个包」同一条思路：要么真支持，要么明说不支持）。
- **400 而非相邻空补全那条 500**：这是**确定性不兼容**，换不了结论 ⇒ 落 `classifyError` 的
  `api`／不可重试。用 500 会被引擎重试三次，每次都重复丢弃同一个调用（把一次故障放大成三次）。
- **`default` 保持 `end_turn`**（未知 finish_reason **且有正文** ⇒ 上游只说「结束了」）：
  空正文那条已在流式/非流式两个调用点各自拦住，不会走到这里变成「成功空回复」。
  这个默认是**有意**的，已用一个 `eos_token` 用例钉住，防后人顺手改成抛错。

**验证**：`tests/integrations/openai.test.ts` +2 例（legacy 形态抛 400／`classifyError.type==='api'`／
消息里含 `function_call`；未知值 `eos_token` + 正文 ⇒ `end_turn`），该文件 15/15 绿。
**变异电池 2/2**：删掉整条分支 ⇒ 用例红在「Missing expected rejection」（本该抛错却拿到了
`end_turn`）；把 400 改回 500 ⇒ 红在状态码那条严格相等断言。⚠️ 诚实记一笔：第二条我脚本里的
`expect_marker` 写的是「状态码」而实际失败行没印这三个字，被标成「非预期断言」——
**核对失败行内容后**确认它确实是目标断言（`assert.equal(status, 400)`）。标记匹配是辅助，
**「红在哪一行」才是判据**（同 §10 ⑪ 那条：被抓住 ≠ 被那条断言抓住）。
### 2026-09-19 ①：HITL 落地 —— 审批 = 异步 tool_result（挂起/恢复），解开 2026-09-11 的「不做」

**背景**：2026-09-11 的能力边界结论把 HITL 定为「闸门层无需新机制（middleware 可 await 决策），
**跨进程挂起/续跑不做**」—— 当时的卡点原文是「`RunStatus` 无『待批准』态、循环位置（消息数组）
不落库、`traceToMessages` 重放有损」。本轮把它落地了，关键想法是：**不落「循环位置」，落消息历史**。

**① 为什么审批 = 异步 tool_result**：Anthropic 协议里一个 tool_use 的归宿只有两种 ——
执行出 tool_result，或给出 is_error 的 tool_result。「等审批」不是第三种归宿，而是
「tool_result 迟到」。于是挂起态**不需要任何断点续跑原语**：run 以「末尾是含未决 tool_use 的
assistant 消息」的消息历史落库（`TaskRecord.spec.messages`），恢复就是引擎见到这种输入时
**先解决这些 tool_use 再调模型**（`agentLoop` 入口的通用恢复检测 —— 通用化收益：任何
「assistant 结尾带 tool_use」的输入都能续跑，不只审批场景）。2026-09-11 那条卡点的三个成分
因此全部消解：状态有了（`awaiting_approval`）、落的就是消息数组本身（无损）、不走
`traceToMessages`（不经 trace 重放）。

**② 为什么回合级全有或全无**：协议要求每个 tool_use 都有配对 tool_result。一个回合里
**任何一个**需审批的 tool_use 没有决定 ⇒ 整回合**一个工具都不执行**、不推任何 tool_result ——
部分执行 + 部分挂起会产出协议上残缺的历史（配不平的 tool_use），恢复时无法重放。
恢复时决定齐了：deny → `tool_result(is_error: true, content: '审批被拒绝：…')`
（**理由回给模型**，可自行换路）；approve → 正常执行且工具体内经 `ToolRunContext.approval`
读到自己的决定（审计 / 分级授权）。两个例外不参与审批：隐藏 `submit_result`（纯内部提交）
与未知工具（走既有 unknown_tool 路径）。恢复后再遇未决 ⇒ 再次挂起（可等多轮）。

**③ 为什么惰性超时（不起定时器）**：`approvalTimeoutMs` 只在 `approve` / `poll`（含
`awaitTask` 的读路径）/ `resumePending` **读到** awaiting 记录时判定 —— 到点自动把全部待决项
写成 `denied, reason: '审批超时'`（`decidedBy: 'system'`）并重派。理由与 2026-09-14 ④ 同源：
「等待的终点」类计时器在空事件循环下会让进程退不出/等待永不结束；而且挂起的任务**不占任何
在飞资源**，一个永远没人读的任务也不该被定时器推着走。代价如实标注：没人读 ⇒ 没人判
（文档写明「惰性」）。

**④ 为什么挂起也 flushSinks**：trace 是一等公民 —— 「挂起段」也是一段真实执行
（模型往返 + 审批请求），它的 trace 必须可观测，否则「任务为什么在等」无从回答。
每段执行一棵独立的新树（`traceId == runId` 不变量不破），恢复段经 `traceContext` link
挂到上一段 runId（复用 2026-09-17 ⑤ 的入站关联机制），观测后端据此把多段连成一条链。
对称地：`TaskSink.onFinished` **不**对挂起开火（它的承诺是「任务达终态」），记忆回写 /
会话追加维持「只成功才写」。

**消费点口径（`awaiting_approval` 这个新状态的全量清单）**：非终态（`awaitTask` 继续等）、
不占并发槽（挂起即释放，`#execute` 正常收尾）、`resumePending` 不捡（它不是孤儿，是在等人）、
InMemory 淘汰跳过（同「在飞永不淘汰」）、幂等键复用（同键重复 submit 返回等待中的任务）、
`Run` 状态机走新加的 `suspend()`（running → awaiting_approval，finishedAt 不置）、
trace 状态记 **ok**（挂起段执行无误，「等人」不该被看板算成失败；区分靠 stop_reason attribute）。

**已知边界（写进 usage-guide §7）**：审批超时是**惰性**判定；挂起段与恢复段是两棵
link 相连的 trace（指标按段计）；**at-least-once**：崩溃发生在「批准后、恢复执行中」时，
副作用工具会重执行（与 resumePending 同口径）；预算口径（maxTotalTokens/maxCostUsd）在
恢复段**重新起算**（新树新账，与 resumePending 续跑同口径）；嵌套能力（@SubAgent/@Skill
的子循环）里的审批工具**不支持挂起整个 run** —— 子循环挂起会以 is_error 交回主 agent
（要审批的能力请放主菜单）；同步 `POST /run` 撞上审批会带着 `awaiting_approval` 返回
（没有人可批的入口 —— 要审批就走 `/tasks` 异步宿主）。

**实现时的两处规格外补充（如实记）**：`AgentRunResult` 除 `suspendedMessages` 外还带
`pendingApprovals`（待决 tool_use_id 列表）—— 宿主必须知道「该批哪些 id」，而它从
suspendedMessages **推不出来**（runner 不知道哪些工具标了审批；待决集合是引擎算出来的）；
`TaskRecord` 除 `approvals` 外带 `approvalPendingSince`（挂起时刻）—— 否则进程重启后
惰性超时与 `approval.decided` 的 `waitedMs` 都没有基准。两者都是纯数据、可序列化、随记录落盘。

**门禁**：`tests/engine/approval.test.ts`（9：挂起形状 / flushSinks 照常 / approved 恢复 +
ctx.approval + waitedMs / denied 回模型 / 混合回合全有或全无 / 二次挂起 / submit_result
绕过与同回合等待 / 通用恢复入口 / 恢复入口尊重 signal）、`tests/transport/approval.test.ts`
（8：挂起落库 + 槽位释放（concurrency=1 证明）+ onFinished 不开火 / 恢复成功 + trace link /
逐 id 幂等（第一次赢）+ 决定不齐不恢复 / 404·409 语义 / 惰性超时自动 deny / resumePending
不捡 + 过期判拒 / FileTaskStore 跨进程 / 幂等键复用）、`tests/transport/httpApproval.test.ts`
（6：200 / 400×5 种坏 body / 404 / 409 / 401 / 拒绝路径端到端）、toolkit 透传 1 +
InMemory 淘汰 1。宿主侧全部走**真引擎**（executeRun + mockClient），不用假 app ——
「宿主测试用假实现」的边界是第五轮 review 三条 MAJOR 的共同病灶。

### 2026-09-19 ②：工具超时的「放弃等待」升级为「放弃 + 通知」——`ToolRunContext.abandoned`

**背景**：第八轮复审（engine/runtime 面）抓到观测完整性的破口：子 agent / skill 被
`toolTimeoutMs` 超时后，capability span 要等子循环自己 settle 才收尾 —— 而 trace 在 run
结束时**浅拷交付**（tracer.snapshot 的注释写明「不拷贝就会事后变异已交付的 trace」），
于是交付的那份里该 span 永远没有 `endedAt`、status 停在缺省 `ok`（与同回合
`tool.output` 事件的 `timeout` 记录自相矛盾）；更糟的是子循环在后台继续跑模型请求，
**花费不进任何观测面**（trace / metrics / report 都看不见）。「超时不取消工具」是
有意设计（副作用无法回滚），但「不取消」不等于「不通知」。

**决策**：新增 `ToolRunContext.abandoned: AbortSignal` —— 引擎 `withTimeout` 判超时的
分支里 abort 它（`executeOneTool`）。「放弃等待」的语义不变（不等、不杀 run、tool_result
记 is_error），但工具现在**收得到通知**：想真停的工具监听它自行收尾。框架自带的
@SubAgent / @Skill 已这么做 —— 收到信号即把 `abandoned` 与 `ctx.signal` 合成后透传给
子循环（在飞模型请求被掐掉，后台不再烧 token），capability span **立刻**以
`error`（type: `timeout`）收尾（不等子循环 settle —— 同步于放弃时刻，必在交付前）。
同轮顺手修掉 skill 的相邻缺陷：`ctx.llm()` 失败被用户方法体 try/catch 降级时，span
曾被提前烙成 error（幂等守卫让整体成功的调用翻不了案）—— 现在丰富错误存起来交给
外层 catch 收尾，方法体正常返回就是 ok。

**反向验证**：新用例在旧实现下必红（旧代码没有 `abandoned`，`subAborted` 永远 false，
capability span 永远没有 `endedAt`）。

同轮还修：**Scheduler 的 `at()` / `every()` 挡 32 位定时器溢出**（> 2³¹-1ms 被 Node
静默钳到 1ms ⇒「30 天后」变立即触发 / 周期任务退化成每毫秒空转；构造期抛错，与
`runTimeoutMs` 的防线同款）。其余低危发现（file store 同进程撕裂写、终态落库失败静默、
Scheduler 调度表不落库、`contextPolicy` 不进子循环、MemoryStore 无删除语义、并行子循环
下预算超限量级）**如实登记**进 usage-guide §7，不改行为。

### 2026-09-19 ③：外部复审（四路）收口 —— 这轮的病是「文档承诺了代码没做的事」

四条复审路线（HITL / MCP 连接器 / gRPC 示例 / soak 脚本）对 `be8e942..9469e91` 的指认，
逐条对代码核实后修复（每条带反向验证：摘掉修复 ⇒ 新用例必红）：

1. **`AsyncRunner.approve` 补重入闸 + 真落库再派发**：并发 approve（双击/多审批人）曾在
   store 往返窗口内各自判「决定齐了」、**各派发一次**（与 resumePending 在 2026-09-18 ⑧
   补的闸同一 bug 类，隔一个方法漏了）；且它用着 `#safeSave`（吞错）却在 docstring 里
   承诺「先落库再派发」—— 现在并发共享在飞那次（第一次决定赢，后到者拿到同一份结果），
   落库改真 `store.save`（失败 ⇒ reject 给调用方、绝不派发）。
2. **MCP StreamableHTTP 连接器去掉 `tools/call` 的第二计时器**：`rpc()` 末尾曾无条件
   `guard(...)`，把装配期的 `timeoutMs` 管进了工具调用（stdio 侧没有这层）—— 正是
   2026-09-17 ①「超时单源化」要消除的双计时器。装配期路径（initialize / initialized /
   tools/list）的 guard 不变。顺带：非 SSE 分支的响应 id 改为**等值配对**（原只验
   「id 是 number」，串包时会把别的请求的结果当本次的返回）。
3. **gRPC 示例 `getTask` 补 try/catch**：grpc-js 不接管 async handler 的 Promise，
   store 抛错 = unhandledRejection = 杀进程 —— 示例在教一个会杀进程的写法。
4. **soak 的两处假绿**：采样不足时「跳过内存断言」却照打「内存有界」（静默跳过 =
   假装验过 —— 自家病灶）⇒ 采样间隔随时长缩放、不足硬失败；宽区间失败率断言换成
   **逐笔对账**（每个不可重试故障恰好杀死一个 run ⇒ `failed ≥ 注入数`，超出部分
   ≤ 请求的 0.1% —— 实测 306 vs 306 分文不差）。
5. **文档对齐**：usage-guide 曾承诺同步 `/run` 返回「含 `suspendedMessages`」，
   `toHttpBody` 没有该字段 —— 改文档（要审批就走异步宿主，不补字段：同步路径
   补了也没有可审批的任务记录，给了是误导）。

未修、如实记下：MCP 会话过期自愈的并发互斥（双 404 → 双 initialize，窗口是毫秒级）、
`e2e-mcp.ts` 探测进程缺 try/finally、gRPC 示例 README 缺 `build` 步骤、示例把 `session`
塞进 transport 选项（靠 excess-property 逃逸生效，换 SqliteTaskStore 会翻车 ——
需要框架侧给「异步宿主带 session」的正式通道，是设计活不是顺手修）。

### 2026-09-19 ④：③ 的「未修」清单收口 + 三条一致性修补 + 预算护栏改走廉价 usage

③ 列出的「未修」由作者收口：MCP 会话过期自愈的并发互斥（`reinitialize` 互斥，双 404 共享
同一次重握手）、`e2e-mcp.ts` 探测进程的 try/finally、gRPC 示例 README 的 `build` 步骤，
以及**异步宿主带 session 的正式通道**（`RunInvocationOptions.sessionId` 可序列化引用 +
未配 `sessionStore` 时 `submit` 当场 `TaskInputError`，不再靠 excess-property 逃逸）。
测试链同时修了「框架套件一挂、CLI 与 trace-view 套件静默不跑」的 `&&` 短路
（`scripts/test-all.mjs`：三套件都跑完再汇总退出码）。

本次复审又补三条「守卫没覆盖自己声称范围」的缺口 + 一处护栏开销：

1. **MCP HTTP `close()` 的 DELETE 过 `guard`**：此前直接 `await fetchImpl(...)`，外层
   `catch` 只兜得住**抛错**、兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
   `close()` 就永久挂住，而调用方是**宿主停机路径**（挂住比失败更糟，与「best-effort、
   不抛错」的承诺相悖）。fetch 与 body 排空**一起**进 guard：只护住响应头，`readText`
   照样能卡。反向验证：摘掉修复 ⇒ 新用例在 `--test-timeout=8000` 下被
   `cancelledByParent` 取消（正是 `verify-all.sh` 专门抽取的那类非断言失败）。
2. **`asset()` 拦绝对路径**：守卫此前只拦带 scheme 的 `rel`，但 `/etc/passwd` 与
   `file:///etc/passwd` 是**同一类** —— `new URL('/etc/passwd', 'file:///…/x.js')` 解析成
   `file:///etc/passwd`，base 的路径部分被整个丢掉，于是「以为读了能力目录里的文件，
   实际读了别处」（macOS 上**真能读到**）。注释声称的那个不变量现在真的守住了。
   `../` 仍**放行** —— 它是相对 base 解析的，base 没被忽略，两者必须区分开。
3. **`interruptibleSleep` 的判定顺序 —— 查过，结论是「不改」（记下来免得下轮再改）**：
   `ms <= 0` 的早退确实排在 `signal.aborted` 检查**之前**，看着像一致性缺口，但它与
   `withTimeout(p, 0)` 的「不设超时、原样透传」是**同一口径**：预算 ≤0 ⇒ 这次机制
   **关掉**，与 signal 状态无关（取消会在下一步 —— 下一个 fetch / 下一轮循环 —— 照常浮出来）。
   本轮曾按「缺口」把它改反（让已中止的 signal 即使 `ms<=0` 也 reject），被既有用例
   `tests/core/sse-text-stats.test.ts` 当场拦下 ⇒ 已回退。该用例的断言同时从「隐式
   `await`」改成显式 `assert.doesNotReject` 并写明理由 —— 这条语义此前只有一行注释，
   太容易被下一次复核再误判成 bug（`src/core/timeout.ts` 的函数注释里也补了同样的警示）。
4. **预算护栏改走廉价 usage（含一处 API 收窄）**：护栏每回合要判**两次**（回合入口
   `checkTurnEntry` + 回合末 `loop`），而 `recorder.snapshot('ok')` 会**拷**全部 span 的
   attributes/events/links ⇒ 白花 O(回合 × 累计事件量)。现在：
   - 新增 `TraceRecorder.usage()`：只扫 spans 求和、不拷；`snapshot().totalUsage` 改为
     **调它** ⇒ 两条路不可能漂移（`tests/engine/tracer.test.ts` 用 `deepEqual` 钉住）；
   - `core/tool.ts` 的 `RecorderBackend` 加 `usage(): Usage`（引擎经这个结构面读 recorder）；
   - `BudgetGuard.check` 入参由 `Trace` **收窄**为 `{ readonly totalUsage: Usage }`。
     传整份 `Trace` 的调用方不受影响（结构上满足），收窄的附带好处是护栏**在类型上**就
     读不到 `spans` —— 「只看 totalUsage」从注释变成了结构约束。
   - **刻意不合并那两次调用**：两处是不同决策点（回合末那次的结果要交给 `executeTurnTools`
     决定循环是否继续；回合入口那次覆盖「上一回合的工具执行把额度推超」），删任一处都改语义。
     ⇒ 优化的是**每次判定的代价**，不是判定次数。

### 2026-09-20：第九轮复审收口 —— HITL×session 组合破口 + 六条小修

1. **HITL × sessionStore 组合破口（高）**：异步宿主恢复段（`rec.approvals !== undefined`）
   **不再把 `session` 注入 `app.run`** —— 挂起段落库的 `suspendedMessages` 已含
   `loadSession` 拼入的完整会话历史，再注入会让 run 层把 store 历史**再 prepend 一遍**
   （历史翻倍、token 复利）；且成功后 `appendSession` 会把整段扩展历史（含未决 tool_use
   的 assistant）写进会话 —— 违反「只存对话轮次」不变量，留下孤立 tool_use + 连续两条
   assistant，下一轮该会话直接撞 API 400。恢复段的会话回写改由 `AsyncRunner` 自己补：
   挂起时（overwrite `spec.messages` 之前）快照「本轮用户输入」到进程内 Map
   （`sessionInputs`，只在首个挂起段快照 —— 恢复段再挂起时 `spec.messages` 已是扩展历史，
   原快照不能丢），恢复成功后 append「用户输入 + 最终回复」（口径同 run.ts 的三条不变量，
   占位文案同 `EMPTY_REPLY_MARK`）。**取舍**：快照只在内存 —— 进程崩在「挂起 → 重启 →
   approve」之间会丢这一次回写（会话少一轮，但绝不写进坏历史；审批决定本身已落库）。
   快照落库要动 `TaskRecord` 的序列化 schema（sqlite/redis），相对审批决定它只是
   锦上添花，故不动 schema。
2. **惰性审批超时补重入闸**：`#expireAndResume` 与 `approve` **共用同一把** per-taskId
   在飞闸（`inflightApprovals`）—— 异步 store 的 `get` 返回新副本，两个并发 poll
   （或 poll 与 approve）各自看到 awaiting 快照 ⇒ 双双填超时拒绝 + 双双派发。进闸后
   **重读一遍** store 再判：闸只互斥「进入」，挡不住「进闸前已取到的旧副本」。
   approve 撞上在飞的超时恢复时共享其结果（与人的决定竞速，先到先得）。
3. **StreamableHTTP MCP 连接器透传 `abandoned`**：`callTool` 接第三参并透传到
   `rpc`/`post` 的 `fetchImpl(url, {...init, signal})`（含会话 404 自愈重试那次）。
   HTTP 侧没有 stdio 的 pending 簿记 —— **掐在飞 fetch 就是清簿记**。此前引擎超时后
   在飞 fetch 泄漏。
4. **Anthropic 流内 error 补 4xx 档**：`invalid_request_error` / `authentication_error` /
   `permission_error` / `not_found_error` → 400（归 api/不可重试），与 openai.ts 的
   `statusOfStreamError` **同口径**（那边 authentication/permission 也归 400，不细分
   401/403）。此前默认 500 → server/可重试：改配置才有救的病因让引擎白重试三轮。
5. **`runTimeoutMs` 超时归 timeout 一类账**：`#raceTimeout` 的裸 `Error` 换成
   `core/timeout.ts` 的 `TimeoutError`（`code='timeout'`）—— 此前落 unknown，
   与「超时自成一类」（2026-09-17 ②）在异步宿主这条路径上两本账。
6. **`FileTaskStore.save` 先落盘后写内存**：旧顺序下落盘抛错时内存已推进 ——
   内存说「已存」而磁盘没有，重启后记录静默回退。
7. **Anthropic SSE 的 content_block `index` 设上限**（1024）：index 是外部输入，
   `blocks[index] = acc` 对超大 index 造稀疏数组，组装的 `for...of`/`reduce` 按 length
   空转（反向验证实测：index=1e9 的用例摘掉守卫后单这一条就跑 30s）。畸形 index
   （超上限 / 负数 / 非整数）响亮抛 `AnthropicApiError(500)`。
8. **`createAnthropicClient` 的 `timeout` 构造期校验**：必须为正有限数（NaN/Infinity
   会被 setTimeout 钳到 1ms，每请求立即超时），与 AsyncRunner 对 `runTimeoutMs` 的
   校验同款。**不改** client 层超时的既有行为（合成信号中止 → 自身不重试 →
   引擎归 timeout 一类账）。

反向验证逐条做过（摘掉修复 ⇒ 新用例红 ⇒ 恢复 ⇒ 绿），证据在各提交的说明里。

### 2026-09-20 ②：`metrics.ts` / `mcp.ts` 纯结构拆分（零行为变化）

review 指出两个超大文件该拆：`integrations/metrics.ts`（1050 行）拆为
`metrics-state.ts`（`MetricsState` 累加/快照/重置）+ `metrics-render.ts`（Prometheus 文本）
+ `metrics-otlp.ts`（OTLP 组装与 flush）+ `metrics.ts`（只留选项校验/定时器/组装）；
`integrations/mcp.ts`（897 行）拆为 `mcp-stdio.ts` / `mcp-http.ts` 两个连接器 +
`mcp.ts`（桥 + 共享 helper + re-export）。全部新文件是同层 module 级 export、**不进公共面**；
`src/index.ts`、既有测试、官网 api.html 一行未改（公共面零漂移即验收标准）。
其余大文件（async / turn / http / module / openai / anthropic）经评审结论为**保持不动**。

### 2026-09-20 ③：CLI 接口面补齐 + **脚手架生产路径修复**（`dist/main.js` 从跑不通到跑通）

起因是「CLI 包写的是不是比较一般」的复查，落到三件事，都属**补丁位**（无破坏性变更）：

**① 脚手架的生产路径此前从未跑通 —— 这是真缺陷，不是优化。** `src/main.ts` 的
`discover` 用的是 cwd 相对字符串（`'src/tools'` 等）：dev（`tsx src/main.ts`）恰好对，
但 `npm run build && npm start` 下它解析到 **`src/` 里的 `.ts` 源码**并去动态 import ——
装饰器不是可擦除的类型语法，Node 直接抛 `Invalid or unexpected token`；换个 cwd 跑则报
「能力目录不存在」。改为**按本文件位置**解析（`fileURLToPath(new URL('<分类>/', import.meta.url))`）：
`tsconfig` 是 `rootDir: src → outDir: dist`（镜像成立），所以 dev 解析到 `src/`、构建后解析到
`dist/`，两边都对且与 cwd 无关。**必须同时过滤不存在的分类目录**：`tsc` 不为空目录产出
`dist/<分类>/`，而 `discover` 对显式给出的不存在路径是**响亮报错**的（那条锁定决定保持不动，
所以过滤放在脚手架侧）。为什么此前 8/8 全绿也没拦住：`scripts/e2e-cli.ts` 只断言 dist 产物
**存在**，从不**运行**它 —— 现补 4e 步用本地假 Anthropic 端点真跑 `node dist/main.js`
（两种 cwd 各一次）+ 断言脚手架的能力真进了模型菜单；反向验证：把模板改回 cwd 相对形态，
该断言即红（`src/tools/echo-back/index.ts: Invalid or unexpected token`）。

**② 命令行契约补齐。** `report` / `diff` / `doctor` 支持 `--json`（stdout 只有一个 JSON 文档、
无人类装饰；出错仍走 stderr + 退出码 1 且 stdout 保持为空 —— 脚本据此区分「有结果」与「没跑成」）。
`diff --json` **不改退出码语义**（有差异仍为 1），只是让「差在哪」也能被读。`harvest` 刻意**不加**：
它的 stdout 本身就是产物（生成的 eval 源码），加 `--json` 会自相矛盾。新增 `--version` / `-v`，
读**包自身 package.json**（不另存常量 —— 常量会漂）。

**③ 命令行从哪来：npx 为主、CLI 进工程。** 脚手架把 `@migor/cli` 写进新工程的
`devDependencies`（走本地 bin：离线可用、版本与框架同批 pin），`dev` script 改指 `agentia dev`
（与 npx 同一条路、带 inspector 面板）—— 为此 `dev` 必须把额外参数**透传**给用户脚本
（`npm run dev -- "问题"` 是文档化用法，不能吃掉）。**首次创建仍必须写带 scope 的
`npx @migor/cli create`**：npm 上另有一个别人的 `agentia` 包，短名会装错东西（实测
`npm view agentia` → `0.0.0`／"AI Agent generator"）。⇒ 发布面随之多一条：`templates.ts` 里的
CLI pin 与框架 pin 是**两条**版本面（漏 bump 会留下与框架漂开的旧 CLI），已进
`scripts/release-surface.mjs` 并在 bump 的计数断言里。

**明确不做**：统一参数解析框架（收益是少几处手写循环，代价是 8 个命令全线回归）；
`harvest` / `diff` 那份「去类型移植副本」的合并（要么破坏 CLI 零运行时依赖，要么动分层守卫，
是独立架构决策）；把四分类目录改成「扫描 `src/` 下所有子目录」（装配顺序是 load-bearing 的，
数组顺序即装配顺序，扫描会把它变成字母序）。

### 2026-09-21：三个 god module 的**纯结构拆分**收尾 —— 判定面有名字、有直测，编排留在原处

**背景**：0.7.1 之后连续出现的竞态都出在同类文件上 —— `transport/async.ts`、`engine/turn.ts` /
`engine/loop.ts`、`transport/http.ts` 这四个「状态机 + 并发 + 编排混住」的大文件。改一处要先在
脑袋里装下整块，出了问题也只能端到端复现。这一串拆分的目的是**把判定面拿出来单测**，而不是把
文件改小。

**纪律（每步都必须满足，否则这一步作废）**：只外移**纯判定**（读参数、回值；不碰 store / 网络 /
时钟 / 回调）；代码**逐字搬迁**，注释跟着走；一步一 PR、squash 合进 main 后下一步再从 main 切；
每步跑全链 + soak；**既有用例一条不改**（改了就不是重构）。

**账（全部当场 `wc -l` 量，不估）**：

- `transport/async.ts`：**910 → 822**（`slot-pool` 895 → `approval-policy` 872 → `drain-gate` 854
  → `resume-policy` 851 → `task-waiters` 822）。
  ⚠️ 这里有个容易记错的基线：910 是**第九轮复审收口之后**（`bfeccec`）的状态，v0.7.1 那个 tag 上是
  813 —— 收口本身把这文件写大了 97 行，拆分是拿收口后的形态当基线的。
- `engine/turn.ts`：**739 → 619**（`stop-reason` 649 → `turn-request` 654 → `tool-context` 646
  → `tool-events` 619）。**其中一步体积反而 +5** —— 抽走的是两个判定，调用点补了类型收窄条件。
  体积不是目标；那一步买的是两个此前零直测的判定（见下）。
- `engine/loop.ts`：**489 → 365**（`run-config` 436 → `loop-result` 384 → `resume-input` 365）。
- `transport/http.ts`：**701 → 630**（`http-shapes` 639 → `http-route` 630）。
  最后一步只缩 9 行 —— if 链改 `switch` 后每个 case 体多缩进两格；忽略空白看真实改动是 38+/47−，
  其余全是缩进。买的是「(路径, 方法) → 分支」这层判定第一次有了名字与 14 条表驱动断言。

**每步买到什么**（这才是这套拆分的产出）：新增 **14 个测试文件 / 127 条直接用例**
（逐文件 `^\s*it(` 计数；全仓口径 +140 条（`tests/` 增量），差额里另有别的 PR 的用例，不记在这套里）。此前只有端到端覆盖的
语义现在逐条钉住了，其中几条是「只在生产里表现」的：

- 审批超时的**基准退化链**（`approvalPendingSince` → `startedAt` → `createdAt`，边界严格大于）
  与**空集真值**；超时兜底**绝不覆盖人工决定**。
- 崩溃恢复的认领判定：**无主（孤儿）记录永远可抢**（这条守卫看着像宽松条件，实际是「崩溃后任务
  还能被捡起来」的唯一依据）。
- 重试闸的 `!emitted`：**吐出去的字收不回来**，已流字一律不重试。
- `maxEventChars: false` / `toolTimeoutMs: 0` 这类**有意义的值**不能被真值判定吃掉。
- 挂起交出的历史是**拷贝**（宿主落库后继续 push 不回写已挂起的结果）。
- HTTP 路由的**三条顺序**：免鉴权组的 405 先于鉴权；其余先鉴权再判方法/路径（不泄露路径是否存在）；
  「方法不对」压过「id 坏了」（`DELETE /tasks/%zz/approve` = 405，不是 400）。

**明确不做**（边界声明 —— 到此为止是判断，不是没做完）：

- **编排本体**：`agentLoop` 的状态机与回合间共享状态、`AsyncRunner` 的在飞闸与「先落库再派发」的
  派发顺序、`http.ts` 的 `drain` 协调。这些互相咬合，再抽一块只是把耦合换个地方放，且抽出去就等于
  把「顺序」这条保证从它原来的上下文里摘掉 —— 而顺序恰恰是它们的全部价值。
- **碰 I/O 与时钟的件**：`readBody`（流读取 + 超限/断开两道兜底）、`waitUntil`（轮询 + deadline）、
  `sseWriter`（背压 + 收口）。搬走它们就不是「纯判定外移」了；底层的等待原语此前已抽过
  （`core/timeout.ts`），这一层没有新的可抽物。
- **`loop.ts` 的 `forkPolicyPerRun` 留在原处**：2 行，per-run 隔离的语义已由 `fork.test.ts` 覆盖，
  抽出去只多一层间接。
- **不为行数继续切**：`loop.ts` 365 行 / `http.ts` 630 行里剩下的是入口 + 编排，没有第 15 块可抽的
  纯件了。

**同期附带**（不属拆分，但同批落地）：CI 在 main 上的 run 不再互相取消
（`cancel-in-progress` 只对 PR 生效 —— 「连合两条后 merge commit 显示 cancelled」是它造成的假象）；
lint 闸门从「只报 error」翻成**零告警**（93 warnings + 12 infos → 0，`info` 级规则在 `biome.jsonc`
升到 warn，因为 `--error-on-warnings` 不覆盖 info）；`@biomejs/biome` 的声明下界对齐 `^2.5.14`
（此前下界比配置与锁文件低一档，非锁文件安装会少报存量 → 「本地绿、CI 挂」）。

**怎么复核这一串**：每步 PR 都带全链 8/8 + soak 的当轮数字（`SOAK_DURATION_MS=30000
SOAK_CONCURRENCY=8 npm run e2e:soak`，报的是「失败与不可重试注入逐笔对账」那一行）；反向验证逐条
写在 commit message 里（「摘掉这条修复 ⇒ 哪条用例红」）。

### 2026-09-21 ②：CLI 脚手架模板从「字符串」升级为「真文件」（CODE-REVIEW-2026-09-21 待决策 2）

**背景**：`packages/cli/src/templates.ts` 把生成给用户项目的 `main.ts` / 能力文件 / tsconfig /
package.json 全部写成字符串模板。字符串不过编译器 —— 模板代码对仓库自己的 typecheck/lint
不可见，discover 路径「生产必崩」缺陷就是这么漏到 0.7.2 的（e2e-cli 的 4c/4d/4e 是事后补的
门禁，发现时机太晚）。

**决定**：模板变成 `packages/cli/templates/` 下的真文件（按生成物的目录结构摆放），被仓库
工具链全程照看：

- **占位符纪律**：token（`__PROJECT_NAME__` / `__NAME__` / `__CLASS_NAME__` /
  `__METHOD_NAME__`）只许出现在**字符串 / 注释 / 标识符**位置 —— 这样模板文件自身就是
  合法 TS/JSON，能过 tsc 与 Biome。标识符位置（类名/方法名）用大写下划线 token，它们本就是
  合法标识符。
- **纳入工具链**：`packages/cli/tsconfig.templates.json` 把 templates/ 纳入 tsc（挂在
  build 里，选项与生成物 tsconfig 同口径），`'@migor/agentia'` 经 paths 映射到框架 src
  （同根 tsconfig.tests.json 对 examples 的做法），无需在 templates/ 里 npm install；
  Biome lint 照常收。
- **Biome 只关 formatter**（`packages/cli/templates/**`）：生成物字节是与存量项目/e2e 断言的
  兼容契约（逐字节零漂移），而 Biome 排版与契约不一致（tsconfig 模板的多行数组来自
  JSON.stringify 的既有输出）—— 排版由「渲染产物逐字节对拍」守门，不由 formatter 重排。
- **点文件用无点文件名**（`gitignore` / `env` / `env.example`，create 写出时才补点）：
  `.env` 会被仓库根 .gitignore 吞掉（进不了版本库），`.gitignore` 会被 npm pack 静默剥掉。
- **运行时读取**：`templates.ts` 从 `dist/templates/`（构建时 copy-assets 整树拷入）读文件 +
  replaceAll 渲染；导出函数签名不变，`packages/cli/test` 一行未改全绿。
- **版本发布面搬家**：两条 pin（框架依赖 + CLI devDependency）从 templates.ts 落到
  `templates/package.json`，`scripts/release-surface.mjs` 清单的路径与正则（单引号 →
  JSON 双引号）已同步，`tests/scripts/release-scripts.test.ts` 夹具同步 —— 这是本迁移
  最容易漏的一处，漏了 bump 就改不到新版本。

**零漂移判据**：一次性对拍脚本（不进仓库）对旧字符串模板与新文件方案的全部渲染产物
（项目级 9 件 + 4 类能力 × 5 个 kebab 名）逐文件 diff —— 为空；e2e-cli 全链绿。

### 2026-09-21 ③：**出站链路传播**落地 —— 解开 spec 自己写下的一处自相矛盾

**背景**：弱方向审计把「出站 `traceparent`」点为全仓唯一「语义已定、只差实现」的开放项。
动手时发现 §9.2 的两句话互相打架：`:135` 锁定「span 句柄**不放** `RunContext`」（理由是并行的
工具调用会互相覆盖），`:146` 却把「`RunContext` 暴露当前 span」当成出站的前置件。原句写的
「硬造一个会是假的 spanId」也经不起查。

**两条实测结论（本条的实质）**：

1. **前置件不是 RunContext，是「调用期作用域」。** run 级 ALS 只有一个值 —— `withRunContext`
   是 run 作用域，往里塞「当前 span」必然被并行工具互相覆盖（这正是 `:135` 锁定的理由）。
   正确形态是**每次调用一份**的独立作用域（`src/engine/span-scope.ts`，
   `AsyncLocalStorage<SpanScope>`），三层由粗到细嵌套：run 根（`engine/loop.ts`）→ 本回合
   `llm.turn`（`engine/turn.ts` 包住每次工具执行）→ `capability`（`toolkit/skill.ts` /
   `subagent.ts` 包住自己的方法体 / 子循环）。`RunContext` / `ToolRunContext` / `Span`
   三个契约**一字未改**。
2. **「假 spanId」不成立：OTLP 早就有这条投影。** W3C 要 trace 32-hex + span **16-hex**，
   本仓 id 一律 UUID（去横线 32-hex）。`integrations/otlp.ts` 的 `spanHex` 早就做了
   `replaceAll('-','').slice(0,16)`（注释原文：「不截 collector 会判 `invalid span_id`」）。
   所以那 16-hex 就是**我们已经在发给 collector 的 span 身份** —— 出站复用同一份投影，
   下游看到的 span id 与 collector 里的是**同一个数**。反过来，出站若各写一份，同一次调用
   在两个系统里就是**两个 span id**，那是跨系统关联最不能出的错。

**决定**：

- 投影**单源化**到 `core/trace.ts`：`wireTraceId` / `wireSpanId` / `formatTraceparent`，
  与 `parseTraceparent` 同处（一个解析、一个生成）。`integrations/otlp.ts` 删掉自己的私有
  副本、改为 import（`integrations → core` 是既有边）。断言随之改为引用单源
  （`tests/integrations/otlp.test.ts`），「导出 id === 出站 id」被机器钉住。
- 公共面**只加一个**：`currentTraceparent(): string | undefined`。flags 恒 `00` ——
  本框架不采样，不替下游声明「已采样」（入站解析器也从不读 flags）。
- **只给读取器，不做自动注入**：框架不创建出站请求（模型客户端那次调用不该带我们的
  traceparent），注入是宿主 `fetch` / metadata 里的一行 —— 与「webhook 后置、用 sink + 用户
  fetch」同一条既有决策。
- **如实标注的边界**：`run` 根 span 由 `runAgent` 打开 ⇒ 更早的 `contextInit` /
  记忆水合取到 `undefined`（那时确实还没有 span 可指）。写进 usage-guide §7 边界表。

**取舍（被否方案）**：把 span 塞进 `RunContext`（并行覆盖，见上）；给 `@Tool` 加第二参
`ctx`（`toolkit/tool.ts` 现在 `Reflect.apply(…, [input])`，要改成公开签名破坏 + 违背
「ctx 不层层下传」的既有取向）；把 spanId 生成改成 W3C 原生 16-hex（会与既有投影并列成
两套口径，且历史 trace 对不上）；另发一对 W3C id 记进 attributes（一个东西两个 id）。

**门禁**：`tests/engine/spanScope.test.ts`（往返闭环 / 并行不串 / 嵌套到 capability /
run 结束不残留）+ `tests/core/trace.test.ts` 的投影组 + otlp 单源断言；反向验证见设计文档
`docs/plans/2026-09-21-outbound-trace-propagation.md` §5。**不加 verify-all 步数**。

### 2026-09-21 ④：发布面清单的 lock 项改为**按包名锚定** —— 裸 version 计数会被同版本依赖撞网

**背景**：发 0.8.1 时 `check-release.mjs` 报「package-lock.json：4 处应为 0.8.1，实际命中
5 处」。逐条查：第 5 处是 `@grpc/proto-loader`，一个**恰好也是 0.8.1** 的第三方依赖 ——
清单那条用的是裸 `/"version": "(\d+\.\d+\.\d+)"/g`，按**值**计数，所以任何依赖与本次发布
版本号相同就会撞网，且报错文案读起来像「清单漏了一项」。

**决定**：改成**按包名锚定** ——
`/"name": "@migor\/(?:agentia|cli|trace-view)",\n\s+"version": "(\d+\.\d+\.\d+)"/g`，仍是 4 处
（顶层 + 根 + `packages/cli` + `packages/trace-view`），但每处都带自己的包名。两条副产物：
① `@migor/website`（`private: true`、版本恒 `0.0.0`）本来就不该在网里，锚定后按构造被排除，
不必再靠「恰好不同版本」侥幸；② 第三方的同版本号**永远**不会进网，撞车不再假红。

**门禁**：夹具里加了同版本**诱饵**（`node_modules/@grpc/proto-loader` 写成本次发布版本），
断言 bump 既不改它、也不把它算进发布面（`tests/scripts/release-scripts.test.ts`）。这正是
「多命中 = 有不认识的东西也叫这个版本号」那条设计意图的照妖镜 —— 原夹具只放了 1.3.0 的
`left-pad`，撞不上，所以这个坑一直没被夹具照到。

### 2026-09-21 ⑤：外部双模型复核（Claude × GPT）逐条复现 —— 7 条全部成立；改的过程中又照出 2 条真缺陷

**背景**：外部把同一份仓库交给两个模型独立审查，交回一张评分表（内部工程 / 发布稳定性 /
生产就绪度）与 7 条问题（4 条 P1、3 条 P2），并自称另有 5 条「证伪」。处理口径：**不采信任何
一侧的结论，逐条自己复现定性**；成立的改成带回归用例的代码，证伪的说清理由。

**逐条定性（7/7 成立，且全部落在「静默」这一类）**

| # | 复现结论 | 修法 |
|---|---|---|
| 1 | OTLP/JSON 的 enum 发的是**名字符串**（`status.code: 'STATUS_CODE_OK'`），规范要求整数枚举 | 改整数 1 / 2；并加一条「**扫整个 payload 不得出现任何 `*_CODE_*` 字面量**」的断言 —— 堵的是「断言跟着实现一起写错」这个**假绿机制**，不只是这一次的取值 |
| 2 | 异步 store 下同键并发提交**两次都执行**（实测 `app.run` 调用数 2） | 见下「认领表」段 |
| 3 | `maxRetries` 收 NaN / Infinity / 负数 / 小数 | 新建 `src/integrations/adapter-options.ts` 的构造期判定，两条适配器**共用一份**（`0` 放行 —— 「不重试」是有意义的值） |
| 4 | 重复构建保留**已删除能力**的产物 | 模板 `build` 先清 `dist/`（`packages/cli/templates/scripts/clean.mjs`）；仓库自身 `build` 同享一份 `scripts/clean-dist.mjs`（只清本次要建的那棵树，避免踩同仓作业的别的 agent） |
| 5 | MCP 已中止的调用**照样发请求**，且返回的 Promise 永不 settle | 判据移到 `write()` **之前**，以 `AbortError` 收场（`core/timeout.ts` 新导出 `abortError`，与 `interruptibleSleep` 共用形状 —— 取消不是超时） |
| 6 | `metricsSink.reset()` 破坏 CUMULATIVE 语义（同一 startTime 下 counter 2 → 1 倒退） | `MetricsState.windowStartedAt` 成为窗口起点的单一真源，`reset()` 把它前移（`max(now, 前值 + 1)` —— 同毫秒连按两次也**严格**前进） |
| 7 | **HTTP 200 不等于全部接收**：collector 的 `partialSuccess` 被读成成功 | 新建 `src/integrations/otlp-partial.ts`：判据是「**真拒收**（键在场且值 > 0）**或**非空 errorMessage」——`{}` 与 `rejectedSpans: 0` 是「全部接收」的另一种写法（有 collector 恒发）；traces 侧新增 `onExportError` 选项（`TraceSink` 的失败缺省是**静默**的，「少了一半数据」得有出口） |

**第 2 条为什么不是「加一句 await」**：`submit` 是**同步门面**（`poll` / `byIdempotency` 同），
异步 store 交回的 `byIdempotency` 是 Promise —— 门面等不了；而 `#executeInner` 只采纳**已
succeeded** 的既有记录（queued / running 不采纳，重复执行本就是 at-least-once 允许的行为）。
所以补法是在 `#execute` 的**同步前段**加一张**进程内认领表**（`#claims`）：`submit` 先查在飞
认领并直接返回它 ⇒ 两次连续 `submit` 之间没有窗口。

**修复本身带出的新缺陷（第 8 条，本轮唯一一条不是外部报告的）**：认领**只在终态释放**
（挂起还在等人，放了会让同键另起一个任务），而 HITL 的恢复段是**另一次** `#execute`
（`approve` 从 store 读出的、异步 store 交出的还是**新副本对象**），那次 `claimed` 必为
`false` ⇒ 释放判据若只看 `claimed` 或只比对象同一性，挂起过的键就**永久钉在认领表里**
（同键再也不执行 + 表无界增长）。判据改为按 `taskId` 比对（`#claims.get(key)?.taskId === rec.taskId`）。
**反向验证**：把判据退回 `claimed` 标志或对象同一性 ⇒ `tests/transport/async.test.ts` 的
HITL 用例立刻真红（3 条红）。

**第 9 条（由「改成字面跑 `npm run build`」这个决定照出来）**：把 e2e 的构建步骤从「测试复刻
`clean → tsc → copy-assets` 三步」改成**跑产物自己的 `npm run build`** 的当场，第一步就
`MODULE_NOT_FOUND` —— 模板目录里有 `scripts/clean.mjs`、`packages/cli/templates/package.json`
的 build 脚本也引用了它，但 `create.ts` **忘了把它写出去**。也就是说：**这一轮此前给模板加的
「清 dist」在生成的项目里从未存在过**，新工程 `npm run build` 第一步就崩（而当时所有单测都是绿的
—— 它们问的是「某个模板函数返回了什么」，没人从模板目录出发反问「谁用了它」）。修法与配套：
① `create.ts` 真写 `scripts/clean.mjs`；② `e2e-cli` 第 4c/4d 步改成**字面跑产物自己的
`npm run typecheck` / `npm run build`**（依赖解析靠 `node_modules` 里的 `@types` 与 `.bin/tsc`
软链，不再由测试拼 tsc 命令、也不写 overlay tsconfig —— 这正是 AGENTS.md「测产物要用产物自己
的输入」那条硬约定）；③ 新增 `packages/cli/test/templates.test.mjs` 的**双向引用守卫**（模板文件
必须被引用 / accessor 必须有**调用方**（掐掉 import 语句后判）/ renderTemplate 路径必须存在）；
④ 去掉「build 脚本字符串里含 `clean.mjs`」那条**字面量断言** —— 它会在合法重构（换文件名/换写法）
时误报，而真删真建的行为断言不问实现细节（反向验证：摘掉模板 build 里的清 dist ⇒
`SMOKE FAIL: 重复构建后仍留着已删除能力的产物`）。

**边界（如实写进 usage-guide §7）**：本轮修的是「**同进程内**并发提交」这一档。跨进程并发、
以及终态之后重提同键，仍是 at-least-once —— store 的 idem 索引是 **last-wins**
（redisStore / fsStore / sqliteStore 头注释同口径），而异步 store 下 `submit` 的同步快路
走不了 thenable。要严格一次得靠副作用自身幂等，或在 store 上做唯一约束（那是 store 的契约面，
不在本轮）。

**门禁**：登记进 `docs/guards.md` §1 四条（OTLP enum + partialSuccess、CUMULATIVE 窗口起点、
模板重建清 dist、幂等键的进程内认领），并把 `maxRetries` 的坏值矩阵并进既有的适配器对拍行。
反向验证逐条做过：OTLP enum 退回字符串（2 条红）、去掉 MCP 早退（1 条红）、窗口起点退回常量
（1 条红）、`maxRetries` 退回 `typeof x === 'number'`（2 条红）、认领表三种退法（1–3 条红）。

**报告自称「已证伪」的 5 条**：本轮**抽查 3 条**并给出证据 —— ① `FileTaskStore.list()` 是 Map
插入序（首次见到该 task 的顺序），**确定且稳定**（无任何语义依赖它排序）；② OpenAI 适配器读
`choices[0]` 而请求恒 **n=1**（从不请求多补全），读首项即全部；③ MCP `close()` 的「返回即子进程
已终止」已有 `mcpConnector.test.ts` 的 15 条变异电池覆盖（含忽略 SIGTERM 的顽固子进程）。
另 2 条（UUID 碰撞、HITL compaction）**未独立复核** —— 不替它们背书，也不当结论引用。

### 2026-09-21 ⑥：**增量 trace 出口**落地 —— F3 两条后置项收口

**背景**：F3 当初给了两条「后置」理由 —— SSE 事件粒度只做 `text.delta` + `run.end`
（「B 需要把 trace 事件实时外推，架构代价大」），以及异步任务流式
（「需要 run 进度跨进程，属『run 内事件流』，不在本期」）。今天读代码发现**真实前置件**
不是「写一个 SSE 端点」，而是**记账面没有订阅缝**：`TraceRecorder` 唯一出口是收尾的
`snapshot()`，全仓 `onSpan|onEvent|onTrace|subscribe` 零命中 ⇒ 端点无论怎么写都只能轮询 store 猜进度。

**决定**（分叉与取舍见 `docs/plans/2026-09-21-incremental-trace-export-and-sampling.md`）：

1. **机制只动一处**：`TraceRecorder.subscribe()` 派发记账事件（5 种：span 开/合、事件、属性、链路），
   engine 零改动（记账点唯一）。四条纪律：同步派发不 await、订阅者抛错被吞、无订阅者零派发、
   **`seq` 每次记账动作都占号**（先自增再判订阅者 —— 否则「订阅晚的人」与「一直订阅的人」
   看到的序号不一致，重放/去重全错位）。
2. **两条缝，不是一个**：`TraceSink`（收尾拿整棵、会投递、有兜底）与 `onTraceEvent`
   （运行期逐笔、**不保证送达**）。不把增量塞进 sink 契约 —— 那会让既有 sink 重新理解
   「可能收到半棵树」，是纯迁移成本。
3. **单次 + 应用级 = 叠加**（应用级在前），**不是覆盖**：观察者注册不是值覆盖，
   覆盖会让「某次 run 顺手传了个面板回调」把应用级那条静默顶掉（可观测性的静默回退）。
   合成后是一个订阅者 ⇒ 合成函数内部各自 try/catch（否则前一条抛错吞掉后一条）。
4. **传输层两个出口**：`POST /run` 的 SSE 追加**一族** `trace.event` 帧（既有三帧逐字不变；
   取一族而非每类型一帧 —— 将来加类型老客户端只是漏一种 type，不是漏一种帧名）+
   新增 `GET /tasks/:id/stream`。后者的三条语义各有一个容易写错的地方：
   **流序号 ≠ recorder 的 `seq`**（一个任务可跨多个 run 段：HITL 挂起→恢复、崩溃重投，
   每段 `seq` 从 1 重来）、**`awaiting_approval` 不是终态**（与 `resume-policy` 那个
   「可续跑」判定刻意相反：批了会接着跑，流得开着）、**背压/断开不 abort 任务**
   （读者是旁观者；对照 `/run` 的 SSE —— 那里的下游就是 run 的所有者）。
5. **不变量钉成一条用例**：把一次 run 的全部事件按 `seq` 折回，必须**逐字等于** `snapshot()`
   —— 不丢 / 不重 / 顺序 / 同源，四件事一条用例。反向验证（实测）：摘掉 `setAttribute` 派发
   ⇒ 6 条红；摘掉 `end` 派发 ⇒ 5 条红；把 `seq` 自增挪到订阅者判断之后 ⇒ 那条红；
   不重放 / 不调 `markDone` / 跨进程不明示 ⇒ 各有一条红。

**实现中发现并修掉的两件事**（都不是设计里写到的）：
- **终态收口必须有广播**：`markDone` 只置标志的话，**实时**订阅者永远等不到收口
  （SSE 一直挂着，客户端以为任务还在跑）⇒ 订阅接口带 `onDone`。这是 HTTP 用例先红出来才补的。
- **端到端用例必须 `closeAllConnections()` 再关服务器**：SSE 是长连，响应结束后 socket 留在
  keep-alive 池里 ⇒ 只 `close()` 会让 `server.close()` 的回调**永远等不到**
  （用例全绿但进程不退出，表现为「跑测试的命令挂着不动」）。

**非目标**：事件落 store 的真跨进程实时流（写放大：实测事件数 = 2 × 工具调用、正文 KB 级，
宿主自己的总线是它的家）；`GET /tasks/:id/stream` 的鉴权新策略（沿用既有路由组口径）。

### 2026-09-21 ⑧：**guards §2 的三条待守形状一次清空** —— `0` 的语义真源 / 转发漏字段 / 队列配方门禁

**背景**：`docs/guards.md` §2 是「已知缺口 —— 下一次 review 从这里开始」。本轮把其中三条
（含一条伴随行）建成了机器守卫，只剩「首屏 0 反射」那一行（它要先把「反射式 DI」写成可判定
的定义，值不值得当门禁还得先定）。

**① `0` 的双重语义 → 单一真源 + 集中用例。** 新增 `src/core/limits.ts`：15 个旋钮的 0 语义
登记成**可执行的数据**（`unlimited` / `disabled` / `immediate` / `invalid` 四类），
`tests/limits.test.ts` 拿这张表**逐条驱动真实站点**对账（探针是 `Record<LimitKnob, …>` ⇒
新旋钮不归类就 `typecheck:tests` 红）。

*动手时才看清的两件事*（都是本轮新发现的，此前没人登记）：

- **`intervalMs` 是同名反义**：`Scheduler.every` 要求「必须 > 0」（0 是配置错误，`setInterval(0)`
  会退化成每毫秒空转），而 `metricsSink` 的 `intervalMs: 0` 是「关掉定时器、每次累加后立即导出」。
  两个同名旋钮两种读法，此前只活在各自的注释里。
- **「数量」类旋钮里 `mapWithConcurrency` 是唯一的例外**：它取 `0` 读作「不限」，而
  `maxRetries` / `maxEvents` / `maxIterations` 取 `0` 都读作「就是不做」。四类的划分不是为了
  整齐，是为了让「哪个词在哪读成什么」一眼可查 —— 上一个事故就是这么来的（
  `handler.drain({ timeoutMs: 1 })` 跨过 deadline 后永不返回）。

**② 转发漏字段 → 穷尽转发类型。** 新增 `src/engine/forwarded.ts`：那七个「嵌套能力必须原样
往下交」的旋钮收进**唯一取值点** `forwardToolContext(ctx)`，映射类型要求七个键全必填 ⇒
`toolkit/subagent.ts` / `skill.ts` 里两处手写清单（各处七八行 `ctx.X,`）删掉，改为
`...forwardToolContext(ctx)`，**没有可漏的地方**。另加类型层守卫：`ToolRunContext` 的每个键
必须在「转发」或「引擎自装配」里归类，否则 `tests/types/forwarding.types.ts` 编译失败。

*为什么值得单独立件*：那个历史事故（漏 `toolTimeoutMs`）的后果是**反的** —— 子循环
`withTimeout(p, 0)` 等于永不超时，同时 MCP 桥又起自己的 60s 兜底，回到双计时器双账本。
而 TS 对「少写一个可选键」不报错，`exactOptionalPropertyTypes` 只堵住「显式传 undefined」
那一半 —— 这条缝只能靠映射类型 + 归类穷尽来堵。

**③ 队列消费者配方 → 真跑的门禁。** `docs/usage-guide.md` §6.4 那条二十行样板（Kafka /
RabbitMQ / SQS 的形态）此前**没有任何 gate 真跑过**。新增 `tests/transport/queueConsumer.test.ts`：
内存版 broker（at-least-once：ack 前不删 / 未 ack 与 nack 一律重投 / `crash()` 模拟崩溃）+
真 `AsyncRunner` + 真引擎，把配方的三条承诺逐条跑出来 —— ① 同键重投不重复执行（断言的是
**副作用计数**，不只是 taskId）；② 崩在 ack 之前重投仍不重复执行；③ `traceparent` 随
`spec.options` 落库，**他进程 `resumePending` 续跑那次 run 仍带得上同一条 link**；
④ 失败不 ack ⇒ nack 重投 ⇒ 二次成功（且失败的键**允许**新任务，否则重投永远拿不到第二次执行）。

*为什么放在 `npm test` 而不是新起示例工程 + e2e 脚本*：① `scripts/verify-all.sh` 的**步骤数写在
CI 必需检查名里**（「verify-all 8 步」），加检查一律折进已有步骤，本文件落在第 6 步、零接线；
② 真 broker 要起 Kafka/RabbitMQ，而这条配方真正的风险不在协议实现，而在**提交位移与幂等的
时机** —— 那正是内存 broker 能确定性钉住的部分。gRPC 那条仍是示例 + `scripts/e2e-grpc.ts`
（它是第 4 个宿主，要验的是协议面）。

**门禁**：`tests/limits.test.ts`（16 条）· `tests/engine/forwarded.test.ts`（4 条）·
`tests/types/forwarding.types.ts`（类型层）· `tests/transport/queueConsumer.test.ts`（4 条）。
**不加 verify-all 步数**。三条形状从 guards §2 移入 §1.2 / §1.3。

### 2026-09-21 ⑦：**记录成本与采样**收口 —— §9.4 从「开放问题」变成决定；`traceparent` flags 的理由换掉

**背景**：§9.4 的唯一开放项是「全量记录成本 vs 截断/采样默认阈值」，长期只有一句
「宿主自己截断/采样」兜着。今天先量（`npm run bench:trace`，零 token 零网络，进仓可复现）：
成本 **90%+ 是事件正文**、每次工具调用 +1.3~1.8 KB；真正会失控的是宿主**显式打开**的
`maxEventChars: false`（大出参下 **13.66×**）与长跑；而**事件数量在框架侧没有任何上限或计数**。

**一个被自己推翻的初始判断（写下来免得下一轮重犯）**：原本打算在框架里加 `samplingSink`。
读代码后否掉 —— `docs/observability.md` §0/§4 早已写死「采样不内建、是配方 2.3」，
且 `examples/observability` 已有成品 `sampleSink`（确定性哈希 + 失败必留 + fanOut），
再造一个就是**同一件事的两份实现**。所以「框架缺一个采样器」是**假缺口**；
真缺口只有两条：采样率**没有依据可算**、被丢掉的那部分**没有任何计数**。

**决定**：**默认全量记账 + 截断默认开 + 采样留在缝外 + 代价可数**。
新增只有一件框架侧的东西：`traceLimits.maxEvents`（整条 trace 的事件总数闸）——
超限即**停止记账**，交付时在 run 根写 `trace.truncated{droppedEvents, limit}`（**不静默**，
与 OTLP `partialSuccess` 那条同因）。**不做**环形缓冲：中间空洞比「尾巴截断」难解释得多。
与 `maxEventChars` 的分工写死：**一个管「多长」、一个管「多少」**，各有各的家
（正是本仓在收的「一个词两个语义」那种债，不能再造一个）。
配套：`observability.md` 2.3 补**容量换算表**（实测数字 → 每日量 → 倒推 `rate`），
示例的 `sampleSink` 补 `dropped()` / `onDrop`（不数的话「被采样掉」与「本来没跑」
在监控上无法区分）。

**同日的连带更正（flags 口径）**：`core/trace.ts` 里 `formatTraceparent` 的注释写的是
「本框架**不采样**（每次 run 全量记账），故没有『已采样』可声明」—— 在采样成为明确推荐配法后
这句话字面上不再成立。**但不能顺手把 flags 改成跟随采样**：记录/导出决策发生在 run
**收尾之后**（采样闸门要看完好整棵 trace 才判得出来），而出站调用发生在**运行期** ——
那时还没有答案。所以恒 `00` 是唯一不撒谎的选择，理由升级为**运行期不可知**。
另写死一条：**采样采的是导出，不是记账**（被采样掉的 trace 在框架内仍完整记账），
所以别拿「有采样」当「可以少记账」。

### 2026-09-22 ①：**e2e 端口 TOCTOU 的修法被取代** —— 删 `startExampleRetrying()`，改 `PORT=0`（补 2026-09-14 那条的取代记录）

**背景**：本文件 2026-09-14 的「附」记的是 `e2e-deploy` 端口 TOCTOU 的修法 —— 新增
`startExampleRetrying()`，**只对端口争用**换端口重试（3 次），并用「占住一个端口 +
把 `freePort()` 注入成第一次返回它」证明了它。那条记录**写下时是如实的**；但它描述的修法
此后被取代，而 §10 的规矩是**追加不改写** ⇒ 缺的是**这一条取代记录**，不是去改旧条目。
（判定方法记一笔：旧段落里引用的符号去全仓 grep，若只剩历史文档提到它，那段记的就是**已死的修法**。）

**决定**：`freePort()` 与 `startExampleRetrying()` **一并删除**；两条 e2e 链
（`scripts/e2e-examples.ts` / `scripts/e2e-deploy.ts`）改 `PORT: '0'` + 解析**就绪日志**里的
实际端口（`/\[boot\] listening on :(\d+)/`，30 s deadline），示例侧打 `server.address().port`
—— 与 `e2e-grpc` 早已确立的形态同构（见 `docs/guards.md` §1.3 那条：`PORT=0` 由服务自报端口）。

*为什么「换端口重试」是错的*：它治的是**症状**。根因是「`listen(0)` 探到端口 → `close()`
→ 交给子进程 bind」**两步之间**的窗口；重试只是把撞上窗口的概率压低，还把「启动失败」
这一类**真错误**也裹进重试路径（诊断变糊、可能被掩盖成「多试几次就好」）。让**服务自己
分配端口**（`PORT=0`）是**消除**窗口，不是缩小窗口。⇒ 根因消失后，为它加的重试**一并删掉**：
留着它就是一份「没人知道为什么存在」的补丁。

**原「证明」作废**：那条证明依赖把 `freePort()` 注入成「第一次返回被占用的端口」——
`freePort()` 已不存在，实验**无法复现**。新的证据是 e2e 自身**真跑**（`npm run e2e`，
`verify-all.sh` 第 7 步；本仓既有纪律：测产物就用产物自己的输入）。

**判据**：`grep -rn 'freePort' scripts/` 应为空（仅历史文档可留引用）。

### 2026-09-22 ②：**dev 环补上「驱动 run」** —— 面板四个旋钮 + 脚手架模板破坏性拆分（`app.ts` / `main.ts`）

**背景**：`agentia dev` 此前只能「spawn 时用 argv 定死一次 run，然后看 trace」。于是开发期
真正想做的事一件都做不了：换一句 prompt 要改代码重跑；指定 agent 的工作目录**完全不可能**
（根由工具代码写死）；改文本资产（`system.md` / `asset.md`）**静默无感**；想只调一个子 agent
只能把整份菜单端上去。设计文档 `docs/plans/2026-09-22-dev-debug-loop.md` 把诉求拆成
G1–G5 并逐条实证了缺口（含探针数字），本轮按它的 P0 → P2 全部落码。

**决定一：调试面复用现有 inspector，不新建调试面。**
「面板 / Playground / `report` 的能力排行」三处共用同一份 `@migor/trace-view` 渲染层，
这条既有结论继续成立。新增的只是**输入端**：`POST /run` + 输入条。

**决定二（本轮支点）：**「**调用方**」是 CLI，不是用户工程。**
四个控件（调哪个能力 / prompt / 工作目录 / 多轮）全部落在 `createApp` 与 `app.run` 的选项上
—— 而**谁调用 app 谁就能设它们**。`agentia dev` 自己 import 用户的 `src/app.ts` 并驱动它，
⇒ CLI 就是调用方 ⇒ **用户工程里不需要任何 dev 文件**（只多一个**数据**文件 `dev.config.ts`）。
据此否掉了「往用户工程里写一个 `dev.ts`」的方案：`dev.ts` 是**逻辑**，逻辑副本会漂移
（CLI 修了 bug，各工程里的副本不会跟着修），而 `dev.config.ts` 是**数据**（声明哪个能力
该多轮），数据不会漂移。判据就是这一条 —— 与 D9 否掉「能力收集逻辑抄一份到 CLI」是同一条。

落地形状：
- `src/app.ts`：导出 `createAgentApp({ toolSources?, workdir? })` 工厂 + `CAPABILITY_DIRS`；
  `discover` 的路径按**文件位置**解析（dev 落 `src/`、build 后落 `dist/`），不依赖 cwd。
- `src/main.ts`：薄入口（`loadEnvFile()` → `createAgentApp()` → `app.run`），**不再**直接调 `createApp`。
- `packages/cli/src/dev-runner.ts`：CLI 自己的子进程，import 并驱动用户的 `app.ts`。
  ⚠️ 框架入口必须从**用户工程**解析（`createRequire(join(root,'package.json'))` + `pathToFileURL`），
  不能从 CLI 自己的安装位置解析 —— 装饰器注册表是模块级 `WeakMap`，两份模块实例 = 收集结果静默为空。

**决定三：模板结构变更 = 破坏性变更（按 minor 发）。**
`src/main.ts` 的装配段搬进 `src/app.ts` 是**机械**的，但老工程必须手动改
（不迁移则 `agentia dev` 起不来）。迁移说明进 CHANGELOG。

**决定四：鉴权分两层，零依赖。**
① `Origin` 校验：**缺失 = 放行**（同源导航 / 非浏览器客户端），`Origin: null` = **拒绝**
（沙箱 iframe / `file://` 是明确不可信的一方）；跨源 `fetch` 必带 `Origin` ⇒ 这一层是 CSRF 的那一半。
② **per-session token**：`randomBytes(16).toString('hex')`，**每个端点**都校验。
它的真正作用是挡住**本机其它被攻陷的进程**（它们能 `curl`，不受 `Origin` 约束），
**不是**在补 `Origin` 的洞。携带方式三种：首帧 `?t=` → `Set-Cookie: agentia_dev_token=…;
Path=/; HttpOnly; SameSite=Strict`；preload/脚本走 `x-agentia-token` 头；后续面板请求走 cookie。
比较用 `timingSafeEqual`。

**决定五：watch 收编进 `dev.ts`，「重启」只有一个主人。**
旧实现把「文件变 → 重跑」交给 `tsx watch`，同时面板又能触发重启 —— **两个主人**。
新形态：`tsx` **不带 `watch`** 启动 CLI 自己的 runner，重启路径**只有一条**（`dev.ts` 决定）。
判据是**允许清单**（`WATCH_EXT`）而不是排除清单：`.md` **必须在**里面 —— 文本资产不在 tsx 的
import 图里，旧实现因此对它们**静默无感**（这就是 G3b 的实测结论）。同时按目录排除
`node_modules` / `dist` / `.git` / `.agentia` / `coverage`：`.agentia` 那条不是洁癖，
dev 环自己每轮多轮对话都往 `.agentia/session.json` 写一次，一旦进 watch 范围就是
「每次 run 重启一次子进程」的自噬循环。

**重启与「不重启」的边界（刻意不对称）**：
- 改 `toolSources`（能力选择）⇒ **重启进程**。理由**不是贵** —— 实测进程内重建只要 2.6 ms，
  初稿的「几秒」高估约两个数量级；真正拦住进程内重建的是**回收口**：框架没有
  `AgentApp.close()`，MCP 连接器由用户代码持有 ⇒ 进程内反复重建会攒孤儿 MCP 子进程。
  ⇒ 配套约定（写进模板注释）：**进程外资源一律在模块作用域创建并注入**，
  不许在 provider 构造函数里建。这是把「重建 app」解锁成纯 CPU 动作的前提。
- 改**工作目录** ⇒ **不重启**，进程内重建（毫秒级 vs ~0.67 s 重启）。
- 改 prompt / 多轮 ⇒ 不重启。
- 在飞 run 期间要重启 ⇒ **延后到该 run 结束**，不杀在飞的 run。

**决定六：四个控件的口径。**
- **能力选择（D8）**：多选，默认全选；**全选传 `undefined`**（与「不传即全量」同义，
  且省掉一次白跑的孤儿能力告警）；**空集也传 `undefined`**（`toolSources: []` 会收窄到
  **空菜单**，是纯陷阱值）；顺序按**字典序**而非点击序（可复现）；不认识的名字丢弃。
  ⚠️ 许诺要写准：收窄的是**菜单**，不是「只可能调它」—— 其他能力 `tools` 里的显式引用
  仍能调到被排除的能力（`module.ts` 的孤儿告警讲的就是这条边界）。
- **多轮**：由能力**显式声明**（`src/dev.config.ts` 的 `multiTurn: [...]`，数据不是逻辑）；
  文件缺失 ⇒ 全部单轮且不告警；**格式错误 ⇒ 响亮告警**（不静默当空）。混选时初始值取
  所选能力声明的 **OR**，且面板**标出来源**（`多轮·trip-planner`）——「不静默改变行为」。
- **工作目录**：走**现成 DI `deps`** 注入 `WORKDIR`（`ClassProvider.deps` 本来就有），
  **零框架改动**。代价：per-app 而非 per-run（重启式下等价），且不进 `config.*`。
  `ToolRunContext.workdir` 推迟到会话式落地时再评估。
  ⚠️ `discover` 自动注册的 provider **没有 deps** ⇒ 需要注入的能力必须走显式 `providers`。
- **预算护栏**：面板上「点一下 = 一次真 run」⇒ runner 缺省套
  `{ maxCostUsd: 1, maxTotalTokens: 200_000 }`（用现成机制）。**面板不是无限烧 token 的入口。**

**决定七：对话历史（G4）的「两层」读法。**
- **(乙) prompt 回显**：输入框记住打过的 prompt（`↑`/`↓` 调回）。**永远有**，与多轮无关；
  它解决「手」的问题（任务型 agent 的 prompt 几乎不变，要的是 `↑` 调回 + 回车）。
- **(甲) 对话历史**：面板显示整段多轮对话。**跟多轮开关走** —— 没开多轮时**不出现**
  （一次 run = 一句输入 + 一段输出，那个东西 run 列表已经在显示了；凭空多一个对话视图
  会让人以为上个仓库的评审被带进来了）。
- ⚠️ **join 键**：`runtime/run.ts` 只在**成功**轮次回写 session ⇒ **失败的轮次在会话文件里
  根本不存在**。面板必须用 run 根 span 的 `session.id`（`attributes['session.id']`）
  把 run 列表与会话文件对上，否则显示的是**一份少了一轮的对话**。

**本轮结论：P0–P2 全程零框架改动。** 逐项核对：鉴权在 `inspector.ts`（CLI 内）；
模板拆分在模板；watch / 进程管理 / IPC 在 `dev.ts`；能力收窄用现成 `AppOptions.toolSources`；
工作目录用现成 DI `deps`。⇒ **`src/` 下没有一行改动**（`src/core/limits.ts` 那处注释是同日
另一件事）。动框架的只剩会话式那一步（`ToolRunContext.workdir`）。

**同时修掉的两处旧账**：
- **`--import` preload 消失**：子进程现在跑 CLI 自己的 `dev-runner.js`，不再需要
  `NODE_OPTIONS=--import`（连带它那条 Node ≥ 20.6 / ≥ 18.19 的版本闸与字符串拼接一起删了）。
  代价是**顺序变成承重的**：必须在 import 用户 `app.ts` **之前** `await registerTraceSink()`
  —— `createApp` 在构造时就把 `defaultSinks` 快照下来了。
- **模板 `@SubAgent` 的 `system` 改函数形态**（`() => asset(...)`）：值形态在**类定义时**求值，
  于是 `system.md` 要重启进程才生效 —— 而 `.md` 不在 tsx 的 import 图里，连「该重启了」
  都不会提示（静默失效）。通则：**模块加载期读 = 冻；调用期读 = 热。**

**判据**：`env -u NODE_OPTIONS npm test` + `npm run e2e`（`verify-all.sh` 第 6/7 步）。
新增守卫见 `docs/guards.md` §1.4：面板纯逻辑可单测（`panel-logic.ts` 零 DOM）、
`shouldWatch` 允许清单与目录递归、模板能力名 snake_case 一致性。

### 2026-09-22 ③：**dev 环真跑一次抓出两个缺陷** —— 门禁全绿不等于没洞

上一条的落码在 `verify-all.sh` 8/8 全绿的状态下收尾。但复核时注意到一件刺眼的事：
`rg -ln "agentia dev|dev-runner" scripts/*.ts` **返回空** —— 本轮改动里最大的一块
（`dev.ts` / `dev-runner.ts` / `inspector-page.html`）**一条守卫都没有**；`e2e-cli` 只断言了
生成物 `package.json` 里有 `dev` 这个 script 名。于是写了个真跑探针，一次就抓到两个真缺陷。

**缺陷一：`npx` 吞掉 IPC 通道（静默，且退出的形状像「成功」）。**
子进程原本是 `spawn('npx', ['tsx', runner])`。`npx` 是个**包装器**：它自己再 spawn 一层，
而**不给孙进程转发 fd 3 的 IPC 通道**。后果不是「启动失败」而是**静默**：runner 里
`process.send` 变成 `undefined`，而代码写的是 `process.send?.(msg)`（可选链）—— 所有协议消息
被无声丢弃：面板永远等不到 `ready`、`POST /run` 永远回不来；更坏的是没有 IPC 通道之后
事件循环无事可做，进程以 **`code=0` 干净退出**，看起来像「用户代码自己跑完了」。
三方对照（同一个 hello 脚本，实测）：

| 启动方式 | `typeof process.send` | IPC |
|---|---|---|
| `node whoami.mjs` | `function` | ✅ |
| `npx tsx whoami.mjs` | `undefined` | ❌（还多出 npx 的 spinner 噪音） |
| `node <tsx>/dist/cli.mjs whoami.mjs` | `function` | ✅ |

**修复**：`process.execPath` + 解析出的 `tsx/cli` 入口直起（`resolveTsxCli()`：**用户工程优先**
—— tsx 是脚手架声明的 devDependency，尊重他们的版本 pin；再退到 CLI 自身解析位置）。
不 spawn `node_modules/.bin/tsx` 的理由是 Windows 上它是 `.cmd` shim，会绕回 `npm-bin.ts`
专门要避开的那个 CVE-2024-27980 坑。

**缺陷二：`.env` 加载留在了 `main.ts`（两个入口两个行为）。**
P0 把模板拆成 `app.ts`（装配）+ `main.ts`（启动）时，`loadEnvFile()` 留在了 `main.ts`。
而 dev 环只 import `app.ts`、**从不执行 `main.ts`** ⇒ `npm run dev` 静默读不到 `.env`，
`npm start` 读得到。这是**静默不一致**的教科书形状：用户看到的是「没配 key」，然后去怀疑框架。
修复：`loadEnvFile()` 挪进 `app.ts`（装配模块是**两个入口都经过**的那条路）。
⚠️ 连带教训：当时 `templates.test.mjs` 与 `e2e-cli.ts` **都有一条断言钉着这件事**，但都指着
`main.ts` —— 断言存在 ≠ 断言钉对了位置。所以两处都改成**成对**写（该在 `app.ts` + 不该在 `main.ts`）。

**顺带补的第三个洞：生命周期里没有「就绪」。**
`DevEvent` 有 `runner-restart` / `runner-error` / `run-start` / `run-done`，**唯独没有 ready**；
而面板加载时只查一次 `/api/dev`，那时 runner 还没装配完（`capabilities` 是父进程的初值 `[]`）
⇒ 能力选择器**空着且没有任何解释**，要等用户先跑一次（`run-done` 才触发刷新）。
新增 `{ kind: 'runner-ready' }`，面板收到即重刷；`runner-restart` 也补了一次刷新。
（这条是写 e2e 时被自己的轮询兜底照出来的 —— **测试里的 workaround 往往是产品缺陷的影子**。）

**修复一个措辞级的误导**：`proc.on('exit')` 在「没等到 `ready` 就退出」时先 `fail()`（reject）
再同步走到 `emit`，而那时 `lastError` 还是 `null` ⇒ 面板收到的是更笼统的
「意外退出」，真正有信息量的那句只进了终端（reject 要到下一个微任务才被调用方的 catch 接住）。
改成先写 `lastError` 再 `fail`。

**新增守卫**：`scripts/e2e-dev.ts`（折进 `verify-all.sh` 第 7 步 = `npm run e2e`，
不加步骤 —— 步骤数写在 CI 必需检查的 job 名里）。四条**行为**断言：能力菜单**精确等于**
`["hello","read-file"]`（菜单是 runner 经 IPC 报回来的 ⇒ 非空才等于 IPC 通了）；run 成功且
`finalText` 来自假端点；收窄 `toolSources` 后**假端点收到的请求体真的变窄**；改 `.md` 触发重启
且能恢复。凭据**只写进工程 `.env`**、进程环境里显式 `delete` 掉 `ANTHROPIC_*`（不删的话
本机 export 过 key 的人会拿到假绿）。**三条修复各做了反向验证**：塞回 `npx` ⇒ 红；
摘掉 `loadEnvFile()` ⇒ 红（打到真端点 403）；去掉 `runner-ready` ⇒ 红。

**代价与教训**：这一轮多花的时间全部来自「改动最大的一块没有守卫」。记进 `guards.md` §2 的尾注：
**「门禁全绿」只覆盖门禁问过的形状。**

### 2026-09-22 ④：**拿功能文档逐项对照做审计** —— 又抓出两处「文档里有、代码里没有」

③ 修完缺陷之后问了一个不同的问题：**不是「测试绿不绿」，而是「文档里承诺的每一件，代码里都在不在」**。
逐条对照 `docs/plans/2026-09-22-dev-debug-loop.md` 的 §5 优先级表与 §6 待定清单，
找出两处**只写在文档里、代码里没有**的条目：

1. **§6 待定 5 的后半 —— 显式 kill 按钮。** 文档建议「拒绝并提示 **+ 显式 kill 按钮**」，
   只做了前一半（在飞时 `POST /run` 回 409）。后果不是小事：**一个卡住的 run 会让面板永久锁死**
   —— 此后每次 `POST /run` 都 409，而面板**没有任何办法**把它解开（只能去终端 Ctrl-C 整个 dev 进程）。
2. **§6 待定 3 —— 对话历史的「清空」入口。** 没有它，一份串味的对话只能手工删 `.agentia/session.json`。

两条都没有前置依赖，所以一直没进 §5 的优先级表（那张表按「依赖 / 爆炸半径」排），
也就一直没被发现「其实还没做」。**这是「按优先级表施工」这种工作方式的固有盲区**：
表外的东西不在任何人的清单上。

**① 中止在飞 run（`POST /run/abort`）。** 走 IPC 让 runner 自己 `abort()`，**不是**父进程杀子进程 ——
理由是 **trace**：`RunInvocationOptions.signal` 是 `toolkit/module.ts` 的**契约字段**（原样送进引擎），
中止后在回合边界以 `stopReason='aborted'` **正常返回**（`engine/loop-result.ts` 的 `abortedResult()`）
⇒ trace 照常落盘。杀进程那条路会把这次 run 的 trace 整个丢掉（trace 是收尾才 POST 的）。
**但 signal 是协作式的**：工具不读它就没人理（本仓已知的「MCP 在途中止 ⇒ Promise 永不 settle」正是这一类），
`running` 会永远为 `true` ⇒ 面板永远 409。所以补一条文档里**没写到**的兜底：
`ABORT_GRACE_MS = 5_000` 之后仍没结束就**重启进程**（此时这次 run 的 trace 会丢，面板明说）。
反向验证时把 runner 的 abort 处理去掉，e2e 正好报到 `escalated: true` —— 这条兜底真的在工作。

**② 清空对话（`POST /session/clear`）。** 清空 = **换一个 sessionId**，**不删** `session.json`：
后者是 `SessionStore` 的账，而面板对它是**只读**的（写它会造出「面板显示的对话」与
「模型真正看到的对话」不一致 —— 正是本仓最忌讳的那种静默不一致）。旧对话仍在盘上、
run 列表里那些 run 也还指得到，只是模型不再带着它跑。当前 id 落盘到 `.agentia/dev-session-id`
（**不是** `session.json` 的一部分）：只放内存的话，重启 `npm run dev` 之后刚清空的对话会**自己回来**；
该路径已在 `WATCH_SKIP` 里，所以写它不触发重启。id 由**父进程**决定并经 IPC 下传 ——
它是面板级状态，必须跨 runner 重启（改代码就会重启）稳定。

**③ 同一条事实的第三个影子（本轮真正的收获）。** 实现②的时候发现：中止的 run `ok` 是 **false** ——
引擎的 `abortedResult()` **刻意**给已取消的 run 带上结构化 `error`（取消不是失败，但原因要可查，
`engine/loop-result.ts` 的注释就写着这句），而 runner 的 `ok` 定义是 `!result.error`。
于是「只看 `ok`」这个写法在**三个地方**各自把用户按的中止当成了失败：

| 位置 | 错误表现 | 修法 |
|---|---|---|
| 面板的 `run-done` 反馈语 | 显示「run 失败（aborted）：run 已被取消」 | **先认 `stopReason` 再认 `ok`**，并抽进 `panel-logic.ts`（顺序是**语义**，不是渲染 —— 面板那份没有单测） |
| `dev.ts` 的 `lastError` | 告警条上永远挂一条红字「run 已被取消」，且不会再消 | `if (!msg.ok && msg.stopReason !== 'aborted')` |
| `dev-runner.ts` 的终端日志 | 打成「run 失败（stopReason=aborted）」 | 单独一句「run 已中止（面板点的中止）」 |

（②的说明原先写的「中止是正常返回、`ok` 两者都是 true」是**错的** —— 那是把
「不抛异常」误当成「不设 `error`」。它只活在注释里，正是这一轮对照审计才照出来的。）

**新增 / 扩面的守卫**（都逐条反向验证过，还原后 `git hash-object` 逐字节比对）：

- `packages/cli/test/panel-logic.test.mjs`：`nextSessionId`（轮换 / 认不出的形状兜到 `-2` /
  **base 进正则前转义**）、`runDoneNotice`（判别顺序、`error` 为空要说「未知原因」）。
- `packages/cli/test/inspector.test.mjs`：`POST /run/abort`（503 / 409 / 202 两态 / **`GET` 不落钩子**）、
  `POST /session/clear`（503 / 409 / 200）、**面板 import 名单的反向全覆盖**
  （页面 import 的每个名字都必须是 `panel-logic` 的真导出 —— 浏览器里 import 一个不存在的导出是
  **整块模块求值失败**（白屏），而 node 侧各用例各自 import 自己要用的名字，**照样全绿**）。
- `scripts/e2e-dev.ts` 第 10/11 步：假端点加「**挂住不回复**」开关（否则一次 run 只活几毫秒，
  那个窗口里插不进中止 —— 测到的其实是 409 那条分支，看着绿、什么都没验）；第 11 步断言
  会话写进**新** id 且**没写进**旧 id（这条能挡住「面板换了 id、runner 还写死旧 id」）。

**可复用的自查问**（补进 `guards.md` §2 尾注）：查完「一个值有几种写法」之后，
还要查「**它被几个地方各自判过一次**」。本轮三处错判是同一件事的三个影子，
而任何单点测试都只覆盖其中一个。

### 2026-09-22 ⑤：追一次**瞬时红** → 抓出 `WATCH_SKIP` 的**半实现**；顺带照出一条「假守卫」

**起点是一次没人解释的红。** 上一轮完整门禁里 CLI 套件红过一次，重跑又绿。没有把它当噪声
跳过，而是连跑三次复现、再隔离到 `panel-logic.test.mjs` 的 watch 用例，最后坐实：
`watchTree` 的目录跳过判据（`WATCH_SKIP` / 点开头）此前**只在「初始递归」那一个调用点执行**，
而 watcher 回调里发现新目录时调 `addDir` 走的是**另一条路**，那条路上**一次判据都没有**
⇒ 行为是「启动时就存在的 `dist/` 不看、**启动后才出现**的 `dist/` 看」。
（用临时探针坐实：启动后再 `mkdir dist` 并写 `dist/out.js` ⇒ 回调真的被触发。）

**修法**：判据收进 `addDir` **内部**（唯一一处），初始递归与动态新增两条路共用；
`root` 由调用方**显式豁免**（`isRoot`）—— 判据只看**目录名**、不看路径段，因为项目根本身
就叫 `dist` / `node_modules` / `.foo` 是合法的（用绝对路径段去认 `dist` 会把整个项目判成「不该看」）。

**本轮真正值钱的是验证侧的教训。** 补守卫时我做了两处：单测（构造「启动后才出现」的形状）
+ e2e（重启次数总账 + 理由里不许出现 `.agentia` / `dist/`）。**反向验证时：单测红了，e2e 照样绿。**
逐条排除三种解释 —— ① 修复没生效？不是（`git hash-object` 确认文件是改坏态，单测那条红了）；
② 断言写错？不是（计数与理由两条都对）；③ **缺陷在这里不可达** ← 真相：
`devServer` 的**监视根是 `<projectRoot>/src`**（`dev.ts` 的 `watchTree` 调用点），
而 `.agentia/` 与 `dist/` 都在**项目根**，从来不在范围内 ⇒ 那条 e2e 断言**碰不到** `WATCH_SKIP` 那条路。

⇒ 它真正守的是「**监视根保持 `src/`**」（这本身也值得守：哪天有人把根扩到项目根，
`.agentia/session.json` 立刻变成「每次多轮 run 重启一次子进程」的自噬循环）。
**两件事都要守，但必须说清哪条守哪件** —— 否则下一个人看到「有 e2e 钉着」就以为漏判被覆盖了。
这就是本仓一直在猎的**假守卫**：断言是真的、绿的、也是对的，只是它守的是**另一件事**。

**落地的改动**（三条注释 + 一条用例；**零行为变化**的部分只有注释）：
- `packages/cli/src/dev.ts`：`WATCH_SKIP` 的注释改写成「**第二层**」，把「第一层是**监视根**」
  写进注释（两层都要有，只靠根 = 碰巧打不到）；新增 `shouldDescend()` 并在注释里说明
  「判据必须由 `addDir` 自己执行」的原因；`addDir` 加 `isRoot` 豁免。
- `packages/cli/test/panel-logic.test.mjs`：新增一条用例，`dist/` 与 `.agentia/` **各自一轮**、
  中间等过去抖窗口 —— 因为 `flush` 只报 pending 里的**第一条**，把两件事放一起会被**事件合并**
  掩盖（上一版用例正是这么侥幸通过的，注释里写明了这一点）。
- `scripts/e2e-dev.ts` 第 12 步：断言改成「3 次重启且理由里无 `.agentia` / `dist/`」，
  **并把注释改准** —— 照实写明它抓不到 `WATCH_SKIP` 那条路、它守的是监视根。

**反向验证**：把判据还原成「只在初始递归判」⇒ 单测**恰好红那一条**（其余 15 条绿）；
再把 `isRoot` 豁免去掉 ⇒ 红「项目根自己叫 `dist` 时必须照常监视」（这条是修复**自己的**失败模式）。
两次都 `cp` 还原 + `git hash-object` 逐字节比对。
⚠️ 顺带记进 skill：**`git checkout -- <file>` 对未跟踪的新文件静默无效**（`panel-logic.ts` 是 `??`），
还原一律用 `cp` + 哈希比对 —— `git diff --stat` 对未跟踪文件恒为空，不能当证据。

**可复用的自查问**（补进 `guards.md` §2 尾注 ⑤）：写完一条守卫，问「**它在什么形状下才可能红**」；
若答案里含一个当前架构下不可达的前提，它就不是这条修复的守卫 —— 要么换个能红的形状，
要么**改名**（说清它守的那件事）并注明它不守什么。

### 2026-09-22 ⑥：**`.env` 是一条「够不着」的判据** —— 改 `.env` 静默不重启

⑤ 把「监视根是 `src/`」这条事实写进注释之后，顺手拿它去核**每一条**判据，立刻照出第二条：

`WATCH_NAMES = {'.env', '.env.local'}` 把这两份文件列进**允许清单**（`shouldWatch` 按文件名命中），
`usage-guide` 的「看什么」也把 `.env` 写进去 —— 但 `watchTree` 的根是 `<projectRoot>/src`，
而 `.env` 在**项目根** ⇒ 这条判据**没有任何一个 watch 够得着**。改 `.env` 静默无感，
与 G3b 完全同类（文档承诺了、代码够不着）。`dev.ts` 顶部那张结构图当时写的还是
`fs.watch(src/**, **.md)` —— 连图里都没有 `.env` 的位置。

**真跑坐实**：`scripts/e2e-dev.ts` 新增第 9-bis 步，真改一次**项目根**的 `.env`。
摘掉修复后帧转储里**一条事件都没有**（`等第 4 条 dev/runner-restart 超时（只收到 3 条）`）。

**修法**：单开一个 `watchRootEnvFiles(projectRoot, onFile)` —— **不递归**、且**只认名字**
（不认扩展名：项目根的 `package.json` 也不该由它管）。**不能**把 `watchTree` 的根抬到项目根：
那会把 `README.md` / `docs/` / `examples/` 全收进来，「改代码要重启」就变成「改任何文档也重启」。
两处 watch 共用一个抽出来的 `makeNotifier()` 去抖器（各写一份会漂 —— 比如只有一处清理 `timer`，
停机后仍会回调一次）。`onFileChange` 也抽成一处，重启理由的文案因此只有一种写法。

**两条可复用的教训**：

1. **「一条判据要问它有没有执行者」。** ⑤ 查的是「判据有没有在**每条路**上执行」，
   ⑥ 查的是「判据有没有**任何人**执行」—— 后者更隐蔽：`shouldWatch` 有单测、写得也对，
   但**没有任何调用点够得着**那两种情况。⇒ 判据的**正确性**（`shouldWatch` 本身）与判据的
   **可达性**（调用点的根）是两件事，各要各的守卫：前者单测，后者**只能真跑**。
2. **⚠️ 探针自身会假红 —— 断言别用写死的序号。** 第一版探针写的是
   `waitDev('runner-restart', …, 2)`（等第 3 帧）。但在这之前 `ack2` 那次 run 已经产生过一条
   `runner-restart`（回到全量菜单），于是它**立刻拿到那条旧帧** ⇒ 报错文案
   「理由里没有 `.env`」与「`.env` 根本没触发」长得一模一样，差点据此下错结论。
   改成**「先数当前帧数 N，再等第 N+1 帧」**才分辨得开。
   ⇒ 一般规则：**断言「某事件发生了」时，绝不能用与「事件总数」耦合的绝对序号** ——
   先取基线、再等增量。

### 2026-09-22 ⑦：**复核轮修复** —— 窄窗口竞态 / 收尾路径 / 两个表面口径不一致 / 登记漂移，
外加一次「假门禁」的自我纠正

⑥ 收口后 `docs/plans/2026-09-22-dev-debug-loop.md` 的需求已全部实现。这一轮**不动设计**，
是拿复核结论逐条回读代码后的边界修复。四条值得留痕：

1. **并发闸必须覆盖「受理 → 真正发出去」之间的那次 await。** `submitRun` 里换能力选择要
   `await restart(...)`（停旧进程 + spawn + 装配，几百毫秒起），而 `running` 只能等到 run **真的
   发进通道之后**才置位（它是「runner 里有个 run 在飞」的口径 —— 面板的按钮与 `abortRun` 都读它）
   ⇒ 只看 `running` 的闸在这条路径上会**放两个请求进来**：两个 `runOnce` 并发、`currentAbort`
   被覆盖、`pendingNote` 挂到别人的 traceId 上。修法是加一个**只给闸看**的 `launching` 占位。
   刻意**不**并进 `running`：那会让面板在还没 run 时就把「中止」按钮点亮，而 `abortRun` 此刻
   只能回 409 —— 一个自相矛盾的面板。
   ⇒ 一般规则：**「忙」有两种含义 ——「资源在飞」与「请求已受理」，它们的时间窗不同，
   别用一个布尔把两者盖住。**
2. **收尾必须等宽限期走完再 `exit`。** `stopChild()` SIGTERM 之后要等 `KILL_GRACE_MS`（3 s）
   才补 SIGKILL，而旧的 SIGINT 处理器是 `shutdown(); setTimeout(() => process.exit(0), 50)`：
   父进程在宽限期内就没了 ⇒ 那个计时器随它消失（SIGKILL 兜底一起丢），`process.on('exit')` 那条
   兜底此刻也已空转（`stopChild` 第一行就把 `child` 置成 null，而归属判定是 `child?.child === proc`）
   ⇒ 一个不响应 SIGTERM 的 runner（连同它自己 spawn 的 MCP 子进程）活成孤儿。
   注意 **SIGTERM 那条路径本来是好的** —— **同一个动作的两条出口口径不一致**本身就是缺陷信号。
3. **「中止」落在装配窗口里也必须生效。** `runOnce` 的顺序是 `send('run-start')` →
   `await ensureApp(...)` → 才 `new AbortController()`；窗口内到达的 `run-abort` 只能看到
   `currentAbort === null`，把它当「没在跑」静默丢掉的话 run 照跑，而父进程 5 s 后会把这次
   **健康的** run 升级成重启兜底（trace 丢掉 + `lastError` 写成「工具不响应 signal」——
   一个错误的归因）。窗口宽度取决于工程的装配开销（有 MCP 握手时是几百毫秒），
   **不能靠「窗口很窄」免修**。修法：窗口内到达的中止记在 `abortRequested` 上，建完 controller 立刻补。
4. **同一个事实的多个表面必须共用一条判别。** 「这一轮失败了吗」在面板上有三个表面
   （通知条 / run 列表红点 / 对话视图红边），而引擎的 `abortedResult()` 刻意给已取消的 run 带
   结构化 error ⇒ 中止时 `ok === false`：只修通知条那一处（先 `stopReason` 后 `ok`）等于让另外两处
   继续把「我按了中止」显示成「这一轮失败了」。⇒ 判别抽进 `panel-logic.runIsFailure`（先 stopReason
   后 ok），并在测试里钉「页面不许裸读 `r.ok`」。同时**中止轮不能从对话视图里消失**：
   框架只在成功路径回写会话 ⇒ 排除它等于显示一份**少了一轮**的对话（另一种静默不一致）。

**⚠️ 本轮的教训：我写的第一个新门禁是「假绿」，而它差点就这么进了库。** 为验第 1 条，我加了
「换能力选择后立刻再发一次 `POST /run`，必须 409」。它全绿 —— 直到**摘掉修复再跑一遍**才发现
摘掉后照样全绿：`await api('/run')` 要等 restart 走完才拿到 202，所以第二个请求是**在窗口之后**
发出去的，压根没进窗口。改成「先不等回包，等 `runner-restart` 广播帧（`restart()` 的第一行就 emit）
再发第二个请求」才真的落在窗口里。
⇒ 一般规则（⑤ 那条的升级版）：**新增门禁必须做一次「把修复摘掉、看它红不红」的反向验证。**
假绿比没有门禁更坏 —— 它把「没人验」伪装成「验过了」。本轮三条关键修复全部做了反向验证
（①摘掉后真红、②③同样真红），并顺手抓出两条复核没提的缺陷：裸 CLI `agentia dev -- "问题"`
会把分隔符 `--` 当成 prompt 传给模型（`npm run dev -- "问题"` 那条因为 npm 吃掉 `--` 而一直是对的）、
`read-file` 未归一化工作目录（带尾斜杠时**每一次**调用都误报「路径越出工作目录」——
不是误报，是工具整个变坏）。两条都补了真跑用例。

### 2026-09-22 ⑧：**dev 面板的三处体验修复** —— 右栏实时长树 / 回复被自己擦掉 / 选择器不可用

⑦ 之后拿**刚发布的 0.9.0** 起了真面板（真浏览器、真点、真发 run）逐项走查，三处现象：

1. **右栏在整轮 run 里是死的。** `playTrace` 此前唯一的调用点在 `open()`，而 `open()` 跑在 run
   **收尾之后**（trace 经 `POST /ingest` 回到面板才触发）⇒ 一次十几秒的 run 期间只在右栏看到一句
   「正在跑…」。框架的**增量出口**（`RunInvocationOptions.onTraceEvent`，0.8.3 落地）本来就是为这类
   消费者准备的，计划 §D7 的评审补充也点名要求接上（P1b），落地时漏了。修法是一条**原样转发**链：
   runner 订阅 `onTraceEvent` → 逐笔 `POST /ingest-event`（sink 自己排 **FIFO 链**：并行 fetch 会走不同
   连接，面板就可能**先收到 `span.end` 再收到 `span.begin`**，折回时那条 end 因「未知 spanId」被丢，
   树上少一个节点）→ 父进程**不做任何解释**地广播 → 面板按 `seq` 折回（`panel-logic.applyTraceEvent`）
   → rAF 合帧重画。为什么不折好再发：框架钉着一条不变量（`tests/engine/trace-events.test.ts`）——
   按 `seq` 升序把全部事件应用到 `span.begin` 建出的 span 上，结果**逐字等于**收尾的 `snapshot()`；
   照它折回就得到与收尾一致的树，父进程插一手只会多一处会漂的口径。两条纪律与框架同名出口一致：
   **不保证送达**（所以折出来的是**临时**的树，收尾那份到达时**覆盖**它并让在飞那份作废）、
   **是观察不是控制**。顺带一个语义修正：`playTrace` 对**根 span 没有 `endedAt`** 的树不再收尾 ——
   否则在飞期间根会被标成「已完成」，是个假事实。
2. **刚跑完的回复在 17 ms 后被面板自己擦掉。** `run-done` 把回复正文写上去之后，面板会**自动
   `open()` 刚跑完那一轮**（让右栏显示这轮的 trace），而 `open()` 无条件清回复区 —— 现象是「跑完了
   但没回复」。修法：把归属判定抽成 `panel-logic.replyBelongsTo(openId, replyFor)`，只有「现在打开的
   就是这条回复的主人」才保留。**不能**改成「open 一律不清」：打开一条历史 run 时若还挂着别人的回复，
   那是张冠李戴（比空白更糟）。
3. **文件夹选择器三处不好用 + 不能选文件。** ① 只列目录 ⇒ 「让 agent 看某个文件」只能靠用户把名字
   打进 prompt；② `浏览…` 是个**开关** ⇒「在输入框敲了目标路径 → 点浏览…」这个最自然的动作反而把
   面板关掉（于是以为「选不了别的目录」）；③ 隐藏目录被整批过滤 ⇒ `.git` / `.y` 这类目录**根本点不
   进去**（`..` 只能退到它上面）。修法：`/api/fs` 回 `{ path, parent, dirs, dotDirs, files, filesTruncated }`
   三组（隐藏目录单列、文件有上限且**截断明示**），点文件名 ⇒ 工作目录取它**所在的**目录、prompt
   **只在为空时**填文件名（`panel-logic.promptAfterFilePick` —— 悄悄改用户写好的输入比少填一次糟得多），
   `浏览…` 改为**总是**按输入框的值打开（`browseTarget`），点面板外面收起。

**同轮做的一件事**：`dev` 环的 e2e（`scripts/e2e-dev.ts`）加第 **7-bis** 步——真进程 + 真 HTTP + 真
SSE 下断言「在飞期间真收到增量帧」「增量帧**先于** `run-done` 到达」，并用 **CLI 自己的
`dist/panel-logic.js`** 把收到的帧折回来与 `/api/runs/:id` 的整棵 trace 做 `isDeepStrictEqual`
（不是在这里重写一遍折回规则——那样就成了「我自己和自己一致」）。⚠️ 这条要**等链路静默**再比：
收尾的整棵 trace 走 `flushSinks`（被 await），而逐笔事件走 fire-and-forget 的链，最后几笔可能还在路
上 —— 「晚到可以，最终必须一致」，所以轮询到一致为止（5 s 超时）。

⚠️ 本轮最贵的一课，写在这里当规矩：**反向验证脚本必须先 commit 再跑。** 脚本的每个变异都要在测完
之后还原源码，而还原用的是 `git checkout -- <路径>` —— 在**未提交**的工作树上，它还原的不是「变异前
的状态」而是 **HEAD** ⇒ 一步就把整份未提交的改动擦掉（本轮真发生了：`dev-runner.ts` 与
`panel-logic.ts` 两个文件的改动被擦，第三个文件上还留着变异体 `if (true) {`）。判别办法是**信测试
不信撤销**：门禁红了先看红在哪 —— 当时那条「✓ 变红」其实红在 `inspector.test.mjs` 的
「页面 import 的每个名字都真的导出」上（因为被擦文件里的导出没了），是个**假红**。
⇒ 规矩两条：**① 反向验证前先 commit（哪怕只是个本地提交）；② 反向验证的判据要能区分「红在我变异
的那条」与「红在别的地方」。**

### 2026-09-22 ⑨：**面板的三处可读性修复** —— 正文 Markdown / 滚动分层 / 长消息折叠

⑧ 之后拿真面板走查（真浏览器、真跑、真点），三处现象：

1. **模型正文是纯文本**（`#reply` 是一整块 `<pre>`，对话视图的助手轮一样）⇒ 长回复里的列表与
   代码块糊成一坨。修法：写一个**自己的**最小 Markdown 解析器（`packages/cli/src/markdown.ts`，
   纯逻辑、零依赖、带单测）。为什么不引 `marked` + `DOMPurify`：本 CLI 的**零运行时依赖**是硬承诺
   （`package.json` 里没有 `dependencies`），而两份第三方产物**没法被本仓单测验证**；这套子集不到
   200 行、每条规则都能配用例。**安全前提是「按构造不产生 HTML」**：解析器只产出 token 树
   （token 类型白名单里没有「HTML 透传」这一类），渲染层只准用 `createElement` / `textContent`
   —— 模型输出里的 `<script>` / `<img onerror>` 只会是字面文本。链接协议过白名单
   （`http` / `https` / `mailto`）；不合法**整条降级成字面文本**（连 `[]()` 一起显示，使用者看得出
   「这里有个链接我没渲染」）。用户轮保持字面 —— 那是「我打的字」。
2. **右栏一长就是整页滚**：`section` 只有 `min-height`、没有上限，而 `footer` 粘在底部 ⇒
   内容一长，「看树」与「读回复」互相把对方推走，而且三个滚动条（页面 / 树 / 展开的行）叠在一起。
   修法：应用外壳（`html/body` 100vh + `body` 不滚），左栏列表自己滚，右栏**只有 `#trace` 是滚动
   区**（它是唯一无界增长的部分），回复 / 排行 / 用量固定在下方并各自有上限；窄屏回落成单列。
3. **长消息没有明确的展开入口**：`#reply` 与聊天里的长回复只能一路读下去（trace-view 那边事件行
   有 caret，但它在**行最右端**、10px，还叠着行内滚动 —— 那是 nowrap 表格状布局的合理形态，
   正文块不是）。修法：`collapseDecision`（纯逻辑、按**行数 + 字符数**，**不量像素** —— 像素阈值在
   字体 / 缩放 / 窄屏下会漂，同一个回复在不同机器上折叠与否都不一样）判定；长正文卡 216px +
   底部渐隐，展开控件放在正文**下方、左对齐**（「展开全文（共 N 行）▾」/「收起 ▴」），
   短正文**不挂控件**。展开态活在渲染之外（面板每次全量重画，状态留在 DOM 里会被下次重画合上）。

**同轮把守卫升了一级**（都做了反向验证）：`markdown.test.mjs` 8 条（含两条安全断言与 1 万行围栏的
防回溯判据）；`inspector.test.mjs` 的「页面 import 名单反向全覆盖」从「只查 `panel-logic.js`」扩到
**所有自建模块**，并加四条页面级不变量（全页 `innerHTML` **赋值**只准一处且必须是 `renderSummary` /
`body` 必须不滚 / `#trace` 必须是滚动区 / 窄屏必须有回退）。

⚠️ 两条踩坑记录，都值得留：**① 变异体必须能编译** —— 「让解析器产出一个非白名单 token 类型」的
变异我第一版直接写 `type: 'html'`，tsc 报「不在联合里」⇒ 构建失败、门禁**根本没跑到**（空跑一次），
改用 `as unknown as 'text'` 双重断言后才真的在运行期产出非法类型。**② 对被格式化过的文件做 `patch`
时用了格式化前的 `old_string`** —— 模糊匹配插到了错位置（一份测试文件里被插出重复的 `it(...)`），
靠「改完立刻回读那一段」才发现。⇒ 教训：**改完紧接着回读**，别只信 patch 的成功返回。

## 11. 开放项

- npm 包拆分（core / runtime / transport）仍待做；CLI 已独立成包（workspaces），框架本体仍单包。
  **宿主 / 集成接入不拆包**（gRPC / Kafka 这类只给配方 + 示例，判别规则与升级触发条件见 §10 2026-09-18 ⑪）。
  ⇒ 发布进度：v0.2.2（2026-09-14，框架包 + CLI 包，scope 为 `@migor/*`）→ v0.3.0（`.env` 一等入口）
  → v0.4.0（trace 事件正文可展开）→ v0.4.1（深度审查修复轮，无新公开 API）
  → v0.4.2（发布后更正：Redis 的 TTL 在 node-redis 上静默失效）
  → v0.5.0（R7 质量闭环：`Score`/`attachScore`、gen_ai.* 对齐、trace 回流 eval、prompt·session 上 trace）
  → v0.6.0（trace diff / 分叉重放 / canCall 能力级路径 / 默认 client 自研化 + 公共类型自有化
  （零运行时依赖）/ examples/code-review 真实案例；**含破坏性变更，迁移指南见 CHANGELOG**）
  → v0.6.1（超时归一类账：`span.error.type` 的 `connection` → `timeout`，**重试行为不变**；
  MCP 超时单源化；对外文档面清理）；
  → v0.6.2（第六轮全量 review 收口：16 条「静默失效」修复 + `beforeFlush` 时序缝
  （eval 分数进指标）+ metrics 三维度基数封顶 + traceparent 入站关联；**无破坏性变更**，
  两处语义变更见 CHANGELOG）；
  → v0.6.3（守卫注册表 + 三个新架构守卫 + 适配器对拍矩阵；`exactOptionalPropertyTypes`
  迁移完成；OpenAI 适配器补客户端内层重试与 anthropic 对称；**无破坏性变更**）；
  → v0.7.0（**MCP 连接器出厂自带**（stdio / StreamableHTTP，只用标准库、不新增第三方依赖）
  + 第七轮复审收口 + StreamableHTTP 会话过期**自愈** + `close()` **保证子进程已终止**
  + 官网手写数字守卫；**无破坏性变更**）；
  → v0.7.1（**HITL 人工审批**（挂起/恢复、跨进程耐久）+ gRPC 宿主配方与可跑示例
  + 连续四轮复审收口：11 条「不报错地不干活」（超时不清簿记 / 重试不排空 / 非流式回落零校验 /
  回调通道缺失 / 幂等键赢家跨重启易主）+ 预算护栏走廉价 usage + 异步会话正式通道
  （`RunInvocationOptions.sessionId` + `AsyncRunner.sessionStore`）+ 测试基建不再被 `&&` 静默
  跳过；**类型面破坏性变更**：`RecorderBackend` 加必填 `usage()`、`BudgetGuard.check` 入参收窄
  —— 运行时行为不变，迁移见 CHANGELOG）；
  → v0.7.2（**第九轮评审收口**：HITL × `sessionStore` 组合破口（恢复段历史翻倍 / 成功后毒化
  会话）+ 六条静默失效修复（惰性审批超时无重入闸 / StreamableHTTP 丢 `abandoned` /
  Anthropic 流内 4xx 落 500 / `runTimeoutMs` 落 `unknown` / `FileTaskStore.save` 先写内存 /
  SSE 稀疏数组）+ `metrics.ts` 与 `mcp.ts` 纯结构拆分 + stdio `pending` 回归补课；
  **无破坏性变更**）；
  → v0.8.0（**CLI 机器可读面**（`--version` / `report·diff·doctor --json`）+ **脚手架
  discover 生产路径修复**（≤0.7.2 生成的工程 `npm start` 必崩，缺陷在产出物里，老工程需
  按新模板改 `src/main.ts`）+ 脚手架 pin 住 CLI 进 devDependencies；纯结构拆分 13 件 +
  零告警闸门 + 覆盖率棘轮门禁；**框架 API 无破坏性变更**）；
  → v0.8.1（**出站链路传播**：新增 `currentTraceparent()`，跨服务关联补上出站方向；
  id 投影上移 `core/trace.ts` 成单一真源（取值不变）；**无破坏性变更**）；
  → v0.8.2（**外部双模型复核逐条复现收口**：OTLP enum 整数化（`v0.2.2` 起 `status.code` 一
  直发的是 enum 名字符串，严格 collector 整批拒收 —— 观测全丢却报正常）/ HTTP 200 +
  `partialSuccess` 按导出失败处理 / 新增 `createOtlpExporter({ onExportError })` /
  `metricsSink.reset()` 前移 CUMULATIVE 窗口起点 / `maxRetries` 坏值构造期抛错（NaN 与
  Infinity 此前等于**无限重试**）/ 已中止的 MCP 调用不再发请求、不再永不 settle /
  异步 store 下同键并发提交不再重复执行（跨进程仍 at-least-once）/ 脚手架模板漏写 `clean.mjs`
  在发布前拦下；**框架 API 无破坏性变更**，唯一动作是 `maxRetries` 传过坏值的要改成非负整数）；
  → v0.8.3（**增量 trace 出口落地** —— 记账与交付之间补上那条缺失的缝：`onTraceEvent`
  （运行期逐笔拿记账事件，应用级与单次**叠加**）+ `GET /tasks/:id/stream`（异步任务进度流：
  重放 → 实时 → 终态 `task.end` 收口；旁观者语义，背压不 abort 任务）+ `/run` SSE 新增一族
  `trace.event` 帧（既有三帧逐字不变）+ `traceLimits.maxEvents`（数量闸 + `trace.truncated`
  丢弃计数）；spec §7 F3 的两条后置项与 §9.4 的记录成本同日收口，**采样仍不内建**（既有决策，
  改为「可算（采样率换算表）+ 可数（丢弃计数）」）；`formatTraceparent` 的 flags 继续恒 `00`，
  但理由更正为「运行期不可知」；guards §2 四条待守形状清到只剩一条（`0` 的语义真源 / 穷尽转发 /
  队列配方门禁三件建成机器守卫）；
  **框架 API 无破坏性变更**，宿主自解析 `/run` SSE 的老客户端不认识新帧即忽略、行为逐字一致）；
  → v0.9.0（dev 调试环落地：常驻 runner + inspector 面板驱动 `src/app.ts`，四个控件全在面板上；含**破坏性变更**，但只在脚手架模板形态（装配/启动拆分，迁移见 CHANGELOG）—— 框架公共 API 逐字未变）；
  → v0.9.1（dev 调试环三处体验修复：面板右栏在 run **在飞期间**就长出调用树（增量记账帧经
  `/ingest-event` 原样转发 + 面板按 `seq` 折回，收尾那份整棵 trace 覆盖它）/ 刚跑完的回复不再被
  自动 `open()` 擦掉（端到端实测 17 ms）/ 工作目录选择器能选文件、隐藏目录可达、`浏览…` 不再是
  开关；**无破坏性变更**，框架公共 API 逐字未变）；
  `AGENTIA_VERSION = '0.9.1'`。决策均见 §10。
- DI 的 property-injection 便利写法（标准装饰器下可行）待定。
- 模型缺省 `claude-opus-5`（`AGENTIA_MODEL` env 可覆盖）；两个内置客户端（Anthropic / OpenAI 兼容）默认走流式。
- CLI 剩余：注册表与扫描混用时的冲突提示策略（`dev` 已落地并内建 inspector 面板；`add` 已落地，见 §10 R5）。
