# AGENTS.md —— 仓库结构与协作约定

> **定位**：面向应用开发的声明式 agent 服务开发框架 —— 装饰器 + DI 声明四类能力，主 agent 编排执行；
> 每次 run 产出结构化结果与**可观测调用树**（trace、成本、指标），交付可直接上线的服务。
>
> **可观测是一等公民、与能力声明同级**，「四类能力决定它能做什么，trace 决定它敢不敢上线」（`docs/spec.md` §1）。
> 改这个仓库时**不要把 trace 当可选外挂**：它是本框架的核心卖点与对外承诺 ——
> 新增能力/宿主/集成的 PR，若绕开了 trace 记账或 `TraceSink` 出口，就是倒退。

## 布局

```
agentia/                     # npm 包 @migor/agentia（框架本体，单包）
├── src/
│   ├── core/                # 数据模型与结构接口（Trace/AgentTool/ModelClient/校验、
│   │                        #   RunStatus/RunMeta、Blackboard 类型族、Message 消息类型族、
│   │                        #   超时原语 timeout.ts —— 引擎与 MCP 桥**共用一份**，见 §10 2026-09-17 ①），零依赖
│   ├── engine/              # 运行时内核：agent loop、trace 记账、长上下文裁剪(trimming)、
│   │                        #   预算策略(policy)、错误分类、replay、run 调用契约
│   │                        #   turn.ts = 回合执行机（自 loop.ts 拆出）；它的纯判定继续外移：
│   │                        #   text.ts（引擎文本口径：多块 `\n` 连接）、stop-reason.ts（stop_reason
│   │                        #   → 收尾结论的映射表；「非正常收尾必须带结构化 error」的唯一落点）、
│   │                        #   turn-request.ts（回合请求装配）、tool-context.ts（工具上下文透传装配 ——
│   │                        #   八处条件展开各自是一个「漏了就静默降级」的守卫；false/0 是有意义的值）、
│   │                        #   tool-events.ts（单工具执行的记账面：两个事件体 + tool_result 块；
│   │                        #   失败出参的截断上限**更小** —— 「哪个工具老超时」要一行看得完）
│   │                        #   retry.ts 的 retryAllowed（重试闸四项合取，含「吐过字不重试」护栏）
│   │                        #   loop.ts 同样在往外移纯件：run-config.ts（run 生效旋钮的缺省解析 +
│   │                        #   快照编码 —— 认下缺省值的人就是写进 trace 的人，NaN/-1 一律记 'off'）、
│   │                        #   loop-result.ts（循环出口的结果形状：7 个字段必在场 + 四个具名出口 ——
│   │                        #   挂起不是失败、取消也带结构化 error、抛出必被 classifyError 翻译）、
│   │                        #   resume-input.ts（续跑入口的读取件：末尾未决 tool_use 的识别只看**末尾一条** ——
│   │                        #   漏判就是把续跑当新对话，同一批工具再跑一遍、花费翻倍）
│   │                        #   (RunSpec/RunInput/RunInvocationOptions/normalizeMessages)
│   ├── runtime/             # run 生命周期：run 状态机、上下文(ALS)、
│   │                        #   SystemPrompt、跨 run 记忆(MemoryStore 水合/回写)
│   ├── transport/           # 触发宿主：HTTP handler、异步任务(AsyncRunner)、定时(Scheduler)、同步 RPC
│   │                        #   slot-pool.ts = 并发槽位原语（纯依赖、带单测）—— AsyncRunner 拆分的第一步：
│   │                        #   910 行的类里只有这块不碰 store/引擎，先抽它 + 配 FIFO/移交语义的回归用例，
│   │                        #   后续抽块（审批监督 / 恢复重投 / drain 协调）才有基线
│   │                        #   approval-policy.ts = 审批的**纯判定**（超时判定 / 超时兜底拒绝 / 决定齐没齐）：
│   │                        #   编排（在飞闸、重读、先落库再派发）仍留在 AsyncRunner，纪律一字未改
│   │                        #   drain-gate.ts = 优雅停机的等待闸（停机态标志 / 排空等待 / 超时竞速）；
│   │                        #   在飞计数不搬（它同时是 /healthz 的 inFlight 口径），以谓词传入
│   │                        #   resume-policy.ts = 崩溃恢复的**认领判定**（跳过原因具名化：terminal /
│   │                        #   own-process / too-fresh）—— 「同一任务重复执行」那个 bug 就出在这几条规则上
│   │                        #   task-waiters.ts = 任务终态等待表（事件唤醒 + 兜底定时器）；**只覆盖本进程写终态**，
│   │                        #   他进程写终态唤不醒 —— 那是 awaitTask 里 intervalMs 兜底轮询存在的原因（不是缺陷）
│   │                        #   http-shapes.ts = HTTP 宿主的**出入站形状口径**（响应体 / 任务提交体 / 审批体）：
│   │                        #   纯形状判定（不合法一律回 undefined，由路由选状态码）；审批体**全有或全无**，
│   │                        #   空 decisions 集合法 —— 「决定齐没齐」是 AsyncRunner 的判断，不是形状问题
│   │                        #   http-route.ts = 路由判定（pathname × method × 有无 metrics → 分支）：
│   │                        #   纯函数；三条顺序是全部内容 —— 免鉴权组的 405 先于鉴权、其余先鉴权再判
│   │                        #   方法/路径（未鉴权不泄露路径是否存在）、approve 先于通用 id 且「方法不对」
│   │                        #   压过「id 坏了」（DELETE /tasks/%zz/approve = 405，不是 400）
│   ├── store/               # 任务记录存储：memory / file(JSONL) / sqlite / redis
│   ├── integrations/        # 外部系统适配：OpenAI 兼容端点(ModelClient)、OTLP 导出、
│   │                        #   MCP 桥(duck-typed) + 出厂连接器(stdio/StreamableHTTP，只用标准库)、
│   │                        #   指标(metricsSink，满足 TraceSink)
│   ├── container/           # 最小显式 DI（useValue/useClass/useFactory+deps），叶子无依赖
│   ├── toolkit/             # 声明式表面：装饰器×4、collect 内核、装配(createApp/defineModule)、
│   │                        #   中间件、目录发现(discover)、文本资产(asset)、env 引导(loadEnvFile)、zod 桥
│   ├── eval/                # evals（D2）：scriptedClient + defineEval + harvest(trace → eval 用例骨架) ——
│   │                        #   **叶子消费模块**，只依赖公共面、零反向依赖（谁都不 import 它）
│   └── index.ts             # 公共 API 唯一出口（新增导出必须在此登记）
├── tests/                   # node:test 单测，目录镜像 src（tests/transport/x → src/transport/x）
│   ├── helpers.ts           # 共用 mock client（**忽略 on('text')**；要「真吐字」用 src/eval 的
│   │                        #   scriptedClient —— 两者定位不同，改 helpers 影响全部套件，谨慎）
│   ├── fixtures/            # discover/asset 测试夹具
│   ├── architecture/        # 分层守卫：解析 src 的 import 图（覆盖 from / 副作用 / 动态 import
│   │                        #   字面量三种形式，带解析计数下限护栏防真空变绿；BARREL 豁免只认
│   │                        #   src/index.ts 本身），断言「允许边集合 + 无环 + src 不引 src 之外」——
│   │                        #   AGENTS.md「分层单向」的可执行版本
│   ├── types/               # **类型断言测试**（*.types.ts，只被 typecheck:types 编译、不被 node:test 收）
│   └── docs/                # 文档校验（usage-guide.md 的表格逐项对源码核；api.html 的导出表
│                            #   正向核 + **反向全覆盖**：导出面的每个导出都必须在页面上出现；
│                            #   website-css.test.ts 钉官网表格版式不变量，见 packages/website 段；
│                            #   no-legacy-terms.test.ts 钉「面向使用者的表面不得出现旧伞形术语」——
│                            #   覆盖文档 / 官网 / npm 包 README 与 description / CLI 的 --help 与报错文本；
│                            #   仅 `<!-- no-legacy-terms: allow -->` 标记块内可豁免，且有行数上限）
├── scripts/e2e-cli.ts       # CLI 端到端（npm run e2e 第一步：脚手架→生成→装配→mock run
│                            #   + **字面跑产物自己的 `npm run typecheck` / `npm run build`**
│                            #   （'@migor/agentia'、@types、.bin/tsc 经 node_modules 软链解析 ——
│                            #   即发布形态；测试不复刻脚本里的命令）+ 第 4d-bis 步真删一个能力
│                            #   再重建，断言旧产物消失；第 8 步 pack → 离线安装 → 真跑最小 run）
├── scripts/e2e-examples.ts  # 示例端到端（npm run e2e 第二步：examples/complete 真构建、真起服务，
│                            #   按它 README 跑完 /healthz · 鉴权 401 · 同步 /run · SSE · 异步 /tasks ·
│                            #   /metrics · 优雅停机；模型侧是内置假 OpenAI 兼容端点，不联网）
├── scripts/e2e-deploy.ts    # 部署示例端到端（npm run e2e 第三步：examples/deploy 真构建、真起服务，
│                            #   跑 /healthz · 同步 /run · /metrics · 优雅停机 + **崩溃续跑**
│                            #   （SIGKILL 后同库重启 resumePending 续跑）；假 Anthropic 端点，不联网）
├── scripts/e2e-grpc.ts      # gRPC 宿主端到端（npm run e2e 第四步：examples/grpc-host 真构建、真起宿主，
│                            #   用**示例自带的客户端**跑四个 RPC —— 一元 / 服务端流 / 异步投递 / 查任务；
│                            #   守四处语义：deadline 到期服务端 run 真被 abort、metadata traceparent →
│                            #   run 根 link、同 session_id 共享历史、同 idempotency-key 不重复执行；
│                            #   假 Anthropic 端点 + tempdir trace，不联网、不留产物）
├── scripts/e2e-mcp.ts       # MCP 端到端（npm run e2e:mcp：真第三方 server → 桥 → 菜单 → 真跑一轮）
├── scripts/e2e-live.ts      # 真 API 集成验证（npm run e2e:live：真实厂商端点跑框架主路径 ——
│                            #   SSE 分片 / tool_use / tool_result 回灌 / cache_control / signal 中止 /
│                            #   runAgent 全链。走 ANTHROPIC_BASE_URL，用 DeepSeek 的 Anthropic 兼容端点
│                            #   即可，**不需要 Anthropic key**。⚠️ 会真花 token ⇒ 不进 verify-all / CI）
├── scripts/e2e-soak.ts      # 浸泡/压力验证（npm run e2e:soak：本地假端点 + 种子固定的故障注入
│                            #   （429/截断/400/流内错误）+ N 并发长跑 ⇒ 断言失败率≈注入率、
│                            #   错误分类无 unknown、metrics 与实测对账、内存有界、干净退出。
│                            #   零网络零 token；SOAK_DURATION_MS / SOAK_CONCURRENCY / SOAK_SEED 可调）
├── scripts/bench-trace-cost.ts  # trace 记录成本基准（npm run bench:trace：量「一条 run 的 trace 多大」——
│                            #   缺省 / 不截断 / 截断 200 三种口径 × 工具调用数；实测大出参下「不截断」是
│                            #   缺省的 13.7× ⇒ spec §9.4「全量记录成本 vs 采样阈值」的答案来源。
│                            #   零网络零 token；PAYLOAD_ROWS / CALLS 可调；不进 verify-all（与 e2e:live 同档））
├── scripts/mcp-fixture-server.py  # 离线夹具 MCP server（stdlib，e2e:mcp 的兜底）
├── scripts/copy-assets.mjs  # 把 docs/usage-guide.md 拷成 dist/AGENTS.md（随框架包发布，见「文档单源」）
├── scripts/release-surface.mjs  # **发布面清单（单源）**：一次发版要动哪些文件的哪个值 ——
│                            #   18 项替换面（每项带 count 期望值 + 「漏了会怎样」）+ 3 项结构面；
│                            #   闸门与 bump 共用这一份。`--list` 给人看、`--json` 给测试
├── scripts/check-release.mjs  # 发版闸门：逐项断言「发布面 == 包版本」+「高于 npm 已发布版本」，
│                            #   挂在**两包的 prepublishOnly**（不进 verify-all：未发布窗口内
│                            #   AGENTIA_VERSION 有意落后）。`--offline` 跳网络、`--allow-pending` 降级骨架
├── scripts/release.mjs      # 发版工具：`bump <x.y.z>`（逐项替换，带计数断言，不符即中止且不写盘）
│                            #   / `tag <x.y.z>`（核对 registry 产物 ↔ 仓库树后打 **annotated** tag
│                            #   + 建 Release）/ `retag <x.y.z>`（lightweight → annotated，默认只演练）
├── packages/
│   ├── cli/                 # npm 包 @migor/cli（agentia create/g/dev/doctor/report/harvest/diff/add），零运行时依赖
│   │                        #   report = trace.jsonl → 调优报告；harvest = trace.jsonl → eval 用例骨架
│   │                        #   （harvest 的用例生成器是框架 src/eval/harvest.ts 的去类型移植副本，
│   │                        #   packages/cli/test 有逐字对拍守护，改生成格式必须两边同步）；
│   │                        #   diff = 两条 trace.jsonl 的调用树 A/B 比对（有差异退出码 1），
│   │                        #   其 diffTraces 是框架 src/engine/trace-diff.ts 的去类型移植副本，
│   │                        #   同样有逐字对拍守护，改算法必须两边同步
│   │                        #   机器可读面：report / diff / doctor 支持 --json（stdout 只一个 JSON
│   │                        #   文档、无人类装饰；出错仍 stderr + 退出码 1，stdout 保持空）；harvest
│   │                        #   刻意没有 —— 它的 stdout 就是产物（生成的 eval 源码）。
│   │                        #   --version / -v 读**包自身 package.json**（不另存常量，免得漂）。
│   │                        #   脚手架的 `dev` script 指向 `agentia dev`（与 npx 同一条路、带面板），
│   │                        #   所以 dev 必须把额外参数透传给用户脚本（`npm run dev -- "问题"`）。
│   │                        #   脚手架还把 CLI 自己写进新工程的 devDependencies（走本地 bin、离线可用、
│   │                        #   版本与框架同批 pin）⇒ templates/package.json 因此有**两条**版本发布面。
│   │                        #   脚手架模板是 templates/ 下的**真文件**（占位符替换渲染，token 只许在
│   │                        #   字符串/注释/标识符位置），被仓库自己的 tsc（tsconfig.templates.json，
│   │                        #   '@migor/agentia' paths 映射到框架 src）与 Biome 全程照看 —— 不再是
│   │                        #   不过编译器的字符串（「生产必崩」缺陷曾这么漏出去）；构建时整树拷进
│   │                        #   dist/templates/，运行时从 dist 读。点文件以无点文件名存放
│   │                        #   （gitignore/env/env.example）：.env 会被根 .gitignore 吞掉、
│   │                        #   .gitignore 会被 npm pack 剥掉。Biome 对 templates/** 只关 formatter
│   │                        #   （生成物字节是兼容契约），lint 照常。
│   │                        #   dev = tsx watch + 本地 inspector 面板（trace-view 产物拷进 dist/inspector；
│   │                        #   inspector 有 Host 头校验，非 localhost 403）；dev/add 支持 Windows
│   │                        #   （npmSpawn：win32 走 cmd.exe /d /s /c 包装 + 逐参数脱敏 ——
│   │                        #   CVE-2024-27980 后裸 spawn .cmd 会 EINVAL，shell:true 不转义
│   │                        #   参数、add 的包名是用户输入有注入面）；build 自给自足（copy-assets 在 trace-view
│   │                        #   未构建时就地补跑其构建，prepublishOnly 只跑 build，无需根 build:cli 预热）
│   ├── trace-view/          # trace 调用树渲染器（零依赖 ESM）：createTraceView + playTrace(真实 Trace)
│   │                        #   官网 playground 与 CLI inspector 共用同一份，避免两处渲染漂移
│   │                        #   test/ 用 node:test，**已并入根 `npm test`** —— 这份共用的渲染器
│   │                        #   此前没有任何门禁在跑，等于「两边都靠它、却谁都不守它」
│   └── website/             # 官网（Astro 静态站，构建产物 dist/ 部署 Cloudflare Pages）
│                            #   src/layouts/Base.astro 全站外壳、src/components/ 共享组件
│                            #   src/fragments/*.html 页面正文（?raw 注入）、src/scripts/ 客户端脚本
└── docs/                # spec.md（锁定决策）、roadmap.md（方向与状态）、
                         # usage-guide.md（**使用者向唯一说明**：CLI 项目 AGENTS.md 与官网 llms.txt 的单源）
                         # 根目录 CHANGELOG.md 是发布史与迁移指南（npm 的「总是包含」不含它：
                         #   根包靠 files 登记，CLI 包靠构建期拷贝到包根 —— e2e-cli 有 pack 断言守着）
```

