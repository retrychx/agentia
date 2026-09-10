# Agentia

> 面向应用开发者的**声明式 agent 服务开发框架** —— NestJS 模式。
> 主 agent 作为路由器，调度 `@Tool` / `@Skill` / `@SubAgent` / `@Prompt` 各单元，执行完整流水线并产出结构化结果。

## 一句话定位

TS 装饰器 + DI 声明“agent 流水线服务”：一次 run = 一份任务 spec 进来，主 agent 编排阶段执行，产出 typed 结果与产物；框架提供 run 生命周期、缓存布局、上下文策略、触发传输与观测；运行时自研、参考 Claude 设计，底层走 Messages API。

## 与既有物的区别

- **Claude Code**：一个产品（终端编码工具），扩展点用于定制工具本身，不可交付为服务。
- **Claude Agent SDK / OpenAI Agents SDK / LangGraph**：运行时原语（Agent、循环、handoff）——相当于 Express。
- **Agentia**：在运行时之上提供声明式 + DI + 模块 + 静态校验 + 服务生命周期的框架——相当于 NestJS。缺失的正是这一层。

## 状态

- **Turn 0**（`src/engine/`）：manual loop（流式）+ trace 记账 + 裸工具执行。
- **Turn 1**（`src/run/`）：Run 生命周期（runId==traceId）+ RunContext(blackboard) + executeRun + SystemPrompt 稳定前缀 cache breakpoint。
- **Turn 2**（`src/container/` + `src/toolkit/`）：`@Tool` 装饰器 + collectTools、显式 DI（value/class/factory）、`createApp` 装配工具菜单；RunContext 经 AsyncLocalStorage 透入工具执行体。
- **Turn 3**（`src/toolkit/subagent.ts`）：`@SubAgent` 单元 —— 独立 agent 循环 + 裁剪上下文 + 隔离报告；loop 抽成 `runAgentScoped`（不双开 run 根），子 agent 的 llm.turn 递归成主 trace 里 `unit` span 的子孙（spec §9）。
- **Turn 4**（`src/engine/context.ts` + `policy.ts`）：长上下文三策略分清 —— context editing（`trimToolPairs` 丢旧工具对）/ compaction（`compactMessages` 摘要器注入）/ 预算护栏（`createBudgetPolicy`，字符/4 估算 + 滞回）；改写时在 run 根记 `context.budget` 事件。
- **Turn 5**（`src/run/`）：触发传输 —— 同步 RPC（`runSync`/`createSyncHandler`）/ 异步任务（`AsyncRunner` + `TaskStore`，idempotencyKey at-least-once 去重、失败可重试、`rethrow:false` 落 failed 记录）/ 定时（`Scheduler.every/.at`）；三类共用一份 `RunInput` 契约 —— 换宿主不换语义。
- **Turn 6**（`src/toolkit/` + `src/run/fsStore.ts`）：单元表补全四类 —— `@Skill`（**代码控制的流程**：方法体 + `SkillContext.llm()` 受限子运行，产物以 tool_result 交回）/ `@Prompt`（纯文本资产，方法形态：实例 volatile / static 常量）；菜单跨类型（tool/skill/subagent/prompt）统一查重；`FileTaskStore`（JSONL）+ `AsyncRunner.resumePending()` 宿主重启续跑（换宿主不换语义）；缺省模型 `resolveDefaultModel()`（`AGENTIA_MODEL` env 覆盖）。
- **Turn 7**（`src/toolkit/asset.ts` + `discover.ts` + `packages/cli/`）：**目录约定 `units/<name>/`（一单元一文件夹，index.ts 入口 + .md 文本资产）**；`asset(import.meta.url, './x.md')` 读文本资产；发现机制双形态 —— 运行时扫描 `createApp({ discover: 'units' })`（返回 Promise）与 CLI 维护的 `units.ts` 显式注册表，可混用、同 token 去重、装配期统一静态校验；独立 CLI 包 `@agentia/cli`：`create` 脚手架项目、`g tool|skill|prompt|subagent <name>` 生成单元文件夹并 codemod 注册表。

## CLI 与目录约定（Turn 7）

