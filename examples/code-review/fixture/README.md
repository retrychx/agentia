# fixture —— 评审对象仓库（故意的）

这是一个**故意写得有问题**的最小后端服务，作为评审 agent 的评审对象。
评审能发现的种子问题（共 5 处）：

| 文件 | 问题 | 期望严重度 |
|---|---|---|
| `src/auth.ts` | 硬编码管理员口令 | critical |
| `src/auth.ts` | MD5 存口令（弱哈希） | major |
| `src/upload.ts` | 文件名未校验 → 路径穿越 | critical |
| `src/counter.ts` | check-then-act 竞态（并发双花） | major |
| `src/config.ts` | 关闭 TLS 证书校验 | major |

> 别修。修了就轮不到评审 agent 发现了。