## 硬约定

- **分层单向**（`tests/architecture/layering.test.ts` 强制；改依赖方向必须同步改该测试的 ALLOWED）：
  core ← engine ← { runtime, store }；store ← transport；runtime ← toolkit；
  `integrations` 只依赖 core（模型/trace 适配器），**engine 依赖 integrations**（仅为取默认
  ModelClient，见下条）；`container` 与 core 是叶子
  （不 import 任何东西），container 仅被 toolkit 依赖。core 不依赖任何上层。
  `index.ts` 是公共唯一出口，允许引用全部层。
  `eval/` 是**叶子消费模块**（依赖 toolkit 与公共面）：它 import 别人，别人不 import 它。
  - `RunStatus`/`RunMeta` 落在 `core/`、run 调用契约落在 `engine/`：它们本是 store/transport
    与 runtime **共用**的类型，早先放在 runtime 逼出了 `store → runtime` 这条未声明的兄弟层
    依赖 —— 已按「纯数据去 core、共用入参契约去 engine」下沉（类型导入也计入分层，虽运行期擦除）。
- **内部工具不进公共面**：跨模块/测试要用的 helper 可以做 **module 级 export**（如 `engine/trimming.ts` 的
  `createTokenCounter`、`engine/turn.ts` 的 `replaceMessages`），但**不要**加进 `src/index.ts` ——
  一旦进了公共导出面，`tests/docs/api-page.test.ts` 的反向全覆盖就会要求官网 API 页同步，
  而那些是纯内部实现细节。
