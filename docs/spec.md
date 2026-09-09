# Agentia —— 规格（v0.1 草案）

状态：讨论收敛后的书面化。锁定的决策在此，后续实现照此推进；契约先行。

## 1. 定位（一句话）

面向应用开发者的**声明式 agent 服务开发框架**：TS 装饰器 + DI + 模块；主 agent 作为路由器调度 tool/skill/subagent/prompt；**最终形态是流水线（pipeline）服务而非对话助手**；运行时自研、参考 Claude 设计，底层调用 Messages API。

> 不是“agent 聊天 SDK”，是“把 agent 跑成服务的框架”。文本只是副产品，agent 执行出的活 + 结构化产物才是产品。

## 2. 运行模型：run（一次运行）

对话助手的“会话=聊天”直觉作废。模型是：

```
触发(请求/事件/定时) → 主 agent 作为路由器编排阶段 → typed 结果 + 产物/副作用 出
```

- **run** = 一次任务实例。入参 = 任务 spec；出参 = 结构化结果。
- **run scope 上下文**：在单次运行内累积（blackboard），结束即释放。跨运行记忆是次级问题。
- **主 agent = 路由器**：不确定阶段顺序，而是自主决定调用哪些单元、什么顺序。
- 单元（tool/skill/subagent/prompt）= 流水线的**阶段**。

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

  @Prompt('brand-style')
  static brand = '扁平 + 水彩，禁用霓虹色…';
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

启动/编译期检查：`canCall` 引用存在、单元 name 无重复、`@Tool` 有合法 schema、能力边静态环检测、孤儿单元告警。运行时抢不过 LangGraph，静态声明 + 校验是 NestJS 路线独有的武器。

## 8. Build order

| 里程碑 | 内容 | 对应框架件 |
|---|---|---|
| Turn 0 | manual loop + 流式，单主 agent 调工具跑通 | 引擎内核 |
| Turn 1 | run 生命周期 + 系统提示拼装 + cache 布局 | 容器 / run scope |
| Turn 2 | 装饰器 → JSON Schema → tool_result 往返 + strict | `@Tool` 容器 |
| Turn 3 | 子 agent 作为 tool（裁剪上下文 + 隔离报告） | `@SubAgent` |
| Turn 4 | compaction / context editing / task budget | 长上下文策略 |
| Turn 5 | 触发传输（同步 RPC / 异步任务 / 定时）+ run 恢复 | transport 层 |

Trace 自 Turn 0 起内建（每个 LLM 往返都记账），Turn 1 后是完整形态。

## 9. Trace（调用树）—— 一等公民

流水线服务靠**事后**调试，trace 是调试表面 + 审计记录（对话助手能现场看，trace 对流水线是必需品）。

### 9.1 模型（对齐 OpenTelemetry 命名，便于接基础设施）

- 一次 run == 一条 trace；v1 里 `traceId == runId`，1:1。
- 树形层级：
  - `run`（根 span）= 整次运行
  - `unit` span = 每次对单元（tool/skill/prompt/subagent）的调用
  - `llm.turn` span = unit 内部每次模型往返，挂 usage（model / input / output / cache_read）
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

### 9.4 开放问题

- 全量记录成本 vs 截断/采样默认阈值。
- trace 是否作“重放基底”（把完成的 trace 喂回模型做调试）—— 未来，不进 v1。

## 10. 决策记录

- 2026-09-10：TypeScript 用 7.x（native tsgo，npm latest 实测 7.0.2）。
- 2026-09-10：**装饰器走标准（Stage 3）+ 显式 DI（providers/useFactory）**，弃用 `experimentalDecorators`/`emitDecoratorMetadata`/`reflect-metadata` —— 原生编译器已在考虑移除 legacy 元数据发射，新框架不该押其上。
- 2026-09-10：**trace（调用树）为一等公民**，与 run 1:1，自 Turn 0 内建。

## 11. 开放项

- npm 包拆分（core / runtime / transport）在发布阶段做，先单包。
- DI 的 property-injection 便利写法（标准装饰器下可行）待定。
- 模型默认 `claude-opus-5`，thinking 用 adaptive，流式优先。
