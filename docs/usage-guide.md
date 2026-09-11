# Agentia 使用说明（给 AI 与人）

> 本文件是 **AI 辅助编码的权威入口**，也是人类速查表。
> 仓库根部的 `AGENTS.md` 讲的是「怎么改这个仓库」；**本文件讲的是「怎么用这个框架」**。
> 文中所有 API 名与选项名都由框架仓库的测试对着源码校验 —— 改名会立刻失败，不会静默过期。

包名：`@migor/agentia`（框架）/ `@migor/cli`（命令行）。Node ≥ 18，ESM，TypeScript 7。

---

## 0. 心智模型（先读这一段）

一次 **run** = 一个 agent 循环跑完一件事，产出一条 **trace**（`traceId === runId`）。

你声明 **四类单元**，它们进同一个「工具菜单」；**主 agent 的模型按 `description` 自己选**：

| 单元 | 装饰器 | 谁决定流程 | 典型用途 |
|---|---|---|---|
| 工具 | `@Tool` | 你的代码（一次调用 = 一个函数） | 确定性操作：查库、算数、调 API |
| 技能 | `@Skill` | 你的代码（脚本式，可显式调模型） | 「先取数 → 再让模型写 → 再加工」这种固定流程 |
| 子 agent | `@SubAgent` | **模型自己**（独立循环 + 裁剪上下文） | 需要自主多步、且中间过程不该污染主上下文 |
| 提示资产 | `@Prompt` | 模型拉取（本质是「按需注入的文本」） | 长文规范/模板，平时不进上下文，需要时拉 |

**关键推论**：单元是**运行时**从装饰器注册表收集的，所以 TypeScript 里**没有**「你的单元清单」这种类型 ——
不要写 `app.hello()`。模型通过 `description` 选单元，你通过 `schema` 约束入参。

---

## 1. 最小可运行示例

```ts
import { Tool, createApp, SystemPrompt } from '@migor/agentia';

const OBJ = { type: 'object', properties: {} } as const;

class Greeter {
  @Tool({
    description: '向某人打招呼',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  })
  say_hello(input: { name: string }): string {
    return `你好，${input.name}`;
  }
}

const app = createApp({
  name: 'greeter',
  providers: [{ provide: 'greeter', useClass: Greeter }],
  system: new SystemPrompt().add('role', '你是友好的助手。', true),
});

const { result } = await app.run([{ role: 'user', content: '跟小明打个招呼' }]);
console.log(result.finalText, result.stopReason, result.trace.totalUsage);
```

要点：
- `@Tool` 方法的**入参必须显式标注类型**（TS 无法从 JSON Schema 反向推断方法形参；`strict` 下不标注会报隐式 any）。
- `schema` 是给**模型**看的契约；方法形参类型是给**你和编译器**看的。想避免两处双写，见第 5 节 `fromZod<T>`。
- 相对 import 必须带 `.js` 后缀（NodeNext）。

---

## 2. 项目结构（CLI 约定）

```bash
npx @migor/cli create my-app     # 脚手架
cd my-app && npm install
export ANTHROPIC_API_KEY=sk-ant-...
npx @migor/cli dev               # tsx watch + 本地 inspector 面板
npx @migor/cli g tool fetch-weather   # 生成单元文件夹（tool/skill/prompt/subagent）
npx @migor/cli doctor            # 静态体检（未登记/悬空/命名/重复）
```

`units/<name>/index.ts` 的 `default export` 支持三种形态：**类**（token = 文件夹名）、**Provider 对象**、**Provider 数组**。

> **陷阱**：装饰器注册表是模块级 `WeakMap`。框架必须是**单一模块实例** —— 混用 `src` 与 `dist`、或在一个仓库里装两份 agentia，会让单元收集为空。让 CLI 生成的 `package.json` 里只依赖一份框架即可。

---

## 3. 装饰器 spec 字段速查

