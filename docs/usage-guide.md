# Agentia 使用说明（给 AI 与人）

> 本文件是 **AI 辅助编码的权威入口**，也是人类速查表。
> 仓库根部的 `AGENTS.md` 讲的是「怎么改这个仓库」；**本文件讲的是「怎么用这个框架」**。
> 文中所有 API 名与选项名都由框架仓库的测试对着源码校验 —— 改名会立刻失败，不会静默过期。

包名：`@migor/agentia`（框架）/ `@migor/cli`（命令行）。Node ≥ 18，ESM，TypeScript 7。

---

## 0. 心智模型（先读这一段）

一次 **run** = 一个 agent 循环跑完一件事，产出一条 **trace**（`traceId === runId`）。

你声明 **四类能力**，它们进同一个「工具菜单」；**主 agent 的模型按 `description` 自己选**：

| 能力 | 装饰器 | 谁决定流程 | 典型用途 |
|---|---|---|---|
| 工具 | `@Tool` | 你的代码（一次调用 = 一个函数） | 确定性操作：查库、算数、调 API |
| 技能 | `@Skill` | 你的代码（脚本式，可显式调模型） | 「先取数 → 再让模型写 → 再加工」这种固定流程 |
| 子 agent | `@SubAgent` | **模型自己**（独立循环 + 裁剪上下文） | 需要自主多步、且中间过程不该污染主上下文 |
| 提示资产 | `@Prompt` | 模型拉取（本质是「按需注入的文本」） | 长文规范/模板，平时不进上下文，需要时拉 |

**关键推论**：能力是**运行时**从装饰器注册表收集的，所以 TypeScript 里**没有**「你的能力清单」这种类型 ——
不要写 `app.hello()`。模型通过 `description` 选能力，你通过 `schema` 约束入参。

**同样是一等公民的是可观测**：这条 trace 带每步的 token / 成本 / 耗时 / 错误类型，run 收尾经 `TraceSink`
出口交给你（落库 / 采样 / 脱敏都在缝外，见 §6「观测」）。一句话——**四类能力决定它能做什么，trace 决定你敢不敢上线**。

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
npx @migor/cli create my-app     # 脚手架（含 .env / .env.example）
cd my-app && npm install
$EDITOR .env                     # 填 ANTHROPIC_API_KEY（脚手架已生成，且已被 .gitignore 挡住）
npx @migor/cli dev               # tsx watch + 本地 inspector 面板
npx @migor/cli g tool fetch-weather   # 生成到 src/tools/fetch-weather/（skill/prompt/subagent 同理）
npx @migor/cli doctor            # 静态体检（未登记/悬空/命名/重复）
```

四分类目录，一能力一文件夹：`src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/` —— **目录名就是类型**，不用记别名。每个文件夹的 `index.ts` 是入口，`default export` 支持三种形态：**类**（token = 文件夹名）、**Provider 对象**、**Provider 数组**。显式注册表在 `src/registry.ts`（`agentia g` 自动维护，也可手改）。

> **陷阱**：装饰器注册表是模块级 `WeakMap`。框架必须是**单一模块实例** —— 混用 `src` 与 `dist`、或在一个仓库里装两份 agentia，会让能力收集为空。让 CLI 生成的 `package.json` 里只依赖一份框架即可。

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

`@Prompt` **只支持方法形态**（标准装饰器下字段拿不到值/类引用）。实例方法与静态方法都**沿继承链**收集（父类的 `@Prompt` 资产子类自动带上）。方法体内用 `asset(import.meta.url, './x.md')` 读同目录长文本。

---

## 4. `createApp` 与 `app.run` 选项

### `createApp(options: AppOptions)`

| 选项 | 说明 |
|---|---|
| `system` | **必填**。`SystemPrompt` 实例（自动打 cache breakpoint）或已拼好的 `SystemParam` |
| `name` | 应用名，同时作为 run 名写进 trace |
| `providers` | DI providers：`useValue` / `useClass` / `useFactory` + `deps` |
| `modules` | 能力包（`defineModule({ providers, middleware })`），模块级先注册、应用级可覆盖同 token |
| `discover` | 能力目录路径：**一个目录或一组目录**（数组顺序即装配顺序，典型是四分类目录）。给出后 `createApp` 返回 `Promise<AgentApp>`；数组里任一目录不存在会**报错**（显式给出的搜索路径不该静默落空） |
| `model` | 缺省模型；不给则 `AGENTIA_MODEL` env，再回落 `claude-opus-5` |
| `maxTokens` | 缺省 `max_tokens` |
| `maxIterations` | 缺省循环上限 |
| `retry` | 缺省模型请求重试策略（可被单次 run 覆盖）：缺省**开启**（`DEFAULT_RETRY`：maxAttempts=3、指数退避 + 抖动）；`false` 关闭 |
| `contextPolicy` | 上下文预算策略（`createBudgetPolicy(...)`）；带状态的策略应实现 `forRun()` 按 run 隔离（见 §长上下文） |
| `toolSources` | 白名单：只把这些 provider 的能力放进主菜单 |
| `tools` | 直接追加到主菜单的**裸工具**（`AgentTool[]`）：给「构造期才知道有哪些工具」的场合（典型：MCP 桥，见 §6）。与能力**同过中间件、同进重名查重**，不是旁路 |
| `middleware` | 能力调用中间件（洋葱链，链序 = 注册顺序） |
| `sinks` | trace 出口，run 收尾投递 |
| `maxTotalTokens` | 缺省成本硬管控：整条 run（**含子 agent / skill 子循环**，上限经 `ToolRunContext` 透传）累计 token 上限（可被单次 run 覆盖） |
| `maxCostUsd` | 缺省成本硬管控：累计成本（美元）上限（**依赖模型在价格表内**，见 `priceOverrides`；未定价模型会留 `usage.unpriced` 事件，所以「护栏有没有真的生效」看得见） |
| `priceOverrides` | 价格表覆盖/追加（`$/1M tokens`）：覆盖内置同名项，或给非 Anthropic 模型定价（如 `{ 'deepseek-chat': { in: 0.27, out: 1.10 } }`）。**透传给子 agent/skill 的子循环** —— 不会「主 agent 有成本、子 agent 恒 0」。非法单价在 run 开始即抛错 |
| `onUnpricedModel` | 遇到价格表外的模型时回调（`{ model, spanId }`，每个循环作用域内每模型一次）；抛错被吞，**不改变 run 结局**（定价缺失是宿主配置问题）。用它接告警 |
| `toolTimeoutMs` | 缺省单工具超时（毫秒）；超时该条 tool_result 记 is_error，不杀 run |
| `maxToolConcurrency` | 缺省同回合并行工具上限；不设 = 不限（全并行） |
| `maxEventChars` | 缺省 trace 事件正文截断上限（可被单次 run 覆盖）：数字 = 入参/出参统一用该上限，`false` = **不截断**（完整正文进 trace，面板里能展开看全文）；不设 = 框架缺省 |

### `app.run(messages, opts?: RunAppOptions)`

| 选项 | 说明 |
|---|---|
| `system` | 单次覆盖 system（volatile 段建议每 run 重建） |
| `model` | 单次覆盖模型 |
| `maxTokens` | 单次覆盖 |
| `maxIterations` | 单次覆盖 |
| `client` | 注入 `ModelClient`（换 OpenAI 兼容端点等） |
| `onText` | 文本增量回调（SSE/终端） |
| `signal` | `AbortSignal`：中止则在飞请求被取消，run 以 `stopReason='aborted'` 收尾（算失败） |
| `blackboard` | 预置黑板种子（配 `Blackboard` 声明合并有键补全） |
| `contextPolicy` | 单次覆盖上下文策略 |
| `retry` | 单次覆盖重试策略：`false` 关闭，或 `{ maxAttempts, baseDelayMs, maxDelayMs, jitter, onRetry }` 调参（只重试「本次尝试尚未产出文本」的可重试失败） |
| `idempotencyKey` | 幂等键（异步宿主的 at-least-once 去重依据） |
| `rethrow` | 硬失败是否抛出；缺省 `true`（异步宿主置 `false`，落 failed 记录而非冒泡） |
| `tools` | 单次覆盖工具菜单（**同样过装配期那条中间件链**，不是旁路 —— 否则 per-run 覆盖就绕开了鉴权/限流/审计） |
| `resultSchema` | 结构化结果 schema；配 `fromZod<T>` 可让 `result.typed` 自动是 `T` |
| `maxTotalTokens` | 成本硬管控：整条 run（**含子 agent / skill 子循环**，各级共享同一 recorder 的累计账单）累计 token 上限；超限以 `stopReason='budget_exceeded'` 收尾（**算失败**） |
| `maxCostUsd` | 成本硬管控：累计成本（美元）上限；模型不在价格表内时**不触发**（用 `priceOverrides` 定价，或用 `maxTotalTokens` 兜底） |
| `priceOverrides` | 单次覆盖价格表（`$/1M tokens`）；语义同 `createApp` 的 `priceOverrides` |
| `onUnpricedModel` | 单次覆盖未定价回调（**是函数，因此不在 transport 的 `RunInvocationOptions` 里** —— 异步宿主不会替你传） |
| `toolTimeoutMs` | 单个工具执行超时（毫秒）；超时该条 tool_result 记 is_error，run 继续 |
| `maxToolConcurrency` | 同回合并行工具上限；缺省不限 |
| `maxEventChars` | trace 事件正文截断上限（字符）：数字 = 入参/出参统一用该上限，`false` = **不截断**；缺省按类型收敛（入参/成功出参 2000、失败出参 1000）。**透传给子 agent/skill 的子循环** —— 同一棵调用树上口径一致。只影响**记账**，回给模型的 tool_result 永远完整 |
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

### 环境变量与 `.env`（`loadEnvFile`）

| API | 说明 |
|---|---|
| `loadEnvFile` | 读一份 `.env` 进 `process.env`，返回**本次真正生效**的键；选项 `LoadEnvOptions`：`{ path?, override? }` |

```ts
import { createApp, loadEnvFile } from '@migor/agentia';