- **零运行时依赖（2026-09-17 达成）**：`@anthropic-ai/sdk` 已退入 devDependencies —— 公共消息类型
  自有（`src/core/message.ts`，`MessageParam` / `Message` / 块联合 + `{ type: string }` 兜底成员，
  命名避让：`ToolParam` ≠ @Tool 装饰器、`MessageUsage` ≠ trace 的 `Usage`），SDK 只留下做
  类型兼容门禁（`tests/types/message-compat.types.ts` 钉双向/单向 assignability）。
  可选能力（zod、redis 客户端）一律 duck-typed / peer。
  ⚠️ 兜底成员**绝不可加索引签名**：SDK 的块类型全是 interface（无隐式索引签名），
  带 `[key: string]: unknown` 会让「SDK 类型整体赋给自有类型」编译失败（方向一破产，见 spec §10 当日条）。
  ⚠️ `tsconfig.json` 的 `"types": ["node"]` **不可删**：全仓 @types/node 此前是靠
  「import SDK 类型 → undici-types → `/// <reference types="node" />`」的传递链偶然进编译程序的，
  SDK import 移除后只能靠显式声明。
- **宿主 / 集成接入不打包**（判别规则只有一条：**客户端是不是标准库**）：只用标准库的平台能力
  （MCP stdio 的 `spawn` + 全局 `fetch`）直接内置；要引第三方客户端的（gRPC 的 `@grpc/grpc-js`、
  Kafka 的 `kafkajs`）**只留 duck-typed 缝 + 配方 / 示例**，框架永不 import —— 这就是
  `examples/grpc-host/` 是示例而不是包的原因。真到该拆包时，粒度是**一个第三方客户端一个包**，
  不是把所有集成塞进一个「服务包」；理由与升级触发条件见 spec §10 2026-09-18 ⑪。
