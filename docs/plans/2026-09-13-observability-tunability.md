# 可观测 · 可调优 —— 设计文档

> **状态**：**待评审**（8 个设计分叉待拍板，见 §6）。落地后决策记录进 `spec.md §10`，状态进 `roadmap.md`。
> **日期**：2026-09-13
> **前置**：本文是**设计**，不是逐步实现计划。分期任务计划落地时另起 `docs/plans/2026-09-13-observability-tunability-*.md`。
> **缘起**：框架定位是「要长期使用、要能被观测、要能被调优的 agent 框架」。当前观测只到 **run 级**（看不到「哪个单元慢/贵/爱失败」），调优旋钮虽齐但**有两处"看着有、实际不生效"**（成本护栏会静默失效）。这块不做透，框架相对"自己拼 SDK"的优势就不成立。

**Goal**：把观测从「**整条 run 的汇总**」下沉到「**单元 / 模型 / 工具维度**」，把调优从「**一堆散落选项**」变成「**有依据、能验证、不会静默失效的闭环**」。

**Architecture**：**不新增层**，全部在既有落点上收口：

- 观测派生（指标 / OTLP metrics / 聚合报告）落 `integrations`（只依赖 `core`）与 `eval` 同款的**叶子消费模块**；
- 让"工具耗时"可测的**唯一**结构改动在 `engine/loop.ts` 的事件面（补时序），不改 span 结构；
- 成本表与未定价处理落 `engine/usage.ts`（配置从选项进，`engine/types.ts` 加字段）；
- 配置快照落 `runtime/run.ts`（写 run 根 attributes）；
- `/metrics` 路由落 `transport/http.ts`（只给缝，不给策略）。

**边界条件（沿用仓库硬约束，所有设计必须满足）**：

1. **零新增运行时依赖** —— OTLP metrics 手写 JSON（见 F4），不引 `@opentelemetry/*`。
2. **框架不读 env** —— 价格表 / 标签策略 / 挂钩一律走选项。
3. **分层单向** —— 相对 import 带 `.js`；`integrations` 只依赖 `core`；`core` 不动。
4. **改语义必须记 `spec.md §10`**；方向性工作更新 `roadmap.md`。
5. **新行为必须带测试**（`node:test`），并纳入 `npm test` 全链；**每块能力带 e2e 或可执行证明**。
6. **观测失败被吞** —— 指标/报告/sink 抛错绝不影响 run（沿用既有原则）。
7. **不重复计数** —— 单元级 `usage` 是**子孙聚合**（`core/trace.ts` 已定语义），任何新指标都必须守住「`totalUsage` 只累加 `llm.turn`」这条口径。

**非目标（YAGNI，明确不做）**：跨 run 的账单/多维分析平台、告警与 SLO 系统、可视化 dashboard UI、TraceQL/Grafana 模板、OpenTelemetry SDK 依赖、采样（sampling）策略、向量检索记忆。理由见 §7。

---

## 1. 缺口 → 现状证据

