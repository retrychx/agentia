# Agent 服务能力补全 —— 设计文档

> **状态**：**四期全部落地（A / B / C / D，2026-09-11）**，8 个设计分叉全部按建议 **A** 拍板（见 §7 决策记录）。决策记录见 `spec.md §10`，状态见 `roadmap.md`；D1 的接入点在实际落地时被推翻，见 §6 的 ⚠️ 标注。
> **日期**：2026-09-11
> **前置**：本文是**设计**，不是逐步实现计划。每个 Phase 的细粒度任务计划见 `docs/plans/` 下对应的 `phase-*.md`。

**Goal**：把框架从「声明式装配 + 能跑」补到「能安心上生产」—— 补齐定位为 agent **服务**（spec §6）所必需、但当前缺失的能力。

**Architecture**：不新增层。缺口天然分布在已有分层上（`core ← engine ← runtime/store ← transport ← toolkit`），因此全部按现有落点归位：
- **成本与稳定性**（取消 / 重试 / 流式）落在 `engine` + `transport`，复用已有的 `onText`、`classifyError.retryable`、`TraceSink`；
- **宿主硬化**（鉴权 / drain / health）落在 `transport`，只给**缝**不给策略；
- **能力成色**（成本硬管控 / 工具闸门 / OpenAI 流式与多模态 / 会话 / 回调）按职责落 `engine` / `integrations` / `runtime`；
- **生态**（MCP / evals / 指标）落 `integrations` 与新的叶子消费模块。

**边界条件（沿用仓库硬约束，所有设计必须满足）**：
1. **零新增运行时依赖** —— 可选能力一律 duck-typed（`ModelClient` / `RedisLike` 是既有范式）。
2. **框架不读 env** —— 配置一律走选项；env 只由 CLI / 宿主读。
3. **分层单向** —— 相对 import 带 `.js`；core 不依赖上层；`integrations` 只依赖 core。
4. **改语义必须记 `spec.md §10`**；方向性工作更新 `roadmap.md`。
5. **新行为必须带测试**（`node:test`），并纳入 `npm test` 全链。
6. **框架不替你造 token**（不主动调模型）；护栏优先于包办。

**非目标（YAGNI，明确不做）**：MCP `sampling`（server 反向请求模型）、跨 run 账单报表、A/B 与实验平台、向量检索记忆、可视化编排。理由见 §8。

---

## 1. 缺口 → 现状证据

| # | 缺口 | 证据（代码事实） | 性质 |
|---|---|---|---|
| 1 | 无法中止在飞 run | `AbortSignal` 全仓 0 命中；`cancel` 仅存在于 `Scheduler`。HTTP 客户端断开后 run 继续跑、继续计费 | 成本漏洞 |
| 2 | 无重试 / 退避 | `engine/errors.ts` 产出 `retryable: true/false`，但**全仓无人读取** —— 一次 429/网络抖动 = 整个 run `failed` | 稳定性 |
| 3 | 传输层无流式出口 | `onText` 回调存在，但 `createHttpHandler` 只回一元 JSON；`text/event-stream` 0 命中 | 体感 / 首字延迟 |
| 4 | HTTP 入口零鉴权 | 框架无鉴权概念，`POST /run` 裸奔；middleware 只拦**单元调用**，拦不住**run 入口** | 安全 |
| 5 | 无优雅停机 / 健康检查 | `SIGTERM`/`/healthz`/`readiness` 0 命中；仅 `Scheduler.stop()` | 运维 |
| 6 | 成本硬管控缺失 | `spec §6.4` 明列「task budget」为服务层要求，但 `§10`/`usage-guide §7` 记的是「预算只是护栏」→ **说了没做** | 成本 |
| 7 | 工具级超时 / 并发上限缺失 | `loop.ts` 用 `Promise.all` 并行全部 tool，无上限、无单工具超时；`runTimeoutMs` 是任务级 | 稳定性 |
| 8 | OpenAI 适配器两处近似 | ① 非流式（`on('text')` 在 `finalMessage()` 后一次性给全量）；② `renderBlocks`（`openai.ts:200`）把非文本块 `JSON.stringify` → 图片退化成 JSON 文本 | 多模型成色 |
| 9 | 无会话（对话历史）持久化 | 只有 `MemoryStore.load/save` 键值钩子；无「messages 落库 + 按 session 续跑」 | 可用性 |
| 10 | 无任务完成回调 | `webhook`/`callback` 0 命中；异步模式只能轮询 | 集成 |
| 11 | 无 MCP | 0 命中；2026 年工具生态事实标准，现只能手写 `@Tool` | 生态（最大） |
| 12 | 无 evals 一等支持 | `mockClient` 仅在 `tests/helpers.ts`（内部） | DX / 质量 |
| 13 | 无聚合指标 | OTLP span 映射完整（`resourceSpans→scopeSpans→spans`），但无 counter/histogram | 运营 |
| 14 | 无提示词/配置版本化、多租户配额 | 0 命中 | 运营 |

