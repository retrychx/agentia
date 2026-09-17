# Changelog

本仓库两包（`@migor/agentia` 与 `@migor/cli`）版本同步发布。
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 SemVer
（0.x 阶段：minor 可含破坏性变更，每个破坏性变更都在对应版本的「迁移」小节里写明）。
决策的完整证据链在 `docs/spec.md` §10（带时间线的决策日志）。

## [Unreleased] —— 拟 0.6.0

### 破坏性变更与迁移

- **公共消息类型自有化**：框架不再从 `@anthropic-ai/sdk` 导出/引用类型，`ModelClient` 契约、
  `RunAgentOptions.messages`、`traceToMessages` / `forkMessages` 的入出参等全部改用
  `@migor/agentia` 自有类型（`MessageParam` / `ContentBlockParam` / `Message` / `ToolParam` /
  `MessageUsage` 等 15 个，见 `src/core/message.ts`）。
  **迁移**：代码里写 `import type Anthropic from '@anthropic-ai/sdk'` 并标注
  `Anthropic.MessageParam` 的，改从 `'@migor/agentia'` import 同名类型（`Tool` → `ToolParam`、
  响应 usage → `MessageUsage`）。只传对象字面量（`{ role: 'user', content: '…' }`）的代码**无需改动**——
  自有类型与 SDK 结构兼容（有 `tests/types/message-compat.types.ts` 双向 assignability 门禁），
  SDK 类型的值可直接喂进来。
- **默认 client 自研化（fetch + SSE 手写，不再实例化 SDK）**：
  `AnthropicClientOptions` 的索引签名保留（旧代码编译不炸），但 SDK 构造参数**不再被消费**，
  只有 `apiKey` / `baseURL` / `maxRetries` / `timeout` 四个已知名生效，多余键静默忽略。
  module 级的 `splitSignal` 随 SDK 包装层删除（它从未进公共导出面）。
  **行为对齐 SDK 缺省**：重试 408/409/429/5xx、缺省 `maxRetries=2`、指数退避 + 抖动、尊重
  `retry-after`；`signal` 直传 fetch（中止语义不变）。
  **迁移**：依赖「SDK 特有的构造参数」（如 `authToken`、`defaultHeaders`）的，改用
  `baseURL` 指向网关或自带 `client`（`RunAgentOptions.client`，契约见 usage-guide「多模型」节）。
- **错误分类改鸭子类型**（`classifyError` 不再 `instanceof` SDK 错误类）：带数值 `status` 的
  错误按 HTTP 语义归类（429→rate_limit、5xx→server，可重试；其余 4xx→api 不可重试）。
  **已知边界**：使用者自装 SDK 并让它把 `APIConnectionError` 抛到引擎时，该错误无 status 可判，
  归类退化为 `unknown`（不可重试）——默认 client 不产生此类错误，仅影响自装 SDK 的场景。

### 新增

- **trace diff**：`diffTraces(a, b)` —— 两条 run 调用树的 A/B 比对（run 级 summary + 逐 span
  字段差；llm.turn 配对忽略模型名，capability 按 `kind:name`；缺省忽略墙钟）。
  CLI `agentia diff a.jsonl b.jsonl`（差异非空 exit 1，可进 CI 挡轨迹漂移）。
- **分叉重放**：`forkMessages(trace, { atTurn, append? })` —— 主循环第 N 回合前截断重放历史、
  拼新消息喂回 `app.run`（新 run，不是续跑；trace 不记 assistant 文本与原始输入）。
- **canCall 能力级能力边**：`@SubAgent` / `@Skill` 的 `tools` 在 provider token 之外接受
  `'token/能力名'` 路径（只引单个能力，装配期校验 + 可用名单报错）。
- **零运行时依赖达成**：`@anthropic-ai/sdk` 退出 dependencies（留 devDependencies 只为类型
  兼容门禁）；`npm i @migor/agentia` 不再连带任何运行时依赖。
- 官网文档站新增「场景指南」区（HTTP 服务上线 / 监控 / 离线评测与回流 / A/B / HITL）。

### 修复

- CLI Windows：`npmBin` 只加 `.cmd` 后缀在 CVE-2024-27980 后裸 spawn 必 EINVAL —— 改
  `npmSpawn`（cmd.exe 包装 + 逐参数脱敏，不用 `shell:true`）。
