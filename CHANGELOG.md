# Changelog

本仓库两包（`@migor/agentia` 与 `@migor/cli`）版本同步发布。
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 SemVer
（0.x 阶段：minor 可含破坏性变更，每个破坏性变更都在对应版本的「迁移」小节里写明）。
决策的完整证据链在 `docs/spec.md` §10（带时间线的决策日志）。

## [Unreleased]

### 修复（第六轮全量 review：「不报错地不干活」一次收口）

- **OpenAI 兼容端点的引擎重试此前整体失效**：非 2xx 抛的是裸 `Error`（无结构化 `status`），
  `classifyError` 一律归 `unknown + 不可重试` —— 兼容端点吃一个 429 就整轮 run 失败。
  现在抛 `OpenAICompatApiError`（带数值 `status`，与 `AnthropicApiError` 同形；module 级导出，
  不进公共面），429 → `rate_limit` 可重试；流内 `error` 分片（塞进 200 的流里的故障）按
  `type`/`code` 反推 status（`rate_limit` / `insufficient_quota` / `too_many` → 429）。
- **OpenAI 流式截断不再被记成成功**（**语义变更**）：终止判据从「累积为空」换成
  「既无 `[DONE]` 也无 `finish_reason` ⇒ 上游故障」—— 此前截断发生在已吐出半句之后时，
  半截输出被 `end_turn` 收尾上报。反向也对齐：正常终止但空的流若 `finish_reason=content_filter`
  不再误抛，与非流式路径同样记 `refusal`。
- **Anthropic 适配器的 usage 合并不再被显式 `null` 清零**：网关型端点的 `message_delta`
  带 `input_tokens: null` 时，浅合并会把 `message_start` 的真实计量抹掉，该回合 input/cache
  token 与 `costEstimate` 归零（`maxCostUsd` 护栏随之失效）。现在 `mergeUsage` 跳过
  `null`/`undefined` —— 缺值的语义是「保持已有值」，不是「清空已有值」。
- **`maxToolConcurrency` 的 (0,1) 小数不再静默丢弃全部工具**：`Math.floor(0.5) = 0` 曾意味着
  零 worker、工具一次都不执行。现在正数一律至少 1 个 worker；run 根快照记**生效的整数**
  （不限记 `'off'`，不再把 `NaN` / `-1` 写进 trace）。
- **`.env` 引号值 + 行内注释不再把字面引号写进值**：`A="sk-..." # prod` 曾被解析成含引号的
  `"sk-..."`（每个请求 401，文件看上去完全正确）。引号判定改为「扫到闭合引号为止，其后只允许
  空白或 `#` 注释」；未闭合 / 有残留回退未加引号分支，不猜。
- **`toolTimeoutMs` 现在透传给子 agent / skill 的子循环**：此前嵌套 run 里工具**永不超时**，
  且 MCP 桥找不到引擎预算会另起 60s 兜底 —— 双计时器 + 双账本。
- **MCP 桥裁判判据改为 `!= null`**（**语义变更**）：显式 `toolTimeoutMs: 0`（引擎表态「不限」）
  时桥不再自作主张判 60s —— 说了不限就该不限。
- **异步任务的崩溃恢复不再可能重复派发**：`resumePending` 认领时**先落库再派发** —— 此前认领
  只改内存，对 `list()` 返回反序列化新对象的 store（sqlite/redis），窗口内第二次扫描会把
  同进程正在跑的任务再派发一遍（重复执行、重复副作用、重复花费）。
- **优雅停机不再可能永不返回**：`handler.drain({ timeoutMs })` 在 deadline 已过时直接返回
  `false`，不再把「已到点」透传给 `0 = 不限` 的语义（SIGTERM 容器被强杀、在飞任务硬切）。
- **显式 `undefined` 不再覆盖重试缺省**：`{ maxAttempts: undefined }` 这类透传组装曾把重试
  静默关闭（快照记 0，像用户主动关的）/ 让退避算出 `NaN`。现在显式 `undefined` 回落缺省。
- **静态 `@Prompt` 不再被同名实例方法静默撞掉**：静态扫描改为按**解析后的菜单名**去重，
  实例↔静态真重名交给装配期抛「菜单能力重名」（对齐 spec §7「重名即抛」）。
- **`tool_use_no_blocks` 收尾现在带结构化 `error`**（`type:'agent_error'`）—— 此前该分支
  `status:'failed'` 但 `result.error` 是 `undefined`，HTTP body / 任务记录里看不出为什么失败。