> 已记档的**边界**（本设计**不**当新缺口重复处理）：模型调用不可中断（→ 本设计 #1 正是要**推翻**它）、预算只是护栏（→ #6 推翻）、`tools` 引用是 provider 粒度、`trace v1` 只覆盖单 run、包未拆未发布。

---

## 2. 分期总览

顺序原则：**先补「省钱的正确性」，再补「能不能上生产」的门槛，最后补能力与生态**。四期之间无强耦合，可并行开工，但 A 期改动面最小、收益最直接，建议先做。

| 期 | 主题 | 条目 | 依赖 |
|---|---|---|---|
| **A** | 成本与稳定性 | A1 取消传播、A2 重试退避、A3 SSE 流式 | A1→A3（流式要能被中止） |
| **B** | 宿主硬化 | B1 鉴权缝、B2 drain/health | 无（可与 A 并行） |
| **C** | 能力成色 | C1 成本硬管控、C2 工具闸门、C3 OpenAI 流式+多模态、C4 会话持久化、C5 完成回调 | C1 依赖 A2（重试会计入用量）。其余独立 |
| **D** | 生态 | D1 MCP、D2 evals、D3 指标、D4 版本化/配额 | D1 复用 `discover`/provider 范式 |

---

## 3. Phase A —— 成本与稳定性

### A1. 取消传播（AbortSignal 贯穿）

**问题**：`runTimeoutMs` 只做到「放弃等待」，底层请求仍在跑、仍在计费；客户端断开后 run 无人叫停。

**设计**：把 `signal` 作为**可选**参数从入口贯穿到模型客户端。

```ts
// core/tool.ts —— 结构面加可选字段（非破坏：旧实现不实现它即可）
export interface ModelClient {
  messages: {
    stream(params: {
      model: string;
      max_tokens: number;
      system?: string | Anthropic.TextBlockParam[];
      tools?: Anthropic.Tool[];
      messages: Anthropic.MessageParam[];
      signal?: AbortSignal;          // ← 新增；Anthropic SDK 天然支持
    }): { on(event: 'text', cb: (delta: string) => void): void; finalMessage(): Promise<Anthropic.Message> };
  };
}

// engine/types.ts —— RunAgentOptions 加
  signal?: AbortSignal;

// runtime/run.ts —— ExecuteRunOptions 继承之；run 收尾统一映射
//   中止 → AgentStopReason 新增 'aborted'，run.status='failed'，error.type='aborted'
```

落点与要点：
- `engine/loop.ts`：每回合开始前 `signal?.throwIfAborted()`；把 `signal` 透传进 `client.messages.stream({...})`。
- 工具执行：`ToolRunContext` 加 `signal`（工具自己决定是否尊重，如传给 `fetch`）；框架**不**强行中断工具（无法保证副作用可回滚）。
- `transport/http.ts`：`POST /run` 里 `req.on('close', () => ac.abort())`（客户端断开 = 放弃本次 run）；SSE 同理。
- `transport/async.ts`：`runTimeoutMs` 从「`Promise.race` 放弃等待」升级为「**真正 abort**」（保留 `Promise.race` 兜底：abort 只对尊重 signal 的客户端有效）。
- **组合**：提供 `combineSignals(...)`（零依赖小工具，`src/core/abort.ts`），让「超时 + 客户端断开 + 宿主停机」三个来源合成一个。