loadEnvFile(); // 缺省 cwd/.env；文件不存在 = 静默返回 {}（首次 clone、CI 的正常路径）
const app = await createApp({ ... });
```

三条语义（都刻意，别当成实现细节）：

- **框架不自动读 `.env`** —— 读哪个文件、什么时候读是宿主的启动决策。塞进 `createApp` 里自动做，会让「同一份代码换个目录跑结果不同」变成要花时间排查的悬案；而放 CLI 里只有 `agentia dev` 生效。写在**你的** `main.ts` 里，`node dist/main.js`、docker、别的宿主都一样读得到。
- **真实环境变量优先**（缺省不覆盖）：`process.env` 里已定义（哪怕空串）的键保持不动 —— CI / docker / `FOO=bar npm start` 永远赢过文件。要让文件里的值压过环境变量就 `loadEnvFile({ override: true })`。
- **想知道「生效没」看返回值**，别去看文件：被挡下的键不在返回对象里。

`agentia create` 生成的脚手架把 `.env`、`.env.example` 与 `main.ts` 首行的 `loadEnvFile();` 都备好了，并在 `.gitignore` 里挡住 `.env` —— 生成 `.env` 却不 ignore，等于把 key 送进用户的第一个 commit。

> ⚠️ **本机 export 过 `ANTHROPIC_API_KEY` 的人**（比如同时用 Claude Code）：按上面的优先级，脚手架 `.env` 里的 key 会被**静默压住**。改了 `.env` 却「没生效」时，先 `echo $ANTHROPIC_API_KEY` 看看环境里是不是已经有一份。

解析规则（刻意窄，够用就好）：`KEY=VALUE`，允许 `export ` 前缀与 `=` 两侧空白；`#` 整行注释；单引号内原样、双引号内认 `\n \r \t \" \\`；未加引号的值里 ` #` 起为行内注释。键名 `__proto__` **显式报错**（它会走原型 setter 被静默吞掉 —— 正是「以为配上了其实没配上」）。**不做变量展开、不合并续行**（需要就上专门的库）；既不像 `KEY=VALUE` 又不是注释的行**直接报错并指出行号** —— 静默跳过等于让你以为「配上了其实没配上」。

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
| `RedisTaskStore` | duck-typed Redis 存储（可设 `ttlSeconds`）；客户端结构面 `get` / `set` / `del` / `keys`（或 `scanIterator`），外加设 TTL 时必需的 `expire`。`set` **只传两参** —— 尾参的选项形状两家相反：ioredis 认位置参数 `('EX', n)`、node-redis 认对象 `{ EX: n }`，取任何一种都会在另一家上失效（ioredis 会把对象字符串化成 `"[object Object]"` 报语法错；**node-redis 的 `SET` 只声明三个形参，位置参数被静默丢弃**）。所以 TTL 一律走 `expire(key, seconds)`（两家同名同形）；设了 `ttlSeconds > 0` 却没给 `expire` 时**构造期抛错**，不静默丢掉 TTL |

### HTTP 端点速查（`createHttpHandler` 的路由）

| 端点 | 请求 | 响应 |
|---|---|---|
| `POST /run` | body 是 `RunInput`（string / messages / `{prompt\|text\|messages}`）；带 `Accept: text/event-stream` 则走 SSE | 200 `{ runId, status, stopReason, finalText, typed?, trace, error? }` —— **`status=failed` 也照返 200**（`rethrow:false` 语义：硬失败以 `error` 字段表达，不用 HTTP 错误码） |
| `POST /tasks` | `{ input, idempotencyKey?, options? }` —— `input` 同 `RunInput`；`options` 是 `RunInvocationOptions` | 202 `TaskRecord`（`status: 'queued'`）；同 `idempotencyKey` 未失败则去重，直接返回既有记录 |
| `GET /tasks/:id` | — | 200 `TaskRecord`；不存在 → 404。**停机中仍可轮询**（否则拿不到在飞任务的结果） |
| `GET /healthz` | — | 200 `HealthResponse`；**不鉴权**，停机中也回 200 |
| `GET /metrics` | — | 200 Prometheus 文本（`text/plain; version=0.0.4`）；**需在 `createHttpHandler` 里传 `metrics`**，**不鉴权**（与 `/healthz` 同档），停机中也回 |

方法不符 → 405（带 `Allow` 头）；路径不符 → 404；body 非法 JSON → 400；body 超 `maxBodyBytes` → 413；
`POST /run` 超 `maxConcurrentRuns` → 503 + `Retry-After`；停机中 `POST /run`、`POST /tasks` → 503。

