# AGENTS.md —— 仓库结构与协作约定

## 布局

```
agentia/                     # npm 包 @migor/agentia（框架本体，单包）
├── src/
│   ├── core/                # 数据模型与结构接口（Trace/AgentTool/ModelClient/校验），零依赖
│   ├── engine/              # 运行时内核：agent loop、trace 记账、长上下文裁剪(trimming)、
│   │                        # 预算策略(policy)、错误分类、replay
│   ├── runtime/             # run 生命周期与调用契约：run 状态机、上下文(ALS)、RunSpec/RunInput、
│   │                        # SystemPrompt、跨 run 记忆(MemoryStore 水合/回写)
│   ├── transport/           # 触发宿主：HTTP handler、异步任务(AsyncRunner)、定时(Scheduler)、同步 RPC
│   ├── store/               # 任务记录存储：memory / file(JSONL) / sqlite / redis
│   ├── integrations/        # 外部系统适配：OpenAI 兼容端点(ModelClient)、OTLP 导出、
│   │                        #   MCP 桥(duck-typed，不含传输)、指标(metricsSink，满足 TraceSink)
│   ├── container/           # 最小显式 DI（useValue/useClass/useFactory+deps），叶子无依赖
│   ├── toolkit/             # 声明式表面：装饰器×4、collect 内核、装配(createApp/defineModule)、
│   │                        #   中间件、目录发现(discover)、文本资产(asset)、zod 桥
│   ├── eval/                # evals（D2）：scriptedClient + defineEval —— **叶子消费模块**，
│   │                        #   只依赖公共面、零反向依赖（谁都不 import 它）
│   └── index.ts             # 公共 API 唯一出口（新增导出必须在此登记）
├── tests/                   # node:test 单测，目录镜像 src（tests/transport/x → src/transport/x）
│   ├── helpers.ts           # 共用 mock client（**忽略 on('text')**；要「真吐字」用 src/eval 的
│   │                        #   scriptedClient —— 两者定位不同，改 helpers 影响全部套件，谨慎）
│   ├── fixtures/            # discover/asset 测试夹具
│   ├── types/               # **类型断言测试**（*.types.ts，只被 typecheck:types 编译、不被 node:test 收）
│   └── docs/                # 文档校验（usage-guide.md 的表格逐项对源码核）
├── scripts/e2e-cli.ts       # CLI 端到端（npm run e2e：脚手架→生成→装配→mock run）
├── scripts/e2e-mcp.ts       # MCP 端到端（npm run e2e:mcp：真第三方 server → 桥 → 菜单 → 真跑一轮）
├── scripts/mcp-fixture-server.py  # 离线夹具 MCP server（stdlib，e2e:mcp 的兜底）
├── packages/
│   ├── cli/                 # npm 包 @migor/cli（agentia create/g/dev/doctor/add），零运行时依赖
│   │                        #   dev = tsx watch + 本地 inspector 面板（trace-view 产物拷进 dist/inspector）
│   ├── trace-view/          # trace 调用树渲染器（零依赖 ESM）：createTraceView + playTrace(真实 Trace)
│   │                        #   官网 playground 与 CLI inspector 共用同一份，避免两处渲染漂移
│   └── website/             # 官网（Astro 静态站，构建产物 dist/ 部署 Cloudflare Pages）
│                            #   src/layouts/Base.astro 全站外壳、src/components/ 共享组件
│                            #   src/fragments/*.html 页面正文（?raw 注入）、src/scripts/ 客户端脚本
└── docs/                # spec.md（锁定决策）、roadmap.md（方向与状态）、
                         # usage-guide.md（**使用者向唯一说明**：CLI 项目 AGENTS.md 与官网 llms.txt 的单源）
```

## 硬约定

- **分层单向**：core ← engine ← runtime/store ← transport ← toolkit；`integrations` 只依赖 core
  （模型/trace 适配器）；`container` 是叶子（不 import 任何东西），仅被 toolkit 依赖。core 不依赖任何上层。
  `eval/` 是**叶子消费模块**（依赖 toolkit 与公共面）：它 import 别人，别人不 import 它。
- **零新增运行时依赖**：可选能力（zod、redis 客户端）一律 duck-typed / peer。
- **ESM NodeNext**：相对 import 必须带 `.js` 后缀；注释用中文。
- **测试**：`npm test`（node:test）；新行为必须带测试，断言按真实语义写（先读实现）。
- **验证顺序**：`npm run typecheck && npm run build && npm run typecheck:types && npm run typecheck:tests && npm run build:cli && npm test && npm run e2e && npm run build:website` 全绿才算完。
  - `typecheck` = src；`typecheck:tests` = src+tests（含测试目录的类型错误）；
  - `typecheck:types` = **针对构建产物 dist 的类型断言测试**（`tests/types/`，用 `@ts-expect-error`
    断言「应当报错」的场景真的报错）—— 必须先 `build`。它与 src 分开编译是**必须**的：模块增强
    （`declare module '…' { interface Blackboard }`）在同一编译程序内全局生效，混在一起会污染 src。
  - 另有 `npm run e2e:mcp`（真接第三方 MCP server，需要网络 / uv；离线自动回落
    `scripts/mcp-fixture-server.py`）。它**不并入**上面 8 步，但动了 `integrations/mcp.ts` 就要跑。
  - 文档改完记得重建派生产物：`npm run build:cli`（→ `dist/AGENTS.md`）与 `npm run build:website`
    （→ `llms.txt` / `llms-full.txt`），否则线上与实际说明漂移。
- **设计决策**：改语义的决定要同步 `docs/spec.md` §10 决策记录；方向性工作更新 `docs/roadmap.md`。
- **使用者向文档单源**：`docs/usage-guide.md` 是**唯一**的框架使用说明（API 速查 + 类型链路 + 已知边界 + 反例）。
  它被三处消费：① `packages/cli` 构建时拷成 `dist/AGENTS.md`，`agentia create` 写进新项目的 `AGENTS.md`；
  ② 官网 `/llms-full.txt`（整篇）与 `/llms.txt`（索引，导出清单也从同一份里抠）；③ 人类速查。
  **不要另写第二份**：`tests/docs/usage-guide.test.ts` 会拿它里面的表格逐项对源码校验，改名/删字段立刻失败。
- **发布**：两包版本同步（@migor/agentia 与 @migor/cli），CLI 模板里的框架依赖版本跟着走。
- **官网（Astro）**：`packages/website` 是独立私有包，只影响官网，与框架本体和两个 npm 包无关。
  构建 `npm run build:website`（产物 `dist/`，已 gitignore），部署 `npm run deploy:website`（构建后上传）。
  - **wrangler 钉死 `4.131.0`，不要改回裸 `npx wrangler`**：`latest`（4.131.1）依赖的 workerd 二进制
    `@cloudflare/workerd-darwin-64@1.20260911.1` 从未发布（registry 最大 `1.20260910.1`），裸 `npx`
    会去拉 latest → workerd 装不上 → 挂死。`4.131.0` 是当前能装的最新版。
  - 客户端脚本必须写在 `<script>` 标签里：**frontmatter 里的 import 只在构建期（Node）执行，不会下发到浏览器**。
  - 页面正文经 `?raw` 片段 + `set:html` 注入——模板里 `{` 会被当表达式解析，而正文含大量 TS 代码块。
  - `build.format: 'file'` 保持 `*.html` 既有 URL；`build/`、`dist/`、`.astro/` 不进版本库。
