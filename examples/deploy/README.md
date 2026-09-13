# Agentia 部署示例

最小「可交付 Agent 服务」—— 演示 [spec §1](../spec.md) 定位里那一脚：交付物是**可上线的服务**，不是对话助手。

一个 HTTP agent 服务，带耐久任务存储、重启续跑、健康检查、指标与优雅停机。

## 里面有什么

| 件 | 说明 |
|---|---|
| `src/main.ts` | 宿主：装配 → `SqliteTaskStore` → `AsyncRunner` → `createHttpHandler` → 信号处理 |
| `src/units/echo/index.ts` | 一个示例 `@Tool` 单元 |
| `src/units.ts` | 显式注册表（形状与 `agentia g` 维护的一致） |
| `Dockerfile` | 多阶段构建（构建期编译 TS，运行期只带产物 + 运行期依赖，非 root） |
| `docker-compose.yml` | 端口 / 环境变量 / 数据卷 / healthcheck / 优雅停机宽限 |
| `.env.example` | 环境变量清单 |

## 跑起来

```bash
# 本地（需要 Node ≥ 22.5 —— SqliteTaskStore 用 Node 内置 node:sqlite）
export ANTHROPIC_API_KEY=sk-ant-...
cd examples/deploy
npm install
npm start                       # 或 npm run dev（tsx watch）

# Docker
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

> ⚠️ 框架尚未发布到 npm（见 `spec §11`），`package.json` 里的 `@migor/agentia: ^0.2.2` 与
> `agentia create` 脚手架模板一致 —— **发布后** `npm install` 可直接拉取。在仓库内验证时，
> 子目录没有 `node_modules`，用仓库的 tsx 跑即可（`npx tsx examples/deploy/src/main.ts`），
> 或按 `scripts/e2e-cli.ts` 的做法把仓库根 symlink 进 `node_modules/@migor/agentia`。

## 端点

| 端点 | 说明 |
|---|---|
| `POST /run` | 同步 run；带 `Accept: text/event-stream` 则 SSE 逐帧 |
| `POST /tasks` | 异步任务（入队即回 `taskId`）；`GET /tasks/:id` 轮询 |
| `GET /healthz` | 健康检查（探针端点，**不鉴权**；`inFlight` / `draining` 见 usage-guide） |
| `GET /metrics` | Prometheus 文本（`metricsSink().render()`）；⚠️ 走 handler 之外，生产请由反代限制可达性 |

```bash
curl -s localhost:3000/healthz
curl -s -X POST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"用 echo 工具回显 hi"}'
curl -s localhost:3000/metrics | head
```

## 生产要点（示例里都已接线）

- **耐久 + 多进程安全**：`SqliteTaskStore` 走 Node 内置 `node:sqlite`（WAL + `busy_timeout`），
  多进程可共库；`resumePending()` 重启续跑未完成任务（按 `ownerId` 跳过本进程记录）。
- **优雅停机**：`handler.drain({ timeoutMs: 15_000 })` —— 拒新单 → 等在飞收尾 → 超时强制收口 SSE。
  框架不订阅 `SIGTERM`，所以这里显式接了；compose 的 `stop_grace_period` 必须大于该超时。
- **成本硬管控**：`maxTotalTokens` 超限以 `budget_exceeded` 收尾（**算失败**）。
- **观测**：`/metrics` 已接；**落库 / 采样 / 脱敏 / 日志关联**四条配方见
  [`../observability/sinks.ts`](../observability/sinks.ts) 与 [`docs/observability.md`](../../docs/observability.md)。

## 本示例**没有**做的（生产按需补）

- **入口鉴权**：`createHttpHandler({ authenticate })` 是缝 —— token/JWT/签名策略由你的宿主或反代实现。
- **TLS / 反代 / 限流**：交给网关。
- **密钥管理**：示例读 env；生产用密钥服务 / 编排平台的 secret。
- **自动扩缩 / 多副本**：`SqliteTaskStore` 支持多进程共库，但多副本共享一份 SQLite 文件
  需要共享卷；跨机部署请换 `RedisTaskStore` 或自实现 `TaskStore`。
