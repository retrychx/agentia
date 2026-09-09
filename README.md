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

设计规格见 [`docs/spec.md`](docs/spec.md)。

## 声明式写法（Turn 2+）

```ts
import { Tool, createApp, SystemPrompt } from 'agentia';

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

## 运行

```bash
npm install
npm run smoke        # Turn 0：mock loop + trace
npm run smoke:run    # Turn 1：SystemPrompt 缓存布局 + run 生命周期
npm run smoke:turn2  # Turn 2：@Tool 装饰器 → DI → createApp（tsx 直接跑源码）
```

真机跑（需要 `ANTHROPIC_API_KEY` 或 `ant auth login`）：
```bash
export ANTHROPIC_API_KEY=sk-...
# 用 runAgent / executeRun / app.run 传 tools/system/messages，返回 { trace, finalText, stopReason, ... }
# trace 即本次 run 的调用树 + usage（traceId == runId）
```

> 注：`npm run dev`（tsx）前需先 `npm approve-scripts` 批准 esbuild/tsx 的 postinstall。
> `@anthropic-ai/sdk` 无 postinstall，不受影响。