### `@Tool(spec: ToolSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 模型据此判断何时调用（**必填**，写好它比什么都重要） |
| `schema` | 入参 JSON Schema；传 `fromZod<T>(...)` 可获得签名校验 |
| `name` | 模型可见的工具名，缺省取方法名（建议 snake_case） |
| `strict` | 透传给 Anthropic 的 strict 模式（**框架不校验 schema 合规性**） |

### `@Skill(spec: SkillSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 同 `@Tool` |
| `schema` | 主 agent 传给技能的入参 schema |
| `name` | 缺省取方法名 |
| `model` | `ctx.llm()` 的缺省模型 |
| `maxTokens` | 同上 |
| `maxIterations` | 同上 |
| `tools` | `ctx.llm()` 可调工具：**provider token 列表**（复用该 provider 的 `@Tool` 菜单） |

技能方法体拿到的第二参是 `SkillContext`：`ctx.llm({ prompt })` 才会真正调模型（脚本式，调几次由你写死）。

### `@SubAgent(spec: SubAgentSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 同 `@Tool` |
| `schema` | 主 agent 填给子 agent 的任务入参 schema |
| `name` | 缺省取方法名 |
| `system` | 子 agent 的角色提示：`string` / `SystemPrompt` / `(task) => SystemParam` |
| `tools` | 子 agent 可调工具：**provider token 列表** |
| `model` | 子 agent 自己的模型 |
| `maxTokens` | 同上 |
| `maxIterations` | 同上 |
| `resultSchema` | 给出后子 agent 用隐藏 `submit_result` 提交结构化结果 |

子 agent 是**独立循环 + 裁剪上下文**：主 agent 的历史它看不到，只有最终文本（或 `{ report, result }`）以 tool_result 回流。

### `@Prompt(spec: PromptSpec)`

| 字段 | 说明 |
|---|---|
| `description` | 描述**何时该拉取**这段文本 |
| `name` | 缺省取方法名 |
| `schema` | 模板化入参 schema；缺省空对象（无参资产） |

`@Prompt` **只支持方法形态**（标准装饰器下字段拿不到值/类引用）。方法体内用 `asset(import.meta.url, './x.md')` 读同目录长文本。

---

## 4. `createApp` 与 `app.run` 选项

### `createApp(options: AppOptions)`

| 选项 | 说明 |
|---|---|
| `system` | **必填**。`SystemPrompt` 实例（自动打 cache breakpoint）或已拼好的 `SystemParam` |
| `name` | 应用名，同时作为 run 名写进 trace |
| `providers` | DI providers：`useValue` / `useClass` / `useFactory` + `deps` |
| `modules` | 能力包（`defineModule({ providers, middleware })`），模块级先注册、应用级可覆盖同 token |
| `discover` | 单元目录路径（给出后 `createApp` 返回 `Promise<AgentApp>`） |
| `model` | 缺省模型；不给则 `AGENTIA_MODEL` env，再回落 `claude-opus-5` |
| `maxTokens` | 缺省 `max_tokens` |
| `maxIterations` | 缺省循环上限 |
| `contextPolicy` | 上下文预算策略（`createBudgetPolicy(...)`） |
| `toolSources` | 白名单：只把这些 provider 的单元放进主菜单 |
| `middleware` | 单元调用中间件（洋葱链，链序 = 注册顺序） |
| `sinks` | trace 出口，run 收尾投递 |
| `maxTotalTokens` | 缺省成本硬管控：整条 run 累计 token 上限（可被单次 run 覆盖） |
| `maxCostUsd` | 缺省成本硬管控：累计成本（美元）上限（依赖模型在价格表内） |
| `toolTimeoutMs` | 缺省单工具超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run |
| `maxToolConcurrency` | 缺省同回合并行工具上限；不设 = 不限（全并行） |

### `app.run(messages, opts?: RunAppOptions)`

