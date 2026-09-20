# __PROJECT_NAME__

基于 [Agentia](https://github.com/retrychx/agentia) 框架的 agent 应用。

## 目录约定

四分类目录，一能力一文件夹，每个能力是一个 default export 的类，用装饰器声明：

- `src/tools/<name>/` —— `@Tool` 工具：主 agent 可调用（input → value）
- `src/skills/<name>/` —— `@Skill` 技能：方法体内通过 `ctx.llm()` 调 LLM
- `src/subagents/<name>/` —— `@SubAgent` 子代理：按 system 角色设定独立跑一轮
- `src/prompts/<name>/` —— `@Prompt` 文本资产：.md 文件，按需拉取进上下文

目录名就是类型，不用记别名。

## 两条装配路线

1. **目录扫描**：`createApp({ discover: [...] })` 启动期按给定顺序扫各目录下的 `<name>/index.ts`，default export 为类时以文件夹名为 DI token 注册（见 `src/main.ts`）。
2. **显式装配**：`createApp({ providers, system })`，providers 来自 `src/registry.ts` 注册表（由 `agentia g` 自动维护，也可手工编辑）。

两者二选一或混用。

## 生成能力

```bash
agentia g tool my-tool        # → src/tools/my-tool/
agentia g skill my-skill      # → src/skills/my-skill/
agentia g prompt my-prompt    # → src/prompts/my-prompt/（含 asset.md）
agentia g subagent my-agent   # → src/subagents/my-agent/（含 system.md）
```

生成的能力自动登记到 `src/registry.ts`。

## 运行

需要 Anthropic API key —— 填进脚手架已生成的 `.env` 即可（本文件在 `.gitignore` 里）：

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run dev -- "你的问题"
```

## 构建与生产运行

```bash
npm run build   # tsc → dist/ + .md 文本资产跟随拷贝（asset() 按文件位置解析，必须跟着 .js 走）
npm start -- "你的问题"   # 跑编译产物 dist/main.js（部署/Docker 用这条）
```

也可以用环境变量（适合 CI / 容器）——**真实环境变量优先，不会被 `.env` 覆盖**：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev -- "你的问题"
```

`.env` 由 `src/main.ts` 首行的 `loadEnvFile()` 读取。框架**不会自动读**它 ——
读哪个文件、什么时候读由你的启动代码决定（这样「换目录跑」不会悄悄改变行为）。
