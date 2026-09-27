# @migor/agentia-observability

Agentia 生产可观测栈的**现成 sink** —— 落库检索 / 日志关联 / 采样 / 脱敏。零依赖（只用 Node 内置
`node:sqlite`），只消费框架的 `TraceSink` 出口，**不改 engine、不加新出口**。

讲解与用法见 [`docs/observability.md`](../../docs/observability.md)。

## 为什么独立成包

示例 [`../complete/`](../complete/) 要用这些 sink，而 `tsc` 的 `rootDir` 不允许跨目录引源码
（也为了零重复）。做成一个本地小包，就是仓库对 `packages/trace-view` 的同一套办法。

## ⚠️ 以 `file:` 引入时的双实例陷阱

本包的 `package.json` 带着 `"@migor/agentia": "file:../.."`。把这个目录拷进你的工程、以
`"@migor/agentia-observability": "file:./observability"` 引入后，它会自带一份自己的
`node_modules/@migor/agentia` —— 与宿主顶层那份是**两个模块实例**。

跨边界传 `Trace` 数据无碍（类型是结构的）；但**模块级状态不共享** —— 典型是
`registerDefaultTraceSink` 的默认 sink 注册表（模块级数组）：在这份实例上注册，另一份看不到；
装饰器能力注册表（模块级 `WeakMap`）同理，与 usage-guide §2 的「陷阱」是同一条。

四个 sink 目前只 `import type` 框架的类型面（运行期零导入），所以**照现状直接用不出事**；
但一旦在这个包里写任何**运行期** `import { ... } from '@migor/agentia'`（比如加一个替宿主调
`registerDefaultTraceSink` 的组装函数），就踩进双实例。**推荐做法：把 sink 源码
（`src/index.ts`，单文件、零依赖）直接拷进你的工程** —— 拷走后它与宿主共享同一个
`@migor/agentia` 实例，这条陷阱整段不适用（与 `docs/observability.md` §2 的建议同款）。

## 构建

```bash
cd <仓库根> && npm install && npm run build     # 先构建框架
cd examples/observability && npm install && npm run build
```

## 导出

| 导出 | 作用 |
|---|---|
| `sqliteTraceSink({ db })` | run/span 落库（`traces` / `spans` 表），`getTrace(runId)` 按 runId 检索；与 `SqliteTaskStore` 同库 |
| `jsonLogSink(opts?)` | 一 run 一行 JSON（含 `runId`）→ 日志与 trace 双向可跳 |
| `sampleSink({ rate, sinks })` | 按 runId 哈希确定性采样；**错误 run 永不采样掉** |
| `redactSink({ keys?, patterns?, presets?, sinks })` | 字段名 + 正则脱敏（深拷贝，不改原 trace）；内置预设（Bearer/JWT/AWS/LLM key/邮箱/手机号）缺省全开，`presets` 可调 |

## Grafana 看板

[`grafana-dashboard.json`](./grafana-dashboard.json) 是一份对着 `metricsSink` 指标族（缺省前缀
`agentia_`）的现成 Grafana dashboard —— 不建看板平台，但把「接入即可视」的摩擦降到零。

面板：run 受理/失败速率（`agentia_runs_total` / `agentia_runs_failed_total`）、token 速率按 kind
（`agentia_tokens_total{kind}`）、成本（`agentia_cost_usd_total`）、run 时长 p50/p95
（`agentia_run_duration_ms_last{quantile}`，跨实例聚合请改用 `agentia_run_duration_ms` histogram）、
能力调用/失败 Top10（`agentia_capability_calls_total` / `agentia_capability_errors_total`）、
评分（`agentia_score` / `agentia_score_total`，来自 `attachScore` 的 score 事件）。

导入方式：

1. 服务侧把同一个 `metricsSink()` 挂进 `createApp({ sinks: [metrics] })`，并经
   `createHttpHandler({ metrics })` 暴露 `GET /metrics`；Prometheus 抓取该端点；
2. Grafana → Dashboards → New → Import → 上传 `grafana-dashboard.json`；
3. 导入时选择 Prometheus 数据源（dashboard 用 `DS_PROMETHEUS` 数据源变量，导入界面会要求绑定）。

指标名带自定义 `prefix` 时（`metricsSink({ prefix })`），把面板查询里的 `agentia_` 批量替换即可。