| # | 缺口 | 证据（代码事实） | 性质 |
|---|---|---|---|
| 1 | **普通工具测不到耗时** | `core/trace.ts`：span 只有 `run`/`unit`/`llm.turn`；`unit` span **只由 skill/subagent 建**。普通工具只在 turn 上记 `tool.input`/`tool.output` 事件（`loop.ts:339,403`），**事件里没有时序** → 占多数的普通工具，耗时/错误率**从 trace 里拿不到** | 观测盲区（最大） |
| 2 | **指标只到 run 级** | `integrations/metrics.ts` 的 label 只有 `{kind=…}`（token 分项）与 `{quantile=…}`；**没有 `unit` / `model` 维度** → 答不出「哪个工具慢/贵/失败多」 | 观测盲区 |
| 3 | **分位不可聚合** | `metrics.ts`：分位是**进程内滑动窗口精确值**（`windowSize`，缺省 1024），非 Prometheus 原生 histogram → 多实例无法相加、无法跨实例算全局分位 | 生产可用性 |
| 4 | **OTLP metrics 未实现** | `metrics.ts`：`export:'otlp'` **构造期抛错**（"后置，见 roadmap D3"）→ 进不了 OTel 采集链路，只能被拉 `/metrics` | 生态缺口 |
| 5 | **`/metrics` 没接线** | `transport/http.ts` 全仓 grep 无 `metrics` 命中 → `createHttpHandler` 不提供指标路由，用户得自己在外面接 | 易用性 |
| 6 | **成本护栏会静默失效** | `engine/usage.ts`：`PRICING` 只硬编码 **6 个模型**；未知模型 `costEstimate` 返回 `undefined` → `Trace.totalUsage.costEstimate` 恒 undefined → **`maxCostUsd` 永不触发**，且**无任何提示**（`budget.ts` 注释已如实标注，但"如实标注"不等于能用） | 调优硬伤 |
| 7 | **价格表不可注入** | `usage.ts`：`PRICING` 是模块内常量，无任何覆盖入口 → 走非 Anthropic 端点（DeepSeek / OpenAI / 自建）的用户**永远算不出成本** | 调优硬伤 |
| 8 | **成本无归因** | 成本只落在 `llm.turn` span 的 `usage.costEstimate`（`loop.ts:245`）；**没有按模型 / 按单元聚合的出口** → 答不出「钱花在哪个模型 / 哪个子 agent 上」 | 观测盲区 |
| 9 | **无调优依据产物** | 没有任何「per-unit 耗时/成本/错误率排行」的函数或命令；`trace-view` 只渲染调用树，不做汇总 | 闭环缺失 |
| 10 | **不知道一条 run 用了哪套旋钮** | policy/guard/retry/trimming 的参数**不落 trace** → 事后无法回答「这条 run 的 `keepToolPairs` 是几、`maxCostUsd` 设了没」 | 可调试性 |

> 已记档的**边界**（本设计**不**当新缺口重复处理）：`metricsSink` 分位是窗口内精确值（#3 正是要**补**掉）、OTLP metrics 后置（#4 推翻）、价格表覆盖不足（#6/#7 推翻）、MCP 只做 tools、HITL 只到同步闸门、无代码沙箱、`canCall` 只有 provider 粒度、记忆只两钩子 —— 后四条**本设计不碰**。

---

## 2. 分期总览

顺序原则：**先把"看不见"变成"看得见"（E），再把"旋钮失灵"修成"旋钮可靠"（F），最后给"怎么调"的依据（G）**。E 是 F/G 的数据前提（没有单元维度，归因与报告都无从谈起）。

| 期 | 主题 | 条目 | 依赖 |
|---|---|---|---|
| **E** | 观测下沉 | E1 工具时序、E2 单元级指标、E3 模型维度指标、E4 histogram、E5 OTLP metrics | E1 → E2（工具指标依赖 E1 的时序） |
| **F** | 成本可调优 | F1 价格可注入、F2 未定价显式、F3 成本归因 | F1 → F2；F3 依赖 E3 |
| **G** | 调优闭环 | G1 聚合报告（库 + CLI）、G2 inspector/trace-view 汇总视图、G3 生效配置快照、G4 `/metrics` 接线 | G1 依赖 E1+E2；G3 独立；G4 依赖 E2/E4 |

三期均可独立开工；**建议顺序 E → F → G**（F/G 都要读 E 的产物）。

---

## 3. Phase E —— 观测下沉

### E1. 工具级时序（让「哪一步慢」可测）

**问题**：普通工具**不建 span**（这是 `26707ef` 的既定决策，为控 trace 体积），只在 turn 上记 `tool.input` / `tool.output` 事件。代价是：**工具耗时彻底不可观测** —— 框架最常用的能力恰恰是普通工具。