- **默认 client 是自研 fetch + SSE 实现**：`src/integrations/anthropic.ts` 手写
  `POST {baseURL}/v1/messages` + 逐行 SSE 组装，**不再实例化 `@anthropic-ai/sdk`**；
  引擎经 `createAnthropicClient()` 取默认 client。使用者自定义只需
  `createAnthropicClient({ apiKey, baseURL })`，**不必直接依赖该 SDK**。
  ⚠️ 错误分类随之改为**鸭子类型**：`engine/errors.ts` 不再 `instanceof` SDK 错误类，
  改认数值 `status`（429→rate_limit、5xx→server、其余 4xx→api）、带 `cause` 的
  TypeError / errno `code`（→connection）。历史教训：该 SDK 的错误类 `name` 恒为
  `'Error'`、`type` 为 null，鸭子类型若靠 `constructor.name` 则压缩即失效 ——
  所以只认数据属性。已知边界：SDK 的 `APIConnectionError` 无 status/code 可判，
  若使用者自装 SDK 并让它抛到引擎，该类错误会落 unknown（该重试的不再重试）。
- **lint / format**：Biome 单工具二合一（`biome.jsonc`）。`npm run lint` 检查、`npm run lint:fix` 写回；
  CI 有独立 `lint` job，**并且已折进 `scripts/verify-all.sh` 的第 1 步**（本地这条链与 CI 是同一条，
  「本地全绿、CI 挂 Biome」曾经真的发生过 —— 加检查要折进已有步骤，理由见「验证顺序」）。规则基线刻意关掉三条与既有风格冲突的（理由写在 `biome.jsonc` 注释里）；
  `.astro` 与独立 `.svg` **不在 lint 面**（Biome 对 Astro 语法支持不全，会误报）。
  ⚠️ **`src/core/blackboard.ts` 的空 `interface Blackboard {}` 是声明合并锚点，绝不可改成 `type` 别名** ——
  Biome 的 `noEmptyInterface` 自动修复会这么干，已用 `biome-ignore` 注释钉住（改了就废掉「扩展黑板键获得补全」）。
