# 安全策略

## 支持的版本

仅**最新发布版本**接受安全修复；本仓处于 `0.x` 阶段，不维护长期分支。

| 版本 | 支持 |
|---|---|
| `0.2.x` | ✅ |
| `< 0.2` | ❌ |

## 上报漏洞

**请勿用公开 issue 报漏洞。** 走 GitHub 的私有通道：

→ [**Report a vulnerability**](https://github.com/retrychx/agentia/security/advisories/new)（Security → Advisories）

请尽量附上：受影响版本、最小复现、影响面（能读到什么 / 能改到什么）、以及你建议的缓解方式。

**响应预期**（尽力而为，非 SLA）：3 个工作日内确认收到；确认后在修复发布时一并公开致谢。

## 范围

**在内**（框架自身的缺陷）：

- 请求/响应处理、SSE 流、HTTP 宿主（`createHttpHandler`）的注入与越界
- 任务记录存储（`FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore`）的路径穿越、注入
- `discover` 目录扫描的越界读取
- 中间件 / 鉴权缝的实现缺陷（注意：框架**只给缝、不给策略** —— 见下）

**不在内**（按设计属于宿主或使用者的责任，不算框架漏洞）：

- 使用者自己写在 `@Tool` / 中间件里的逻辑缺陷
- 凭据管理、TLS、反代、进程级决策 —— 框架明确不碰（不读 env、不订阅信号）
- 提示词注入、模型输出内容问题 —— 属应用层
- 依赖自身的漏洞（请报给上游；我们会跟进 `dependabot` 的告警）

## 已知边界（如实标注）

- `errors.ts` 用 `instanceof` 判定厂商 SDK 的错误类。若使用者**自装一份不兼容版本**的
  `@anthropic-ai/sdk` 形成双副本，错误分类会退化为 `unknown`（该重试的不再重试）——
  这是已知边界，非安全漏洞。详见 `AGENTS.md`。
