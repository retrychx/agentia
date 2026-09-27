# R8 演化候选 设计与实施（MCP 反向桥 / trace 脱敏 / SFT 导出 / fallback / 租户归因 / durable）

> **状态**：**实施中**（2026-09-27 立项）。来源是同日的三视角分析（业界成熟产品对照 /
> AI 演化方向 / 产品化路径），用户授权「做成规划文档，然后一个个的做」。
> 每项的落地证据（PR 号、反向验证读数、与设计的偏差）滚动记入本文末尾「实施记录」。

## 定位筛子（每条候选先过这四道，不过就拒）

1. **trace 一等公民**：新能力必须进 trace 记账或让 trace 更有用，绕开 `TraceSink` 出口 = 倒退。
2. **零运行时依赖**：只用标准库直接内置；要第三方客户端的一律 duck-typed 缝 + recipe/示例。
3. **不建后端看板 / 告警引擎 / 数据集 CMS**（对照 Langfuse/LangSmith 的刻意不做清单）。
4. **一个第三方客户端一个包**：真到拆包时的粒度，不是「服务包」。

## 候选清单与排序

| 序 | 项 | 体量 | 一句话 |
|---|---|---|---|
| P1 | trace 脱敏钩 | 小 | sink 包装器：本地全量、远端脱敏 |
| P2 | 模型 fallback client | 小中 | 组合式 ModelClient，分类错误落备选 |
| P3 | trace → SFT 导出 | 中 | 拆 P3a（引擎可选记 assistant 文本）+ P3b（CLI 导出） |
| P4 | 租户归因 labels | 小中 | run 级标签进 trace 根；metrics 侧 opt-in 防基数爆炸 |
| P5 | MCP 反向桥 | 大 | 把 @Tool 集合暴露成 MCP server（stdio + StreamableHTTP） |
| P6 | durable 长时程 | 立项调研 | 天级 run：durable timer / 事件唤醒 / 版本兼容 —— **本轮不实施** |

缓做：**A2A 协议适配**（协议仍在快速漂移，现在接容易接到过时版本；等收敛）。
拒做：后端看板、DAG 可视化编辑器、swarm 编排（定位决定，见 roadmap 原则节）。

## P1 trace 脱敏钩（redacting sink）

**动机**：「trace 决定它敢不敢上线」还有另一半 —— 敢不敢**出库/发给厂商**。trace 里
有用户输入、工具出参，可能含 token/邮箱/手机号。LangSmith 用户最大的顾虑就是这个。

**设计**：`src/integrations/redact-sink.ts`，导出
`redactingSink(sink, opts?): TraceSink` —— 包装器而非引擎级开关，因为真实诉求是
**按出口分别脱敏**（本地 `jsonlTraceSink` 全量留档，OTLP 出口脱敏后上远端），引擎级
一刀切反而把这个用法灭了。

- 深遍历 trace（它是 JSON 可序列化结构），只改写字符串值；数字/布尔/结构不动。
- 出厂规则：Bearer/AKIA 类 token、邮箱、手机号（+86 与国际形态）；`patterns` 追加自定义
  `RegExp[]`（与出厂规则**叠加**，不是替换 —— 替换会让「想加一条」变成「把出厂的默全默」）。
- 替换文案带计数（`⟨已脱敏:email⟩` 形态），让「这里被改过」在 trace 里可见 ——
  静默替换会让下游排查误以为数据本来如此。
- 纪律与 `flushSinks` 一致：脱敏本身不得抛（规则正则写坏了也不能击穿业务）。

**验收**：单测覆盖出厂规则逐条、叠加语义、非字符串字段不动、坏正则不抛；
反向验证（摘掉某条出厂规则 ⇒ 对应用例红）；usage-guide 加节；api.html 登记导出。

## P2 模型 fallback client

**动机**：OpenRouter/LiteLLM/Portkey 的核心卖点之一。引擎已有 `classifyError`
（rate_limit/server/api/connection/unknown），fallback 是它的天然消费者。

**设计**：`src/engine/fallback-client.ts`（在 engine 不在 integrations：要用
`classifyError`，而 integrations 只许依赖 core —— 分层单向不破）。导出
`fallbackModelClient({ clients, shouldFallback? }): ModelClient`：

- 逐个尝试 `clients`；失败时 `classifyError` 判类，缺省对 `rate_limit` / `server` /
  `connection` 落下一个，`api` / `unknown` 直接抛（4xx 多半是请求本身有病，换模型无用）。
- **「吐过字不换」**（与 retry.ts 的「吐过字不重试」同一护栏）：本尝试已 `on('text')`
  吐过任何 delta，失败就抛 —— 否则换 client 重跑会让用户看到两段拼起来的回答。
- `shouldFallback?: (err: SpanError, clientIndex: number) => boolean` 覆盖缺省判定。
- 抛出的错误是**最后一个** client 的原始错误（不包装 —— 引擎的分类器靠鸭子类型认
  status/code，包装会灭掉这些属性）。
- 不记账：fallback 发生在 llm.turn 内部的一次 stream 调用里，重试/切换由引擎既有
  span（`retry.attempt` / llm.retry 事件）覆盖；本组合器不加自己的观测面 —— 
  若实践表明「换了哪个 client」需要可见，再加（**先不做**）。

**验收**：单测（mock client 依次失败/成功、吐字后失败不换、api 类不换、原错误冒泡）；
反向验证（摘掉「吐过字不换」⇒ 对应用例红）；usage-guide + api.html。