| 选项 | 说明 |
|---|---|
| `system` | 单次覆盖 system（volatile 段建议每 run 重建） |
| `model` | 单次覆盖模型 |
| `maxTokens` | 单次覆盖 |
| `maxIterations` | 单次覆盖 |
| `client` | 注入 `ModelClient`（换 OpenAI 兼容端点等） |
| `onText` | 文本增量回调（SSE/终端） |
| `blackboard` | 预置黑板种子（配 `Blackboard` 声明合并有键补全） |
| `contextPolicy` | 单次覆盖上下文策略 |
| `idempotencyKey` | 幂等键（异步宿主的 at-least-once 去重依据） |
| `rethrow` | 硬失败是否抛出；缺省 `true`（异步宿主置 `false`，落 failed 记录而非冒泡） |
| `tools` | 单次覆盖工具菜单 |
| `resultSchema` | 结构化结果 schema；配 `fromZod<T>` 可让 `result.typed` 自动是 `T` |
| `maxTotalTokens` | 成本硬管控：整条 run 累计 token 上限；超限以 `stopReason='budget_exceeded'` 收尾（**算失败**） |
| `maxCostUsd` | 成本硬管控：累计成本（美元）上限；模型不在价格表内时不触发（要兜底用 `maxTotalTokens`） |
| `toolTimeoutMs` | 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，run 继续 |
| `maxToolConcurrency` | 同回合并行工具上限；缺省不限 |
| `session` | 会话持久化 `{ store, id }`：run 前拼历史、成功收尾追加本轮（见 `SessionStore`） |

返回 `AgentRunOutput`：`{ run, result }`。`result` 含 `trace` / `stopReason` / `finalText` / `iterations` / `error` / `typed`。

---

## 5. 类型链路（这块决定「编辑器给不给提示」）

三条链路默认是**关闭**的（为向后兼容），声明后才生效。**写 AI 代码时优先用它们**，因为它把「两处双写」变成「一处声明、编译器兜底」。

### 5.1 黑板键：`Blackboard` 声明合并

不声明时 `ctx.get('任意字符串')` 返回 `unknown`（人肉记键名）。声明一次，全局生效：

```ts
declare module '@migor/agentia' {
  interface Blackboard {
    profile: { name: string; vip: boolean };
    turnCount: number;
  }
}
// 之后：
ctx.get('profile');   // { name: string; vip: boolean } | undefined
ctx.set('turnCount', 1);
ctx.get('profil');    // ✗ 编译期报错（键不存在）
```

动态键（运行期算出来的 `string`）拿不到字面量联合，按文档断言：`ctx.get(key as BlackboardKey)`。

### 5.2 schema 即单一事实来源：`fromZod<T>`

```ts
const Weather = z.object({ city: z.string(), days: z.number().int().min(1).max(7) });

class WeatherTools {
  @Tool({
    description: '查天气',
    schema: fromZod<z.infer<typeof Weather>>(z.toJSONSchema(Weather) as JsonSchema, Weather),
  })
  get_weather(input: { city: string; days: number }): string {
    return `${input.city} ${input.days}`;
  }
}
```

- 框架**永不 import zod**（duck-typed，只认 `safeParse`）；
- `fromZod<T>` 之后，**方法签名与 `T` 不一致会编译期报错** —— 不用手写泛型；
- 不写 `<T>`（或直接用裸 JsonSchema）→ 入参回落 `any`，**不校验**（旧行为，不算错，只是没护栏）。

### 5.3 结构化结果：`typed` 自动推导

```ts
const { result } = await app.run(messages, {
  resultSchema: fromZod<{ answer: string }>(schema, zodSchema),
});
result.typed;   // { answer: string } | undefined
```

模型没提交就是 `undefined`（不是失败）。`stopReason` 仍以 `end_turn` 正常收尾。

---

## 6. 运行时 API

### `RunContext`（`RunContext.current()`，run 内任意异步上下文可取）

