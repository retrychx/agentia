# @migor/agentia-observability

Agentia 生产可观测栈的**现成 sink** —— 落库检索 / 日志关联 / 采样 / 脱敏。零依赖（只用 Node 内置
`node:sqlite`），只消费框架的 `TraceSink` 出口，**不改 engine、不加新出口**。

讲解与用法见 [`docs/observability.md`](../../docs/observability.md)。

## 为什么独立成包

示例 [`../complete/`](../complete/) 要用这些 sink，而 `tsc` 的 `rootDir` 不允许跨目录引源码
（也为了零重复）。做成一个本地小包，就是仓库对 `packages/trace-view` 的同一套办法。

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
| `redactSink({ keys?, patterns?, sinks })` | 字段名 + 正则脱敏（深拷贝，不改原 trace） |