- **`POST /tasks` 的 store 落库故障不再回 400 + 内部原文**：新增 `TaskInputError`（module 级，
  不进公共面）区分「调用方参数错」（400 + 原因）与「服务端故障」（500 + 走 `exposeErrors`
  策略）；读 body 期间开始停机的竞态回 503。
- **长上下文压缩不再切出孤儿 `tool_result`**：`compactMessages` 的切点校验换成「保留段工具
  自洽」—— 非相邻工具对（tool_use 与 tool_result 中间隔着普通消息）此前会切出孤儿块、下一次
  请求被 API 400；退无可退时照 `trimToolPairs` 先例整体放弃本次压缩。

### 新增（质量闭环收尾 + 指标基数封顶）

- **`beforeFlush(trace, result)`**（`RunAppOptions` / `ExecuteRunOptions`，可选）：sinks 冲刷
  **之前**的最后一笔 —— 「拿到 run 结果才判得出的结论」（典型是 `defineEval` 的 score）在这个
  时点挂上，`metricsSink` 才聚合得到。**此前 eval 的 score 挂在冲刷之后，永远进不了
  `agentia_score` 指标族**（usage-guide / roadmap 承诺的「eval → trace → 监控」链路是断的）。
  宿主漏透传该字段时 `defineEval` 退回「跑完再断言」：断言照做，不误报全挂，只是分数进不了指标。
- **`metricsSink` 三个维度的键空间都封顶**：新增 `maxModels`（缺省 50）/ `maxScores`（缺省 200），
  与 `maxCapabilities` 同口径 —— 超限键折叠进 `__other__`（**量不丢，只丢标签粒度**），
  snapshot 新增 `droppedModels` / `droppedScores`（各自最多记账 1024 个不同键，满了以后是下界）。
  此前 `models` / `scores` 无上限，与 usage-guide 承诺的内存上界不符。

### 重构（内部去重下沉 core，公共面不变）

- `sseLines` / `percentile` / `capabilityKindOf` / `textOf` / 可中断 `sleep` 各只剩一份
  （`src/core/{sse,stats,trace,text,timeout}.ts`）—— `integrations` 只准依赖 `core`，core 是让
  两处重复合一的唯一合法落点。`textOf(message, separator)` 三个调用点各传各的原值，行为零变化；
  两份 backoff（引擎 ±20% 均匀抖动 vs client ±25% 且尊重 `retry-after`）**刻意不合并** ——
  合并即改行为。

### 新增（trace 跨进程关联：`traceparent` → run 根 span links）

- **入站链路上下文**：`RunInvocationOptions.traceContext`（`{ traceId, spanId? }`）与 HTTP 请求头
  `traceparent`（W3C）现在会记成 run 根 span 的一条 **`links`**（新类型 `SpanLink`），
  `createOtlpExporter` 映射为 OTLP **span links** —— 于是「这条 run 是被谁触发的」在跨进程 / 跨服务
  时也可查。**不改 `traceId == runId` 的 1:1 不变量**：run 仍是自洽的一棵新树，上游是被**链接**
  而不是被**继承**成父 span（理由与取舍见 `docs/spec.md` §10 2026-09-17 ⑤）。
- 新增 `parseTraceparent(value)` 导出：把 `traceparent` 头解析成 `TraceContext`。
  **非法 / 缺失 / 版本 `ff` / 全零 id / 位宽不符一律返回 `undefined`**（不抛）——
  链路是观测行为，不该把业务请求打成 400。`createHttpHandler` 在 `POST /run` 与 `POST /tasks`
  上自动用它；`POST /tasks` 的 body 里显式给的 `options.traceContext` 优先于该头。
- **异步宿主零改动即继承**：`traceContext` 随 `spec.options` 落进 `TaskRecord`，所以另一个进程
  `resumePending` 续跑的那次 run 也带得上（队列消费者场景）。
- `TraceRecorder.addLink()` 记为公共能力；没记 link 的 span **没有 `links` 键**（不是空数组）。
- **已知边界（如实标注）**：只做**入站** —— 框架不生成出站 `traceparent`（运行中没有「当前 span」
  可导出，硬造会给出假 spanId）；link 只落 run 根，不自动跨进程传播（队列场景由调用方把
  `traceContext` 传下去）。

### 文档