```bash
agentia create my-app            # 脚手架：package.json/tsconfig/src/main.ts/units.ts/units/hello/
cd my-app && npm install
agentia g subagent doc-reviewer  # 生成 units/doc-reviewer/{index.ts,system.md} 并登记 units.ts
agentia g prompt style-guide     # 生成 units/style-guide/{index.ts,asset.md} 并登记 units.ts
```

- **一单元一文件夹**：`units/<name>/index.ts` default export 一个 provider 类（或 Provider / Provider[]），
  DI token 缺省 = 文件夹名；长文本放文件夹内 `.md`，代码里 `asset(import.meta.url, './system.md')` 读取。
- **装配两条路（可混用）**：
  - 目录扫描：`await createApp({ discover: 'units', system, ... })` —— 启动期扫描装配；
  - 显式注册表：`import { providers } from './units.js'`（CLI 自动维护），`createApp({ providers, system, ... })`。

设计规格见 [`docs/spec.md`](docs/spec.md)。

## 声明式写法（Turn 2/3）

```ts
import { Tool, SubAgent, createApp, SystemPrompt } from 'agentia';

class WeatherTools {
  // 工具名缺省取方法名（建议 snake_case）；方法入参即模型按 schema 解析的结构化 input
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
    // 无需把 ctx 传进来 —— 直接从当前 run 取
    const token = RunContext.current()?.get<string>('authToken');
    return `city=${input.city};token=${token ?? 'none'}`;
  }
}

const app = createApp({
  name: 'weather-app',
  providers: [{ provide: 'weather', useClass: WeatherTools }],
  system: new SystemPrompt().add('role', '你是天气助手。', true),
});

const { run, result } = await app.run(
  [{ role: 'user', content: '上海天气如何?' }],
  { blackboard: { authToken: 'sk-...' } }, // 预置本次 run 的上下文
);
console.log(result.trace); // runId==traceId 的调用树 + usage
```

子 agent（Turn 3）：主 agent 自主决定调用，子 agent 在裁剪上下文里独立循环，
只有最终报告回流主上下文：

```ts
class PipelineModule {
  @SubAgent({
    name: 'reviewer',
    description: '审查给定文档并输出书面评审意见',
    schema: { type: 'object', properties: { doc: { type: 'string' } }, required: ['doc'], additionalProperties: false },
    system: '你是评审 agent。结论必须以“审查通过/不通过”开头。',
    tools: ['weather'],   // 子 agent 自己的 @Tool 菜单（provider token）
  })
  reviewer(_input: { doc: string }): void {} // 方法体不执行
}
```

## 运行

```bash
npm install
npm run smoke        # Turn 0：mock loop + trace
npm run smoke:run    # Turn 1：SystemPrompt 缓存布局 + run 生命周期
npm run smoke:turn2  # Turn 2：@Tool 装饰器 → DI → createApp（tsx 直接跑源码）
npm run smoke:turn3  # Turn 3：@SubAgent 嵌套循环 + 上下文裁剪/隔离 + usage 聚合
npm run smoke:turn4  # Turn 4：trimToolPairs/compactMessages 纯函数 + 预算策略端到端压缩
npm run smoke:turn5  # Turn 5：AsyncRunner 状态机 + 幂等去重/失败重试 + runSync + Scheduler
npm run smoke:turn6  # Turn 6：@Skill 端到端 / @Prompt / 菜单查重 / FileTaskStore 续跑 / AGENTIA_MODEL
npm run smoke:turn7  # Turn 7：CLI create/g 脚手架 → 目录发现 + 注册表双路线装配 → mock run 端到端
```

真机跑（需要 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`；走兼容端点时配 `ANTHROPIC_BASE_URL`，
模型缺省 `claude-opus-5`、可用 `AGENTIA_MODEL` 覆盖）：
```bash
npm run live        # runAgent + get_weather 工具往返，打印 stopReason/finalText/trace
npm run live:skill  # @Skill 真机：方法里 ctx.llm() 两次取数拼产物（走源码）
# 用 runAgent / executeRun / app.run 传 tools/system/messages，返回 { trace, finalText, stopReason, ... }
# trace 即本次 run 的调用树 + usage（traceId == runId）
```

> 注：`npm run dev`（tsx）前需先 `npm approve-scripts` 批准 esbuild/tsx 的 postinstall。
> `@anthropic-ai/sdk` 无 postinstall，不受影响。