**设计（建议 A：在既有事件面补时序，不建 span）**：

```ts
// engine/loop.ts —— 工具执行处（既有 tool.input / tool.output 事件）
// tool.input  事件体不变（记开始时刻在 loop 内局部变量，不落事件）
// tool.output 事件体**增补**两个字段：
recorder.event(turnId, 'tool.output', {
  tool: use.name,
  tool_use_id: use.id,
  durationMs: Math.max(0, Date.now() - startedAt),   // ← 新增：该工具本次执行耗时
  status: ok ? 'ok' : 'error',                        // ← 新增：成功 / 失败（含超时、校验拒绝）
  // …既有字段（输出截断、is_error 等）保持
});
```

要点：
- **零 span 增量**：不动 `SpanKind`、不给普通工具新开 span —— 守住既定决策（trace 体积 & 渲染成本）。
- **覆盖所有终止路径**：成功、抛错、**工具超时**（C2，`Promise.race` 放弃等待）、**入参校验拒绝**（`validateJsonSchema` 不过）都要记 `status:'error'` 且带 `durationMs`。
- **并行工具各记各的**：`tool_use_id` 已保证配对（同名并行工具不会串）。
- **中间件的计时不进这里**：中间件（R1）能测「包了一层的总耗时」，但它是用户接缝、可能不存在；E1 测的是**框架侧的可信基线**。两者不冲突（文档写明区别）。

**取舍 / 被否**：
- **被否 B**：给普通工具也建 `unit` span。理由：当初显式把普通工具降为事件就是为了**控 trace 体积与渲染成本**（一次 run 可能几十上百次工具调用）；为一个耗时会把这笔账重新付一遍，且会让缺省 trace 变大、`trace-view` 变卡。若用户需要 per-tool span，可用中间件自己在 trance 外记。
- **被否 C**：在 turn 事件上记 `startedAt`/`endedAt` 绝对时间戳。理由：`SpanEvent` 已有 `time`，再记绝对时间会让"耗时"要跨两个事件相减才能得，且并行时容易读错；直接给 `durationMs` 语义最清晰。

**测试**：mock client 触发一次工具调用 → 断言 `tool.output` 事件带 `durationMs ≥ 0` 且 `status:'ok'`；工具抛错 → `status:'error'` 且 run 不失败；工具超时 → `status:'error'` 且 `durationMs ≈ timeoutMs`。

### E2. 单元级指标（`metricsSink` 下沉到 `unit` 维度）

**问题**：`metricsSink` 只有 run 级标签，答不出「**哪个单元慢 / 贵 / 爱失败**」—— 而这正是调优第一步。

**设计**：`metricsSink` 在 `export(trace)` 时**遍历 span 与 turn 事件**，按单元聚合：

```ts
// integrations/metrics.ts —— 新增选项
export interface MetricsSinkOptions {
  export?: 'prometheus' | 'otlp';
  windowSize?: number;
  prefix?: string;
  /**
   * 单元标签粒度：'unit'（缺省，按 `kind:name` 如 `tool:search`）| 'kind'（只按类型，基数极小）| 'none'（关掉单元指标）。
   */
  labelMode?: 'unit' | 'kind' | 'none';
  /**
   * 单元标签基数上限（缺省 200）。超出后新单元归入 `unit="__other__"`，防标签爆炸。
   * 只对 labelMode:'unit' 生效。
   */
  maxUnits?: number;
}
```

新增指标（Prometheus 文本）：

```
agentia_unit_calls_total{unit="tool:search"}            3
agentia_unit_errors_total{unit="tool:search"}           0
agentia_unit_duration_ms_bucket{unit="tool:search",le="50"} 2
agentia_unit_duration_ms_bucket{unit="tool:search",le="+Inf"} 3
agentia_unit_duration_ms_count{unit="tool:search"}      3
agentia_unit_duration_ms_sum{unit="tool:search"}        142
agentia_unit_tokens_total{unit="skill:summarize",kind="input"} 1200   ← 仅 skill/subagent（unit span 有 usage）
```

