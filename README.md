# Agentia

声明式 agent 服务开发框架：TS 装饰器 + DI，主 agent 调度 `@Tool` / `@Skill` / `@SubAgent` / `@Prompt` 单元执行任务，产出结构化结果与调用树（trace）。

## 环境准备

```bash
export ANTHROPIC_API_KEY=sk-...        # 或 ANTHROPIC_AUTH_TOKEN
# 可选：ANTHROPIC_BASE_URL（兼容端点）、AGENTIA_MODEL（缺省 claude-opus-5）
```

## 快速开始（CLI）

```bash
npm i -g @migor/cli                 # 安装 CLI（提供 agentia 命令）
agentia create my-app                  # 脚手架新项目（依赖 @migor/agentia）
cd my-app && npm install
agentia g tool weather                 # 生成 units/weather/index.ts 并登记 units.ts
agentia g subagent doc-reviewer        # 生成 units/doc-reviewer/{index.ts,system.md}
agentia g skill note-writer            # 生成 units/note-writer/index.ts
agentia g prompt style-guide           # 生成 units/style-guide/{index.ts,asset.md}
npm run dev                            # 运行 src/main.ts
```

**目录约定**：`units/<name>/` 一单元一文件夹，`index.ts` default export 一个 provider 类，DI token 缺省 = 文件夹名；长文本放文件夹内 `.md`，代码里用 `asset(import.meta.url, './system.md')` 读取。

**装配两条路（可混用）**：

```ts
// 1) 目录扫描：启动期扫描 units/*/ 自动装配（返回 Promise）
const app = await createApp({ name: 'my-app', discover: 'units', system });

// 2) 显式注册表：units.ts 由 CLI 自动维护
import { providers } from './units.js';
const app = createApp({ name: 'my-app', providers, system });
```

## 手写单元

```ts
import { Tool, SubAgent, createApp, SystemPrompt, RunContext } from '@migor/agentia';

class WeatherTools {
  // 工具名缺省取方法名（建议 snake_case）；入参 = 模型按 schema 解析的结构化 input
  @Tool({
    description: '查询城市天气',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
  })
  get_weather(input: { city: string }): string {
    // 方法体内随时可读本次 run 的上下文（blackboard）
    const token = RunContext.current()?.get<string>('authToken');
    return `city=${input.city};token=${token ?? 'none'}`;
  }
}

class Pipeline {
  // 子 agent：独立循环 + 裁剪上下文，只有最终报告回流主上下文（方法体不执行）
  @SubAgent({
    name: 'reviewer',
    description: '审查给定文档并输出书面评审意见',
    schema: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'], additionalProperties: false },
    system: '你是评审 agent。结论必须以“审查通过/不通过”开头。',
    tools: ['weather'], // 子 agent 自己的工具菜单（provider token）
  })
  reviewer(_input: { doc: string }): void {}
}

const app = createApp({
  name: 'weather-app',
  providers: [
    { provide: 'weather', useClass: WeatherTools },
    { provide: 'pipeline', useClass: Pipeline },
  ],
  system: new SystemPrompt().add('role', '你是天气助手。', true),
});

const { run, result } = await app.run(
  [{ role: 'user', content: '上海天气如何?' }],
  { blackboard: { authToken: 'sk-...' } }, // 预置本次 run 的上下文
);
console.log(result.finalText); // 最终文本
console.log(result.trace);     // 调用树 + 每步 token/成本（traceId == runId）
```

另外两类单元：

```ts
// @Skill：代码控制的流程，模型调用只发生在显式 ctx.llm()
class Notes {
  @Skill({ description: '按主题整理要点' })
  async note_writer(input: { topic: string }, ctx: SkillContext): Promise<string> {
    const r = await ctx.llm({ prompt: `就「${input.topic}」给出三个要点` });
    return r.text; // 返回值即产物，以 tool_result 交回主 agent
  }
}

// @Prompt：纯文本资产，模型判定需要时拉取进上下文
class Assets {
  @Prompt({ description: '品牌基调文案规范' })
  style_guide(): string {
    return asset(import.meta.url, './asset.md'); // 从单元文件夹读 .md
  }
}
```

## 触发方式

同一份应用，三种触发任选：