- `docs/usage-guide.md`：新增「跨进程关联」小节（含队列消费者配方与「只做入站」的边界）、
  `app.run` 选项表补 `traceContext`、已知边界补一条；官网 API 页补 `TraceContext` / `SpanLink` /
  `parseTraceparent` 三行并把 `Span.links` 写进签名。

## [0.6.1] - 2026-09-17

### 文档（对外文案不再暴露内部流程；使用说明按用途重排）

> 随包发布的 `dist/AGENTS.md`（单源即 `docs/usage-guide.md`，也是 `agentia create` 写进新项目的
> 那份）一并更新 —— 装上本版即可看到，不必等下一次发版。

- **删掉讲本仓库自身流程的内容**：`§9 提交前自检`（它列的是本仓库门禁 —— `typecheck:tests` /
  `test` / `e2e` 三步链 —— 而脚手架生成的项目并没有这些 script，照抄必然失败）、前言里
  「文中 API 名由框架仓库的测试对着源码校验」句，以及散在正文里的内部路线图代号（`（R7）`）。
- **相对上一版的措辞改成陈述句**：「不再混进 connection」「不再静默映射成成功」这类只有用过旧版
  才读得懂的写法，改为直接陈述现状。
- **结构**：加顶层目录；「运行时 API」的 33 个子节按用途拆成六组（运行时上下文与装配 / 触发与宿主 /
  上下文预算与成本 / 观测与调优 / 集成 / 横切缝）；「框架只给缝、不建子系统」的口径集中到一处讲，
  不再逐个标题辩白。
- 官网（不随 npm 包发布）：API 页 `classifyError` 措辞、docs 页侧栏按用途分组、以及**滚到页面底部时
  末条导航不高亮**的修复。
- `@migor/trace-view`（不单独发布，随 CLI 构建期拷贝）README 补齐漏写的 `rawArg` 导出，
  并加一份「README 必须覆盖导出面」的守卫防再漏。


### 变更（超时有了自己的 `errorType`：`connection` → `timeout`）

- `classifyError` 对超时（内建 `DOMException('TimeoutError')` —— `AbortSignal.timeout()` 与默认 client 的
  超时合成信号；以及任何 `code === 'timeout'` 的错误）现在返回 **`type: 'timeout'`**，不再归进 `connection`。
  **`retryable` 保持 `true`** ⇒ **自动重试行为不变**（超时本来就是可重试故障）；变的是**记账**：
  按 `span.error.type` 分流的看板 / 告警会把超时类从 `connection` 挪到 `timeout`，`trace-diff` 比对旧 trace
  时超时会显示为「类型变了」。取证与决策见 `docs/spec.md` §10 2026-09-17 ②。
- 顺带把 `isTimeoutError` 的契约写清（三条判据，全鸭子类型）：框架 `TimeoutError` 实例 /
  `code === 'timeout'` / `name === 'TimeoutError'`；引擎的工具级 catch 用它 ⇒ 工具自判的超时与引擎判的
  超时记同一类账（`errorKind='timeout'`）。
- ⚠️ **更正**：此前一版说明里「模型调用超时在 `span.error` 上是 `type:'unknown'`（不可重试）」是**错的** ——
  它一直判 `connection` + 可重试（`engine/errors.ts` 的 `isConnectionError` 专门认 `name === 'TimeoutError'`）。
  该错误说明已从 `docs/spec.md` 删除，以 2026-09-17 ② 为准。

### 变更（MCP 超时单源化 —— 一次调用只有一个裁判）

- **原语单源**：`TIMED_OUT` / `withTimeout` 下沉到 `src/core/timeout.ts`，`engine/concurrency.ts`
  原样再导出（`import` 路径与名字对使用者与测试都不变）。MCP 桥的 `withDeadline` 改为它的**薄封装** ——
  此前桥自带一份**纯竞速**实现，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥能把**超预算**的
  MCP 调用记成成功（确定性可复现；取证与决策见 `docs/spec.md` §10 2026-09-17 ①）。
- **⚠️ 行为变更（迁移注意）**：引擎设了 `toolTimeoutMs` 时，`mcpTools({ timeoutMs })` **不再参与判定**
  （即使桥的 `timeoutMs` 更短）—— 一次调用只有一个裁判，此前「谁短谁生效」让同一件事在 trace 里
  落成两种账。要收紧某个 MCP server 的时限，请设 `toolTimeoutMs`（或把该工具单独包一层）。
  桥的 `timeoutMs`（缺省 `MCP_DEFAULT_TIMEOUT_MS` = 60000）只在「桥脱离引擎单用」或
  「引擎没设 `toolTimeoutMs`」时作为兜底，且兜底同样走**实测耗时**判定。
