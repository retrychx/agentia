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

1. **目录扫描**：`createApp({ discover: [...] })` 启动期按给定顺序扫各目录下的 `<name>/index.ts`，default export 为类时以文件夹名为 DI token 注册（见 `src/app.ts`）。
2. **显式装配**：`createApp({ providers, system })`，providers 来自 `src/registry.ts` 注册表（由 `agentia g` 自动维护，也可手工编辑）。

两者二选一或混用。

## 文件分工（**装配与启动是分开的**）

| 文件 | 作用 |
|---|---|
| `src/app.ts` | **装配**：导出 `createAgentApp({ toolSources?, workdir? })` 工厂 + `CAPABILITY_DIRS` + `createSessionStore()`；`.env` 也在这里读 |
| `src/main.ts` | **启动**：薄入口 —— 调工厂 → `app.run(...)` → 处理 `result.error` |
| `src/server.ts` | **服务入口**：调同一个工厂 → `createHttpHandler` + `AsyncRunner` + `SqliteTaskStore`（崩溃续跑）→ drain 优雅停机（见「作为服务运行」节） |
| `src/dev.config.ts` | 开发期**数据**声明（`multiTurn` / `budget` / `workdir`）；只有 `agentia dev` 读它 |
| `src/session-store.ts` | 多轮的会话后端（`FileSessionStore`，落盘 `.agentia/session.json`） |
| `src/registry.ts` | 显式注册表（`agentia g` 自动维护） |

**为什么拆**：`agentia dev` 要**复用同一个工厂**才能把「这次调哪个能力 / 工作目录是哪个」喂进
`createApp`。所以装配必须以**函数**形态待在 `app.ts` 里 —— 别把 `createApp(...)` 搬回 `main.ts`：
搬回去 dev 环就起不来（`agentia dev` 会直接报错并给出迁移方法，不会静默降级成一个「面板能用但
什么都驱动不了」的空壳）。

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
npm start -- "你的问题"   # 跑编译产物 dist/main.js —— 跑一次就退出的**批处理入口**
```

⚠️ `npm start` 是 **Job 形态**（跑一次、打印、退出）：适合 cron / CI / 容器里的一次性任务，
**不是长期在线的服务**（没有端口、没有 `/healthz`、没有优雅停机）。长期在线用下面的
`start:server`；更完整的生产配方（含 Dockerfile / compose / metrics）在框架仓库的
[`examples/deploy/`](https://github.com/retrychx/agentia/tree/main/examples/deploy)，
上线前的决定清单在同仓库 `docs/deployment.md`；API 细节见本项目 `AGENTS.md` 的「触发与宿主」节。

## 作为服务运行

`npm start` 跑一次就退出；要挂成长期在线的 HTTP 服务，用脚手架自带的 `src/server.ts`：

```bash
npm run build && npm run start:server   # = node dist/server.js
```

端点：

- `GET /healthz` —— 健康检查（探针用，不鉴权）
- `POST /run` —— 同步 run（请求带 `Accept: text/event-stream` → SSE 逐帧）
- `POST /tasks` —— 异步任务（轮询 `GET /tasks/:id`，或 SSE 订阅 `GET /tasks/:id/stream`）

服务侧给到的另外三件事：任务落 SQLite（`AGENTIA_DB` 指定路径，缺省 `./agentia.db`），
**崩溃续跑**（重启后上次未完成的任务接着跑）、**优雅停机**（SIGTERM/SIGINT →
拒新单、等在飞收尾、15s 超时收口；超时没跑完的任务下次启动续跑）。

**鉴权**：设了环境变量 `AGENTIA_TOKEN` 就启用 Bearer 校验（`Authorization: Bearer <token>`，
`/healthz` 除外）；**不设则无任何鉴权**，启动时会打一条响亮警告 —— 此时只应监听
回环 / 内网（或放到有鉴权的反代后面）。框架**不实现** token/JWT 策略，更复杂的
鉴权自己改 `src/server.ts` 里的 `authenticate` 钩子。

环境变量：`PORT`（缺省 3000）· `AGENTIA_DB`（缺省 `./agentia.db`）· `AGENTIA_TOKEN`（可选）。

⚠️ **Node ≥ 22.5**：任务存储 `SqliteTaskStore` 用 `node:sqlite`，更低版本起服务时
构造期会抛可读报错（`npm run dev` 与 `npm start` 不受影响 —— 它们不碰它）。

要 metrics（`/metrics`）/ OTLP 导出 / Dockerfile / compose 编排，直接抄框架仓库的
[`examples/deploy/`](https://github.com/retrychx/agentia/tree/main/examples/deploy)
与 `docs/deployment.md` —— `src/server.ts` 是它的精简版，两者同一套 API。

也可以用环境变量（适合 CI / 容器）——**真实环境变量优先，不会被 `.env` 覆盖**：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev -- "你的问题"
```

`.env` 由 `src/app.ts` 的 `loadEnvFile()` 读取（放在装配模块里，`npm run dev` 与 `npm start`
两个入口才都会读到）。框架**不会自动读**它 ——
读哪个文件、什么时候读由你的启动代码决定（这样「换目录跑」不会悄悄改变行为）。
