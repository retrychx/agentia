# Agentia 完整示例

一个「可上线」的 agent 服务该有的样子 —— 把框架的**完整表面**接在一起，而不是最小可运行。

> 只要最小可交付骨架（一个工具 + HTTP + 存储 + 优雅停机）？看 [`../deploy/`](../deploy/)。
> 只要观测 sink 的现成实现？看 [`../observability/`](../observability/) 与
> [`docs/observability.md`](../../docs/observability.md)。

## 覆盖了什么

| 面 | 用到的 |
|---|---|
| **四类单元** | `@Tool`（`echo`）· `@Skill`（`outline-writer`，代码控流程）· `@SubAgent`（`researcher`，独立上下文）· `@Prompt`（`house-style`，文本资产） |
| **装配** | 显式注册表 `src/units.ts`（形状与 `agentia g` 一致；也可换 `discover`） |
| **观测** | 指标 + 采样 + **脱敏** + **落库（按 runId 检索）** + 结构化日志 —— 五件套接线见 `src/observability.ts` |
| **触发** | `POST /run`（同步 / SSE）· `POST /tasks`（异步 + 幂等键）· `Scheduler.every`（定时） |
| **宿主** | 鉴权缝（`authenticate`）· 并发闸门 · 成本硬管控（`maxTotalTokens`）· `/healthz` · `/metrics` · 优雅停机 · 重启续跑 |
| **部署** | 多阶段 `Dockerfile` + `docker-compose.yml`（从源码构建框架） |

## 目录

```
src/
├── main.ts               # 宿主：装配 / 三种触发 / 鉴权 / 停机
├── observability.ts      # 观测栈组装（引用 @migor/agentia-observability）
├── units.ts              # 显式注册表
└── units/
    ├── echo/             # @Tool
    ├── outline-writer/   # @Skill
    ├── researcher/       # @SubAgent（+ system.md）
    └── house-style/      # @Prompt（+ asset.md）
scripts/copy-assets.mjs   # 把 .md 资产拷进 dist（asset() 按文件位置解析）
```

## 跑起来

框架当前版本**未发布到 npm**（registry 上最新是 0.2.1，缺 `metricsSink` / `mcpTools` /
`createApp({sinks})` 等本示例用到的能力），所以依赖走 `file:../..` 指向本仓库：

```bash
cd ..                      # 仓库根
npm install && npm run build      # 先把框架构建到 dist/

cd examples/complete
npm install                       # file:../.. → 装上刚构建的框架
ANTHROPIC_API_KEY=sk-ant-... npm start
```

### Docker

构建上下文是**仓库根**（镜像里先从源码构建框架）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build                 # 在本目录执行
# 或：docker build -f examples/complete/Dockerfile -t agentia-complete .
```

框架发布后，把 `package.json` 的 `"@migor/agentia": "file:../.."` 改成 `"^0.2.2"`，
Dockerfile 即可退回常规单包写法。

## 试试端点

```bash
# 同步 run（会走 主 agent → 选单元 → 出结果）
curl -s -X POST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"用 house_style 的规范，为「新手引导」写三条要点"}' | head -c 400

# SSE 流式
curl -N -X POST localhost:3000/run -H 'content-type: application/json' \
  -H 'accept: text/event-stream' -d '{"prompt":"回显 hi"}'

# 异步任务 + 幂等键（同键未失败则去重，直接返回既有记录）
curl -s -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"input":"调研：SSE 与 WebSocket 的取舍","idempotencyKey":"demo-1"}'
curl -s localhost:3000/tasks/<taskId>

# 健康检查与指标
curl -s localhost:3000/healthz
curl -s localhost:3000/metrics | head

# 开了鉴权（API_KEY=...）时
curl -s -X POST localhost:3000/run -H 'x-api-key: <API_KEY>' \
  -H 'content-type: application/json' -d '{"prompt":"hi"}'
```

## 观测怎么用

`src/observability.ts` 把四条配方接成一条链：

```
metrics（全量 —— 指标要准，不吃采样）
└ sampleSink（采样；错误 run 一律保留）
  └ redactSink（先脱敏，下游都拿不到原文）
    ├ sqliteTraceSink（落库；与 SqliteTaskStore 同一个库文件）
    └ jsonLogSink（一 run 一行 JSON，runId 贯穿）
```

于是出问题时：**日志里 grep `runId` → 查库拿完整调用树**。

```bash
sqlite3 agentia.db \
  "SELECT name, kind, ended_at - started_at AS ms FROM spans
    WHERE run_id = '<runId>' ORDER BY ms DESC LIMIT 10;"
```

（表结构与更多查法见 [`docs/observability.md`](../../docs/observability.md) §2.1。）

## 与真实生产的差距（本示例故意没做）

- **入口鉴权策略**：示例用固定 `x-api-key` 演示缝的位置；生产走 JWT / 签名 / 反代。
- **密钥管理**：示例读 env；生产用密钥服务。
- **多副本跨机**：示例的 SQLite 适合单机多进程共库；跨机换 `RedisTaskStore` 或自实现 `TaskStore`。
- **定时任务**：`Scheduler` 是进程内定时；需要跨副本唯一触发请在队列/调度平台侧做。
