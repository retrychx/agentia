# R8 演化候选 设计与实施（MCP 反向桥 / 租户归因 / SFT 导出 / fallback / 脱敏配方 / durable）

> **状态**：**实施中**（2026-09-27 立项；同日经一轮逐条核证评审后修订 —— 见文末「修订记录」，
> 初稿的 P1/P2/P4 三条被打回重定界）。来源是同日的三视角分析（业界成熟产品对照 /
> AI 演化方向 / 产品化路径），用户授权「做成规划文档，然后一个个的做」。
> 每项的落地证据（PR 号、反向验证读数、与设计的偏差）滚动记入本文末尾「实施记录」。

## 定位筛子（每条候选先过这五道，不过就拒）

1. **trace 一等公民**：新能力必须进 trace 记账或让 trace 更有用，绕开 `TraceSink` 出口 = 倒退。
2. **零运行时依赖**：只用标准库直接内置；要第三方客户端的一律 duck-typed 缝 + recipe/示例。
3. **不建后端看板 / 告警引擎 / 数据集 CMS**（对照 Langfuse/LangSmith 的刻意不做清单）。
4. **一个第三方客户端一个包**：真到拆包时的粒度，不是「服务包」。
5. **先查「不内建表」再写设计**：`docs/observability.md` 顶部那张表与 spec §9.3/§10 已经
   否决过的条目（脱敏、采样、日志层、落库……）**不得在框架内重做** —— 初稿 P1 就撞在这条上
   （见修订记录①）。⚠️ 这类越界**没有机械守卫**：`tests/docs/observability.test.ts` 只核
   「文档 ↔ examples 导出集」，不比 `src/` —— 拦它的是读表的人，写设计稿时自己先对一遍。

## 候选清单与排序

| 序 | 项 | 体量 | 一句话 |
|---|---|---|---|
| P1 | trace 脱敏：**配方升级**（不进框架） | 小 | 配方 2.4 的示例实现补出厂预设规则与可读替换文案 |
| P2 | 模型 fallback：**引擎级**链路 | 中 | run 级备用模型链，每次切换各开 llm.turn，成本归对模型 |
| P3 | trace → SFT 导出 | 中 | 拆 P3a（引擎可选记 assistant 文本）+ P3b（CLI 导出） |
| P4 | 租户归因 labels | 小中 | run 级标签进 trace 根；metrics 侧 opt-in + 基数上限 |
| P5 | MCP 反向桥 | 大 | 把 @Tool 集合暴露成 MCP server（stdio + StreamableHTTP） |
| P6 | durable 长时程 | 立项调研 | 天级 run：durable timer / 事件唤醒 / 版本兼容 —— **本轮不实施** |

缓做：**A2A 协议适配**（协议仍在快速漂移，现在接容易接到过时版本；等收敛）。
拒做：后端看板、DAG 可视化编辑器、swarm 编排（定位决定，见 roadmap 原则节）。

## P1 trace 脱敏 —— 配方升级，**不在框架内新增模块**

**为什么是配方而不是框架件**（这不是妥协，是已锁定决策）：

- spec §9.3：`脱敏不在框架内 —— 那是 sink 缝外的事`（`src/core/trace.ts` 头注同款声明）；
- spec §10 2026-09-14 ⑥：曾把「脱敏」作为空头承诺写进文档，处理方式是**删掉** ——
  原话「删错的、不补对的」；
- spec §9.4 用同一个理由否掉过 `samplingSink` 内置化：「示例已有实现 ⇒ 同一件事两份实现」；
- 成品已存在：`examples/observability/src/index.ts` 的 `redactSink(opts)`
  （深拷贝不改原 trace、按 keys+patterns 递归脱敏 attributes 与事件体），
  `examples/complete` 已在用（sample → redact → [sqlite, log] 扇出）。

**要做什么**（delta 很小，但真实）：配方 2.4 的示例实现目前要求用户从零写 `patterns`。
升级为：示例里给一组**出厂推荐预设**（Bearer/JWT、AWS AKIA、邮箱、手机号 —— 注释写明
「预设只是起点，合规清单是宿主自己的事」），替换文案从裸 `[REDACTED]` 改为带类别的
`[REDACTED:email]` 形态（让「这里被改过、改的是哪类」在 trace 里可见，便于下游排查）。
`docs/observability.md` 配方 2.4 同步，并加一句指向 spec §9.3 的「为什么不内建」。

**不做什么**：`src/` 零改动；不新建 `redact-sink.ts`；`src/index.ts` 不加导出。

