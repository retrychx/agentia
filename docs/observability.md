# 生产可观测栈（配方）

面向「把 agentia 服务**交付上线**」的人 —— 定位见 [spec §1](./spec.md)（交付物是可上线的 Agent 服务，
不是对话助手）。本文只讲**观测落地**：框架给什么、不给什么，以及四条开箱即用的 sink 配方。

> 代码：[`examples/observability/`](./../examples/observability/)（本地小包 `@migor/agentia-observability`，
> 四个 sink 的完整实现，零依赖）。
> 该文件与本文的写法由 `tests/docs/observability.test.ts` 真跑一遍钉住 —— 仓库既有约定：
> 文档里的写法必须真能工作。

## 0. 框架给什么 / 不给什么

| | 状态 |
|---|---|
| 完整 trace（调用树，run == trace 1:1，含每步 usage） | ✅ 内建（`spec §9`） |
| sink 出口（`TraceSink`）+ 投递（成功/失败两条路径） | ✅ 内建（`spec §9.3`） |
| OTLP 导出器 / 指标累加器 | ✅ 现成（`createOtlpExporter` / `metricsSink`） |
| **日志层**（级别 / 结构化 JSON / runId 贯穿） | ❌ 全仓库仅 6 处 `console.error/warn` 兜底 → **配方 2.2** |
| **采样**（量大时别压垮后端） | ❌ → **配方 2.3** |
| **字段级脱敏**（框架只有长度截断） | ❌ → **配方 2.4** |
| **按 runId 落库 + 检索** | ❌ → **配方 2.1** |
| **部署产物**（Dockerfile / compose） | ❌ → `examples/deploy/` |

关键点：**这些缺口都不需要改 engine**。trace 出口是缝，四条配方全是缝外的组合 ——
这正是 `spec §10` 把出口定成 `TraceSink` 的收益。

## 1. 出口：`TraceSink`

```ts
interface TraceSink {
  export(trace: Trace): void | Promise<void>;
}
```

- **投递时机**：run 收尾后，**成功与失败两条路径都投递**（`runtime/run.ts`）。失败时 trace 仍完整，只是根 span
  可能带 `status: 'error'`。
- **抛错语义**：sink 抛错被框架**吞掉**，绝不影响 run 结果（与记忆回写同款防护）。所以每个 sink 自己
  负责「观测失败不能连累别的 sink」—— 见示例里的 `fanOut()`。
- **挂载点两个**：
  - `createApp({ sinks: [...] })` —— 按 app 装配（推荐，作用域清晰）。
  - `registerDefaultTraceSink(sink)` —— 全局默认（**构造期快照合并**，之后再注册不影响已建好的 app）。
- **数组 = 串联**：`sinks: [a, b]` 顺序执行 `a.export` 然后 `b.export`。需要「一个包一个」时（采样包脱敏、
  脱敏包落库）用配方里的组合参数，不用框架感知。

## 2. 四条配方

现成实现在 `examples/observability/`（本地小包）。下面给**接线**与**为什么**，实现细节读那个包。

### 2.1 按 runId 落库检索（span 与 run 记录同库）

`spec §9.3` 承诺的「span 与 run 记录同库存储」，落地就是一个 sink：

```ts
import { DatabaseSync } from 'node:sqlite';
import { sqliteTraceSink } from '@migor/agentia-observability';

// 与 SqliteTaskStore 用**同一个库文件** —— run 记录（tasks 表）与 trace（traces/spans 表）共库
const db = new DatabaseSync('agentia.db');
const store = sqliteTraceSink({ db });

createApp({ name: 'svc', providers, sinks: [store] });
```

建表 `traces`（一 run 一行：全量 JSON + 反规范化列）与 `spans`（一 span 一行）都用 `IF NOT EXISTS`，
与 `SqliteTaskStore` 共存一库；`busy_timeout = 5000` 与它一致，多进程共库不会 `SQLITE_BUSY`。

取回一次历史 run：

```ts
store.getTrace(runId);   // → Trace | undefined（按 runId 检索，回放调试的入口）
store.getSpans(runId);   // → span 明细行
store.listRecent(20);    // → 最近 N 条 run 摘要（按开始时间倒序）
```

**taskId → runId 关联**：`tasks` 表的 `run_id` 在 `json` 列里（不在列上）。两步查：

```sql
SELECT json FROM tasks WHERE task_id = ?;        -- 1) 解析出 runId（TaskRecord.runId）
SELECT * FROM traces WHERE run_id = ?;           -- 2) 取该 run 的 trace
```

直接 SQL 的常见问题（`spans` 表已反规范化，不用解析 JSON）：

