# 目录约定：去伞形词（四类分置）—— 设计文档

> **状态**：**设计待拍板** —— §4 有 6 个分叉，每条都给了建议，等你勾。
> **日期**：2026-09-13
> **缘起**：`agentia create` 产出的 `units/` 目录被指出「命名不太好」。核实后发现问题不止是名字 —— 仓库里**同时跑着两套目录约定**，而且没有任何一步验证能发现（§1）。
> **前置**：本文是**设计**，不是逐步实现计划。拍板后另起 `docs/plans/2026-09-13-typed-unit-dirs-*.md` 列任务。

**Goal**：把**用户可见的目录约定**从「伞形词 `units/`」换成「分类目录」（`tools/ skills/ prompts/ subagents/`），让目录名自解释；顺手收掉三处既存漂移（§1 ②③④）。

**非目标**：不做运行时破坏性变更；不重写公共类型面（见 F4）；不引入布局探测魔法；不动观测/指标语义。

---

## 1. 现状 → 证据（全部是代码事实）

**① 「unit」是空词，靠图例才成立**
文档必须专开一节「四类单元」+ 一张四行对照表来定义它（`usage-guide.md` §0）。而 `units/weather/` 这个目录名，一个字都没说里面装的是工具、文本资产还是脚本流程。

**② 仓库里同时存在两套约定**

- 规范侧（CLI 硬编码 + 全部文档 + 官网 + spec）：项目**根** `units/` + 根 `units.ts`
  - `packages/cli/src/create.ts:62-63`、`packages/cli/src/generate.ts:17`、`packages/cli/src/registry.ts:15`
  - `README.md:25`、`docs/usage-guide.md:78`、`packages/website/src/fragments/docs.html:147-154`、`docs/spec.md`（Turn 7 条目）
- examples 侧（2026-09-13 新增，比规范晚 3 天）：`src/units/` + `src/units.ts`
  - `examples/complete/src/units.ts:11`、`examples/deploy/src/units.ts:6`

**③ 没有任何一步验证会发现它**

- `tsconfig.tests.json` 明确 `exclude: ['examples/deploy','examples/complete']` → 这两个示例**不参与任何类型检查**
- `scripts/verify-all.sh` 的 8 步都不碰 examples；仓库无 CI（无 `.github/workflows`）

**④ 同源 bug：脚手架 tsconfig 漏了 `units/`**
`templates.ts:86` 的 `include: ['src','units.ts']` **不含 `units/`**。实测：脚手架建项目后往 `units/broken/index.ts` 写 `const x: number = "不是数字"`，`tsc --listFiles` **不包含该文件**（只有被 `units.ts` import 的单元才被顺带检查）。而 CLI 自己在生成时还提示「discover 目录扫描路线下无需登记即可生效」→ 走 discover 的用户，**手写的单元静默不参与类型检查**。

**⑤ 会真炸的组合**
`agentia g` 硬编码根级。在 examples 里跑 `agentia g tool x`，会在项目根**再建一棵** `units/` + 一个新的根 `units.ts`，与示例自己的 `src/units` 并存；而示例 tsconfig 是 `rootDir:"src"`，建在根的 units 又会被判成「在 rootDir 之外」。

**⑥ 行业惯例：基本不用伞形词**

- MCP：`tools` / `resources` / `prompts`
- OpenAI Agents SDK：`tools` / `handoffs` / `agents`
- LangChain、Vercel AI SDK：`tools`
- NestJS：`providers` / `modules` / `controllers`

**⑦ 命名泄漏面（F4 的代价依据）**
`UnitType` / `UnitCall` / `UnitMiddleware` / `UnitNext` / `SkillUnit` / `SubAgentUnit` / `UnitMetrics` / `UnitReport`（8 个公共类型名）+ 字段 `maxUnits` / `labelMode:'unit'` / `droppedUnits` + Prometheus 标签 `unit="…"` + trace span kind `unit` + trace-view 前缀 `unit:`。全仓 `unit` 命中约 **515** 处（src 147 / tests 137 / CLI 53 / trace-view 35 / 官网 47 / docs 64 / examples 17 / scripts 15）。