## P3 trace → SFT 导出（拆两步）

**动机**：harvest 是「trace → eval 用例」，它的孪生是「trace → 训练数据」—— 配合
score/exemplar 筛好 run，把「生产 trace → 自我改进」的环闭上。

**关键事实调查结论（2026-09-27，已读码核实）**：trace **不记 assistant 文本** ——
llm.turn 只记 usage/事件（`engine/replay.ts:30-32` 如实声明了这个有损边界）。工具往返
（tool_use 参数 / tool_result 出参）在事件里，可还原。⇒ 纯 trace 导出的 SFT 数据**缺
assistant 正文**，那是训练数据里最值钱的部分。所以拆两步：

- **P3a（引擎，改语义 ⇒ spec §10 决策记录）**：可选记录 assistant 文本。
  形状候选：run 级 opt-in 旋钮 `traceContent: 'full'`（缺省不记，现状不变）——
  记进 llm.turn span 的 `output.text` 属性（过 `traceLimits.maxEventChars` 同款截断闸）。
  必须写清的：这会显著增大 trace 体积（bench:trace 跑一遍给出实测数）且把模型输出
  纳入「要脱敏的面」（与 P1 直接联动 —— 文档里两条互相指）。
- **P3b（CLI）**：`agentia export <trace.jsonl> [--min-score X] [--out file]` ——
  按 score 过滤 run，输出 JSONL（每行一份 messages 序列）。无 `traceContent:'full'`
  的 run 导出为工具轨迹（assistant 文本缺席**要在导出物里标注**，不静默）；有全量
  记录的导出完整对话。去类型移植副本纪律同 harvest/diff（CLI 侧逐字对拍守护）。

**验收**：P3a 有反向验证（摘掉旋钮 ⇒ 导出物无正文）+ bench 体积数进文档；
P3b 走 CLI 套件 + e2e-cli 链条惯例。

## P4 租户归因 labels

**动机**：用框架做 SaaS 的人第一张账单是「哪个客户烧了多少钱」。

**设计**：run 调用契约加 `labels?: Record<string, string>`（RunSpec/RunInvocationOptions）：

- **trace 根**记 `labels.*` 属性（无基数问题，随便加）。
- **metrics 侧 opt-in**：`metricsSink({ labelKeys: ['tenant'] })` 显式声明哪些 key 上指标
  标签 —— **缺省一个都不上**。Prometheus 标签基数爆炸是真实事故类（tenant 有几千个，
  指标族 × 租户数 = 时间序列爆炸），所以必须是显式选择而不是默认行为。
- OTLP 出口映射成资源/span 属性（additive，不动既有 gen_ai.* 键）。

**验收**：单测 + 反向验证；usage-guide 写清基数警告；spec §10 记决策（metrics opt-in
的理由）；api.html。

## P5 MCP 反向桥（最大项，最后做）

**动机**：生态位跃迁 —— 框架从「agent 的运行容器」变成「生态里的工具供应商」：
`@Tool` 集合暴露成 MCP server 后，Claude Code / Cursor / 任何 MCP 宿主能直接调。

**设计草案（实施前先写细化设计）**：

- 范围**只到 tools**（`initialize` / `tools/list` / `tools/call`）；resources/prompts 不做。
- 传输：stdio（CLI 场景）+ StreamableHTTP（服务场景）—— 两者都是标准库可写
  （正向桥的连接器已是标准库实现，协议认知现成）。
- 形状候选：`createMcpServer(app, { transport, auth? })`；tool 菜单 = 装配后的能力清单
  （与 run 同一份，经中间件包装后的那份 —— 与 canCall 语义一致）。
- 鉴权：HTTP 侧 token 闸（与 HTTP 宿主同纪律）；stdio 侧信任父进程。
- 每调用 = 一个 capability span（挂在 server run 根下）—— trace 叙事不破。

**验收**：`npm run e2e:mcp` 同款纪律反过来 —— 真第三方 MCP **client** 打过来跑一轮
（离线夹具回落）；usage-guide + api.html；独立 PR。

## P6 durable 长时程（本轮只立项）

**动机**：agent 任务时间跨度在变长（LangGraph 1.0 主叙事）。现有崩溃续跑 + HITL 挂起
覆盖「分钟级」；「天级」需要 durable timer（三天后继续）、外部事件唤醒（webhook 到了
接着跑）、agent 代码版本 vs 在飞 run 的兼容策略。

本轮**只做**：调研文档（对照 Temporal/Restate/DBOS 的 durable executor 模型，列出
agentia 现状与他们之间的差距清单 + 推荐的最小语义增量）。**不写实现代码。**

## 实施纪律（每项都适用）

1. 新增公共导出必须登记 `src/index.ts`，官网 `api.html` 同步（反向全覆盖测试会咬）。
2. 新行为带测试 + **反向验证**（摘掉实现 ⇒ 对应用例红，读数记进 PR 描述）。
3. 改语义的进 `docs/spec.md` §10 决策记录；`docs/usage-guide.md` 是唯一使用者文档。
4. CHANGELOG `[Unreleased]` 随 PR 记账，不攒到发版。
5. 每项独立 PR；verify-all 8/8 全绿才提；CI 五个必需检查绿才合。
6. 旋钮类新增先查 `src/core/limits.ts` 真源表要不要登记（0 的语义必须落地）。

## 实施记录

（滚动更新：每项落地后在此记 PR 号、反向验证读数、与设计的偏差。）