- **Node 下限靠延迟加载守护**：`node:sqlite`（≥22.5）等内置模块**不可顶层静态 import** ——
  `src/index.ts` 的导出是 eager 的，静态 import 会让**整包**在旧 Node 上加载即崩（而 `engines` 写着 `>=18`）。
  一律延迟加载 + 可读报错，并由 CI 的 `import-floor` job 在 Node 18/20 上实跑验证。
- **ESM NodeNext**：相对 import 必须带 `.js` 后缀；注释用中文。
- **`exactOptionalPropertyTypes` 是承重开关（2026-09-18 起，勿关）**：它让
  `{foo: x}`（`x: T | undefined`）**不再是**合法的 `foo?: T` —— 「不传这个键」与「传了个
  undefined」被区分开。关掉 = 39 处防线无声消失（`retry.ts` 的「显式 undefined 覆盖缺省」
  重新变成合法代码）。由 `tests/architecture/tsconfig-strictness.test.ts` 钉住。
  **改类型时按角色分三类**（改错类别 = 把开关的价值自己放掉）：
  ① **结果/状态记录**（总是写进对象字面量）→ 必填 `T | undefined`（`AgentRunResult` /
  `RunMeta` / `TurnOutcome` …）；② **内部管道**（缺省与 undefined 等价）→ 可选 `?: T | undefined`
  （`AgentLoopArgs` / `Job` / `TaskRecord` …）；③ **公共入参**（「不提供 = 用缺省」有意义）
  → **签名不动**，在调用点条件展开 `...(x !== undefined ? { x } : {})`，或一次转交多字段时用
  `omitUndefined({...})`（`src/core/object.ts`）。理由与实测见 spec §10 2026-09-18 ⑦、`docs/guards.md` 附录。