要点：
- **数据来源分两路**（必须写进注释）：
  - `skill` / `subagent` → 读 `unit` span（有起止 + 子孙 usage 聚合）；
  - `tool` → 读 turn 上的 `tool.output` 事件（依赖 **E1** 的 `durationMs`/`status`）。
  - `prompt` → 不建 span、无独立耗时，**不产出单元指标**（如实缺省，不硬凑）。
- **token 指标只对 skill/subagent**：普通工具是用户代码，本身不消耗 token；给它记 token 是伪指标。
- **错误口径**：`unit_errors_total` 数 `status:'error'` 的单元调用（工具失败/抛错/超时/入参被拒 + skill/subagent span `status:'error'`）。**不**把 `budget_exceeded` 算成某单元的错。
- **基数防护**：`maxUnits`（缺省 200）+ `labelMode` 开关；超限归 `__other__`，并在 `snapshot()` 里给出 `droppedUnits` 计数（可观测"标签被截断了"）。
- **仍零依赖**：Prometheus 文本继续手写。

**测试**：构造一条含 2 个工具（一成功一失败）+ 1 个 skill 的 trace → 断言 `render()` 里出现对应 `unit_calls_total` / `unit_errors_total` / `duration_ms_*`，且 `labelMode:'none'` 时不出现任何 `unit=` 标签、`maxUnits:1` 时第二个单元归 `__other__`。

### E3. 模型维度指标（成本 / token / 延迟按模型归因）

**问题**：成本只躺在 `llm.turn` span 里，没有按模型聚合的出口。

**设计**：`llm.turn` 的 `span.name` **就是模型 id**（`core/trace.ts` 已定），直接按它聚合：

```
agentia_model_turns_total{model="claude-sonnet-4-6"}        12
agentia_model_tokens_total{model="claude-sonnet-4-6",kind="input"}  …（四类分项）
agentia_model_cost_usd_total{model="claude-sonnet-4-6"}     0.048
agentia_model_duration_ms_count{model="claude-sonnet-4-6"}  12
```

要点：
- 成本按模型累加 `usage.costEstimate`；**未定价模型**的 turn 计入 `turns_total` 但成本不累加 —— 并由 **F2** 单独计数（`agentia_unpriced_turns_total{model=…}`），闭环可查。
- 延迟：`llm.turn` span 的 `endedAt - startedAt`（模型往返耗时，热路径指标）。
- 基数天然小（模型数有限），不做上限。

**测试**：一条 run 两个模型（主 + 子 agent 换模型）→ 断言两行 `model_turns_total`，成本各自归因。

### E4. 直方图（可聚合的分位）

**问题**：现在是**进程内滑动窗口精确分位**，多实例不可相加。

**设计（建议 A）**：**补**原生 histogram（bucket），**保留**窗口精确分位：

```
agentia_run_duration_ms_bucket{le="100"}   3
agentia_run_duration_ms_bucket{le="250"}   5
...
agentia_run_duration_ms_bucket{le="+Inf"}  7
agentia_run_duration_ms_count             7
agentia_run_duration_ms_sum               1180
```

- 缺省 buckets：`[25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]`（毫秒），可用选项覆盖 `buckets?: number[]`。
- `snapshot()` 仍返回窗口精确 `latencyP50/P95`（**人看**方便）；`render()` 出 histogram（**机器聚合**方便）。两者并存、口径在注释里写明。
- **被否 B**（只保留窗口分位）：Prometheus 抓取端无法跨实例聚合分位，生产上等于少一条腿。
- **被否 C**（只出 histogram、删掉 snapshot 分位）：`snapshot()` 是对外公开 API（`MetricsSnapshot`），删字段是破坏性变更；且单实例场景窗口分位更好读。

