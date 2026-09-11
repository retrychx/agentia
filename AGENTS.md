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
│   ├── integrations/        # 外部系统适配：OpenAI 兼容端点(ModelClient)、OTLP 导出
│   ├── container/           # 最小显式 DI（useValue/useClass/useFactory+deps），叶子无依赖
│   ├── toolkit/             # 声明式表面：装饰器×4、collect 内核、装配(createApp/defineModule)、
│   │                        # 中间件、目录发现(discover)、文本资产(asset)、zod 桥
│   └── index.ts             # 公共 API 唯一出口（新增导出必须在此登记）
├── tests/                   # node:test 单测，目录镜像 src（tests/transport/x → src/transport/x）
│   ├── helpers.ts           # 共用 mock client（改它影响全部套件，谨慎）
│   └── fixtures/            # discover/asset 测试夹具
├── scripts/e2e-cli.ts       # CLI 端到端（npm run e2e：脚手架→生成→装配→mock run）
├── packages/
│   ├── cli/                 # npm 包 @migor/cli（agentia create/g/dev/doctor/add），零运行时依赖
│   └── website/             # 官网（Astro 静态站，构建产物 dist/ 部署 Cloudflare Pages）
│                            #   src/layouts/Base.astro 全站外壳、src/components/ 共享组件
│                            #   src/fragments/*.html 页面正文（?raw 注入）、src/scripts/ 客户端脚本
└── docs/                    # spec.md（锁定决策）、roadmap.md（方向与状态）
```

## 硬约定

- **分层单向**：core ← engine ← runtime/store ← transport ← toolkit；`integrations` 只依赖 core
  （模型/trace 适配器）；`container` 是叶子（不 import 任何东西），仅被 toolkit 依赖。core 不依赖任何上层。
- **零新增运行时依赖**：可选能力（zod、redis 客户端）一律 duck-typed / peer。
- **ESM NodeNext**：相对 import 必须带 `.js` 后缀；注释用中文。
- **测试**：`npm test`（node:test）；新行为必须带测试，断言按真实语义写（先读实现）。
- **验证顺序**：`npm run typecheck && npm run build && npm run build:cli && npm test && npm run e2e` 全绿才算完。
- **设计决策**：改语义的决定要同步 `docs/spec.md` §10 决策记录；方向性工作更新 `docs/roadmap.md`。
- **发布**：两包版本同步（@migor/agentia 与 @migor/cli），CLI 模板里的框架依赖版本跟着走。
- **官网（Astro）**：`packages/website` 是独立私有包，只影响官网，与框架本体和两个 npm 包无关。
  构建 `npm run build:website`（产物 `dist/`，已 gitignore），部署 `npm run deploy:website`（构建后上传）。
  - 客户端脚本必须写在 `<script>` 标签里：**frontmatter 里的 import 只在构建期（Node）执行，不会下发到浏览器**。
  - 页面正文经 `?raw` 片段 + `set:html` 注入——模板里 `{` 会被当表达式解析，而正文含大量 TS 代码块。
  - `build.format: 'file'` 保持 `*.html` 既有 URL；`build/`、`dist/`、`.astro/` 不进版本库。