**取舍**：为什么不把 signal 放请求参数而放 `stream` 的 params？因为 SDK 的 signal 是 per-request 的；放 params 让 `ModelClient` 实现者一眼看到需要转发。**被否**：全局 `AbortController` 单例 —— 并发 run 会互相中止。

**测试**：mock client 断言「收到 signal 且 abort 后 `finalMessage` 以 `AbortError` 拒绝」；HTTP 断连 → run 记录为 `failed/aborted`（而非挂到超时）。

### A2. 重试与退避（消费 `retryable`）

**问题**：`classifyError` 认真标了 `retryable`，但没人读它。

**设计**：engine 内建**可选**重试，只重试「安全可重试」的失败。

```ts
// engine/retry.ts
export interface RetryOptions {
  /** 最大尝试次数（含首次）；缺省 3。1 = 关闭 */
  maxAttempts?: number;
  /** 首次退避毫秒；缺省 500，指数增长 */
  baseDelayMs?: number;
  /** 退避上限；缺省 8000 */
  maxDelayMs?: number;
  /** 抖动比例 0~1；缺省 0.2（避免并发 run 同时重试打爆上游） */
  jitter?: number;
  /** 判定可重试；缺省 `(e) => classifyError(e).retryable` */
  isRetryable?: (err: unknown) => boolean;
  /** 重试前回调（观测用；框架不记 trace 事件以外的东西） */
  onRetry?: (info: { attempt: number; delayMs: number; error: SpanError }) => void;
}

// RunAgentOptions / AppOptions 加
  retry?: RetryOptions | false;   // 缺省 undefined = 用缺省策略；false = 关闭
```

关键约束（必须写进注释与测试）：
- **只重试「尚未产出任何文本块」的失败** —— 已经流出去一半的文本无法撤回，重试会造成重复输出。实现：`finalMessage()` 抛错且 `onText` 未被调用过 → 可重试。
- **可重试即整个 `llm.turn` span 重开**：失败的 turn 以 `status:'error'` + attribute `retry.attempt` 保留在 trace 里（可观测「重试了几次」），重试的 turn 是**新 span**。
- **用量不重复计**：只有成功的 turn 计入 `Trace.totalUsage`（现有口径已保证 —— 只累加 `llm.turn`，失败 turn 无 usage）。
- **与 SDK 内置重试的关系**：Anthropic SDK 自己会重试 429/5xx（默认 2 次）。框架层重试是**更外层**的兜底（覆盖 SDK 放弃后的失败，以及 OpenAI 兼容客户端）。文档须写明「两层可能叠加」，建议用户二选一调（`maxAttempts=1` 关框架层）。

**测试**：脚本化 client 第 1 次抛 429、第 2 次成功 → run `succeeded`，trace 里两个 turn（一个 error 一个 ok），`onRetry` 被调一次；已产出文本后失败 → **不**重试。

### A3. SSE 流式下发

**问题**：`onText` 出不去；首字延迟 = 整段生成时间。

**设计**：`POST /run` 支持内容协商，`Accept: text/event-stream` → SSE。

```ts
// transport/http.ts
// 事件序列（第一版只做前两类 + 收尾；全量单元事件后置）
//   event: run.start   data: { runId }
//   event: text.delta  data: { text }            ← 逐 token
//   event: run.end     data: RunHttpResponse     ← 与原 JSON 响应体同形状
//   event: error       data: { message }         ← 流已开后出错
```

落点与要点：
- 零依赖手写 SSE 帧（`data: ...\n\n` + `event:`），设置 `content-type: text/event-stream`、`cache-control: no-cache`、`connection: keep-alive`；心跳注释帧（`: ping\n\n`）防中间层超时。
- **错误语义**：流**开之前**的错误仍走普通 HTTP 状态码（400/413/503）；**流开之后**只能以 `error` 事件收尾（HTTP 状态已发出），这一点必须写进注释。
- `signal`（A1）必须接：客户端断开 → abort run。
- 非 `Accept: text/event-stream` 的请求**逐字保持现状**（向后兼容，零破坏）。
- 异步任务流式（`GET /tasks/:id/stream`）**后置** —— 需要 run 进度跨进程，属「run 内事件流」，不在本期。