```ts
// 同步 RPC
const { run, result } = await app.run(messages);

// 异步任务（幂等键去重，失败可重提，可落盘续跑）
const runner = new AsyncRunner(app, { store: new FileTaskStore('./tasks.jsonl'), concurrency: 4 });
const task = runner.submit('总结一下今天的新闻', { idempotencyKey: 'daily-2026-09-10' });
await runner.awaitTask(task.taskId);

// 定时
const scheduler = new Scheduler(runner);
scheduler.every(60_000, '巡检一次', { idempotencyKey: 'patrol' });
```

## 长上下文预算

```ts
import { createBudgetPolicy } from '@migor/agentia';

const app = createApp({
  // ...
  contextPolicy: createBudgetPolicy({
    budgetTokens: 60_000,   // 超预算先丢旧工具对，仍超且有 summarize 才压缩
    summarize: (text) => mySummarizer(text), // 可选，框架不替你调模型
  }),
});
```

## 中间件

挂在每一次单元调用前后的洋葱链——鉴权、限流、缓存、审计都走这里：

```ts
const app = createApp({
  // ...
  middleware: [
    async (call, next) => {
      if (call.unit.name === 'danger_op' && !RunContext.current()?.get('isAdmin')) {
        return 'forbidden'; // 短路，不调 next 即拦截
      }
      return next(); // next(newInput) 还可改写入参
    },
  ],
});
```

## 结构化结果

```ts
const { result } = await app.run(messages, {
  resultSchema: {
    type: 'object',
    properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['pass', 'reason'],
    additionalProperties: false,
  },
});
console.log(result.typed); // 校验过的结构化结果，不再从文本里猜 JSON
// schema 也可来自 zod（peer 可选）：fromZod(z.toJSONSchema(S), S)
```

## 宿主、多模型与记忆

```ts
// HTTP 宿主：POST /run（同步） POST /tasks（异步） GET /tasks/:id（轮询）
createServer(createHttpHandler(app, { runner })).listen(8080);

// OpenAI 兼容端点（DeepSeek 等）+ 跨 run 记忆
const { result } = await app.run(messages, {
  client: createOpenAIClient({ baseURL: 'https://api.deepseek.com' }),
  model: 'deepseek-chat',
  memory: { store: new InMemoryMemoryStore(), keys: ['profile'] },
});

// trace 导出到 OTLP 收集器
await createOtlpExporter({ endpoint: 'http://localhost:4318' }).export(result.trace);
```

## 常用 API

| 导出 | 用途 |
|---|---|
| `createApp` / `discoverProviders` | 装配应用 / 扫描单元目录 |
| `defineModule` | 能力包（providers + middleware 打包分发） |
| `Tool` / `Skill` / `SubAgent` / `Prompt` | 四类单元装饰器 |
| `UnitMiddleware`（`middleware` 选项） | 单元调用拦截器链 |
| `asset` | 读单元文件夹内的文本资产 |
| `SystemPrompt` | 拼装系统提示（自动打缓存 breakpoint） |
| `RunContext.current()` | 取本次 run 的 blackboard / runId |
| `AsyncRunner` / `Scheduler` / `runSync` / `createHttpHandler` | 异步 / 定时 / 同步 / HTTP 触发 |
| `FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore` / `InMemoryTaskStore` | 任务记录存储 |
| `createBudgetPolicy` | 长上下文预算护栏 |
| `createOpenAIClient` | OpenAI 兼容端点适配（多模型） |
| `InMemoryMemoryStore`（`memory` 选项） | 跨 run 记忆水合/回写 |
| `createOtlpExporter` | trace 导出 OTLP |
| `traceToMessages` | trace 重放基底：把完成的 run 还原成消息喂回模型调试 |
| `fromZod` | zod schema 接入（peer 可选） |
| `runAgent` / `executeRun` | 裸引擎入口（不走装配） |

完整导出见 [`src/index.ts`](src/index.ts)，设计规格见 [`docs/spec.md`](docs/spec.md)，roadmap 见 [`docs/roadmap.md`](docs/roadmap.md)，官网见 [agentia-web.pages.dev](https://agentia-web.pages.dev)（含[在线 Playground](https://agentia-web.pages.dev/playground.html) 与[文档](https://agentia-web.pages.dev/docs.html)）。

## 本仓库脚本

```bash
npm install
npm run build        # 编译框架（dist/）
npm run typecheck    # 类型检查
npm test             # 单元测试（node:test）
npm run e2e          # 端到端：CLI 脚手架 → 目录发现/注册表装配 → mock run
```

> 注：`npm run dev`（tsx）前需先 `npm approve-scripts` 批准 esbuild/tsx 的 postinstall。