**验收**：examples/observability 的测试与 e2e-examples 全绿（示例是 e2e 的真跑对象，
改它就是改被测面）；observability.md 的表格不动（脱敏仍是 ❌ → 配方 2.4，这行**不改**）。

## P2 模型 fallback —— 引擎级链路（不是 client 组合器）

**为什么不能在 client 层做**（评审核证，初稿在此犯了两条）：

1. **记账会错**：llm.turn span 的 model 与成本都取自 run spec 的 `args.model`
   （`engine/turn.ts` 的 begin 与 `costEstimate`）。组合器在 client 层静默换厂商，
   span 归错模型、成本按错价目表算、`usage.unpriced` 也不会响 —— 撞在本仓当作特性
   做了很久的成本口径上，违反筛子 #1 的方式不是「少看点东西」而是「记错账」。
2. **枚举要全**：`classifyError` 实际 7 类 —— `aborted` / `rate_limit` / `server` /
   `api` / `timeout` / `connection` / `unknown`。初稿漏了 `timeout`（retryable: true，
   恰恰是最该换模型的那类）与 `aborted`（用户取消 —— 不点明就会变成「用户按了取消，
   它跑去打第二个厂商」）。

**设计**：run 调用契约加可选 `fallbacks: Array<{ model: string; client?: ModelClient }>`
（app 级缺省 + run 级覆盖，与现有 model/client 的生效层级同款）：

- 每个链环节=**自己的 llm.turn span**（model 名正确 ⇒ 成本归因、unpriced 探测天然正确）；
- 触发判定：本环节最终失败（含其内部 maxRetries 用尽）且错误类 ∈ 缺省集合
  `{rate_limit, server, timeout, connection}` ⇒ 落下一环；`api` / `unknown` 立即抛
  （请求本身有病，换模型无用）；`aborted` **立刻收尾，永不 fallback**；
- **「吐过字不换」**（与 `retry.ts` retryAllowed 第四项 `!emitted` 同一护栏）：
  本回合任何一次尝试吐过文本，失败即抛，不换环 —— 否则用户看到两段拼起来的回答；
- 每次切换在新 turn span 上记 `llm.fallback` 事件 `{fromModel, toModel, errorType}`
  （与既有 `llm.retry` 事件同级同形）；
- run 生效配置快照（`engine/run-config.ts`）把 fallback 链编进 trace 根 —— 认下链的人
  就是写进 trace 的人；spec §10 记决策。

**验收**：单测（逐类错误的换/不换、吐字后不换、abort 不换、每环独立 span 与成本、
快照编码）；反向验证（摘掉 aborted 分支 ⇒ 「取消不 fallback」用例红）；
usage-guide + api.html；`tests/limits.test.ts` 不涉及（非数值旋钮，说明理由）。

## P3 trace → SFT 导出（拆两步）

**动机**：harvest 是「trace → eval 用例」，它的孪生是「trace → 训练数据」—— 配合
score/exemplar 筛好 run，把「生产 trace → 自我改进」的环闭上。

**关键事实调查结论（2026-09-27，已读码核实，评审逐字复核通过）**：trace **不记
assistant 文本** —— llm.turn 只记 usage/事件（`engine/replay.ts:30-32` 如实声明了
这个有损边界，spec §9.4 同款）。工具往返（tool_use 参数 / tool_result 出参）在事件里，
可还原。⇒ 纯 trace 导出的 SFT 数据**缺 assistant 正文**，那是训练数据里最值钱的部分。
所以拆两步：

- **P3a（引擎，改语义 ⇒ spec §10 决策记录）**：可选记录 assistant 文本。
  形状：`RunInvocationOptions` 加 opt-in 开关（如 `traceContent: 'full'`；缺省不记，
  现状逐字不变），记进 llm.turn span 的 `output.text` 属性。**旋钮分工写清**：
  裸旋钮 `maxEventChars`（`engine/tool-events.ts`）管「单段负载多长」（新属性过同一道
  截断闸），新开关管「记不记」—— 不是第二个长度旋钮。⚠️ 路径别写错：`traceLimits`
  下只有 `maxEvents`（管「多少条」），长度旋钮是裸 `maxEventChars`。
  必须写清的代价：trace 体积显著增大（`npm run bench:trace` 跑三档给实测数进文档）
  且模型输出从此进入「要脱敏的面」（与 P1 配方直接联动 —— 两份文档互相指）。