| 成员 | 说明 |
|---|---|
| `runId` | 本次 run 的 id（== traceId） |
| `get` | 读黑板（配 `Blackboard` 有键类型） |
| `set` | 写黑板（链式返回 this） |
| `has` | 键是否存在 |
| `delete` | 删除键 |
| `keys` | 当前全部键 |

### `SkillContext`（`@Skill` 方法第二参）

| 成员 | 说明 |
|---|---|
| `model` | 本次技能的缺省模型 |
| `llm` | 受限子运行：`await ctx.llm({ prompt })` / `{ messages, system, model, maxTokens, maxIterations }` |

### 装配与执行

| API | 说明 |
|---|---|
| `createApp` | 装配应用（同步；带 `discover` 时为 `Promise<AgentApp>`） |
| `AgentApp` | `run` / `tools` / `container` / `name` |
| `defineModule` | 定义能力包 |
| `executeRun` | 低层 run 入口（自己管 `Run`/trace sink/记忆） |
| `runAgent` | 更底层：只要一个循环 + trace，不管 run 生命周期 |
| `SystemPrompt` | 系统提示拼装 + cache 布局 |
| `Container` | 显式 DI：`register` / `resolve` / `has` / `registered` |
| `validateJsonSchema` | 框架的 JSON Schema 子集校验（含路径的可读错误） |
| `classifyError` | 异常 → `{ type, message, retryable }` |
| `isSuccessStopReason` | `end_turn` / `stop_sequence` 都算正常收尾 |
| `resolveDefaultModel` | 显式 > `AGENTIA_MODEL` > `claude-opus-5` |

### 宿主（换宿主不换语义）

| API | 说明 |
|---|---|
| `createHttpHandler` | `(req,res)` handler：`POST /run` 同步（带 `Accept: text/event-stream` 则 SSE 流式）、`POST /tasks` 异步、`GET /tasks/:id`、`GET /healthz`；返回值另带 `drain()` 与 `runner` |
| `AsyncRunner` | 异步任务宿主（`submit` / `poll` / `awaitTask` / `resumePending` / `drain`） |
| `TaskSink` | 任务完成回调 `{ onFinished(rec) }`，配 `AsyncRunner({ taskSinks })`；抛错被吞 |
| `HttpException` | 鉴权钩子抛出以自定 HTTP 状态与响应体（抛别的错误一律按 401 处理） |
| `Scheduler` | 定时触发（`every` / `at`） |
| `runSync` | 同步 RPC（`(input, opts?) => result`） |
| `InMemoryTaskStore` | 内存任务存储（可设 `maxRecords` 做内存闸门） |
| `FileTaskStore` | JSONL 耐久存储（`compact()` 可压实日志） |
| `SqliteTaskStore` | `node:sqlite` 耐久存储（WAL + busy_timeout） |
| `RedisTaskStore` | duck-typed Redis 存储（可设 `ttlSeconds`） |

### `createHttpHandler(app, opts?: HttpHandlerOptions)`

| 选项 | 说明 |
|---|---|
| `authenticate` | 入口鉴权钩子：**除 `/healthz` 外所有路径**都过它，且在**读 body 之前**（未通过就不收 body）。正常返回即通过；抛 `HttpException` 按其 `status`/`body` 回；抛别的错误回 401，原文只进服务端日志。框架**不实现策略**（不读 env、不碰凭据） |
| `maxBodyBytes` | 请求 body 上限（字节），超限回 413；缺省 1 MiB |
| `maxConcurrentRuns` | 同时在跑的 `POST /run` 上限，超限回 503 + `Retry-After`；缺省 32（传 `Infinity` 恢复无上限） |
| `exposeErrors` | 是否把内部异常原文回给调用方；缺省 `false`（细节只进服务端日志） |
| `runner` | 注入 `AsyncRunner`（共用 store / 并发上限 / `resumePending`）；缺省内部 `new AsyncRunner(app)` |