- CLI doctor 的 import 识别只认 default import（named/namespace/别名/跨行形态的悬空条目
  静默漏检）——已全形态支持。
- 脚手架模板纳入真 `tsc` 检查（e2e-cli 第 4 步）；CLI 对拍测试在产物缺失时不再静默跳过
  （CI 判失败，本地醒目横幅）。
- 引擎 `agentLoop` 拆分（433 行循环体 → 8 个有名字的函数 + `turn.ts` 独立成文件），纯重构
  零语义变更。
- 官网 playground 单价对齐框架内置价格表；正文链接色统一主题色。

## [0.5.0] - 2026-09-16

### 新增（R7 质量闭环）

- **score 一等公民**：`Score` + `attachScore`（评分挂 run 根 span 的 `score` 事件）；
  `defineEval` 结论自动落 score；metricsSink 聚合 `agentia_score` / `agentia_score_total` 指标族。
- **OTLP 对齐 OTel GenAI semconv v1.37**（additive 保留旧 `usage.*` 键；score 译
  `gen_ai.evaluation.result`）。
- `session.id` 提升为 trace 根属性（OTLP 映射 `gen_ai.conversation.id`）；
  `PromptSpec.version` → run 根 `prompts.versions`。
- **线上 trace 回流 eval**：CLI `agentia harvest <file.jsonl> [--failed] [--limit N] [--out]`。
- `examples/observability/grafana-dashboard.json` 随仓库发布。

## [0.4.2] - 2026-09-15

### 修复（发布后更正）

- `RedisTaskStore` 的 TTL 在 node-redis 上完全不生效（0.4.1 把 TTL 挪到 `SET` 位置参数，
  node-redis 只声明三个形参、多余参数被静默丢弃）—— `set` 只传两参，TTL 一律走
  `expire(key, seconds)`；设了 `ttlSeconds` 却没给 `expire` 时构造期抛错。
- `e2e-deploy` 端口 TOCTOU flake（`EADDRINUSE` 曾被误报为「示例进程启动即退出」）。

## [0.4.1] - 2026-09-15

### 修复（深度审查修复轮，40+ 处，无新公开 API）

- metricsSink 的 Prometheus 文本每个家族只发一次 HELP/TYPE（重复即整次 scrape 硬失败）。
- 预算护栏（`maxTotalTokens` / `maxCostUsd`）经 `ToolRunContext` 真透传到子 agent / skill 循环。
- CLI inspector：SSE 路径 `innerHTML` → `textContent`（XSS）+ Host 头校验。
- `drain` 强制关 SSE 现在真 abort 对应 run；示例 Dockerfile 补 `COPY docs`；新增
  `scripts/e2e-deploy.ts`（崩溃续跑验证）。

## [0.4.0] - 2026-09-14

### 新增

- trace 事件正文可展开：`maxEventChars` opt-in 开关（缺省截断值逐字不变，`false` = 不截断），
  CLI inspector 与官网 playground 两个宿主都真展开。

### 修复

- 默认 client 从不转发 `signal`（中止在飞 run 失效、超时 run 继续烧 token）——
  `splitSignal` 把 signal 搬到 SDK RequestOptions；门禁为本地假端点测试。
- `withTimeout` 收紧为硬保证（只看实测耗时）；截止计时器不得 `unref()`（四处）。
- CI 抖动根因修复（toolTiming 计时器赛跑改确定性形态）。

## [0.3.0] - 2026-09-14

### 新增

- `.env` 一等配置入口：显式 `loadEnvFile()`（框架不自动读），零依赖手写解析，真实环境变量
  优先；脚手架生成 `.env` / `.env.example` 并 gitignore。

## [0.2.2] - 2026-09-14

首个公开发布：`@migor/agentia` + `@migor/cli`（scope `@migor/*`），两包版本同步。
框架本体单包；CLI 独立成包（workspaces）。

[Unreleased]: https://github.com/retrychx/agentia/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/retrychx/agentia/releases/tag/v0.5.0
[0.4.2]: https://github.com/retrychx/agentia/releases/tag/v0.4.2
[0.4.1]: https://github.com/retrychx/agentia/releases/tag/v0.4.1
[0.4.0]: https://github.com/retrychx/agentia/releases/tag/v0.4.0
[0.3.0]: https://github.com/retrychx/agentia/releases/tag/v0.3.0
[0.2.2]: https://github.com/retrychx/agentia/releases/tag/v0.2.2