- **测试**：`npm test`（node:test）；新行为必须带测试，断言按真实语义写（先读实现）。
- **多 agent 同仓作业**：本机可能有多个 agent 同时在这个仓里改代码。三条纪律：
  ① **结论一律钉到 commit**（commit 不可变才可复现），未提交的在制品不评审（评草稿 = 白评）；
  ② **门禁/测试跑在隔离导出树**（`git archive <sha> | tar -x -C <tmp>` + 软链 `node_modules`），
  不在共享工作区跑 —— 那里读到的是别人改到一半的中间态，结论随对方下一次保存失效；
  ③ **遇到不属于自己的未提交改动：不提交、不修改、不还原**；commit 只 add 自己动过的文件。
- **承诺过的 script 必须真跑，且测产物要用产物自己的输入**：脚手架/模板在 package.json 里
  承诺的每个 script（dev / build / start …），e2e 至少**真执行一次**（「产物存在」≠「产物能跑」——
  只断言 dist/main.js 存在的那版门禁全绿时，`node dist/main.js` 一跑就崩）；凡「测产物 X」必须用
  **X 自己的输入/代码路径**（如模板生成的入口文件、模板里那句路径表达式），禁止测试脚本另算一份
  等价输入绕过产物 —— discover「生产必崩」（#83）就是这么漏的：测试脚本自己 `join(proj, 'src/tools')`，
  模板里有病的 cwd 相对路径从未被执行。
- **验证顺序**：`npm run typecheck && npx biome ci . && npm run build && npm run typecheck:types && npm run typecheck:tests && npm run build:cli && npm test && npm run e2e && npm run build:website` 全绿才算完
  （在仓库里就是 `bash scripts/verify-all.sh`，8 步 —— 第 1 步同时管类型检查与 lint）。
  - **要加检查，折进已有步骤，不要加第 9 步**：`verify` job 的 name 是分支保护的必需状态检查，
    而它写死了步数（「全链验证（verify-all 8 步）」）。加一步这名就成了假话；改名则 PR 会卡死
    等一个永不出现的检查。折进已有步骤还有个好处 —— 新检查直接落进**必需**检查里。
    lint 就是这么进来的：它原本只在 CI 的独立 job 里，本地链不跑它，于是「本地 8/8 全绿、
    CI 挂 Biome」是可能的（2026-09-14 真发生了一次）。
  - `typecheck` = src；`typecheck:tests` = src+tests（含测试目录的类型错误）**+ `examples/` 四份示例的 `src`**
    —— 示例此前被 tsconfig 排除在外，等于「文档指着它说『完整可跑写法』、却没有任何门禁守着」；
    靠 `paths` 映射指到框架 `src` 与 `examples/observability` 源码，因此**无需在示例目录里 install** 即可检查；
  - `typecheck:types` = **针对构建产物 dist 的类型断言测试**（`tests/types/`，用 `@ts-expect-error`
    断言「应当报错」的场景真的报错）—— 必须先 `build`。它与 src 分开编译是**必须**的：模块增强
    （`declare module '…' { interface Blackboard }`）在同一编译程序内全局生效，混在一起会污染 src。
  - 另有 `npm run e2e:mcp`（真接第三方 MCP server，需要网络 / uv；离线自动回落
    `scripts/mcp-fixture-server.py`）。它**不并入**上面 8 步，但动了 `integrations/mcp.ts` 就要跑。
  - 另有 `npm run e2e:live`（真 API 集成验证）。**不并入**上面 8 步、**不进 CI**（会真花 token），
    无凭据时跳过并打横幅（静默跳过 = 假装验过）。动了 `integrations/anthropic.ts` 或
    `core/tool.ts` 的 `ModelClient` 契约就要跑它 —— **mock 全绿发现不了「SDK 真实行为与我们的假设不符」**：
    2026-09-14 靠它挖出「默认 client 从不转发 `signal`」（中止在飞 run 失效，见 spec §10）。
    那次也留下一条更省的教训：这类「契约有没有真落到传输层」的断言，**本地假端点**就能在 CI 里零成本守住
    （`tests/integrations/anthropic.test.ts` 就是这么做的），不必依赖真端点。
  - 另有 `npm run e2e:soak`（浸泡/压力：本地假端点 + 故障注入 + 并发长跑，零网络零 token）。
    **不并入**上面 8 步（它是「跑多久」而不是「对不对」的验证）。默认 60s×16 并发；
    排「内存/句柄随时间泄漏」或「高并发下重试与背压行为」这类**时间维度**的疑点时跑它
    （`SOAK_DURATION_MS=7200000` 即真两小时）。
  - **CI**：`.github/workflows/ci.yml` —— 五个 job：① `verify`（`bash scripts/verify-all.sh`，与本地**同一条链**，
    不新增检查项）；② `lint`（`npx biome ci .`）；③ `import-floor`（在 Node 18/20 上验证「包可导入」——
    守住 `engines: >=18` 的声明，见 `scripts/check-import-floor.mjs`）；④ `e2e:mcp`（runner 无 uvx ⇒ 必走回落分支，
    同时当回落守卫）；⑤ `deploy-website`（**发布**，只在 `main` 上跑：`needs: [verify, lint]` + `npm run deploy:website`
    推 Cloudflare Pages。PR 上 skip。**它不是必需状态检查，不要加进分支保护** —— 同下面 `verify` 的坑）。
    **`verify` 的 job name 是分支保护的必需状态检查，改名 = PR 永远等不到该检查 → 卡死**；
    同理**不要给 `verify` 加 matrix**（matrix 会给检查名加后缀）。要挡更低 Node 版本请另开 job。
    发布 job 需要仓库 secret `CLOUDFLARE_API_TOKEN`（Account → Cloudflare Pages → Edit）与
    `CLOUDFLARE_ACCOUNT_ID`；**缺 secret 时它响亮失败，不静默跳过** —— 静默跳过正是「以为部署了、
    其实没有」的病根（2026-09-13 官网合并了却仍跑旧版，就是这么来的）。
    `verify-all.sh` 用 `cd "$(dirname "$0")/.."` 自推仓库根 —— **别再往里写绝对路径**（本地能跑、CI 必挂）。
    失败分支**必须先用 `grep` 抽失败标记行**（`✖` / `not ok` / `AssertionError` / `error TS`）再 `tail` ——
    整段输出被捕获进 `$out`，只 `tail -30` 恰好会把「哪条测试挂了」冲掉，CI 上就只剩一个 exit 1，谁也查不出是谁。
  - 文档改完记得重建派生产物：`npm run build`（→ 框架包 `dist/AGENTS.md`）、
    `npm run build:cli`（→ CLI `dist/AGENTS.md`）与 `npm run build:website`
    （→ `llms.txt` / `llms-full.txt`），否则线上与实际说明漂移。