返回值另外挂着两样（不影响 `(req,res)` 的调用形状）：

- **`handler.drain(opts?)`** —— 优雅停机：拒新单（`POST /run` 与 `/tasks` → 503，`GET /tasks/:id` 仍可轮询）→ 等异步任务与在飞同步 run 收尾 → 强制收口仍开着的 SSE 流。返回是否排空干净；超时返回 `false`，**未完成的任务留在 store 里**，下次启动由 `resumePending` 续跑（不是丢弃）。`timeoutMs` 缺省 0 = 一直等。
  **框架不订阅信号** —— `process.on('SIGTERM', () => handler.drain())` 是宿主的事（同「框架不读 env」）。
- **`handler.runner`** —— 内部 `AsyncRunner`，需要时手动控制（`resumePending` / `awaitTask` / `list`）。

```ts
const handler = createHttpHandler(app, {
  // 只给缝：token/JWT/签名策略由你的宿主或反代实现
  authenticate: (req) => {
    if (req.headers['x-api-key'] !== expected) throw new HttpException(401, { error: '无效凭据' });
  },
});
http.createServer(handler).listen(3000);

process.on('SIGTERM', async () => {
  const clean = await handler.drain({ timeoutMs: 15_000 });
  console.log(clean ? '已排空' : '超时收口，剩余任务下次启动续跑');
  process.exit(0);
});
```

### `GET /healthz` → `HealthResponse`

| 字段 | 说明 |
|---|---|
| `ok` | 恒 `true` —— 能回这个响应就说明进程活着（停机中也是 `true`，就绪与否看 `draining`） |
| `inFlight` | 在飞工作量 = 正在处理的同步 run（含 SSE 流）+ 已受理未完成的异步任务（queued + running）；与 `drain()` 等的范围一致 |
| `uptimeMs` | 本 handler 创建至今的毫秒数 |
| `draining` | 是否已进入优雅停机 —— 负载均衡据此摘流量 |

**不鉴权**（探针带不了凭据），且停机中也照回 200。非 `GET` 回 405。

### 取消 / 重试 / 流式 / 并发闸门

| API | 说明 |
|---|---|
| `combineSignals` | 合成多个中断源（调用方 / 超时 / 断连），任一触发即中止 |
| `DEFAULT_RETRY` | 缺省重试参数（maxAttempts=3、指数退避 + 抖动）—— 缺省**开启** |
| `isAbortError` | 判定异常是否为中断（`name === 'AbortError'`） |
| `mapWithConcurrency` | 有界并发 map（结果保序）；`maxToolConcurrency` 的底座，也可自用 |

- **取消**：`app.run(messages, { signal })` 传 `AbortSignal` —— 框架会 abort 在飞请求（内置 Anthropic / OpenAI 适配器都转发 `signal`），run 以 `stopReason='aborted'` 收尾（算失败）。`createHttpHandler` 已内置「客户端断开即中止」；`AsyncRunner.runTimeoutMs` 到点同样是**真中止**。
- **重试**：缺省自动重试可重试失败（429 / 5xx / 连接失败），指数退避 + 抖动。`retry: false` 关闭，或 `retry: { maxAttempts, baseDelayMs, maxDelayMs, jitter, onRetry }` 调参。**只在本次尝试尚未产出任何文本时重试**（已吐出的字无法撤回）。⚠️ 与 SDK 内置重试叠加 —— 建议二选一调（这里 `maxAttempts: 1` 或把 SDK 的 `maxRetries` 调小）。
- **流式**：`POST /run` 带 `Accept: text/event-stream` → SSE 逐帧下发（`text.delta` / `run.end` / `error`）；不带该头仍回一元 JSON。
- **工具超时 / 并发闸门**：`toolTimeoutMs` 超时**不杀 run**（该条 tool_result 记 `is_error`，模型可换路）；`maxToolConcurrency` 给同回合的并行工具设上限（默认全并行）。⚠️ 超时 = **放弃等待**，`AgentTool.run` 没有 signal 参数，**副作用可能已发生** —— 想真停的工具请自行读 `ToolRunContext.signal`。

