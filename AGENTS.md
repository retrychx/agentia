# AGENTS.md —— 仓库结构与协作约定

## 布局

```
agentia/                     # npm 包 @migor/agentia（框架本体，单包）
├── src/
│   ├── core/                # 数据模型与结构接口（Trace/AgentTool/ModelClient/校验），零依赖
│   ├── engine/              # 运行时内核：agent loop、trace 记账、长上下文策略、错误分类、replay
│   ├── run/                 # run 生命周期、上下文(ALS)、触发（同步/异步/定时/HTTP）、
│   │                        # 任务存储（memory/file/sqlite/redis）、OTLP、OpenAI 适配、MemoryStore
│   ├── container/           # 最小显式 DI（useValue/useClass/useFactory+deps）
│   ├── toolkit/             # 声明式表面：装饰器×4、collect 内核、装配(createApp/defineModule)、
│   │                        # 中间件、目录发现(discover)、文本资产(asset)、zod 桥
│   └── index.ts             # 公共 API 唯一出口（新增导出必须在此登记）
├── tests/                   # node:test 单测，目录镜像 src（tests/run/x → src/run/x）
│   ├── helpers.ts           # 共用 mock client（改它影响全部套件，谨慎）
│   └── fixtures/            # discover/asset 测试夹具
├── scripts/e2e-cli.ts       # CLI 端到端（npm run e2e：脚手架→生成→装配→mock run）
├── packages/
│   ├── cli/                 # npm 包 @migor/cli（agentia create/g/dev/doctor/add），零运行时依赖
│   └── website/             # 官网静态站（index/playground/docs/api），Cloudflare Pages
└── docs/                    # spec.md（锁定决策）、roadmap.md（方向与状态）
```

## 硬约定

- **分层单向**：core ← engine ← run ← toolkit（container 独立），core 不依赖任何上层。
- **零新增运行时依赖**：可选能力（zod、redis 客户端）一律 duck-typed / peer。
- **ESM NodeNext**：相对 import 必须带 `.js` 后缀；注释用中文。
- **测试**：`npm test`（node:test）；新行为必须带测试，断言按真实语义写（先读实现）。
- **验证顺序**：`npm run typecheck && npm run build && npm run build:cli && npm test && npm run e2e` 全绿才算完。
- **设计决策**：改语义的决定要同步 `docs/spec.md` §10 决策记录；方向性工作更新 `docs/roadmap.md`。
- **发布**：两包版本同步（@migor/agentia 与 @migor/cli），CLI 模板里的框架依赖版本跟着走。
