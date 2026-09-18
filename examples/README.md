# 示例

四个示例，各管一件事。都只 import 框架的**公共面**（`@migor/agentia`），不碰内部路径。

| 目录 | 是什么 | 什么时候看 |
|---|---|---|
| [`observability/`](./observability/) | 四个现成 sink：按 runId 落库检索 / 日志关联 / 采样 / 脱敏（本地小包 `@migor/agentia-observability`，零依赖） | 要把 trace 送进生产观测栈时 |
| [`deploy/`](./deploy/) | **最小**可交付服务：HTTP 宿主 + `SqliteTaskStore` + `/healthz` + 优雅停机 + Docker | 想知道「怎么把它跑上线」时 |
| [`complete/`](./complete/) | **完整**示例：四类能力 + 三种触发 + 鉴权 + 全观测栈（上面四个 sink 接成一条链）+ Docker | 想知道「一个真实服务长什么样」时 |
| [`code-review/`](./code-review/) | **产品验证**示例：代码评审 agent 服务 —— 四类能力编排 + 结构化报告 + trace/成本数字，离线确定性 demo 与真模型两种跑法 | 想看「拿它做一个真业务长什么样、跑一轮花多少钱」时 |

配套阅读：[`docs/observability.md`](../docs/observability.md)（配方讲解）、
[`docs/usage-guide.md`](../docs/usage-guide.md)（API 速查）、[`docs/spec.md`](../docs/spec.md)（设计规格）。

## 依赖说明（重要）

三个应用示例的依赖都写成 `"@migor/agentia": "file:../.."`（指向本仓库）—— 这是**刻意的**：
示例要跑的是**工作区里刚构建的那份框架**，而不是 npm 上的发布版。仓库的端到端门禁
（`scripts/e2e-examples.ts`）也靠这一点：换掉依赖，示例就不再验证本仓库的构建产物。

```bash
cd <仓库根> && npm install && npm run build    # 先把框架构建到 dist/
cd examples/complete && npm install            # 再装示例
```

要用 **npm 上的发布版**（`0.4.0` 起，本目录示例用到的能力都已包含），把那一行换成
`"@migor/agentia": "^0.7.0"` 即可；两个 Dockerfile 也能相应退回常规单包写法
（各自的 README 里都标注了改动点）。

## Docker

两个示例的 Dockerfile 都以**仓库根**为构建上下文（镜像里先从源码构建框架）：

```bash
docker build -f examples/complete/Dockerfile -t agentia-complete .
docker compose -f examples/complete/docker-compose.yml up --build
```

> Docker 只认**构建上下文根**上的 `.dockerignore` —— 所以忽略清单在仓库根
> （[`.dockerignore`](../.dockerignore)），放在示例目录里不会生效。