### 观测

| API | 说明 |
|---|---|
| `TraceSink` | `{ export(trace) }`，run 收尾（成功/失败）都投递，抛错被吞 |
| `registerDefaultTraceSink` | 注册全局默认 sink（构造期快照合并） |
| `TraceRecorder` | 内存 recorder（一次 run 一个） |
| `createOtlpExporter` | OTLP/JSON 导出，零依赖 |

### 长上下文

| API | 说明 |
|---|---|
| `createBudgetPolicy` | 预算策略：超预算先 `trimToolPairs` 编辑，再 `compactMessages` 压缩（带滞回） |
| `trimToolPairs` | context editing：丢旧 tool 对（按**对数**，`keepToolPairs`） |
| `compactMessages` | compaction：旧前缀做摘要（摘要器由你注入，框架不替你造 token） |
| `estimateMessages` | 估算 token（预算决策用，不是精确记账） |

### 成本硬管控（**别与上面的上下文预算混为一谈**）

| API | 说明 |
|---|---|
| `createBudgetGuard` | 执行 `check(trace)` → `'tokens' \| 'cost' \| null` 的护栏（也可只用来自己记账） |

两者是**互补的两件事**，取舍点完全不同：

| | `createBudgetPolicy`（§长上下文） | `BudgetGuard`（本节） |
|---|---|---|
| 时机 | **发送前** | **记账后** |
| 干什么 | 改 messages（丢旧 tool 对 / 压缩旧前缀） | 改 run 结局（超限即停） |
| 为解决 | 历史太长把请求撞 400 / 过早压缩 | **控制花钱** |
| 怎么开 | `contextPolicy` | `maxTotalTokens` / `maxCostUsd` |

- 超限后 run 以 `stopReason='budget_exceeded'` 收尾（**算失败**），run 根记一条 `budget.exceeded` 事件（带 `{ kind, limit, actual, totalTokens, costUsd }`）。
- **不是硬实时**：一回合跑完才判，实际用量可能超上限一个回合的量。
- **模型自然收尾的那一回合超限不改判失败**（只留事件）—— 那次 run 的任务其实做完了，不该追认成失败。
- 子 agent 的 token **计入**总账（口径 = 整个 trace 的 `totalUsage`）。

```ts
const { result } = await app.run(messages, { maxTotalTokens: 200_000 });
if (result.stopReason === 'budget_exceeded') console.warn('这次 run 被预算拦下了', result.error);
```

选项字段（`TrimOptions` / `CompactOptions` / `BudgetPolicyOptions`）：

### `TrimOptions`（`trimToolPairs` 的选项）

| 字段 | 说明 |
|---|---|
| `keepToolPairs` | 保留的最近工具**对数**（tool_use→tool_result）；缺省 1 |

### `CompactOptions`（`compactMessages` 的选项）

| 字段 | 说明 |
|---|---|
| `keepRecent` | 保留的最近消息**条数**；缺省 20 |
| `summarize` | 摘要器：输入被弃旧前缀的渲染文本，返回摘要（框架不替你造 token） |

### `BudgetPolicyOptions`（`createBudgetPolicy` 的选项）

| 字段 | 说明 |
|---|---|
| `budgetTokens` | 预算（估算 input tokens）；缺省 60000 |
| `keepRecent` | compaction 保留的最近消息**条数**；缺省 20 |
| `keepToolPairs` | context editing 保留的最近工具**对数**；缺省 1 |
| `estimateTokens` | token 估算函数（预算决策用，非精确记账） |
| `editBeforeCompact` | 超预算时是否先编辑再压缩；缺省 true |
| `summarize` | 提供则允许 compaction（旧前缀→摘要） |
| `compactEvery` | 距上次压缩至少隔几个回合（滞回）；缺省 1 |