**测试**：已知一组 run 时长 → 断言各 `le` 桶累计值符合预期、`count`/`sum` 正确；`buckets` 选项生效。

### E5. OTLP metrics 导出

**问题**：`export:'otlp'` 构造期抛错。

**设计（建议 A：零依赖手写 OTLP/JSON over HTTP）**：与既有 `createOtlpExporter`（traces）**同款**做法 —— duck-typed endpoint，手写 OTLP JSON，不引 `@opentelemetry/*`。

```ts
export interface MetricsSinkOptions {
  export?: 'prometheus' | 'otlp';
  /** export:'otlp' 时的采集端（如 http://localhost:4318/v1/metrics）；缺省读不到则抛错（不静默） */
  endpoint?: string;
  /** 导出间隔毫秒（缺省 60000；0 = 每次 export 后立即 flush） */
  intervalMs?: number;
  /** 附加 resource 属性 */
  resourceAttributes?: Record<string, string>;
  /** 导出失败回调（缺省吞掉，观测不击穿业务） */
  onExportError?: (err: unknown) => void;
}
// MetricsSink 增：flush(): Promise<void>  —— 主动导出当前累计（测试 / 进程收尾用）
```

要点：
- 走 OTLP/HTTP **JSON**（`application/json`），不引 protobuf（零依赖硬约束）。
- 累积器按 `Cumulative` 语义；`flush()` 主动导出，`intervalMs` 定时导出（`setInterval(...).unref()`，不阻止进程退出）。
- 导出失败**吞掉**（可选 `onExportError` 观测），不影响 run —— 与 sink 抛错被吞同款。
- **端点不默认猜**：没给 `endpoint` 就抛错（比"静默不导出"好）。

**测试**：起一个本地 `http.createServer` 收 `/v1/metrics` → 断言收到合法 OTLP JSON（`resourceMetrics[0].scopeMetrics[0].metrics` 结构）、`flush()` 幂等、端点错误吞掉且调 `onExportError`。

---

## 4. Phase F —— 成本可调优（不再静默失效）

### F1. 价格表可注入

**问题**：`PRICING` 是模块常量、只 6 个模型 → 非 Anthropic 用户成本恒 0。

**设计（建议 A：走选项，不引入全局单例）**：

```ts
// engine/usage.ts
export interface Pricing { in: number; out: number }   // $/1M tokens
/** 合并内置表与覆盖（覆盖优先）；返回新表，不改模块常量 */
export function buildPricing(overrides?: Record<string, Pricing>): Record<string, Pricing>;

// engine/types.ts（RunAgentOptions）与 toolkit 的 AppOptions 均可加
  priceOverrides?: Record<string, Pricing>;
```

- **合并语义**：`overrides` 的键**覆盖**内置同名项（想改 sonnet 单价就写 `'claude-sonnet-4-6'`），未列出的沿用内置；想给 DeepSeek 定价就加 `'deepseek-chat': { in: 0.27, out: 1.10 }`。
- **配置走 options**：符合「框架不读 env」；`AppOptions` → `RunAgentOptions` 透传。
- **被否 B**（全局 `registerPricing()` 单例）：有全局可变状态 → 多 app / 测试间互相污染，且与「配置走选项」的既有风格冲突。

**测试**：`priceOverrides` 指定某模型 → 该模型 turn 有 `costEstimate`；覆盖内置模型 → 用新价算；未覆盖者仍用内置价。

### F2. 未定价模型**显式**（让护栏不静默）

**问题**：未知模型成本恒 0 → `maxCostUsd` 静默失效，**没有任何提示**。

**设计（建议 A）**：

```ts
// engine/types.ts（RunAgentOptions）加（可选）
  /** 遇到不在价格表内的模型时回调（每模型一次，去重）；框架同时会在 run 根记 `usage.unpriced` 事件 */
  onUnpricedModel?: (info: { model: string; spanId: string }) => void;
```