- **超时归一类账**：工具自判的超时（抛 `code === 'timeout'` 的错误，桥的兜底超时即是）从
  `errorKind='threw'` + `error(unknown)` 变为 `errorKind='timeout'` + `error(timeout): …`，
  与引擎判的超时同类、同样**不杀 run**。按 `errorKind` 分流看板的查询请知悉这一变化。

### 修复（第五轮 review：三条「功能静默失效」+ 一批边界）

- **`app.run` 丢掉 `signal`（取消全线失效）**：运行期入参是逐字段手抄进 `executeRun` 的，
  唯独漏了从 `RunInvocationOptions` 继承来的 `signal`（TS 不报错）。后果是**三处宿主与三份文档
  都假设的取消全都不生效**：HTTP 客户端断开不中止、`drain` 收口只关流不灭 run、
  `AsyncRunner.runTimeoutMs` 只 race 掉结果而在飞请求继续烧 token。已补上转发 +
  真 `AgentApp` 路径的回归用例（宿主侧测试用的是**假 app**，正好绕过了这一跳）。
- **OTLP 的 `spanId` 宽度错**（`otlp.ts`）：内部 UUID（32 hex）被原样当作 span id，
  而 OTLP 契约里 span id 是 8 字节（**16 hex**，trace id 才是 32）—— 真 collector 会判
  `invalid span_id` 拒收或截断。已按两种宽度分开转换。
- **OTLP 对能力 span 一条 `gen_ai.*` 都不发**：`genAiAttributes` 按 `span.name.startsWith('subagent:')`
  判类型，而生产代码写的是**裸能力名 + `attributes.subagent` / `skill`**（metrics / report /
  trace-view 三个消费者都读 attributes，只有这里读前缀）⇒ 子 agent 的 `gen_ai.agent.name`、
  skill 的 `gen_ai.tool.name` 在生产里从未发出。已改为读 attributes，并把测试夹具改成生产形状。
- **`gen_ai.evaluation.score.name` 不是 semconv 键**（真实 key 是 `gen_ai.evaluation.name`）——
  已修正并同步文档（实测 `@opentelemetry/semantic-conventions` 全量键名里无前者）。
- **`costEstimate` 命中原型链 → NaN**：模型名恰为 `constructor` / `toString` 时
  `pricing[model]` 拿到函数（真值）而 `.in` 为 undefined ⇒ 成本 NaN，`maxCostUsd` 的
  `NaN > x` 恒 false 而静默失效，NaN 还会进 trace / OTLP。改为 `Object.hasOwn` 查找。
- **`mcpTools` 两处**：外部 server 的 `description` 不是 string 时装配期崩 `TypeError`
  （同循环里 name / inputSchema 都有类型防御）；`mcp.tool` 单值 attribute 在同回合并行调多个
  MCP 工具时互相覆盖 ⇒ 新增 `mcp.tool.<菜单名>`，审计 / 回放不再丢原名。
- **`combineSignals` 同源重复时残留监听器**（去重后走单源快路径）；
  **`session.append` 展开传参的 12 万项 RangeError**（同 `replaceMessages` 已规避过的坑）；
  **`harvest` 把缺 `tool` 的事件回填成 `'unknown'`**（会在生成物里造出一个真的、且断言必然
  通过的工具调用 —— 骨架自我自洽、永不报错）与**注释行裸插 name / source**（含换行即破产物）；
  **`replay` 放行数组型 `tool_use.input`**（API 要求对象）。

### 新增

- **脚手架补齐生产构建链**：`agentia create` 生成的项目此前只有 `dev`/`typecheck`，没有
  打包工具（连模板自己的 .env 注释都引用了不存在的 `npm start`）。现在生成
  `build`（tsc → `dist/` + `scripts/copy-assets.mjs` 跟随拷贝 .md 文本资产）与
  `start`（`node dist/main.js`），tsconfig 带 `rootDir`/`outDir`；e2e-cli 新增 4d 步
  真跑这条链（emit + 资产拷贝 + dist 产物断言）。

### 修复（第四轮 review：文档面错到「照抄就坏」+ 边界条件）