> `keepRecent`（**消息条数**，compaction 用）与 `keepToolPairs`（**工具对数**，context editing 用）是两种单位，刻意分开命名 —— 别拿同一个值套过去。

### 多模型 / 记忆 / 重放

| API | 说明 |
|---|---|
| `createOpenAIClient` | OpenAI 兼容端点适配（DeepSeek 等；**真流式**、图片块转 `image_url`、cache token 恒 0） |
| `InMemoryMemoryStore` | 跨 run 的**键值黑板**记忆（`{ store, keys }` 配 `executeRun`） |
| `InMemorySessionStore` | 跨 run 的**对话历史**（`{ store, id }` 配 `executeRun` / `app.run`）；与前者正交，可同时用 |
| `traceToMessages` | 把 trace 还原成 messages（重放基底） |
| `applyMiddleware` | 手动包裹配置菜单（装配层已自动做） |

---

## 7. 已知边界（如实标注，不要指望框架替你兜）

| 边界 | 说明 |
|---|---|
| 方法入参要自己标注 | TS 不会从 JSON Schema 反向推断方法形参；`strict` 下不标注会报隐式 any |
| 裸 schema 不校验签名 | 只给 `schema: {...}` 时，schema 与方法签名**互不关联**（要护栏就用 `fromZod<T>`） |
| 黑板键默认无类型 | 不合并 `Blackboard` 就是裸 `string` + `unknown`；动态键需 `as BlackboardKey` |
| 没有「单元清单」类型 | 单元是运行时从装饰器注册表收集的，所以 `app.my_tool()` 这种写法不存在 |
| `strict` 只是透传 | 框架**不校验** schema 的合规性（是否 `additionalProperties:false` 等） |
| schema 校验是**子集** | 只覆盖 `type/properties/required/additionalProperties/enum/items`；`format`/`minimum`/`oneOf` 一律放行 |
| 历史畸形就放弃裁剪 | `trimToolPairs` 遇到非严格交替历史会整体放弃（宁可少裁，也不切出孤立 tool_use 让请求 400） |
| 缺省内存 store 不淘汰 | 长跑宿主请设 `InMemoryTaskStore({ maxRecords })` 或换 `FileTaskStore` / `SqliteTaskStore` |
| 单元引用是 provider 粒度 | 子 agent / skill 的 `tools` 写的是 **provider token**，不是单个工具名 |
| 取消要传进客户端才有效 | 传 `signal` 后框架会 abort 在飞请求（内置 Anthropic / OpenAI 适配器都转发）；不转发 `signal` 的自定义 `ModelClient` 只能「放弃等待」（请求在后台跑完、产物丢弃） |
| 观测失败被吞 | sink 抛错不影响 run（观测是辅助动作）；同理记忆水合/回写失败也不击穿 run |
| 框架不读 env | 除 `AGENTIA_MODEL`（缺省模型覆盖）与 `OPENAI_API_KEY`（OpenAI 适配器）外不读环境变量；不含 dev 逻辑 |
| 鉴权只是缝 | 框架**不实现** token / JWT / 签名策略，也不碰凭据 env —— `authenticate` 只承诺「拦在入口、读 body 之前」；策略是宿主或反代的事 |
| 停机不由框架触发 | 框架给 `drain()` 但**不订阅** `SIGTERM`/`SIGINT`（不读 env、不做进程级决策）；信号处理是宿主的 |
| 停机可能切断 SSE | `drain()` 超时后会强制关闭仍开着的 SSE 流，其 run 以 `stopReason='aborted'` 收尾 —— 客户端应把断流当作可重试 |
| 鉴权失败即断连 | 未通过鉴权时在读到 body 之前就回响应，连接**不可复用**（显式 `connection: close`）；这是「不收body省资源」的代价 |
| 预算护栏不是硬实时 | 一回合记账完才判，实际用量可能超上限一个回合的量；模型自然收尾的那回合超限**不算失败**（只留 `budget.exceeded` 事件） |
| `maxCostUsd` 依赖价格表 | 模型不在 `engine/usage.ts` 的价格表内时成本恒为 0，这条护栏**不触发** —— 要无条件兜底用 `maxTotalTokens` |
| 工具超时**不取消**工具 | `AgentTool.run` 没有 signal 参数，超时只是「不等了」；副作用可能已发生。想真停请让工具自己读 `ToolRunContext.signal` |
| 会话只存对话轮次 | `SessionStore` 存「用户输入 + 最终回复」，run 内部的 tool 往返**不进历史**（要完整过程用 `traceToMessages`）；且只有**跑成功**的轮次才回写 |
| OpenAI 适配器听端点的话 | 请求发 `stream:true`，但**按响应形态解析**：端点回 JSON 就退回一次性（没有打字机效果），回 `event-stream` 才逐 token |

