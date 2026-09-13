# @migor/cli

Agentia 框架的命令行工具：脚手架、单元生成与本地调试。

```bash
npm i -g @migor/cli

agentia create my-app          # 脚手架：目录约定 + units.ts 注册表 + src/main.ts
cd my-app && npm install
agentia g subagent doc-reviewer # 生成单元并自动登记到注册表
agentia dev                    # tsx watch + 本地 inspector 面板
agentia doctor                 # 装配体检：未登记 / 悬空单元、命名规范、重复条目
agentia add <pkg>              # 安装第三方单元包并登记
```

## 命令

| 命令 | 作用 |
|---|---|
| `agentia create <name>` | 脚手架新项目：目录约定、`units.ts` 注册表、`src/main.ts` 入口、tsconfig |
| `agentia g <type> <name>` | 生成单元（`tool` / `skill` / `subagent` / `prompt`）到 `units/<name>/` 并登记注册表；长文本资产（`system.md` / `asset.md`）一并生成 |
| `agentia dev` | `tsx watch` 启动 `src/main.ts`，改单元文件自动重启；内建 inspector 面板查看 trace |
| `agentia doctor` | 纯静态体检，不加载用户代码 |
| `agentia add <pkg>` | 安装第三方单元包（`defineModule` 能力包）并登记到注册表 |

## 与框架的关系

CLI 生成的项目的框架依赖是 `@migor/agentia`。框架用法见
[`@migor/agentia`](https://www.npmjs.com/package/@migor/agentia)；
完整说明见仓库的 `docs/usage-guide.md`。

## 许可

MIT
