# 参与贡献

感谢你愿意贡献。本仓的**详细约定只有一份** —— 见 [`AGENTS.md`](./AGENTS.md)（它同时是 AI 编码助手的权威入口）。
本文只讲**人**的流程，不重复那份约定，避免出现两套说法。

## 快速上手

```bash
git clone https://github.com/retrychx/agentia.git
cd agentia
npm install
npm run build          # 编译到 dist/
bash scripts/verify-all.sh   # 8 步验证链（第 1 步含 lint），全绿才算完
```

> Node ≥ 18（`engines` 声明，CI 在 18/20/22 上守）。
> 若 `npm run dev`（tsx）报缺 esbuild，先 `npm approve-scripts` 批准 postinstall。

## 提交前必须跑

```bash
bash scripts/verify-all.sh    # 8 步：typecheck + lint → build → typecheck:types → typecheck:tests
                              #        → build:cli → test → e2e → build:website
npm run lint                  # 只想跑 lint 时用这个（`biome check .`，与链里同一个工具）
npm run lint:fix              # 格式化 / 安全修，别手工调格式
```

链的第 1 步会跑 `npx biome ci .` —— 与 CI 那个独立 `lint` job **同一条命令**，所以本地全绿就意味着
lint 也过了。**要往链上加检查，请折进已有步骤，不要加第 9 步**：CI 的 `verify` job 名（= 分支保护的
必需状态检查）写死了步数，加一步这名就成了假话，改名则会让所有 PR 卡死等一个永不出现的检查。

动了 `src/integrations/mcp.ts` 还要跑 `npm run e2e:mcp`。

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
| 某步验证「本地过了」但 CI 挂了 | 先分清是哪个 job。`verify-all.sh` 现在**含 lint**（第 1 步），但它**不含** CI 独有的 `import-floor`（Node 18/20 导入下限）与 `e2e:mcp` —— 这三个是必需检查，本地得单独跑 |
| 语义变更没留决策记录 | 改语义要同步 `docs/spec.md` §10；方向性工作更新 `docs/roadmap.md` |

## 报 issue

用 issue 模板（Bug 报告 / 功能建议）。安全漏洞**不要**开公开 issue —— 见 [`SECURITY.md`](./SECURITY.md)。

## 许可

贡献即表示同意以本仓的 [MIT 许可](./LICENSE) 发布你的贡献。