**测试**：起 `http.createServer(createHttpHandler(app))`，`curl -N`（或 Node fetch 读流）断言收到 ≥2 个 `text.delta` 且末帧是 `run.end`；不带 Accept 的请求仍回 JSON。

---

## 4. Phase B —— 宿主硬化 ✅ 已落地（2026-09-11）

### B1. 鉴权缝（只给缝，不给策略）

```ts
// transport/http.ts
export interface HttpHandlerOptions {
  /**
   * 入口鉴权钩子。请求进入 /run、/tasks 前调用。
   * - 返回任意值 → 视为通过（可作为 per-request 上下文，暂无消费点，留给中间件/工具读）；
   * - 抛错 → 回 401（HTTPException 可带 status/body）；/healthz 不鉴权。
   * 框架不实现策略（token/JWT/签名都不做）—— 那是宿主/反代的事。
   */
  authenticate?: (req: IncomingMessage) => unknown | Promise<unknown>;
}
```

**取舍**：为什么不做成 middleware？middleware 拦的是**单元调用**（run 内部）；鉴权要拦的是**run 入口**，且必须在读 body 之前（省资源）。**被否**：内置 API-Key 校验 —— 框架不读 env、不该碰凭据。

### B2. 优雅停机 + 健康检查

```ts
// transport/async.ts
export class AsyncRunner {
  /** 停止接单；等待在飞任务收尾（或超时）；返回是否排空干净 */
  drain(opts?: { timeoutMs?: number }): Promise<boolean>;
}

// transport/http.ts —— createHttpHandler 返回的 handler 上加一个属性（不破坏调用形状）
interface HttpHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  drain(opts?: { timeoutMs?: number }): Promise<boolean>;   // 委托 runner.drain + 排空 SSE 连接
  readonly runner: AsyncRunner;                             // 需要时手动控制
}
```

- 约定 `GET /healthz` → `{ ok: true, inFlight, uptimeMs }`（**由 createHttpHandler 直接提供**，因为它已经知道并发闸门状态）。
- `SIGTERM` 的处理**不放进框架**：框架给 `drain()`，宿主自己 `process.on('SIGTERM', ...)`。理由同「框架不读 env」。

**测试**：`/healthz` 返回在飞数；`drain()` 在有在飞任务时等待、超时后返回 false；drain 后新 `POST /tasks` 回 503。

---

## 5. Phase C —— 能力成色 ✅ 已落地（2026-09-11）

### C1. 成本硬管控（补 `spec §6.4` 的欠账）

```ts
// engine/types.ts
export type AgentStopReason = ... | 'budget_exceeded';   // 新增

// RunAgentOptions / AppOptions 加（二选一或都设，先到先算）
  maxTotalTokens?: number;   // 整条 run（含子 agent）累计 token 上限
  maxCostUsd?: number;       // 累计成本上限（用 span 级 usage 的成本估算）

// engine/budget.ts
export interface BudgetGuardOptions { maxTotalTokens?: number; maxCostUsd?: number; onExceed?: (snapshot) => void }
export function createBudgetGuard(o: BudgetGuardOptions): {
  /** 每回合 llm.turn 结束、记账完成后调用；超限返回 'tokens' | 'cost' | null */
  check(trace: Trace): 'tokens' | 'cost' | null;
};
```

- 触发点：`engine/loop.ts` 每回合 `recorder.end(turnId, {usage})` 之后 → `check` → 超限则 `finished=true; stopReason='budget_exceeded'`，并在 run 根记 `budget.exceeded` 事件（带快照）。
- **与「预算只是护栏」的区别**：`createBudgetPolicy` 是**发送前**的上下文裁剪（防止 400 / 过早压缩）；`BudgetGuard` 是**记账后**的硬停止（控制花钱）。两者互补，文档必须并列讲清。
- `budget_exceeded` **算失败**（run 没跑完）：`isSuccessStopReason` 不纳入它 → `status='failed'`，`error` 带上快照。

**被否**：把硬管控塞进 `contextPolicy.beforeTurn` —— 职责不同（一个是改消息、一个是记完账再判断）。

### C2. 工具级超时 + 并发闸门

```ts
// RunAgentOptions / AppOptions 加
  toolTimeoutMs?: number;        // 单个工具执行的超时；超时 → 该 tool_result 记 is_error（不杀 run）
  maxToolConcurrency?: number;   // 同回合并行工具上限；缺省 Infinity（现行为）
```