**换 model client 的缝**：HTTP 宿主**不持有 client** —— 同步 `/run` 走的是 `app.run(messages, opts)`，
而 `AppCallable` 就是 `{ name, run }`。所以要换 provider（OpenAI 兼容端点 / 自建 client），
**包一层**把 `client` 补进 `opts` 即可：

```ts
const callable = { name: app.name, run: (msgs, opts) => app.run(msgs, { ...opts, client: myClient }) };
const handler = createHttpHandler(callable, { runner });
```

异步侧更直接：`AsyncRunner` 的构造选项就有 `client`。完整可跑写法见仓库 `examples/complete/`
（**不随 npm 包发布** —— 包里只有 `dist/`、README、LICENSE 与本说明）：
<https://github.com/retrychx/agentia/tree/main/examples/complete>

### `createHttpHandler(app, opts?: HttpHandlerOptions)`

| 选项 | 说明 |
|---|---|
| `authenticate` | 入口鉴权钩子：**除 `/healthz` 与 `/metrics` 外所有路径**都过它，且在**读 body 之前**（未通过就不收 body）。正常返回即通过；抛 `HttpException` 按其 `status`/`body` 回；抛别的错误回 401，原文只进服务端日志。框架**不实现策略**（不读 env、不碰凭据） |
| `metrics` | 指标出口：给 `metricsSink()`（或任意 `{ render() }` / 返回字符串的闭包）后，`GET /metrics` 回它的 Prometheus 文本。**不鉴权**（拉取端在集群内网）；要保护请放反代后面。不给则该路径 404。⚠️ 这只管**渲染** —— 数字要真的累计，必须把**同一个** sink 注册进 `createApp({ sinks: [metrics] })`（它靠 run 收尾投递，不自己埋点），否则 `/metrics` 恒为 0 **且不报错** |
| `maxBodyBytes` | 请求 body 上限（字节），超限回 413；缺省 1 MiB |
| `maxConcurrentRuns` | 同时在跑的 `POST /run` 上限，超限回 503 + `Retry-After`；缺省 32（传 `Infinity` 恢复无上限）。构造期校验：必须 > 0 或 Infinity —— NaN 会让闸门静默失效、0/负数会全部 503，故直接抛错 |
| `sseMaxBufferedBytes` | SSE 下游积压上限（字节，`res.writableLength` 超过即收口该 SSE 流并 **abort 对应 run** —— 客户端已经不消费了，继续逐 token 生成只是白烧 token）；缺省 8 MiB |
| `exposeErrors` | 是否把内部异常原文回给调用方；缺省 `false`（细节只进服务端日志） |
| `runner` | 注入 `AsyncRunner`（共用 store / 并发上限 / `resumePending`）；缺省内部 `new AsyncRunner(app)` |

返回值另外挂着两样（不影响 `(req,res)` 的调用形状）：

- **`handler.drain(opts?)`** —— 优雅停机：拒新单（`POST /run` 与 `/tasks` → 503，`GET /tasks/:id` 仍可轮询）→ 等异步任务与在飞同步 run 收尾 → 强制收口仍开着的 SSE 流（**收口同时 abort 对应 run**，以 `stopReason='aborted'` 收尾 —— 只关流不中止会让 run 在后台继续烧 token）。返回是否排空干净；超时返回 `false`，**未完成的任务留在 store 里**，下次启动由 `resumePending` 续跑（不是丢弃）。`timeoutMs` 缺省 0 = 一直等。
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

- **取消**：`app.run(messages, { signal })` 传 `AbortSignal` —— 框架会 abort 在飞请求（内置 Anthropic / OpenAI 适配器都转发 `signal`），run 以 `stopReason='aborted'` 收尾（算失败）。`createHttpHandler` 已内置「客户端断开即中止」；`AsyncRunner.runTimeoutMs` 到点同样是**真中止**（构造期校验：必须 ≥ 0 的**有限**数 —— NaN/Infinity 会被 `setTimeout` 钳到 1ms，等于每个任务立即超时，故直接抛错；要「不限」传 0 或不设）。
- **重试**：缺省自动重试可重试失败（429 / 5xx / 连接失败），指数退避 + 抖动。`retry: false` 关闭，或 `retry: { maxAttempts, baseDelayMs, maxDelayMs, jitter, onRetry }` 调参。**只在本次尝试尚未产出任何文本时重试**（已吐出的字无法撤回）。⚠️ 与 SDK 内置重试叠加 —— 建议二选一调（这里 `maxAttempts: 1` 或把 SDK 的 `maxRetries` 调小）。
- **流式**：`POST /run` 带 `Accept: text/event-stream` → SSE 逐帧下发（`text.delta` / `run.end` / `error`）；不带该头仍回一元 JSON。
- **工具超时 / 并发闸门**：`toolTimeoutMs` 超时**不杀 run**（该条 tool_result 记 `is_error`，模型可换路）；`maxToolConcurrency` 给同回合的并行工具设上限（默认全并行）。⚠️ 超时 = **放弃等待**，`AgentTool.run` 没有 signal 参数，**副作用可能已发生** —— 想真停的工具请自行读 `ToolRunContext.signal`。

### 观测

| API | 说明 |
|---|---|
| `TraceSink` | `{ export(trace) }`，run 收尾（成功/失败）都投递，抛错被吞 |
| `registerDefaultTraceSink` | 注册全局默认 sink（构造期快照合并） |
| `TraceRecorder` | 内存 recorder（一次 run 一个） |
| `createOtlpExporter` | OTLP/JSON 导出，零依赖；选项 `OtlpExporterOptions`：`endpoint` / `headers` / `serviceName` / `timeoutMs`（单次导出超时，缺省 10000，非正数 = 不限 —— 裸 fetch 无超时，collector 半开连接会让 run 收尾永久挂起；超时按导出失败处理，不击穿 run） |
| `metricsSink` | 指标累加器（Prometheus 文本 / OTLP metrics），满足 `TraceSink` 即接入 —— 见 §6「指标」 |
| `buildRunReport` | 从一条 trace 生成**调优报告**（能力/模型的耗时、token、成本、错误率排行）—— 见 §6「调优报告」 |

> **生产落地**（按 runId 落库检索 / 日志关联 / 采样 / 脱敏）见 `docs/observability.md` ——
> 框架只保证 trace 出口，这些都在缝外用 sink 组合；四条现成 sink 的实码在
> `examples/observability/`。**完整的示例**（四类能力 + 三种触发 + 鉴权 + 全观测栈）在 `examples/complete/`；
> 最小可交付示例（Dockerfile + compose）在 `examples/deploy/`。

### 长上下文

| API | 说明 |
|---|---|
| `createBudgetPolicy` | 预算策略：超预算先 `trimToolPairs` 编辑，再 `compactMessages` 压缩（带滞回） |
| `trimToolPairs` | context editing：丢旧 tool 对（按**对数**，`keepToolPairs`） |
| `compactMessages` | compaction：旧前缀做摘要（摘要器由你注入，框架不替你造 token） |
| `estimateMessages` | 估算一组消息的 token（预算决策用，不是精确记账） |
| `defaultEstimateTokens` | 缺省的单文本估算函数（CJK 感知启发式：CJK ≈ 1.5 字/token、其余 ≈ 4 字符/token） |
| `renderMessages` | 把 messages 渲染成纯文本 —— 喂给你注入的 compaction 摘要器（`summarize`）用 |