---

## 2. 目标布局（建议态，取决于 F1）

```
my-app/
├─ src/
│  ├─ main.ts                                  # createApp 装配入口
│  ├─ registry.ts                              # 显式注册表（agentia g 自动维护）
│  ├─ tools/weather/index.ts                   # @Tool
│  ├─ skills/outline-writer/index.ts           # @Skill
│  ├─ prompts/style-guide/{index.ts,asset.md}  # @Prompt
│  └─ subagents/doc-reviewer/{index.ts,system.md}
├─ tsconfig.json                               # include: ['src']
└─ package.json
```

- `agentia g <type> <name>` 按 type 落到对应目录，并登记进注册表
- `agentia doctor` 扫这四个目录 + 注册表做体检
- `discover` 收四路径数组（F2）

---

## 3. 改动面（机械清单）

**框架 `src/`**

- `toolkit/discover.ts`：`discoverProviders(dir: string | string[])` —— 逐个扫描，**顺序即装配顺序**；错误措辞去掉 `units/`
- `toolkit/module.ts`：`AppOptions.discover` 放宽为 `string | string[]`；`createApp` overload 同步
- `index.ts`：**不新增、不删除导出**（api.html 反向全覆盖计数保持 **173**）

**CLI `packages/cli/src/`**

- `templates.ts`：`main.ts` 模板的 `discover` 改为四路径数组；`projectTsconfig()` 的 `include` → `['src']`；README 模板目录树
- `create.ts`：写 `src/tools/hello/index.ts`、`src/registry.ts`
- `generate.ts`：按 type 选目录（`tool→tools` / `skill→skills` / `prompt→prompts` / `subagent→subagents`）
- `registry.ts`：注册表路径改为 `src/registry.ts`；import 前缀按 type
- `doctor.ts`：扫四个目录；新增「跨类型同名 token」检查
- `add.ts` / `cli.ts`：措辞同步

**脚本 / 测试**

- `scripts/e2e-cli.ts`、`scripts/e2e-mcp.ts`：路径与断言
- `tests/toolkit/discover.test.ts` + `tests/fixtures/`：新增**数组形态**用例（顺序、含某目录不存在时的报错）、**跨目录同名**用例
- `tests/docs/usage-guide.test.ts`：本次**不改字段名**（只改路径措辞），避免触发表格逐项核

**文档 / 官网**

- `docs/usage-guide.md`：§0 心智模型（去伞形词，改按四类直呼）、§2 项目结构
- `docs/spec.md`：§10 决策记录
- `docs/roadmap.md`：方向条目状态
- `README.md`：目录约定段
- `packages/website/src/fragments/{docs,index,api,playground}.html`：layout 图、命令表、`discoverProviders` 行签名
- `examples/complete`、`examples/deploy`：`src/units` → 四个分类目录；README 目录表同步
- **派生产物重建**：`npm run build`（→ 框架包 `dist/AGENTS.md`）、`npm run build:cli`（→ CLI `dist/AGENTS.md`）、`npm run build:website`（→ `llms.txt` / `llms-full.txt`）

---

## 4. 设计分叉（待拍板）

### F1 —— 目录放哪

- **A（建议）**：`src/tools | skills | prompts | subagents/`。一次解决三件事：①正面回答你最初那句「跟平常的框架默认目录不一样」；②examples 的 `rootDir:"src"` 不用动，②里的漂移**自愈**；③tsconfig `include` 收缩成 `['src']`，顺带修掉 §1④ 那个漏 include 的 bug。
- **B**：项目根 `tools | skills | prompts | subagents/`。内容更显眼，但 tsconfig 仍要枚举四个目录，examples 也仍要放宽 rootDir。
- **建议 A。**

### F2 —— `discover` 怎么拿到四个目录