- `loop.ts` 的 `Promise.all(toolUses.map(...))` 改为「**有界并发 map**」（`src/engine/concurrency.ts`，零依赖 ~20 行的信号量）。
- 单工具超时用 `Promise.race` + 记 `is_error: 'tool timeout after {n}ms'` 回模型 —— 与「工具抛错不中断 run」的既有语义一致（模型可自行换路）。
- ⚠️ 与 A1 的关系：超时**不能**取消工具（无 signal 给工具就无法真停），文档须写明「超时 = 放弃等待该工具，副作用可能已发生」；想把 signal 传给工具的用户可从 `ToolRunContext.signal` 拿。

### C3. OpenAI 适配器：真流式 + 多模态块

- **真流式**：`stream: true` + 解析 `data:` 行 → 把 `delta.content` 转给 `on('text')`；`tool_calls` 增量按 index 累积后再汇成完整 `tool_use`。删除头部「非流式模拟」的近似声明。
- **多模态**：`renderBlocks` 不再无脑 `JSON.stringify` —— 文本块 → `{type:'text'}`；图片块（`source.type==='base64'|'url'`）→ OpenAI `image_url` part。**保留**「cache token 恒 0」「refusal 近似」两条近似声明（协议层面无法对齐）。
- 这是**让「多模型」名副其实**的关键一步：当前走 OpenAI 端点的体验（无打字机 + 图片退化成 JSON）与 Anthropic 路径差距明显。

### C4. 会话持久化（对话历史）

```ts
// runtime/session.ts
export interface SessionStore {
  /** 读整段历史（无则空数组） */
  load(sessionId: string): MaybePromise<Anthropic.MessageParam[]>;
  /** 追加消息（append-only，便于并发/审计） */
  append(sessionId: string, messages: Anthropic.MessageParam[]): MaybePromise<void>;
}
export class InMemorySessionStore implements SessionStore { ... }   // 缺省/测试

// ExecuteRunOptions 加
  session?: { store: SessionStore; id: string };
```

- 语义：run 开始 `load(id)` 拼在**传入 messages 之前**；run 结束把「本轮新消息 + assistant 回复」`append` 回去。
- **与 `MemoryStore` 的区别（文档必须写清）**：`MemoryStore` = 键值**黑板**（跨 run 的状态/事实）；`SessionStore` = **对话历史**（messages 序列）。二者正交，可同时用。
- 失败不击穿 run（沿用既有原则：水合/回写失败吞掉，不把成功 run 打成 failed）。

### C5. 任务完成回调（先做进程内 sink）

```ts
// transport/async.ts
export interface TaskSink { onFinished(rec: TaskRecord): void | Promise<void> }
export interface AsyncRunnerOptions { taskSinks?: TaskSink[] }   // sink 抛错被吞，不影响任务状态
```

`webhook`（HTTP POST 到指定 url + 重试）**后置**：它引入「出站请求 + 签名 + 重试策略」的复杂度，且用 sink + 用户自己的 `fetch` 就能实现（零框架改动）。先给 sink，够用。

---

## 6. Phase D —— 生态 ✅ 已落地（2026-09-11）

### D1. MCP 桥（duck-typed，框架零依赖）

**设计原则同 `RedisLike`**：框架只定义**结构面**，不 import `@modelcontextprotocol/sdk`。

```ts
// integrations/mcp.ts（只依赖 core，符合分层）
export interface McpClientLike {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpToolsOptions {
  /** 工具名前缀，避免与本地单元撞名；缺省 `mcp_<server>_` */
  prefix?: string;
  /** 单次调用超时（毫秒），超时 → is_error 回模型；缺省 60000 */
  timeoutMs?: number;
}

/** 把 MCP server 的工具映射成框架的 AgentTool[]（可直接进 tools / providers） */
export function mcpTools(client: McpClientLike, opts?: McpToolsOptions): Promise<AgentTool[]>;
```