- **设计决策**：改语义的决定要同步 `docs/spec.md` §10 决策记录；方向性工作更新 `docs/roadmap.md`。
- **使用者向文档单源**：`docs/usage-guide.md` 是**唯一**的框架使用说明（API 速查 + 类型链路 + 已知边界 + 反例）。
  它被四处消费：① 框架包构建时拷成 `dist/AGENTS.md`（`scripts/copy-assets.mjs`，随 `@migor/agentia` 发布）；
  ② `packages/cli` 构建时拷成 `dist/AGENTS.md`，`agentia create` 写进新项目的 `AGENTS.md`；
  ③ 官网 `/llms-full.txt`（整篇）与 `/llms.txt`（索引，导出清单也从同一份里抠）；④ 人类速查。
  **不要另写第二份**：`tests/docs/usage-guide.test.ts` 会拿它里面的表格逐项对源码校验，改名/删字段立刻失败。
  三份副本都是**构建产物**（落在各自 `dist/`，已 gitignore），只拷不手写，因此不存在漂移。
- **发布**：两包版本同步（@migor/agentia 与 @migor/cli），CLI 模板里的框架依赖版本跟着走。
  ⚠️ **发布面不是「两个 package.json」，也不是「四处」** —— 一次 bump 真实动到十几个文件：
  `examples/` 的 `^旧版` pin（含两个 Dockerfile **注释**里那份）、`.github/ISSUE_TEMPLATE/*.yml`
  的版本占位、README 版本行、`docs/roadmap.md` 状态行、`docs/spec.md` §11 进度链、CHANGELOG 的
  compare 基线与链接引用、`package-lock.json` 的 version 字段、官网对渲染器的精确 pin。
  清单**只有一份**：`scripts/release-surface.mjs`（`--list` 可查）。闸门 `scripts/check-release.mjs`
  逐项断言「== 包版本」，bump `scripts/release.mjs bump` 逐项替换且**每项带计数断言**
  （不符即中止、一个字节都不写）。闸门挂在**两包的 `prepublishOnly`** —— **不**进 `verify-all`：
  未发布窗口内 `AGENTIA_VERSION` 是**有意落后**的（包版本先行），只有真发时才要求一致；
  不一致 `npm publish` 当场失败。同处还有一条 **bump 闸门**：要发的版本必须高于 npm 已发布版本
  （查官方 registry，E404 放行）—— 只验一致不验高低时，破坏性变更可能压在旧版本号上发出去。
  - **发版步骤（顺序不能换）**：`node scripts/release.mjs bump <x.y.z>` → 填掉它标出的两个
    `TODO(发版)`（CHANGELOG 正文 / spec §11 链说明）→ `bash scripts/verify-all.sh` → 开 PR 等必需
    检查绿 → **先发布**（两包分别 `npm publish`；`prepublishOnly` 会先自检再 build）→ 合并 PR →
    `node scripts/release.mjs tag <x.y.z> --title '一句话'`。**发布必须在合并之前**：反过来的话
    main 上会挂着「已发布」而 registry 还没有，这个谎会一直挂到发出去为止。
  - **tag 一律 annotated**（`release.mjs tag` 负责）。**不要用 `git tag -a … -m "<消息>"`**：
    消息里全是反引号，shell 会把反引号内容当**命令替换**执行 —— 消息里的词当场消失、bash 先打一行
    “No such file or directory”，而 tag 照样创建成功（本仓库真踩过）。脚本的做法是消息写文件 +
    `-F` 传入，建完 `git cat-file tag` 回读。存量 lightweight tag（v0.5.0 / v0.6.0 / v0.6.1）要转
    annotated 用 `node scripts/release.mjs retag <x.y.z>`（**默认只演练**，`--apply` 才真改；
    它按哈希判据确认这个 tag 确实是当初发出去那版才动，force-push 已推送的 tag 是外部可见动作）。
  - **打 tag 前会核对「registry 产物 ↔ 仓库树」**：单源文档 `docs/usage-guide.md` 与 tarball 内
    `dist/AGENTS.md` 的 sha256 必须相等，另加产物里的 `AGENTIA_VERSION`、CLI 包零 `@migor/*` 依赖、
    `dist/inspector/` 在场。不等就是「这棵树不是发出去那版」，直接拒绝打 tag。