**per-run 隔离（`ContextPolicy.forRun`）**：策略可能被配成应用级单例（`createApp({ contextPolicy })`）
被所有 run 复用。带状态的实现（滞回计数、token 缓存等）应实现可选的 `forRun(): ContextPolicy` ——
引擎在每条 run 开始时调一次，拿**本 run 专用**的实例（`createBudgetPolicy` 已实现它）；
不实现的自定义策略按单例复用，状态跨 run（含并发 run）共享 —— 适合无状态策略，有状态请实现 `forRun`。

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
- **模型自然收尾的那一回合超限不改判失败**（只留事件）—— 那次 run 的任务其实做完了，不该追认成失败。同理，超预算的回合仍照常处理 `submit_result`（纯内部的结构化提交、零副作用）—— 模型已把最终结果交出来，连同回合丢弃等于白烧这一回合。
- 预算是**整条 run（含各级子 agent / skill 子循环）**的口径：上限经 `ToolRunContext` 透传，各级循环共享同一 recorder 的累计账单、每回合各自检查。子循环超限以 `budget_exceeded` 收尾（该次能力调用记 `is_error`，capability span 上记 `budget.exceeded` 事件），主循环在下一回合**入口**拦住、不再发出新请求，整条 run 以 `budget_exceeded` 收尾。

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
| `createAnthropicClient` | 默认 ModelClient（Anthropic）：自定义只传 `apiKey` / `baseURL`，不必直接依赖厂商 SDK |
| `createOpenAIClient` | OpenAI 兼容端点适配（DeepSeek 等；**真流式**、图片块转 `image_url`、cache token 恒 0） |
| `InMemoryMemoryStore` | 跨 run 的**键值黑板**记忆（`{ store, keys }` 配 `executeRun`） |
| `InMemorySessionStore` | 跨 run 的**对话历史**（`{ store, id }` 配 `executeRun` / `app.run`）；与前者正交，可同时用 |
| `traceToMessages` | 把 trace 还原成 messages（重放基底） |
| `applyMiddleware` | 手动包裹配置菜单（装配层已自动做） |

### MCP 桥（MCP 是「工具来源」，不是新机制）

| API | 说明 |
|---|---|
| `mcpTools` | 把 MCP server 的 `tools/list` 映射成框架 `AgentTool[]`（进 `createApp({ tools })`） |
| `McpClientLike` | 最小结构面：`listTools()` + `callTool(name, args)`；框架**不 import** MCP SDK |
| `MCP_DEFAULT_TIMEOUT_MS` | 桥的缺省单次调用超时（60000 ms） |

- **名字**：`prefix + 归一化原名`（MCP 名里的 `-` / `.` / 空格 → `_`）。归一化后**空名（原名不含任何 ASCII 字母/数字/下划线时产物为空，如全 emoji 名）/ 撞名 / 超 64 字符**一律**装配期抛错**（静默改名会得到一个调不回去的名字，比启动期报错难查得多）。
- **原名**：每次调用写进发起 turn 的 `mcp.tool` attribute —— 审计 / 回放要还原它才能回调 server。
- **入参 schema**：MCP 的 `inputSchema` 已是 JSON Schema → 原样透传，由 engine 的子集校验器在 `callTool` **之前**校验（非法入参根本不会发给 server，模型自己会改）。
- **失败**：`callTool` 抛错 → 该条 `tool_result` 记 `is_error`，**不杀 run**（与本地工具抛错同语义）。⚠️ **协议层的 `isError: true` 框架看不见** —— 连接器必须转成抛错，否则模型以为成功了。
- **连接器不在框架里**（守「零运行时依赖」）：stdio / StreamableHTTP 归独立可选包，或你自己接 SDK 后实现 `McpClientLike`。本仓库 `scripts/e2e-mcp.ts` 有一份最小连接器可参考。

```ts
// 任意实现了 listTools/callTool 的对象都能接（duck-typed，无需继承）
const client: McpClientLike = myStdioConnector;
const tools = await mcpTools(client, { server: 'time' }); // → mcp_time_get_current_time …

// 与本地 @Tool 同池：同过中间件链、同进重名查重
const app = createApp({ system, providers: [...], tools });
```

### `McpToolsOptions`（`mcpTools` 的选项）

| 字段 | 说明 |
|---|---|
| `prefix` | 工具名前缀；缺省 `mcp_<server>_`（没给 `server` 时 `mcp_`）；`''` = 不加前缀（撞名自负） |
| `server` | server 标识，只用于拼缺省前缀（不会发给 server） |
| `timeoutMs` | 单次 `callTool` 超时（毫秒）；缺省 60000，非正数 = 不限 |

### evals（把 mockClient 提升为一等能力）

| API | 说明 |
|---|---|
| `scriptedClient` | 按脚本依次返回模型响应（**真把文本块经 `on('text')` 吐出去**）；脚本耗时报错 |
| `defineEval` | 定义「用例 + 断言」，`run()` 返回 `EvalReport` |

- **为什么需要**：单测覆盖的是框架语义，evals 覆盖的是**你的 agent 语义** —— 改 prompt / 换模型 / 加工具之后有没有回归，靠断言而不是人眼。
- 断言源是既有 `Trace`：「先 `search` 才 `summarize`」这类顺序断言全从 trace 读，框架不为此新增埋点。
- `run()` **不抛**（用例失败进报告，一次跑完能看到所有回归，而不是修一个跑一次）；只有「应用建不起来」才冒泡 —— 那是环境错误，不是回归。失败 case 带 `trace`，直接看现场。
- `scriptedClient` 的步骤**在 `finalMessage()` 成功返回后才前进**：抛错的步骤（函数步骤 `throw` 模拟 429）会在重试时**重放同一步**，想验重试就这么写。

```ts
const ev = defineEval<{ summary: string }>({
  name: 'doc-review',
  app: () => createApp({ system: new SystemPrompt({ version: 'v3' }).add('role', R), providers: [...] }),
  // 每 case 可带 opts（透传 app.run）：注入 resultSchema 就能断言 result.typed
  cases: [{ name: '先检索再总结', input: '总结这份文档', client: scriptedClient([searchMsg, submitMsg]) }],
  expect: (r, { trace }) => {
    assert.equal(r.stopReason, 'end_turn');
    const order = trace.spans.flatMap((s) => s.events)
      .filter((e) => e.name === 'tool.input')
      .map((e) => (e.body as { tool: string }).tool);
    assert.deepEqual(order, ['search', 'summarize']); // 顺序断言从 trace 读
  },
});
const report = await ev.run();
if (!report.ok) console.error(report.cases.filter((c) => !c.ok));
```

### 指标（从 trace 派生）

| API | 说明 |
|---|---|
| `metricsSink` | 进程内累加 + Prometheus 文本 / OTLP metrics；**天然满足 `TraceSink`** → `createApp({ sinks: [metricsSink()] })` 即接入，零新出口 |
| `DEFAULT_BUCKETS` | 时长直方图的缺省桶边界（毫秒），可用 `buckets` 覆盖 |

三个维度，全部从既有 trace 派生，**不需要在业务代码里埋点**：