要点：
- **工具名归一化**：MCP 名可含 `-`/`.`（对 LLM API 不友好）→ 统一转 `_`，并**记录原名**到 attribute（审计/回放需要原名才能回调 server）。
- **入参 schema**：MCP 的 `inputSchema` 已是 JSON Schema → 直接当 `inputSchema` 用（框架已有子集校验器，天然兼容）。
- **连接器不进框架**：stdio（spawn 子进程 + JSON-RPC over stdin/stdout）与 HTTP（StreamableHTTP）两种传输的实现放**独立可选包 `@migor/mcp`**（或由用户自己接 SDK 后实现 `McpClientLike`）。框架只留这 20 行桥。
- **接入点**：`createApp({ providers })` 里放一个 provider（`useFactory` 里 `await mcpTools(...)`）即可 —— 复用现有装配/查重/中间件，**零新机制**。
  > ⚠️ **落地时此条被推翻（见 spec §10）**：菜单只从装饰器注册表收集，`useFactory` 的返回值**不进菜单**；
  > 且 `Container.resolve` 是同步的，异步的 `mcpTools()` 塞不进去。实际接入点 = `AppOptions.tools`（裸工具直进主菜单，
  > 仍过中间件与查重）。
- **不做**：`sampling`（server 反向请求模型）、`resources`/`prompts` 原语（先只做 tools）、连接池。

### D2. evals（把 `mockClient` 提升为一等能力）

```ts
// eval/（叶子消费模块，依赖公共面；无反向依赖）
export function scriptedClient(steps: Array<Record<string, unknown> | (params: unknown) => Record<string, unknown>>): ModelClient;
export function defineEval<T>(e: {
  name: string;
  app: () => Promise<AgentApp> | AgentApp;
  cases: Array<{ input: string; client: ModelClient }>;
  /** 断言：看 stopReason / 调用了哪些 tool / typed 结果 / 自定义 */
  expect: (r: AgentRunResult, ctx: { trace: Trace }) => void | Promise<void>;
}): { run(): Promise<EvalReport> };
```

- 价值：agent 改 prompt / 换模型 / 加工具后，**回归**靠断言而非人眼。这是 agent 服务最缺的一环。
- 复用 `Trace` 做断言源（「调用了 `search` 才调 `summarize`」这类顺序断言都从 trace 读）。
- 输出 `EvalReport`（通过/失败 + 失败 case 的 trace），不引测试框架。

### D3. 指标（从 trace 派生）

```ts
// integrations/metrics.ts（只依赖 core）
export interface MetricsSink extends TraceSink { /* export(trace) 内部累加 */ }
export function metricsSink(opts?: { export?: 'otlp' | 'prometheus' }): MetricsSink & {
  snapshot(): { runs: number; failed: number; latencyP50: number; latencyP95: number; tokens: number; costUsd: number };
  render(): string;   // Prometheus 文本格式；零依赖
};
```

- `MetricsSink` 天然满足既有 `TraceSink` 接口 → `createApp({ sinks: [metricsSink()] })` 即接入，**零新出口**。
- 先做「进程内累加 + Prometheus 文本 `/metrics`」，OTLP metrics 导出后置。

### D4. 提示词版本化 + 多租户配额（最轻的形态）

- **版本化**：`SystemPrompt` 加 `version?: string`，并写进 run 根 attribute（`system.version`）→ trace 里能查出「哪个版本的提示词产出的结果」。**不做**版本库/回滚平台。
- **配额**：不做独立子系统 —— 用既有 middleware + `BudgetGuard`（C1）组合：per-tenant 的计数器放 `Blackboard`/外部 store，中间件里检查。文档给一个 20 行示例即可。

---

## 7. 设计分叉（已拍板：全部按 A，2026-09-11）

> 用户回复「都选 A」。下表「我的建议」列即最终决策，下方逐条记录后果。