---

## 8. 常见错误

| 症状 | 原因与修法 |
|---|---|
| 菜单里没有我的单元 | ① 方法没写装饰器；② 类没注册进 `providers`；③ 框架双实例（见第 2 节陷阱）；④ `toolSources` 白名单把它排除了 |
| `菜单单元重名` 装配期抛错 | 四类单元**共用命名空间**，改名即可 |
| 编译错 `不能把 X 赋给 Y` | 用了 `fromZod<T>`，方法签名与 `T` 不一致（这是护栏，不是 bug） |
| 模型传的入参没被拦 | 只填了 `schema` 没写 `strict`；且框架的校验是**子集校验**（`format`/`minimum` 等不校验） |
| `ctx.get('k')` 没有类型 | 没做 `Blackboard` 声明合并（见 5.1） |
| `result.typed` 是 `unknown` | `resultSchema` 用的是裸 JsonSchema；改 `fromZod<T>`（见 5.3） |
| TS 里想 `app.my_tool(...)` | 不要这样写：单元由模型选择，不是你的方法。要确定性调用就**直接调类方法** |
| 子 agent 调不到工具 | `tools` 是 **provider token**（文件夹名）列表，不是工具名 |
| 长跑内存涨 | 缺省内存 store 不淘汰；设 `InMemoryTaskStore({ maxRecords })` 或换耐久 store |
| 鉴权钩子抛错，客户端只看到「未通过鉴权」 | 这是设计：非 `HttpException` 的错误原文只进服务端日志（要回给调用方就抛 `HttpException(status, body)`） |
| 停机后 `POST /tasks` 回 503 | `drain()` 已被调用（或注入的 runner 已 drain）—— 这是「拒新单」的正常行为，任务没丢 |
| `stopReason` 是 `budget_exceeded`、任务被判失败 | 这是设计（护栏拦下的 run **没跑完**）。只想「记一笔」不想改结局，就自己用 `createBudgetGuard` 读 trace |
| 工具超时了，副作用却还是发生了 | 超时是「放弃等待」不是取消（`AgentTool.run` 收不到 signal）。要能真停就得让工具自己读 `ToolRunContext.signal` |
| 用 OpenAI 端点没看到打字机效果 | 端点没按 `stream:true` 回 `event-stream`（回了一整份 JSON）—— 适配器按响应形态解析，此时退回一次性 |
| 改了框架源码却看不到效果 | 确认 import 的是同一份构建产物（`npm run build` 后跑 `dist`） |

---

## 9. 提交前自检

```bash
npm run typecheck        # src 类型
npm run typecheck:tests  # 测试目录类型（含类型断言测试）
npm run test             # 单测（node:test）
```

框架仓库另有两道：`npm run typecheck:types`（针对构建产物的类型测试）、`npm run e2e`。