- **P3b（CLI）**：`agentia export <trace.jsonl> [--min-score X] [--out file]` ——
  按 score 过滤 run，输出 JSONL（每行一份 messages 序列）。无全量记录的 run 导出为
  工具轨迹（assistant 文本缺席**要在导出物里标注**，不静默）；有全量记录的导出完整对话。
  去类型移植副本纪律同 harvest/diff（CLI 侧逐字对拍守护，
  先例：`packages/cli/test/diff.test.mjs` / `harvest.test.mjs`）。

**验收**：P3a 有反向验证（摘掉开关 ⇒ 导出物无正文）+ bench 体积数进文档；
P3b 走 CLI 套件 + e2e-cli 链条惯例。

## P4 租户归因 labels

**动机**：用框架做 SaaS 的人第一张账单是「哪个客户烧了多少钱」。

**设计**：run 调用契约加 `labels?: Record<string, string>`（RunSpec）：

- **trace 根**记 `labels.*` 属性（无基数问题，随便加）；
- **metrics 侧 opt-in + 封顶**：`metricsSink({ labelKeys: ['tenant'], maxLabelValues? })`
  显式声明哪些 key 上指标标签，缺省一个都不上；**每个 key 的相异值数有上限**
  （缺省值随实现定，写进 limits 真源表 —— 它是「数量」类旋钮，0 的语义必须落地），
  超出归入 `__other__` 桶 —— 与既有 `maxCapabilities` / `maxModels` / `maxScores`
  的折叠语义同款（折叠只丢标签粒度不丢量）。⚠️ 光 opt-in 不够：它挡「意外爆炸」，
  封不住「我知道有几千租户、我偏要上」—— sink 的内存不变量（上限 × 窗口 = 常驻内存
  上界）要求每个新基数维度都有对应 cap；
- 与既有 `RunSpec.source` 的关系：**不动也不合并**。`source` 是触发来源审计
  （sync / async / schedule:<id>，框架自己写的单值）；`labels` 是业务维度归因
  （tenant / plan / …，宿主写的多值）。两者正交，文档里一句话说清；
- OTLP 出口映射成 span 属性（additive，不动既有 gen_ai.* 键）。

**验收**：单测 + 反向验证（摘掉 cap ⇒ 超限折叠用例红）；limits 真源表登记新旋钮；
usage-guide 写清基数警告；spec §10 记决策；api.html。

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
6. 旋钮类新增先查 `src/core/limits.ts` 真源表要不要登记（0 的语义必须落地；
   非数值旋钮说明不登记的理由）。
7. **设计稿里的每条可证伪断言先在代码里核对再落笔**（行号、枚举成员、分层边、
   既有实现是否存在）—— 本稿初稿的三条硬伤全是「没查就先写」造成的。

## 修订记录

**2026-09-27 ①（初稿评审修订，评审方为独立 agent，逐条核证后我已复验全部属实）**：

1. **P1 重定界**：初稿要在 `src/integrations/` 新建 `redact-sink.ts` —— 与 spec §9.3 /
   §10 2026-09-14 ⑥（「删错的、不补对的」）三重对撞，且 `examples/observability` 已有
   成品 `redactSink`。改为「配方升级」，`src/` 零改动。附带承认：这类越界无机械守卫
   （observability.test.ts 不比 `src/`），⇒ 定位筛子新增第 5 条。
2. **P2 重写**：初稿是 client 组合器且「不记账」—— 实错在归因（span 的 model/成本取自
   run spec，静默换 client = 记错账），且 `classifyError` 枚举漏了 `timeout` 与
   `aborted`。改为引擎级 fallback 链：每环独立 llm.turn、`llm.fallback` 事件、
   abort 永不换、吐过字不换、进 run-config 快照。
3. **P4 补基数上限**：初稿只写 opt-in —— 与 metrics 的内存不变量（三个基数上限 × 窗口
   才是常驻内存上界）冲突。补 `maxLabelValues` cap + `__other__` 折叠（与既有三帽同款），
   并交代与 `RunSpec.source` 的正交关系。
4. 小修：P3a 的旋钮路径订正（裸 `maxEventChars`，`traceLimits` 下只有 `maxEvents`）+
   补旋钮分工；删掉初稿 P1 的「替换文案带计数」自相矛盾（示例形态里并无计数，既有实现
   是 `[REDACTED]`，升级为 `[REDACTED:<类别>]`）；动机句删无出处的最高级表述；
   roadmap 状态不得先于事实（初稿把 P1 标「进行中」但 `src/` 无任何对应物 —— 全部
   回退为「待做」，状态只随已合并的 PR 推进）。