- **A（建议）**：`discover?: string | string[]`（模板写四路径数组）。显式、可 grep、允许自定义布局；**老项目 `discover:'units'` 单串照跑**（向后兼容）。
- **B**：`discover: 'src'` 自动展开四个约定子目录。短，但是魔法。
- **C**：新增 `discoverConventional(root)` 导出。多一个公共导出 → api.html 计数变。
- **建议 A**（合「只给缝」的取向）。

### F3 —— 注册表文件名

- **A（建议）**：`src/registry.ts`（文档里一直管它叫「注册表」）
- **B**：`src/providers.ts`（与它导出的 `providers` 同名）
- **C**：保留 `src/units.ts` —— **不建议**，等于把伞形词留在用户项目里
- **建议 A。**

### F4 —— 公共类型面的 `Unit*` 动不动（**这条最值得你反驳**）

涉及：8 个公共类型名 + 3 个字段 + 指标标签 `unit="…"` + span kind `unit` + trace-view 前缀 `unit:`。

- **A（建议）**：**不动**。只在 `usage-guide` 加一行：「`unit` = tool / skill / prompt / subagent 的**统称，内部术语**，不出现在目录约定里」。理由：你抱怨的是**用户可见的目录与约定**；改这一层是 ~500 处机械改动，还会作废刚落的观测三期的文档 / 官网 / api 计数，收益只是措辞一致。
- **B**：整体换成 `Capability*` / `capability="…"` / `capability:`。彻底统一，代价见 §1⑦。
- **建议 A**，但如果你要「一个词走到底」，就选 B —— 现在也是唯一便宜的时机。

### F5 —— 老项目怎么办

- **A（建议）**：**运行时零破坏** —— `discover` 收的是路径，老项目 `discover:'units'` 照跑；只有 `create` / `g` / `doctor` 的**约定**变。`g` / `doctor` 检测到根 `units/` + `units.ts`（老布局）时**明确提示迁移**，不悄悄新建目录。
- **B**：兼容期同时认两套布局（探测）。与「不做子系统」冲突。
- **建议 A。**

### F6 —— 跨类型同名怎么处理

四个目录之后，`src/tools/weather` 与 `src/skills/weather` 会产出两个同 token `weather` 的 provider，装配期按既有「同 token 后者覆盖」**静默吃掉一个**。

- **A（建议）**：`doctor` 报**错误**（跨类型同名 token）；装配期语义**不变**（不改运行时）。
- **B**：`g` 生成时就拒绝跨目录同名。
- **建议 A + B 都做**：生成期拦住 + 体检兜底。

---

## 5. 风险与不做的事

- **不**改运行时语义、**不**改任何公共类型名（F4=A）、**不**新增依赖、**不**加布局探测。
- `tests/docs/api-page.test.ts` 反向全覆盖：不新增/删除导出 → 计数保持 **173**；但 `discoverProviders` 那一行的**签名文字**要同步。
- `playground.html` / trace-view 的 `unit:` 前缀**不在本次范围**（F4=A 的直接后果）。
- 老用户项目**不会**被破坏（F5=A），但要在决策记录里写清「新约定只影响 `create` / `g` / `doctor`」。
- 本仓 `docs/plans/` 的历史文档**不改**（带日期的历史快照）。

## 6. 验证标准

1. `bash scripts/verify-all.sh` **8/8**（按显式退出码判定）
2. 新用例：`discoverProviders` 数组形态（顺序 + 某目录不存在时报错）；跨目录同名 token 的 `doctor` 报错；`g` 跨目录同名拒绝
3. `npm run e2e`（脚手架 → 生成 → 装配 → mock run）在**新布局**下全绿；`npm run e2e:mcp` 全绿
4. 用 `tsc --listFiles` 证明新脚手架的 `src/tools/*/index.ts` **在**编译程序内（修掉 §1④）
5. 派生产物一致：框架包 + CLI 的 `dist/AGENTS.md`、官网 `llms.txt` / `llms-full.txt`
6. `api.html` 反向全覆盖通过，导出计数仍 **173**
7. `spec.md §10` 有决策记录；`roadmap.md` 状态更新
8. 仓库 `main` 干净且与 `origin/main` 同步