| # | 分叉 | 选项 A | 选项 B | 我的建议 |
|---|---|---|---|---|
| F1 | `signal` 怎么进 `ModelClient` | 放进 `stream` 的 params（显式可见） | 作为独立可选参数 `stream(params, opts?)` | **A**（SDK 天然按 request 传，且 params 是单参现状，改动最小） |
| F2 | 重试默认开还是关 | 缺省**开**（`maxAttempts:3`），`false` 关 | 缺省**关**，用户显式开 | **A** —— 但必须在文档写明「与 SDK 内置重试叠加，建议二选一调」 |
| F3 | SSE 事件粒度 | 只 `text.delta` + `run.end` | 全量（含 `unit.start/end`、`tool.input/output`） | **A**（B 需要把 trace 事件实时外推，架构代价大，后置） |
| F4 | 鉴权钩子失败怎么表达 | 抛错即 401（可带 `status`/`body`） | 返回显式 `{ ok:false, status, body }` | **A**（与「工具抛错即 is_error」的既有风格一致） |
| F5 | `budget_exceeded` 算成功还是失败 | `failed`（没跑完） | `succeeded`（护栏是流程一部分） | **A** |
| F6 | 会话持久化 | 新增 `SessionStore`（与 `MemoryStore` 并列） | 扩展 `MemoryStore` 承载 messages | **A**（两者语义正交，合并会让「键值黑板」变糊） |
| F7 | MCP 连接器落点 | 独立可选包 `@migor/mcp`（框架零依赖） | 直接进 `src/integrations/mcp.ts`（含 stdio/HTTP 实现） | **A**（守住「零运行时依赖」；框架只留 duck-typed 桥） |
| F8 | 任务完成回调 | 先做进程内 `TaskSink` | 直接做 webhook（含重试/签名） | **A**（webhook 可用 sink+fetch 自搭；先给最小缝） |

---

## 8. 风险与不做的事

**风险**
- **A1 的语义变更面最大**：`runTimeoutMs` 从「放弃等待」变「真 abort」是**行为变更**（可能让原本「跑完但白等」的任务变成真失败）—— 须记 `spec §10`，并在 `usage-guide §7` 更新那条边界。
- **A2 与 SDK 内置重试叠加** → 上游被重试放大。缓解：默认参数保守 + 文档写明二选一。
- **C3 真流式** 会显著增加 OpenAI 适配器的解析复杂度（`tool_calls` 增量按 index 累积易错）—— 必须带足单测（含「流中 tool_calls 分片」的 case）。
- **D1 MCP** 的协议演进快 → 只承诺 `McpClientLike` 这个**最小结构面**，协议细节推给连接器包，避免框架被协议变更拖着走。

**不做（YAGNI，写清以防反复讨论）**
- MCP `sampling` / `resources` / `prompts` 原语；
- 跨 run 账单报表与多维成本分析（trace v1 边界之外）；
- 向量/检索式记忆（`MemoryStore` 只承诺 load/save 两钩子）；
- 可视化编排 / DAG 编辑器（框架是代码优先）；
- 内置 API-Key/JWT 实现（只给缝）；
- A/B 实验与提示词平台。

---

## 9. 验证标准（每期收尾的命令）

```bash
npm run typecheck && npm run build && npm run typecheck:types && \
npm run typecheck:tests && npm run build:cli && npm test && \
npm run e2e && npm run build:website
```

外加**该期特有**的端到端证明：
- A1：HTTP 断连 → run 记录 `aborted`；且 mock client 收到 abort。
- A2：429 后重试成功；trace 两个 turn。
- A3：`curl -N` 收到多帧 `text.delta` + `run.end`。
- B1/B2：`/healthz` 反映在飞数；drain 生效。
- C1：超预算 run 以 `budget_exceeded` 收尾。
- D1：真接一个 MCP server（如 `mcp-server-time`），`agentia doctor` 能看到其工具进菜单。
  **落地方式（实测）**：`npm run e2e:mcp` —— 真起 `uvx mcp-server-time`（第三方 server，真 stdio JSON-RPC），
  走完「`tools/list` → `mcpTools()` 映射 → `createApp` 主菜单 → 真跑一轮（模型经它拿到真实时区时间）」。
  注：`agentia doctor` 是**静态**体检（不 import 用户代码，见 spec §10），它只能看到「MCP 单元已登记且入口齐全」；
  「工具进了菜单」这条由 e2e 脚本打印 `app.tools` 来证明。无网 / 无 uv 时自动回落
  `scripts/mcp-fixture-server.py`（同一协议面）。

每期完成后：更新 `roadmap.md` 状态 + `spec.md §10` 决策记录 + `usage-guide.md`（及派生的 `llms.txt`/`dist/AGENTS.md`）。