- **run 级** —— 总数 / 失败数 /四类 token / 成本 / 时长；
- **能力级** —— 每个 `tool` / `skill` / `subagent` 的**调用次数、失败次数、耗时、token、成本**。
  工具的数据来自 turn 上的 `tool.output` 事件（框架已补 `durationMs` / `ok`）；`skill`/`subagent`
  来自 `capability` span。**`@Prompt` 不建 span、无独立耗时，因此不产出能力指标**（如实缺省，不硬凑）。
- **模型级** —— 按模型（`llm.turn` 的 span name）归因 turn 数 / token / 成本 / 耗时，并单独给出
  `model_unpriced_turns_total`（算不出成本的 turn 数 —— **成本护栏失效的显式信号**）。

接完 `GET /metrics` 直接回 `render()` 即可 —— 交给 `createHttpHandler({ metrics })` 就是一行的事
（见 §6 HTTP 端点速查）。

时长同时给两种口径，**并存不冲突**：

- **histogram**（`*_bucket` / `*_sum` / `*_count`，累积语义）—— 抓取端可**跨实例任意聚合**；
- **窗口内精确分位**（`*_last{quantile="..."}` gauge，如 `agentia_run_duration_ms_last`）—— 单实例排障时更好读。
  分位 gauge 与 histogram **必须不同名**（同名指标只允许一种 TYPE，混发会被 expfmt 判硬错误、整次 scrape 失败），
  故分位家族统一带 `_last` 后缀；capability / model 维度同理（`capability_duration_ms_last` / `model_duration_ms_last`）。

### `MetricsSinkOptions`（`metricsSink` 的选项）

| 字段 | 说明 |
|---|---|
| `export` | 输出形态；缺省 `'prometheus'`。`'otlp'` 走 OTLP/JSON 导出（**必须同时给 `endpoint`**，不给就构造期抛错） |
| `endpoint` | OTLP 采集端基地址（如 `http://localhost:4318`）；尾部斜杠会被去掉 |
| `intervalMs` | OTLP 导出间隔（毫秒，缺省 60000）；`0` = 每次 run 收尾立即导出。定时器已 `unref()`，不阻止进程退出 |
| `resourceAttributes` / `serviceName` | OTLP resource 属性（`service.name` 缺省 `agentia`） |
| `timeoutMs` | OTLP 单次导出请求超时（毫秒，缺省 10000，非正数 = 不限）——collector 半开连接时兜底，`intervalMs: 0` 模式不被挂死；超时按导出失败处理 |
| `onExportError` | 导出失败回调（缺省吞掉 —— 观测失败不得击穿业务） |
| `windowSize` | 时长分位保留的样本数（环形窗口，缺省 1024，**run / 能力 / 模型各自独立**）；非正数抛错 |
| `prefix` | 指标名前缀，缺省 `agentia_` |
| `labelMode` | 能力标签粒度：`'capability'`（缺省，`tool:search` 这种）/ `'kind'`（只按类型，基数极小）/ `'none'`（不产出能力指标） |
| `maxCapabilities` | 能力标签基数上限（缺省 200）：超出后新能力归入 `capability="__other__"`（防标签爆炸）；非正数抛错 |
| `buckets` | 直方图桶边界（毫秒，严格升序）；缺省 `DEFAULT_BUCKETS` |

### `MetricsSink`（`metricsSink()` 的返回值）

| 成员 | 说明 |
|---|---|
| `export` | `TraceSink` 的实现（run 收尾投递）—— 也是接进 `sinks` 的形状 |
| `snapshot` | `{ runs, failed, latencyP50, latencyP95, tokens, costUsd, capabilities, models, droppedCapabilities }` |
| `render` | Prometheus 文本（`/metrics` 直接回它） |
| `flush` | 主动导出一次（`export:'otlp'` 时有意义；prometheus 模式为空操作） |
| `stop` | 停掉定时导出（进程收尾 / 测试用） |
| `reset` | 清空累计（含能力与模型维度） |

- `tokens` 口径 = **四类之和**（input + output + cacheRead + cacheCreation），与 `BudgetGuard` 一致；分项在 `render()` 里以 label 给出，不会丢。
- 分位是**窗口内精确值**（最近 rank 法），只反映最近 `windowSize` 条样本；**直方图计数是累积的**（全历史），两者语义不同、各有各的用处。
- **内存上限** ≈ `(1 + 能力数 + 模型数) × windowSize` —— 能力数由 `maxCapabilities` 封顶，长跑宿主不会被拖住。
- `costUsd` 依赖模型在价格表内（不在表里时不计、并计入 `unpricedTurns` 与 `usage.unpriced` 事件）；根 span 未收尾（如失败路径的半截 trace）的 run 不进延迟样本。

### 调用树面板（`agentia dev` 的本地面板 / 官网 Playground）

同一份 `@migor/trace-view` 渲染器，**面板 / Playground / `report` 的能力排行三处共用**，不各写一套。

- **折叠态是「一行一件事」**：事件行（`tool.input` / `tool.output`）只显示省略号收敛的摘要。
- **点事件行展开看完整正文**（正文可选中复制），再点收起。展开的正文**默认仍与标签同一行**，
  只有在放不下时才整段换到下一行 —— 官网 Playground 的 trace 列（约 320px）就属于放不下。
- **可展开的行右端常显一个 caret**（`▸` / `▾`）：这一行能不能展开随时看得见，不必先悬停才发现。
- **展开只能展开 trace 里存着的正文** —— 想看到被截断掉的部分，得在**记账时**就别截：`maxEventChars: false`（见 §4）。缺省截到 2000 字符，展开了也只有那 2000 字符。
- 入参折叠态的摘要被砍到 62 字符（4 个键 / 每值 21 字符）；**展开拿到的是原文**，不是那份摘要 ——
  本地面板与官网 Playground 两个宿主都是如此（两个宿主都不该只喂摘要，否则点开什么都没多出来）。

### 调优报告（**哪个能力慢 / 贵 / 爱失败**）

指标回答「整体怎么样」，报告回答「**该拧哪个旋钮**」：

| API | 说明 |
|---|---|
| `buildRunReport(trace)` | 一条 trace → `RunReport`：能力排行（按总耗时降序）、模型归因、未定价模型清单 |
| `mergeRunReports(reports)` | 跨 run 汇总（**分位只在多条 run 上才有统计意义**） |
| `renderRunReport(report)` | 人类可读的纯文本表（CLI / 日志用） |

```ts
import { buildRunReport, mergeRunReports, renderRunReport } from '@migor/agentia';

const report = buildRunReport(trace);
console.log(renderRunReport(report));
// capability                              calls  err   total     max       tokens    cost
// subagent:researcher               1      0     400ms     400ms     60        0.004000
// tool:search                       2      1     325ms     300ms     -         -
```

CLI 侧有薄壳：`agentia report <trace.jsonl>` —— 每行一个 JSON（裸 Trace，或含 `result.trace` /
`trace` 的 TaskRecord，如 `FileTaskStore` 的导出），跨行按能力合并后打印排行。

> ⚠️ **单条 run 内样本常 < 5，分位没有意义** —— 所以报告以 `total` / `max` 为主；
> 要看分位请用 `mergeRunReports` 汇总多条，或用 `metricsSink` 的直方图。
> CLI 报告的聚合口径与 `agentia dev` 面板的能力排行同源（同一份 `@migor/trace-view` 实现）。

