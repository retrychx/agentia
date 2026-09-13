# 参与贡献

感谢你愿意贡献。本仓的**详细约定只有一份** —— 见 [`AGENTS.md`](./AGENTS.md)（它同时是 AI 编码助手的权威入口）。
本文只讲**人**的流程，不重复那份约定，避免出现两套说法。

## 快速上手

```bash
git clone https://github.com/retrychx/agentia.git
cd agentia
npm install
npm run build          # 编译到 dist/
bash scripts/verify-all.sh   # 8 步验证链，全绿才算完
```

> Node ≥ 18（`engines` 声明，CI 在 18/20/22 上守）。
> 若 `npm run dev`（tsx）报缺 esbuild，先 `npm approve-scripts` 批准 postinstall。

## 提交前必须跑

```bash
npm run lint                  # Biome（lint + 格式），CI 有独立 job
bash scripts/verify-all.sh    # 8 步：typecheck → build → typecheck:types → typecheck:tests
                              #        → build:cli → test → e2e → build:website
```

动了 `src/integrations/mcp.ts` 还要跑 `npm run e2e:mcp`。
格式化交给 `npm run lint:fix`，别手工调格式。

## 提 PR 的流程

`main` 是**受保护分支**：

1. 从 `main` 开分支（`feat/…` · `fix/…` · `docs/…` · `chore/…`）
2. 提交、推送
3. 开 PR —— CI 必须全绿才能合并（`verify` · `lint` · `import-floor` · `e2e:mcp`）
4. 用 **squash** 合并（仓库要求线性历史）

> 直接 `git push origin main` 会被拒 —— 这是设计，不是故障。

## 提交信息

沿用 Conventional Commits 前缀（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` / `perf:`），
正文用中文讲清**为什么**（而不只是做了什么）。语义有变更的用 `!` 标记并在正文说明兼容性影响。

## 几条最容易踩的坑

| 坑 | 说明 |
|---|---|
| 忘了 `AGENTS.md` 的约定 | 尤其是**分层单向**（改了依赖方向必须同步改 `tests/architecture/layering.test.ts` 的 `ALLOWED`）与**零新增运行时依赖** |
| 改了 `docs/usage-guide.md` 没重建派生物 | 它是**单源**，跑 `npm run build` / `build:cli` / `build:website` 重新生成 `dist/AGENTS.md` 与 `llms.txt` |
| 新增了公共导出没改官网 | `tests/docs/api-page.test.ts` 做**反向全覆盖**：`src/index.ts` 的每个导出都必须出现在 `packages/website/src/fragments/api.html`（含页头统计数字） |
| 某步验证「本地过了」但 CI 挂了 | 检查是否依赖了本机状态（绝对路径、忽略的产物）。`verify-all.sh` 与 CI 是**同一条链** |
| 语义变更没留决策记录 | 改语义要同步 `docs/spec.md` §10；方向性工作更新 `docs/roadmap.md` |

## 报 issue

用 issue 模板（Bug 报告 / 功能建议）。安全漏洞**不要**开公开 issue —— 见 [`SECURITY.md`](./SECURITY.md)。

## 许可

贡献即表示同意以本仓的 [MIT 许可](./LICENSE) 发布你的贡献。