- **`app.run` 支持 `memory`（新增选项，非破坏）**：官网手写页与单源指南一直用
  `app.run(messages, { memory })` 演示跨 run 记忆，但 `RunAppOptions` 里**没有**这个字段
  —— 照抄的代码 TS 直接报「对象字面量只能指定已知属性」，硬绕过去则运行期**静默不生效**
  （记忆从不水合、也不回写）。现在与 `session` 完全对称：`app.run` 也水合/回写，
  边界同样只在程序内（store 不可序列化，不进 transport 的 `RunInvocationOptions`）。
- **`compactMessages` 不再劈开「工具对在索引 0」的历史**：回退循环的 `cut > 1` 让它停在 1
  时，`tool_use` 被折进摘要、尾部留下**孤立 `tool_result`**（并与摘要构成连续两条 `user`）
  —— 正是该函数 docstring 明说不产出的两种形态，下一次请求会被 API 400 拒。
  现在回退到 1 仍落在 `tool_result` 上就**放弃本次压缩**（原样返回）。
- **`agentia create` 撞同名普通文件**：此前 `readdirSync` 抛原始 `ENOTDIR` 栈（栈里全是
  `node:fs` 内部帧），那句「目录已存在且非空」的友好文案根本轮不到；现在先判路径类型。
- **子命令 `--help`**：`agentia report --help` 此前把 `--help` 当文件名去读，报
  `读不到文件 --help（ENOENT）`；现在 8 个子命令都回自己的用法串（与 `fail()` 共用同一份常量）。
- **`agentia harvest --out` 默认不覆盖**：产物是「人工核对后再进 CI」的脚手架，重跑一次会
  静默抹掉你手改过的断言与 input；目标已存在时报错，要覆盖显式加 `--force`。
- **`agentia report` 缺 CLI 资源时的报错**：`dist/inspector/summary.js` 缺失时给出人话 +
  补救动作（此前是原始 `ERR_MODULE_NOT_FOUND`，路径全在 dist 内部，用户读不出该做什么）。
- **文档面形状**：官网 `docs.html` 与单源 `usage-guide.md` 的「出参护栏」示例读的是
  `out.finalText`，而 run 输出是 `{ run, result }` —— 判断恒为 `undefined`、**护栏恒不触发**，
  页面上却像在生效；改为 `out.result.finalText`，并新增定向守卫
  `tests/docs/run-output-shape.test.ts`（手写片段此前没有任何东西在编译它）。
  `tests/docs/api-page.test.ts` 的行匹配器同时放宽（`<tr class="…">` 此前整行静默跳过）。

### 修复（发布面与证据可核性）

- **CHANGELOG 进 npm 包**：npm 的「总是包含」只覆盖 README/LICENSE（实测 `npm pack` 不含
  CHANGELOG）——根包 `files` 登记 + CLI 包构建期拷贝到包根，`e2e-cli` 新增两包 pack 内容断言。
- **bump 闸门**：`check-release.mjs` 新增「要发的版本必须高于 npm 已发布版本」（查官方
  registry，E404 首发放行）——此前只验四处一致、不验高低。
- **code-review 证据签入**：真跑 trace 与报告落 `examples/code-review/evidence/`（此前 `out/`
  被 gitignore，README 的数字无从核）；README 表格数字全部改为可从产物复核的值。

## [0.6.0] - 2026-09-17

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
- **`examples/code-review/` 真实案例**：代码评审 agent 服务（四类能力 + 能力级 tools 路径 +
  预算护栏 + 自定义 file sink 产 trace.jsonl），离线 demo（scriptedClient）与真模型两种跑法；
  已用真端点实跑并在 README 记录真实 token/成本/trace 数据（验证证据）。

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

[Unreleased]: https://github.com/retrychx/agentia/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/retrychx/agentia/releases/tag/v0.6.1
[0.6.0]: https://github.com/retrychx/agentia/releases/tag/v0.6.0
[0.5.0]: https://github.com/retrychx/agentia/releases/tag/v0.5.0
[0.4.2]: https://github.com/retrychx/agentia/releases/tag/v0.4.2
[0.4.1]: https://github.com/retrychx/agentia/releases/tag/v0.4.1
[0.4.0]: https://github.com/retrychx/agentia/releases/tag/v0.4.0
[0.3.0]: https://github.com/retrychx/agentia/releases/tag/v0.3.0
[0.2.2]: https://github.com/retrychx/agentia/releases/tag/v0.2.2