那个 jsonl 从哪来 —— 框架不替你落盘（观测出口是缝），自己接一个 sink 就行，零依赖：

```ts
import { appendFileSync } from 'node:fs';
import { createApp, type TraceSink } from '@migor/agentia';

const jsonl: TraceSink = {
  export: (trace) => appendFileSync('trace.jsonl', `${JSON.stringify(trace)}\n`, 'utf8'),
};
const app = await createApp({ /* … */ sinks: [jsonl] });
// 之后：agentia report trace.jsonl
```

异步宿主更省事：把 `FileTaskStore` 的落盘文件直接喂给它 —— `TaskRecord` 里带 `result.trace`，
`report` 认这种形态，不用另写 sink。

### 生效配置快照（「这条 run 用了哪套旋钮」）

每个 run 的**根 span** 都带一组 `config.*` attributes（`config.maxTokens` / `config.maxCostUsd` /
`config.retry.maxAttempts` / `config.contextPolicy.budgetTokens` / `config.priceOverrides` /
`config.maxEventChars` …）。
带缺省值的那几项（`maxTokens` / `maxIterations` / `contextPolicy` / `retry`）**缺省值也记**——
「没配」与「配了缺省值」因此可区分；可选项（`toolTimeoutMs` / `maxToolConcurrency` /
`maxEventChars`）只在设了才记。换参数前后对比、复现线上行为都有据可查。
函数型选项（`summarize` / `confirm` 之类）只记「配没配」，不记函数体。
截断关掉时记的是 `'off'` 而不是 `false` —— 后者在日志/看板里会被读成「上限为 0」。

### 提示词版本化

- `new SystemPrompt({ version: 'git-abc123' })` → 自动写到 **run 根 span 的 `system.version` attribute**：trace 里能查出「这个结果是哪个版本的提示词产出的」（换 prompt 前后对比、排查回归都靠它）。
- 版本号怎么来（git sha / 语义版本 / 手工）由你决定 —— 框架**不做**版本库与回滚平台。
- 单次 `app.run(..., { system })` 覆盖时，版本**跟当次那个 `SystemPrompt` 走**；`system` 传已拼好的 `SystemParam` 则无版本可记（不写空串冒充实有版本）。
- 直连 `runAgent` / `executeRun` 时可用引擎级选项 `systemVersion` 显式给。

### 多租户配额（组合既有缝，不是子系统）

框架不提供配额组件 —— 用 `middleware`（拦在能力调用前）+ `TraceSink`（收尾后记账）+ `BudgetGuard`（单次 run 上限）组合即可，存储与策略是你的事：

```ts
declare module '@migor/agentia' { interface Blackboard { tenant: string } }

const spentTokens = new Map<string, number>(); // 真实场景换成 Redis / DB
const TENANT_LIMIT = 200_000;

const quota: CapabilityMiddleware = async (call, next) => {
  const tenant = RunContext.current()?.get('tenant');
  if (tenant && (spentTokens.get(tenant) ?? 0) >= TENANT_LIMIT) {
    throw new Error(`租户 ${tenant} 的额度已用满`); // → 该条 tool_result 记 is_error，不杀 run
  }
  return next(); // 额度内放行
};

const billing: TraceSink = {
  export(trace) {
    const tenant = RunContext.current()?.get('tenant'); // sink 在 run 的 async 上下文里投递，读得到黑板
    if (!tenant) return;
    const u = trace.totalUsage;
    spentTokens.set(tenant, (spentTokens.get(tenant) ?? 0) + u.inputTokens + u.outputTokens);
  },
};

createApp({ system, providers: [...], middleware: [quota], sinks: [billing] });
// 单次 run 再有上限就叠加 C1：app.run(msgs, { maxTotalTokens: 50_000 })
```

- 拦下来的那次 run **仍然要记账**（模型的钱已经花了）—— 记账在 sink 里、拦截在 middleware 里，两者独立。
- 被拦下的能力**不会执行**（副作用不发生），但 run 继续跑（模型可以换路）。

### 人工介入：审批闸门（缺口只在「跨进程挂起」，闸门现成）

框架不做审批子系统，但**闸门**这一层已经具备 —— `middleware` 可以 `await` 决策再放行，
引擎会等工具结果（`Promise.resolve(tool.run(...))`）：

```ts
const DANGEROUS = new Set(['send_email', 'deploy', 'delete_records']);

const requireApproval: CapabilityMiddleware = async (call, next) => {
  if (!DANGEROUS.has(call.capability.name)) return next();
  const ok = await askHuman(call.capability.name, call.input); // 在这里 await —— run 就地停着等人
  if (!ok) throw new Error(`调用 ${call.capability.name} 未获批准`); // → tool_result 记 is_error，run 不中断
  return next();
};

createApp({ system, providers: [...], middleware: [requireApproval] });
```

三种结局都有对应写法：

- **放行**：`next()`；**拒绝**（副作用不发生）：不调 `next()` —— 短路；**拒绝并让模型改道**：抛错 → 该条
  `tool_result` 记 `is_error`，模型换路，run 不中断。
- 决策依据随你：`call.capability.name` / `call.input`，或在中间件里 `RunContext.current()?.get('…')` 读黑板
  （ALS 传播，见上一节）。
- 等待不会被默认掐断（`toolTimeoutMs` 缺省 0 = 不限）；真设了它，注意别把人的思考时间算进去。

**框架不做的**：把 run 停成「待批准」态、进程重启后从断点续跑。`RunStatus` 没有这个状态、循环位置不落库，
且 `traceToMessages` 重放**有损**（assistant 原文未记录）—— 拿它假装续跑只会拿到降级的上下文。
要跨重启审批，就自己上工作流引擎（见 §7）。

### 内容护栏（三处缝，不是子系统）

和「多租户配额」同一个形状：策略千差万别（正则 / 分类模型 / 外部审核 API），框架硬编码必错，**只给缝**。

| 关卡 | 缝 |
|---|---|
| 入参（run 之前）| 包一层 `app.run`；HTTP 侧用 `createHttpHandler({ authenticate })`，拦在**读 body 之前** |
| 工具调用前 | `middleware`（见上；能短路，也能用 `next(newInput)` 改写入参）|
| 出参 / 结果 | 包返回值，或挂 `sinks: [...]`（`TraceSink`）在收尾处审 |

```ts
const callable = {
  name: app.name,
  async run(msgs, opts) {
    const out = await app.run(redactInput(msgs), opts);      // 入参护栏
    if (flagged(out.finalText)) throw new Error('输出被护栏拦下'); // 出参护栏
    return out;
  },
};
```

### 代码执行隔离（沙箱是工具的事，不是框架的）

**框架从不执行模型生成的代码** —— `@Skill` 跑的是你写的方法体、`@Tool` 是你写的函数，
模型输出只会变成文本 / `tool_result`。所以「要不要沙箱」等价于「你那个*代码执行工具*要不要隔离」：
在**工具实现内部**做（Docker / 子进程 / 微 VM 随你），框架不参与也不该参与 ——
`AgentTool.run(input) → output` 这个契约把隔离整个挡在实现里。