- **落点**：`loop.ts` 每次 `llm.turn` 记账时，若 `costEstimate(model, usage) === undefined` → `recorder.event(runRootSpanId, 'usage.unpriced', { model })`（去重自 `events` 即可），并调 `onUnpricedModel`（**try 包裹**，抛错吞掉）。
- **指标**：`agentia_unpriced_turns_total{model="…"}` → 监控能告警"成本护栏实际没生效"。
- **不把 run 判失败**（**被否 B**）：模型没定价是**宿主配置问题**，不是这次 run 的业务失败；把成功 run 打成 `failed` 代价过大。用"事件 + 指标 + 回调"三处可见即可，文档在 `usage-guide §7` 明确「`maxCostUsd` 需要价格表覆盖，否则只在 `maxTotalTokens` 上兜底」。

**测试**：未知模型跑一轮 → run 根有 `usage.unpriced` 事件、`onUnpricedModel` 被调一次（同模型多 turn 只调一次）、`maxCostUsd` 下 run **不**失败；配了 `priceOverrides` 后不再有该事件。

### F3. 成本归因出口

- 复用 **E3** 的 `agentia_model_cost_usd_total{model=…}`；
- 再加**单元维度**成本：skill/subagent 的 `unit` span 有**子孙 usage 聚合** → `agentia_unit_cost_usd_total{unit="subagent:researcher"}`（仅 skill/subagent；普通工具无 token，不产出）。
- **不做**（YAGNI，见 §7）：跨 run 账单、按租户/客户的多维成本分析、"成本预测"。

**测试**：主 agent + 一个子 agent → 模型成本与子 agent 单元成本都能在 `render()` 里读到，且**不与 `totalUsage` 双算**（断言两者之和关系符合"单元聚合 = 子孙之和"）。

---

## 5. Phase G —— 调优闭环

### G1. 聚合报告（调优依据）

**问题**：没有任何"哪一步慢 / 贵 / 爱失败"的产物，用户不知道该调哪个旋钮。

**设计（建议 A：库函数 + CLI 薄封装）**：

```ts
// integrations/report.ts（只依赖 core）
export interface UnitReport {
  unit: string;          // `${kind}:${name}`
  calls: number;
  errors: number;
  durationMs: { total: number; p50: number; p95: number; max: number };
  tokens: Usage | null;  // 仅 skill/subagent
  costUsd: number | null;
}
export interface RunReport {
  traceId: string;
  status: 'ok' | 'error';
  durationMs: number;
  totalUsage: Usage;
  models: Array<{ model: string; turns: number; tokens: Usage; costUsd: number | null }>;
  units: UnitReport[];   // 按 durationMs.total 降序
  unpricedModels: string[];
}
/** 从一条 Trace 生成报告（纯函数，无副作用） */
export function buildRunReport(trace: Trace): RunReport;
/** 多条 trace（如 JSONL 落盘）→ 汇总（跨 run 的单元排行；report 里的"跨 run"仅此一处，不做多维分析） */
export function mergeRunReports(reports: RunReport[]): RunReport;
```

CLI：`agentia report <trace.jsonl>` —— 读 `FileTaskStore` / trace 落盘的 JSONL，打印单元耗时/成本/错误率排行 + 未定价模型清单。**纯读，不联网、不调模型。**

要点：
- 报告是**派生视图**，不新造数据源；`traceToMessages` 不改。
- 分位在单条 run 内样本太少 → 报告以 `total`/`max` 为主、分位作参考，跨 run 用 `mergeRunReports` 才有统计意义（注释写明）。
- **被否 B**（只做 CLI）：库函数才能被 inspector / 用户自己的 dashboard 复用；CLI 只是薄壳（同 `trace-view` 的"共享渲染器"思路）。

**测试**：对一条已知 trace 断言排序、`errors` 计数、未定价清单；两条 trace merge 后 `calls` 相加、`units` 按总耗时重排。

### G2. inspector / trace-view 汇总视图