## 实施记录

- **P1 已落地（2026-09-27）**：`redactSink` 增内置预设（bearer / jwt / aws-access-key /
  llm-api-key / email / phone-cn，缺省全开、`presets` 可调）、预设替换文案带类别标签；
  `examples/complete` 删掉与预设重复的手机号/邮箱 patterns（演示新缺省）；
  `docs/observability.md` §2.4 重写（预设表 + 「为什么不内建」指 spec §9.3/§10 2026-09-14 ⑥），
  顶部不内建表**原样不动**（脱敏仍是 ❌ → 配方 2.4）。`src/` 零改动。
  反向验证读数：摘掉 phone-cn 预设 ⇒ 恰好「预设缺省全开」用例红；presets 缺省改全关 ⇒
  同一条红；其余 32 条不动。偏差：无（与设计一致）。
- **P2 已落地（2026-09-27）**：引擎级 fallback 链（`fallbacks: [{ model, client? }]`，
  RunAgentOptions / AppOptions / RunInvocationOptions 三层同语义）。每环独立 llm.turn +
  `llm.fallback` 事件 + `TurnOutcome.model` 供 `recordTurnUsage` 按实际成功模型算账；
  换环判定复用 `classifyError` 的 retryable 位（没另写类清单）；`resolveModelChain`
  在 runAgent 的 try **之外**（配置错抛 TypeError，不被收成失败的 run）；
  快照 `config.fallbacks` 只记模型名。runAgentScoped 不传链（子循环不继承，代码里留了
  注释说明这是有意边界）。门禁 `tests/engine/fallback.test.ts` 12 条；反向验证 4 变异
  （摘 `!emitted` / abort 分支失效 / retryable→true / 成本按 args.model）各恰好咬死
  对应用例。偏差：设计稿说「`shouldFallback` 覆盖判定」—— 落地时**砍掉了**（复用
  retryable 位已够，少一个公共面少一份漂移；真有人要自定义判定再加）。
- **P3a 已落地（2026-09-27）**：`traceContent: 'full'`（RunAgentOptions /
  RunInvocationOptions / AppOptions 三层同语义）。记进 llm.turn 的 `output.text`
  （引擎文本口径多块 `\n` 连接；过 `maxEventChars` 同一道闸）；透传走 forwarded.ts
  真源（ToolRunContext 新键被类型守卫逼着归类 —— 实施时它真咬了一次：调用点漏传
  当场编译红）。偏差：无。实测体积数（3 回合 × ~1600 字符 ⇒ 5 564 → 11 010 字节）
  进了 spec §10 ④ 与 CHANGELOG。门禁 `tests/engine/trace-content.test.ts` 7 条 +
  反向验证 3 变异。
- **P3b 已落地（2026-09-27）**：`agentia export <trace.jsonl> [--out] [--ok-only]
  [--min-score n]`。框架侧 `src/eval/export.ts` 的 `exportRun`（module 级，不进公共面）；
  CLI 侧去类型移植副本 + 逐字对拍（`packages/cli/test/export.test.mjs`）。
  实施中设计修正一处（写进 spec §10 ⑤）：assistant 文本缺口的判定口径 —— 纯 tool_use
  回合本来就没文本，**不算缺口**（初版实现把所有无 output.text 的回合都标缺口，
  被「全量记录的 run」用例当场抓住）；占位文本纪律与 harvest **相反**（那里是给人看的
  脚手架，这里会进训练集）。反向验证 2 变异（造占位文本 / 缺输出不补占位块）各咬死
  对应用例。structure 棘轮补账 8328 → 8639。