唯一沾边的一条：工具起了子进程，**取消时要自己 kill**。框架的 `toolTimeoutMs` 是「不等了」不是取消
（`AgentTool.run` 收不到 `signal`）；要能真停，让工具自己读 `ToolRunContext.signal`。

---

## 7. 已知边界（如实标注，不要指望框架替你兜）

| 边界 | 说明 |
|---|---|
| 方法入参要自己标注 | TS 不会从 JSON Schema 反向推断方法形参；`strict` 下不标注会报隐式 any |
| 裸 schema 不校验签名 | 只给 `schema: {...}` 时，schema 与方法签名**互不关联**（要护栏就用 `fromZod<T>`） |
| 黑板键默认无类型 | 不合并 `Blackboard` 就是裸 `string` + `unknown`；动态键需 `as BlackboardKey` |
| 没有「能力清单」类型 | 能力是运行时从装饰器注册表收集的，所以 `app.my_tool()` 这种写法不存在 |
| `strict` 只是透传 | 框架**不校验** schema 的合规性（是否 `additionalProperties:false` 等） |
| schema 校验是**子集** | 只覆盖 `type/properties/required/additionalProperties/enum/items`；`format`/`minimum`/`oneOf` 一律放行 |
| 历史畸形就放弃裁剪 | `trimToolPairs` 遇到非严格交替历史会整体放弃（宁可少裁，也不切出孤立 tool_use 让请求 400） |
| 缺省内存 store 不淘汰 | 长跑宿主请设 `InMemoryTaskStore({ maxRecords })` 或换 `FileTaskStore` / `SqliteTaskStore` |
| 能力引用是 provider 粒度 | 子 agent / skill 的 `tools` 写的是 **provider token**，不是单个工具名 |
| 能力名有格式校验 | 装饰器能力名（`name` 或缺省的方法名）必须匹配 `^[A-Za-z0-9_-]{1,64}$`（与 MCP 桥同口径），非法名在 `createApp` **装配期即抛错** —— 含空格/点/中文的名字会让模型 API 400，宁可在启动期拦住 |
| `discover` 入口会回落 | 能力目录里源码与编译产物并存（`index.ts` + `index.js`）时，首选 `.ts` 加载失败会**回落 `.js` 并 warn** —— 命中的可能是**陈旧编译产物**（刚改过源码时注意）；全部候选都失败才抛错并列出各自原因 |
| `asset()` 的 rel 必须是相对路径 | 带 scheme（`file:` / `https:` …）的 rel 会让 `new URL(rel, base)` 整个忽略 base（「以为读了能力目录、实际读了别处」），显式抛错；`../` 越出能力目录是**有意放行**（共享资产如 `../../shared/x.md` 是合法用法） |
| 取消要传进客户端才有效 | 传 `signal` 后框架会 abort 在飞请求（内置 Anthropic / OpenAI 适配器都转发）；不转发 `signal` 的自定义 `ModelClient` 只能「放弃等待」（请求在后台跑完、产物丢弃） |
| 工具阶段的 abort 有盲区 | abort 只在三处被观察：**回合边界 / 在飞模型请求 / 重试退避 sleep**。没设 `toolTimeoutMs` 且工具挂死时，abort 之后 run 也不会返回（工具的 Promise 永不 settle）—— 挂死的工具要么设超时，要么自己读 `ToolRunContext.signal` |
| 观测失败被吞 | sink 抛错不影响 run（观测是辅助动作）；同理记忆水合/回写失败也不击穿 run |
| 框架不自动读 .env | 除 `AGENTIA_MODEL`（缺省模型覆盖）与 `OPENAI_API_KEY`（OpenAI 适配器）外，框架自己不去翻环境变量，也不读 `.env`；要读就在启动代码里调 `loadEnvFile()`（脚手架已内置那行），**真实环境变量优先**于文件 |
| 鉴权只是缝 | 框架**不实现** token / JWT / 签名策略，也不碰凭据 env —— `authenticate` 只承诺「拦在入口、读 body 之前」；策略是宿主或反代的事 |
| 运行时是 Node | 按 Node ≥ 18 设计与测试（`engines` 写明，CI 在 18/20/22 上守）；**未对 Deno / edge 做验证**。`SqliteTaskStore` 需 Node ≥ 22.5（`node:sqlite`），未提供时构造期抛可读报错 |
| 停机不由框架触发 | 框架给 `drain()` 但**不订阅** `SIGTERM`/`SIGINT`（不做进程级决策）；信号处理是宿主的 |
| 停机可能切断 SSE | `drain()` 超时后会强制关闭仍开着的 SSE 流，其 run 以 `stopReason='aborted'` 收尾 —— 客户端应把断流当作可重试 |
| 鉴权失败即断连 | 未通过鉴权时在读到 body 之前就回响应，连接**不可复用**（显式 `connection: close`）；这是「不收body省资源」的代价 |
| 预算护栏不是硬实时 | 一回合记账完才判，实际用量可能超上限一个回合的量；模型自然收尾的那回合超限**不算失败**（只留 `budget.exceeded` 事件） |
| `maxCostUsd` 依赖价格表 | 模型不在价格表内（且未用 `priceOverrides` 覆盖）时成本恒为 0，这条护栏**不触发** —— 要无条件兜底用 `maxTotalTokens`。**但失效不再静默**：turn 上会记 `usage.unpriced` 事件、指标有 `model_unpriced_turns_total`、可回调 `onUnpricedModel` |
| 工具超时**不取消**工具 | `AgentTool.run` 没有 signal 参数，超时只是「不等了」；副作用可能已发生。想真停请让工具自己读 `ToolRunContext.signal` |
| 会话只存对话轮次 | `SessionStore` 存「用户输入 + 最终回复」，run 内部的 tool 往返**不进历史**（要完整过程用 `traceToMessages`）；且只有**跑成功**的轮次才回写 |
| 同 session 并发 run 要自行串行化 | `SessionStore` 是 **append-only**：并发写不互相覆盖、不丢数据，但**不保证角色交替** —— 两个并发 run 共用同一 sessionId 时，各自追加的轮次可能交错成「连续两条 user」，下一轮 load 出来撞角色交替校验（400）。同一 session 的并发 run 请调用方自行串行化（每 session 一把锁 / 一条队列） |
| OpenAI 适配器听端点的话 | 请求发 `stream:true`，但**按响应形态解析**：端点回 JSON 就退回一次性（没有打字机效果），回 `event-stream` 才逐 token |
| OpenAI 流式的上游故障不再装成功 | 流中 `error` 分片（上游把故障塞进 200 的流）与「流正常结束却无文本无 tool_calls」都**抛错**按失败处理 —— 不再静默映射成「成功空回复」（与非流式空 `choices` 的守卫同口径） |
| MCP 只做 tools | `sampling`（server 反向请求模型）/ `resources` / `prompts` 原语不做；连接器（stdio / HTTP）不在框架内 |
| MCP 的协议层错误框架看不见 | `isError: true` 只有连接器能看见 —— 它必须转成抛错，否则模型收到的是一条「成功」的结果 |
| MCP 超时同样是「不等了」 | 桥自带的 `timeoutMs` 取消不了 server 侧执行（拿不到取消句柄）；它与 engine 的 `toolTimeoutMs` **双重计时**，谁短谁生效 |
| MCP 名字可能被归一化 | 原名含 `-` / `.` / 空格 → 进菜单时变成 `_`；回调 server 用的仍是原名（`mcp.tool` attribute 里查得到） |
| MCP 工具不能进 DI 容器 | 它没有 provider token，也不能被别的能力的 `tools` 引用 —— 引用是 provider 粒度 |
| 指标分位是窗口内精确值 | `*_last{quantile=...}` 只反映最近 `windowSize`（缺省 1024）条样本；要跨实例聚合请用直方图（`*_bucket` / `_sum` / `_count`，累积语义） |
| 指标是**进程内**累加 | 不做分布式聚合与持久化：多实例各算各的（直方图可相加），重启即清零。要长期保留请把 `render()` 抓走或用 `export:'otlp'` 推给采集端 |
| OTLP metrics 只推当前累计 | 按 `intervalMs` 周期导出**累积值**（CUMULATIVE），不做增量/背压；导出失败按 `onExportError` 处理（缺省吞掉，不重试、不阻塞 run） |
| `GET /metrics` 不鉴权 | 与 `/healthz` 同档（拉取端在集群内网）。要保护请放反代之后，或不传 `metrics` 选项自行在外层挂路由 |
| 工具没有 token/成本指标 | 工具是**你的代码**、本身不消耗 token，所以只产出调用数/失败数/耗时；token 与成本只对 `skill`/`subagent`（有 `capability` span）与模型维度产出 |
| `@Prompt` 没有能力指标 | 资产类能力不建 span、无独立耗时，故不出现在能力排行里（这是刻意的：硬凑一个假耗时会误导调优） |
| 能力标签有基数上限 | `labelMode:'capability'`（缺省）+ `maxCapabilities`（缺省 200），超出的能力归入 `capability="__other__"`；`snapshot().droppedCapabilities` 给出被归并的能力个数。要完整明细请用 `buildRunReport`（不设上限） |
| 提示词版本只是标记 | 框架不存版本库、不回滚：`version` 只落 run 根 attribute；`system` 传已拼好的 `SystemParam` 时无版本可记 |
| 配额不是框架子系统 | 只给缝（middleware + TraceSink + BudgetGuard），计数放哪（内存 / Redis / DB）与超限怎么办都是你的策略 |
| 人工介入只到「闸门」 | `middleware` 能 `await` 审批决策再放行；**跨进程挂起/续跑框架不做** —— `RunStatus` 无「待批准」态、循环位置不落库，`traceToMessages` 重放有损，不能拿它假装续跑（要跨重启审批请上工作流引擎）|
| 内容护栏不给实现 | 同「配额」：只给缝（入参包 `app.run` / 工具前 `middleware` / 出参包返回值或 `sinks`），策略（正则 / 分类器 / 外部 API）是你的 |
| 框架不执行模型生成的代码 | 无沙箱可言：`@Skill` 跑你写的方法、`@Tool` 是你写的函数，模型输出只成文本 / `tool_result`；代码执行工具的隔离是**工具实现内部**的事；工具起的子进程取消时要自己 kill |