- `Dev Inspector` 在调用树旁加一格 **per-unit 汇总**（耗时/成本/错误率排行），数据源 = **G1** 的 `buildRunReport`；
- **不新写渲染**：沿用"共享渲染器"原则 —— 排行视图放 `@migor/trace-view`，官网 playground 与 CLI 面板共用。
- **被否**：另做一套 dashboard —— 与「框架是代码优先、不做可视化编排」冲突。

**测试**：trace-view 单测断言排行渲染（既有 6 例的基线上加）；inspector 服务测试断言新 feed 可访问。

### G3. 生效配置快照（"这条 run 用了哪套旋钮"）

**设计（建议 A：写 run 根 attributes）**：

```ts
// runtime/run.ts —— run 根 span 上写（键前缀 config.，值化为可序列化标量）
config.budgetTokens / config.keepRecent / config.keepToolPairs / config.compactEvery
config.maxTotalTokens / config.maxCostUsd
config.retry.maxAttempts / config.retry.baseDelayMs
config.toolTimeoutMs / config.maxToolConcurrency
config.model
```

要点：
- 只记**已显式设置或走缺省的值**中可序列化的标量；函数型选项（`summarize`/`estimateTokens`）记 `true/false`（"配了没"），不记函数体。
- 让 `Trace` 自解释 → 事后复现/对比"换参数前后"有据可查。
- 与 D4 的 `system.version` 并列，不重复。

**测试**：配一组选项跑一轮 → 断言 run 根 attributes 含预期键值；默认配置下也有缺省值（可读）。

### G4. `/metrics` 接线

```ts
// transport/http.ts
export interface HttpHandlerOptions {
  /** 提供则在 GET /metrics 输出 sink.render()（text/plain; version=0.0.4）；不鉴权（与 /healthz 同档） */
  metrics?: { render(): string } | (() => string);
}
```

- 只给缝：框架不知道指标从哪来，宿主把 `metricsSink()` 传进来即可。
- `/metrics` 与 `/healthz` 同档**不鉴权**（拉取端通常在集群内网）；文档在 `usage-guide §6` 写明「要保护请放反代后面」。
- **被否 B**（用户自己接）：与"框架内建 `/healthz`"的既有做法不一致 —— 健康与指标是同一档运维需求。

**测试**：`createHttpHandler(app,{metrics})` → `GET /metrics` 返回 `200` + `text/plain` + 内容等于 `render()`；不传 `metrics` 时该路由 `404`。

---

## 6. 设计分叉（**待拍板**）

| # | 分叉 | 选项 A | 选项 B | 我的建议 |
|---|---|---|---|---|
| F1 | 工具耗时怎么测 | 在既有 `tool.output` 事件上**补** `durationMs`/`status`（零 span 增量） | 给普通工具也建 `unit` span | **A** —— 守住"普通工具降为事件"的既定决策（trace 体积/渲染成本） |
| F2 | 指标形态 | **补** histogram buckets，**保留**窗口精确分位（并存） | 只保留窗口分位 | **A** —— B 让多实例无法聚合；C（只 histogram、删分位）是破坏性变更 |
| F3 | 单元标签基数 | 默认 `labelMode:'unit'` + `maxUnits`（缺省 200，超限归 `__other__`） | 不设上限，全量打标签 | **A** —— 用户可定义任意多工具，裸打标签会打爆 Prometheus |
| F4 | OTLP metrics 实现 | **零依赖手写** OTLP/JSON over HTTP | 引 `@opentelemetry/exporter-*` | **A** —— 守住"零运行时依赖"；与 `createOtlpExporter`(traces) 同款 |
| F5 | 价格注入形态 | `priceOverrides` **选项**（`AppOptions`→`RunAgentOptions`） | 全局 `registerPricing()` 单例 | **A** —— 无全局可变状态、与"配置走选项"一致 |
| F6 | 未定价模型怎么处理 | 记 `usage.unpriced` 事件 + 指标 + `onUnpricedModel` 回调（**不**改 run 结局） | 让 run 失败 / 抛错 | **A** —— 定价缺失是宿主配置问题，不该毁掉一次成功的 run |
| F7 | 报告落点 | 库函数 `buildRunReport` + CLI `agentia report` 薄壳 | 只做 CLI 命令 | **A** —— 库函数才能被 inspector/用户 dashboard 复用（对齐 `trace-view` 共享原则） |
| F8 | `/metrics` 接线 | `createHttpHandler({ metrics })` 内建路由 | 用户在外层自己接 | **A** —— 与内建 `/healthz` 同档，运维一致性 |