```sql
-- 慢 span 排行
SELECT name, kind, ended_at - started_at AS ms FROM spans
 WHERE run_id = ? ORDER BY ms DESC LIMIT 10;
-- 错误 span
SELECT name, error_type, retryable FROM spans WHERE run_id = ? AND status = 'error';
-- token 大户（只算 llm.turn 自身计量，与 Trace.totalUsage 口径一致）
SELECT name, input_tokens + output_tokens AS tok FROM spans
 WHERE run_id = ? AND kind = 'llm.turn' ORDER BY tok DESC;
```

### 2.2 日志关联

```ts
import { jsonLogSink } from '@migor/agentia-observability';

createApp({ sinks: [jsonLogSink({ labels: { service: 'svc', env: 'prod' } })] });
```

一 run 一行 JSON 落到 stdout（容器里就是 stdout 采集），字段含 `runId` / `status` / `durationMs` /
`iterations` / `tokens` / `costUsd` / `error`。**接缝就在 `runId`**：

- 日志里看到异常 → 拿 `runId` → `SELECT * FROM traces WHERE run_id = ?`（配方 2.1）取完整调用树。
- trace 里看到异常 span → grep 同 `runId` 的日志行看当时上下文。

这是补上「框架没有日志层」那一脚的最小做法 —— 不需要引入日志库。

### 2.3 采样

```ts
import { sampleSink } from '@migor/agentia-observability';

const sink = sampleSink({ rate: 0.1, sinks: [/* 下游 */] });  // 只留 10%
```

- 判定用 **runId 的哈希**（FNV-1a）而非 `Math.random` —— 同一 run 的判定**确定**，回放/复现时一致。
- **失败 run 永不采样掉**：采样为了省钱，不能省掉最该看的那些。
- `rate: 0` = 只留错误 run；`rate: 1` = 全留。

### 2.4 脱敏

```ts
import { redactSink } from '@migor/agentia-observability';

const sink = redactSink({
  keys: ['authorization', 'api_key', 'password', 'cookie'],   // 字段名（大小写不敏感子串）
  patterns: [/1[3-9]\d{9}/, /[\w.+-]+@[\w-]+\.[\w.]+/],        // 可选：手机号 / 邮箱
  sinks: [/* 下游 */],
});
```

- 递归深拷贝 —— **原 trace 不被改动**（其余 sink 仍拿得到原文，便于「本地调试看原文、上报脱敏」并存）。
- 覆盖 `span.attributes`、`span.events[].body`、`span.error.message`。
- 放在链路上游（脱敏 → 落库/日志），保证下游拿到的都是脱敏副本。

### 2.5 组装

数组顺序即调用顺序，最外层先看到原始 trace：

```ts
const db = new DatabaseSync('agentia.db');
const sink = sampleSink({
  rate: 0.1,
  sinks: [
    redactSink({
      keys: ['authorization', 'api_key'],
      sinks: [
        sqliteTraceSink({ db }),   // 落库（同库）
        jsonLogSink(),             // 一行 JSON 日志
      ],
    }),
  ],
});

createApp({ name: 'svc', providers, sinks: [sink] });
```

## 3. 与内置件的关系（别重复造）

| 内置件 | 干什么 | 和上面的关系 |
|---|---|---|
| `createOtlpExporter({ endpoint })` | OTLP/JSON → collector（Jaeger / Tempo / Grafana） | **可以用内置的**：返回值天然满足 `TraceSink`，直进 `sinks` |
| `metricsSink({ prefix })` | 进程内累加 + Prometheus 文本 `/metrics` | **可以用内置的**：同样满足 `TraceSink` |
| 本文四条配方 | 落库 / 日志 / 采样 / 脱敏 | 内置件没有的那部分，缝外自建 |

OTLP 与本文配方**不互斥**：`sinks: [sampleSink({ rate: 0.1, sinks: [createOtlpExporter({...})] }), sqliteTraceSink({ db })]`
= OTLP 采样 10%、本地库全量留档，是常见配法。

## 4. 边界（如实标注）

- **框架不内建日志层 / 采样 / 脱敏 / 存储 / 部署产物** —— 那是宿主职责，框架只保证 trace 出口。
- **失败路径的根 span 可能未收尾**（`endedAt === undefined`）：半截 trace 仍会投递（信息比丢了好），
  但按 duration 统计时要过滤 —— `metricsSink` 就是这么做的（根没收尾的 run 不进延迟样本）。
- **采样与「错误必留」是取舍**：错误全留会让故障期的落库量反而升高；极端场景请自行收紧。
- **`costUsd` 依赖模型在价格表内**：不在表里时成本恒 0（见 `usage.ts`）。
- **部署示例未含自动扩缩 / 密钥管理 / 反代鉴权** —— 见 `examples/deploy/README.md` 的标注。