---

## 8. 常见错误

| 症状 | 原因与修法 |
|---|---|
| 菜单里没有我的能力 | ① 方法没写装饰器；② 类没注册进 `providers`；③ 框架双实例（见第 2 节陷阱）；④ `toolSources` 白名单把它排除了 |
| `菜单能力重名` 装配期抛错 | 四类能力**共用命名空间**，改名即可 |
| 编译错 `不能把 X 赋给 Y` | 用了 `fromZod<T>`，方法签名与 `T` 不一致（这是护栏，不是 bug） |
| 模型传的入参没被拦 | 只填了 `schema` 没写 `strict`；且框架的校验是**子集校验**（`format`/`minimum` 等不校验） |
| `ctx.get('k')` 没有类型 | 没做 `Blackboard` 声明合并（见 5.1） |
| `result.typed` 是 `unknown` | `resultSchema` 用的是裸 JsonSchema；改 `fromZod<T>`（见 5.3） |
| TS 里想 `app.my_tool(...)` | 不要这样写：能力由模型选择，不是你的方法。要确定性调用就**直接调类方法** |
| 子 agent 调不到工具 | `tools` 是 **provider token**（文件夹名）列表，不是工具名 |
| 长跑内存涨 | 缺省内存 store 不淘汰；设 `InMemoryTaskStore({ maxRecords })` 或换耐久 store |
| 鉴权钩子抛错，客户端只看到「未通过鉴权」 | 这是设计：非 `HttpException` 的错误原文只进服务端日志（要回给调用方就抛 `HttpException(status, body)`） |
| 停机后 `POST /tasks` 回 503 | `drain()` 已被调用（或注入的 runner 已 drain）—— 这是「拒新单」的正常行为，任务没丢 |
| `stopReason` 是 `budget_exceeded`、任务被判失败 | 这是设计（护栏拦下的 run **没跑完**）。只想「记一笔」不想改结局，就自己用 `createBudgetGuard` 读 trace |
| 工具超时了，副作用却还是发生了 | 超时是「放弃等待」不是取消（`AgentTool.run` 收不到 signal）。要能真停就得让工具自己读 `ToolRunContext.signal` |
| 用 OpenAI 端点没看到打字机效果 | 端点没按 `stream:true` 回 `event-stream`（回了一整份 JSON）—— 适配器按响应形态解析，此时退回一次性 |
| 改了框架源码却看不到效果 | 确认 import 的是同一份构建产物（`npm run build` 后跑 `dist`） |
| MCP 工具没出现在菜单里 | `mcpTools()` 的返回值没传进 `createApp({ tools })` —— 它不走装饰器收集，也不进 DI 容器（裸工具缝） |
| 装配期报「归一化后撞名」 | server 侧两个工具名只差非法字符（`a-b` / `a.b`）→ 归一化后同名；给个 `prefix` 或改 server 侧名字 |
| MCP 调用「成功」但内容是错误文本 | 连接器没把协议层 `isError: true` 转成抛错（框架只认抛错） |
| eval 里模型调了不存在的工具 | 脚本里的工具名必须是**菜单里的名字**（MCP 工具是归一化后的 `mcp_<server>_<name>`） |
| `metricsSink` 的数字一直是 0 | 没接进 `createApp({ sinks })`（或 `registerDefaultTraceSink`）—— 它靠 run 收尾投递，不自己埋点 |
| `metricsSink({ export: 'otlp' })` 构造期报错 | 没给 `endpoint` —— OTLP 导出必须知道往哪发，响亮失败好过静默不导出；补上 `endpoint`（如 `http://localhost:4318`）即可。`windowSize` / `maxCapabilities` 非正数、`buckets` 非严格升序同理是构造期配置校验 |

---

## 9. 提交前自检

```bash
npm run typecheck        # src 类型
npm run typecheck:tests  # 测试目录类型（含类型断言测试）
npm run test             # 单测（node:test）
```

框架仓库另有这些门禁：`npm run typecheck:types`（针对构建产物的类型测试）、`npm run e2e`（三步链：CLI 端到端 + `examples/complete` 与 `examples/deploy` 真起服务）、`npm run e2e:examples` / `npm run e2e:deploy`（单跑对应一步）、`npm run e2e:mcp`（真接一个 MCP server 走完「映射 → 菜单 → run」；无网时自动回落本地夹具 server）。