---

## 7. 风险与不做的事

**风险**

- **E1 的语义面**：给 `tool.output` 加字段是**事件体扩展**（非破坏，但 `tests/docs` 里若有对事件体的逐字断言需同步）。`usage-guide §7` 要补一条"普通工具耗时从 `tool.output.durationMs` 读"。
- **E2/E3 的基数风险**：用户若有海量工具名 → 标签爆炸。缓解：**F3 的 `maxUnits` + `labelMode` + `droppedUnits` 计数**三件套，并在文档写明调法。
- **E5 OTLP/JSON 的协议漂移**：OTLP JSON 结构随规范演进 → 只承诺**当前规范**的 `resourceMetrics/scopeMetrics/metrics` 最小结构，不追新。
- **G1 单 run 分位的统计意义**：单条 run 内样本数常 `< 5`，分位没有意义 → 报告以 `total`/`max` 为主，跨 run 用 `mergeRunReports`；文档必须写明，避免用户误读。
- **性能**：E2/E3 让 `metricsSink.export` 从 O(1) 变成 O(spans + events)。对超长 trace（几百 span）要**复用一次遍历**，别每个指标扫一遍；纳入性能自检（既有 `deps` 无变化，不引新依赖）。

**不做（YAGNI，写清以防反复讨论）**

- 跨 run 账单 / 按租户/客户的多维成本分析平台（`mergeRunReports` 已是本期上限）；
- 告警系统与 SLO/预算外推（只出指标与事件，规则是宿主/监控系统的事）；
- 可视化 dashboard UI / Grafana 模板 / 采样策略；
- 引入 `@opentelemetry/*` SDK（零依赖硬约束）；
- 向量检索记忆、HITL 跨进程续跑、`canCall` 单元级边（**本期不碰**，各自独立议题）。

---

## 8. 验证标准

```bash
npm run typecheck && npm run build && npm run typecheck:types && \
npm run typecheck:tests && npm run build:cli && npm test && \
npm run e2e && npm run build:website
```

外加**本期特有**的可执行证明：

- **E1**：mock client 跑通一条含成功/失败/超时工具的 run → `tool.output` 事件三态 `status` + `durationMs` 齐全。
- **E2/E3/E4**：对一条构造 trace `render()` → 断言出现 `unit_*`、`model_*`、`*_bucket` 三类指标；`labelMode:'none'` / `maxUnits:1` 的边界各一例。
- **E5**：本地起 HTTP server 收 `/v1/metrics` → 断言合法 OTLP JSON（真导出，不是"调了就算"）。
- **F1/F2**：`priceOverrides` 让非 Anthropic 模型算出成本；未知模型 → `usage.unpriced` 事件 + `onUnpricedModel` + run 仍 `succeeded`。
- **G1**：`agentia report <trace.jsonl>` 打印排行（真读文件、真排序）。
- **G4**：`curl localhost:PORT/metrics` 返回 Prometheus 文本。

收尾后：更新 `roadmap.md` 状态 + `spec.md §10` 决策记录 + `usage-guide.md`（及派生 `llms.txt` / `dist/AGENTS.md`）+ 官网对应页面（`api.html` 导出表反向全覆盖会强制同步）。