- **P4 已落地（2026-09-27）**：三层同语义（`RunAgentOptions` / `AppOptions` /
  `RunInvocationOptions` 的 `labels`，`AppOptions` 被单次覆盖时**整体替换**不合并）。
  run 根写 `labels.<key>`，快照 `config.labels` 只记键名；入口校验（try 之外抛
  TypeError）与 resolveModelChain 同纪律。metrics 侧 `labelKeys`（Prometheus 标签名
  校验 + 查重）+ `maxLabelValues`（缺省 100、invalid 类、limits 真源表登记 +
  探针）；每键一本 KeyBudget，折叠进 `__other__`。出口：四个 run 级家族追加带标签
  样本（全局行仍在第一位 —— renderOpenMetrics 的 exemplar 精确匹配靠它）+
  `dropped_keys{kind="label:<key>"}`（kind 取 `label:<key>` 与能力标签 `kind:name`
  同款拼法，保住 dropped_keys 家族的单 label 同质性）。OTLP trace 导出侧零改动
  （span attributes 本来就全量透传，`labels.*` 自动跟出去）。
  实施中两处设计与实现互相订正：① combo 键不做「值里含 `,`/`=` 可反解」的承诺
  —— 累加器自带 `pairs`，出口按 pairs 拼标签，combo 键只是展示形；
  ② **不做 per-label 时长直方图**（cap × windowSize 的又一份乘法，收益不抵代价，
  「哪个租户慢」去 trace 侧按 `labels.*` 查）—— 已写进 spec §10 ⑥。
  门禁 `tests/engine/run-labels.test.ts` 7 条 + `tests/integrations/metrics.test.ts`
  R8-P4 块 7 条 + limits 探针；反向验证 2 变异（摘 cap 折叠 ⇒ 折叠/reset 两条红；
  引擎摘 labels 落根 ⇒ run-labels 3 条红）。公共面新增 `RunLabelMetrics` 类型导出
  （api.html 计数 219 → 220）。
- **P5 已落地（2026-09-27）**：MCP 反向桥 `createMcpServer(app, opts)`
  （`src/engine/mcp-server.ts`；落 engine 的理由 —— integrations 只许依赖 core 装不下
  TraceRecorder、engine→integrations 反向成环、transport 够不到 integrations）。
  app 是鸭子类型 `{ tools: AgentTool[] }`（e2e 夹具走 createApp + @Tool 真装配钉住
  「AgentApp 结构满足」）。协议只到 tools（initialize / tools/list / tools/call + ping；
  其余 -32601、params 坏 -32602）；传输 stdio + StreamableHTTP 都只用标准库；
  每次 tools/call 一棵 trace（run 根 `mcp.tools/call` + capability span +
  同形状的 tool.input/tool.output 事件）投递 opts.sinks；结果映射与正向桥方向对称
  （抛错 → isError: true）。**偏差**：① 设计稿说 capabilityKindOf 把这种 span
  「归为 tool」—— 读码核实后它归 `capability:<name>`（capabilityKindOf 三值里没有
  'tool'；`tool:` 标签只来自 llm.turn 上的 tool.output 事件），「自动进能力指标」
  成立但标签名不同，已写进 spec §10 ⑦；② HTTP 选项形状定为 host/port/path +
  可挂进既有 http.Server（close 只摘 handler）。门禁
  `tests/engine/mcp-server.test.ts` 19 条；反向验证 3 变异（摘 isError 映射 ⇒
  恰好 3 条红；摘 trace 投递 ⇒ 恰好 4 条红；未知 method 不回 -32601 ⇒ 恰好 1 条红），
  还原后 19/19。e2e `npm run e2e:mcp:server`（stdio 真子进程 + HTTP 真端口，离线零网络，
  不进 verify-all）。公共面 +4（api.html 计数 220 → 224）。
  **规划稿 P5 验收口径的偏离**：原稿写「真第三方 MCP **client** 打过来跑一轮」——
  落地用**自己的出厂连接器**当真协议客户端（createStdioMcpConnector /
  createStreamableHttpMcpConnector，本身就是真协议实现且双向都被 e2e 守住）；
  第三方 client（如官方 SDK）要引依赖才能进 CI，留给后续评估。
- **P6 已交付（2026-09-27，调研）**：`docs/plans/2026-09-27-durable-execution-research.md`。
  关键判断：agent 主循环的状态是消息历史（天然可序列化、可断点续传），Temporal 系的
  事件溯源重放对它是**错的抽象** —— 差距清单 G5（重放模型）确认不做；要补的是
  durable timer（G1）与外部事件唤醒（G2）两个维度，候选增量列在文档 §6，
  动代码前各自回 spec §10 立项。偏差：无（范围就是调研）。
  **2026-09-27 复核追加**：候选从 4 条补到 **7 条**（§6 的 5/6/7 是 1/2 的配套：
  挂起期的取消/排空语义、挂起期可见性、事件投递幂等 + 到期索引 —— 前两条只写「怎么醒」
  会留下醒不过来的静默路径）；G4（代码版本 vs 在飞 run）定级由「中」提到「**中高**」，
  依据是 §4.1 的实测：菜单变了不是「没人接」而是**降级且不告知**（`unknown tool: <name>`
  当出参交回模型、run 照常收尾、调用方零信号，且这条路径当前无用例覆盖）。