- **官网（Astro）**：`packages/website` 是独立私有包，只影响官网，与框架本体和两个 npm 包无关。
  构建 `npm run build:website`（产物 `dist/`，已 gitignore），部署 `npm run deploy:website`（构建后上传）。
  - **wrangler 钉死 `4.131.0`，不要改回裸 `npx wrangler`**：`latest`（4.131.1）依赖的 workerd 二进制
    `@cloudflare/workerd-darwin-64@1.20260911.1` 从未发布（registry 最大 `1.20260910.1`），裸 `npx`
    会去拉 latest → workerd 装不上 → 挂死。`4.131.0` 是当前能装的最新版。
  - 客户端脚本必须写在 `<script>` 标签里：**frontmatter 里的 import 只在构建期（Node）执行，不会下发到浏览器**。
  - 页面正文经 `?raw` 片段 + `set:html` 注入——模板里 `{` 会被当表达式解析，而正文含大量 TS 代码块。
  - `build.format: 'file'` 保持 `*.html` 既有 URL；`build/`、`dist/`、`.astro/` 不进版本库。
  - **`src/fragments/api.html` 是手写的导出速查**（不像 `llms.txt` 从 usage-guide 派生）：新增 / 改名
    导出必须同步补进它 —— `tests/docs/api-page.test.ts` 做反向全覆盖校验，漏写即失败。`docs.html` /
    `index.html` 的正文与统计数字同样要跟着改，它们没有自动校验。
  - **表格版式三条不变量**（`tests/docs/website-css.test.ts` 钉住，改 CSS 前先读它）：
    ① API 页签名列**只能用 `overflow-wrap: break-word`，绝不能用 `anywhere`** —— `anywhere`
       会参与**固有尺寸**计算，把该列 min-content 压成 1 个字，表格最小宽度锁死 ~764px，
       中列无论容器多宽都只分到 55px（长签名竖成一列字，一行表高 1294px）。
    ② 三列都要有 `min-width` 下限，否则容器一窄就牺牲某一列。
    ③ ≤768px 必须卡片化（行变 block、`thead` 隐藏、表格 `min-width:0`）——
       列宽下限只能救「不至于逐字竖排」，救不了「一屏放不下 490px 的首列」。
  - **只验「页面不横向溢出」是不够的**：那次签名列被挤死时页面**没有**横向溢出（表在
    `.table-wrap` 里滚），所以溢出检查全绿而内容已经烂了。要看**列宽与折行数**：
    `td:nth-child(2)` 的宽度、签名代码块的渲染行数，在 360 / 390 / 641 / 768 / 1024 / 1600
    各档都要量。
