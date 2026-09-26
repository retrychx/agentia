# Agentia 推广文案

> 2026-09-26 生成，配合 30 秒产品演示视频使用

---

## 一、Product Hunt 发布文案

### 英文版

**Tagline:** Zero-runtime-dependency declarative agent framework in TypeScript

**Description:**

Agentia lets you build AI agents with **4 decorators** — `@Tool`, `@Skill`, `@SubAgent`, `@Prompt` — and zero runtime dependencies.

No orchestration boilerplate. No lock-in to a specific LLM provider. Define capabilities declaratively, wire them via dependency injection, and run anywhere Node 18+ runs.

What you get out of the box:
- **Declarative capabilities** — decorate methods, the framework handles registration and dispatch
- **Zero runtime deps** — the core ships with no npm dependencies (not even `zod` or `reflect-metadata`)
- **Built-in dev panel** — `agentia dev` launches a local inspector with real-time trace streaming, capability narrowing, and run abort
- **Observable by design** — OpenTelemetry-compatible traces, metrics, and structured events
- **Type-safe forwarding** — options and contexts flow through the entire pipeline without silent drops

The framework is the result of iterative guard-building: every invariant is registered in `docs/guards.md`, mutation-batteried, and tracked. We treat "tests that always pass" as bugs.

**Launch status:** Open source, MIT license. Try it: `npx @migor/cli create my-app`

---

### 中文版

**一句话介绍：** 零运行时依赖的 TypeScript 声明式 Agent 框架

**正文：**

Agentia 让你用 **4 个装饰器**（`@Tool`、`@Skill`、`@SubAgent`、`@Prompt`）构建 AI Agent，核心零运行时依赖。

不需要编排样板代码，不锁定特定 LLM 提供商。声明式定义能力，依赖注入自动接线，Node 18+ 随处运行。

开箱即得：
- **声明式能力** —— 装饰方法，框架自动处理注册与分派
- **零运行时依赖** —— 核心包不含任何 npm 依赖（连 `zod` 和 `reflect-metadata` 都不要）
- **内置 dev 面板** —— `agentia dev` 启动本地调试器，实时 trace 流式推送、能力收窄、运行中止
- **原生可观测** —— 兼容 OpenTelemetry 的 trace、metrics、结构化事件
- **类型安全透传** —— 配置与上下文在整条链路中静默传递，不会半路丢失

这个框架是持续迭代守卫的结果：每个不变量都登记在 `docs/guards.md` 里，经过变异电池验证，持续追踪。我们认为「永远绿的测试」就是 bug。

**状态：** 开源，MIT 协议。试用：`npx @migor/cli create my-app`

---

## 二、Twitter / X 线程（英文）

**Tweet 1 (hook):**
We built an agent framework. The weirdest thing we learned?

"Tests that always pass" are bugs.

Here's how we caught 3 of them — and why your test suite might have some too.

🧵

**Tweet 2 (framework):**
Agentia is a declarative agent framework in TypeScript.

4 decorators: `@Tool`, `@Skill`, `@SubAgent`, `@Prompt`.
Zero runtime dependencies.
No boilerplate. No vendor lock-in.

**Tweet 3 (dev experience):**
`agentia dev` launches a local inspector panel with:
- Real-time trace streaming
- Capability narrowing
- Run abort + session reset

All in the browser. No external dashboard needed.

**Tweet 4 (the guard story):**
We maintain a registry of 50+ invariants in `docs/guards.md`.

Every guard must be mutation-batteried: we deliberately break the code and confirm the test turns red. If it stays green, it's a "fake guard" — and we treat it as a bug.

**Tweet 5 (fake guard examples):**
3 shapes of fake guards we found:
1. Self-comparison (`deepEqual(x, x.snapshot())`)
2. Unread controls (a baseline listener never asserted non-zero)
3. Samples that don't bite (synthetic regression ≠ real defect)

All 3 had "correct" code. All 3 stayed green when the bug returned.

**Tweet 6 (CTA):**
Agentia is open source (MIT).

`npx @migor/cli create my-app` to try it.

Repo: github.com/retrychx/agentia

We'd love feedback — especially on what we got wrong.

---

## 三、即刻 / 朋友圈（中文，短版本）

Agentia：一个零运行时依赖的 TypeScript Agent 框架。

核心就 4 个装饰器：`@Tool`、`@Skill`、`@SubAgent`、`@Prompt`。
`agentia dev` 一键启动带实时 trace 的调试面板。

最奇怪的经验：「永远绿的测试」是 bug。
我们给每个不变量建了「守卫注册表」，改完代码故意改坏它，确认测试真的变红。
测到 3 个假守卫——代码写得对，绿的也对，但守的是另一件事。

开源，MIT。`npx @migor/cli create my-app` 试试。

---

## 四、awesome-ai-sdks PR 条目

提交目标：`https://github.com/e2b-dev/awesome-ai-sdks`

条目内容（插入到 E2B 之后，AgentOps 之前，按字母序）：

```markdown
## [Agentia](https://github.com/retrychx/agentia)
A zero-runtime-dependency declarative agent framework in TypeScript. Build agents with 4 decorators (`@Tool`, `@Skill`, `@SubAgent`, `@Prompt`), dependency injection, and a built-in dev panel with real-time trace streaming. Every invariant is registered, mutation-batteried, and tracked in a guard registry.

<details>

### Description
- **Declarative capabilities** — define agent abilities with 4 decorators; framework handles registration and dispatch
- **Zero runtime dependencies** — core ships with no npm dependencies, not even `zod` or `reflect-metadata`
- **Built-in dev panel** — `agentia dev` launches a local inspector with real-time traces, capability narrowing, and run abort
- **Observable by design** — OpenTelemetry-compatible traces, metrics, and structured events
- **Guard-driven development** — 50+ registered invariants, each validated with mutation batteries; "tests that always pass" are treated as bugs

### Links
- [GitHub](https://github.com/retrychx/agentia)
- [Documentation](https://agentia-web.pages.dev)
- [npm](https://www.npmjs.com/package/@migor/agentia)
</details>
```

---

## 五、V2EX / 掘金 / 知乎 长文标题建议

1. 《我们给每个不变量建了一份「守卫注册表」，然后发现了 3 个永远绿的测试》
2. 《零运行时依赖的 Agent 框架：为什么我连 zod 和 reflect-metadata 都不要》
3. 《TypeScript 装饰器 + 依赖注入 = Agent 框架？我们的回答》
4. 《「测试永远绿」也是一种 bug：我们的 50+ 条守卫和 3 个假守卫的故事》

---

## 六、30 秒视频旁白脚本

### 英文版

[0:00] Agentia. A declarative agent framework with zero runtime dependencies.
[0:03] One command creates a project.
[0:07] Built-in dev panel.
[0:10] `agentia dev` starts the inspector.
[0:17] Type a prompt. Run.
[0:22] Watch every tool call, every trace event, in real time.
[0:26] Four decorators. That's the entire API surface.
[0:28] Zero deps. Try it now: `npx @migor/cli create my-app`

### 中文版

[0:00] Agentia。零运行时依赖的声明式 Agent 框架。
[0:03] 一行命令，创建项目。
[0:07] 内置调试面板。
[0:10] `agentia dev` 启动调试器。
[0:17] 输入一句话，运行。
[0:22] 实时看到每一次工具调用、每一条 trace 事件。
[0:26] 四个装饰器，就是全部 API。
[0:28] 零依赖。现在就试：`npx @migor/cli create my-app`
