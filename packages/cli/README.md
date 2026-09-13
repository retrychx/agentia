# @migor/cli

Agentia 框架的命令行工具：脚手架、能力生成、本地调试与 **trace 观测**。

```bash
npm i -g @migor/cli

agentia create my-app          # 脚手架：四分类目录 + src/registry.ts + src/main.ts
cd my-app && npm install
agentia g subagent doc-reviewer # 生成能力并自动登记到注册表
agentia dev                    # tsx watch + 本地 inspector 面板
agentia doctor                 # 装配体检：未登记 / 悬空能力、命名规范、重复条目
agentia add <pkg>              # 安装第三方能力包并登记
```

## 命令

| 命令 | 作用 |
|---|---|
| `agentia create <name>` | 脚手架新项目：`src/tools` · `src/skills` · `src/prompts` · `src/subagents` 四分类目录、`src/registry.ts` 注册表、`src/main.ts` 入口、tsconfig |
| `agentia g <type> <name>` | 生成能力（`tool` / `skill` / `subagent` / `prompt`）到对应分类目录 `src/<分类>/<name>/` 并登记注册表；长文本资产（`system.md` / `asset.md`）一并生成 |
| `agentia dev` | `tsx watch` 启动 `src/main.ts`，改能力文件自动重启；内建 inspector 面板查看 trace |
| `agentia doctor` | 纯静态体检，不加载用户代码 |
| `agentia report <trace.jsonl>` | 从 trace 落盘文件生成调优报告（能力耗时 / 成本 / 错误率排行） |
| `agentia add <pkg>` | 安装第三方能力包（`defineModule` 能力包）并登记到注册表 |

## 可观测（trace）

框架的观测面 **Turn 0 起内建**：一次 run == 一条 trace（`runId == traceId`）。CLI 把这份 trace 带进本地开发流程，**不需要另装追踪后端**：

- **`agentia dev`** —— 起 `tsx watch` 的同时开一个本地 inspector 面板，实时看每次 run 的调用树（`llm.turn` / 能力 span / 每步 token 与成本）。面板的渲染器与官网 Playground 共用同一份 `@migor/trace-view` —— 两处一套代码，不漂移。
- **`agentia report <trace.jsonl>`** —— 把落盘的 trace 汇成调优报告：「**哪个能力慢 / 贵 / 爱失败**」的排行。面对一堆旋钮时，这是「该拧哪个」的依据。

落库检索 / 采样 / 脱敏、指标与 OTLP 导出都在框架侧的 `TraceSink` 缝上做 —— **策略归宿主，框架只给缝**。详见 [`@migor/agentia`](https://www.npmjs.com/package/@migor/agentia) 的「可观测性与成本」一节，以及仓库的 [`docs/observability.md`](https://github.com/retrychx/agentia/blob/main/docs/observability.md)。

## 目录约定

新项目的四类能力各占一个自解释的目录，一能力一文件夹（目录名即类型）：

```
src/
├─ tools/<name>/       # @Tool
├─ skills/<name>/      # @Skill
├─ prompts/<name>/     # @Prompt（含 asset.md）
├─ subagents/<name>/   # @SubAgent（含 system.md）
├─ registry.ts         # 显式注册表（create / g / add 维护，doctor 校验）
└─ main.ts             # createApp 装配入口
```

<!-- no-legacy-terms: allow -->
> 老项目（根 `units/` + `units.ts`）**运行时不受影响** —— `discover` 收的是路径，
> `discover: 'units'` 照跑；但 `g` / `doctor` 撞见老布局会**明确提示迁移**，绝不悄悄
> 在旁边新建第二棵目录树。
<!-- /no-legacy-terms: allow -->

## 与框架的关系

CLI 生成的项目的框架依赖是 `@migor/agentia`。框架用法见
[`@migor/agentia`](https://www.npmjs.com/package/@migor/agentia)；
完整说明见仓库的 `docs/usage-guide.md`。

## 许可

MIT
