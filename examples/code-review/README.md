# Agentia 代码评审示例（产品验证）

一个**真实感强的业务案例**：对自带 fixture 仓库做代码评审的 agent 服务。主 agent 编排四类能力，
产出结构化评审报告 + 完整 trace + token/成本数字。它是「框架敢不敢上线」的证据：
trace 里看得见每个能力被调用的入参/出参、每次模型往返的 token 与成本、以及覆盖率评分。

> 框架能力导览看 [`../complete/`](../complete/)；本示例回答的是另一个问题：
> 「拿它做一个**真业务**长什么样、跑一轮花多少钱」。

## 业务与编排

评审对象是 `fixture/` 下故意写有 5 处真实问题（硬编码口令、MD5 弱哈希、路径穿越、
check-then-act 竞态、关闭 TLS 校验）的最小后端服务。主 agent 的编排路径：

```
拉评审标准（@Prompt review_rubric）
  → 列文件 / 通读（@Tool list_files / read_file / grep_code）
  → 安全专项深挖（@SubAgent security_scan，独立上下文循环，只借 'tools/grep_code' 一个工具）
  → 汇总定级（@Skill summarize，代码控制的一次受限模型调用）
  → 提交结构化报告（resultSchema → result.typed）
```

演示到的框架缝（都可以照搬到你自己的服务）：

| 面 | 用到的 |
|---|---|
| 四类能力 | `@Tool` ×3 · `@Prompt`（asset() 读 rubric.md）· `@SubAgent`（tools 用**能力级路径** `'tools/grep_code'`）· `@Skill`（ctx.llm） |
| 结构化输出 | `resultSchema`（`TypedSchema<ReviewReport>`，`result.typed` 自动推导） |
| 成本护栏 | `maxTotalTokens` + `priceOverrides`（给不在内置价格表的 deepseek-v4-flash 定价） |
| trace 出口 | 自定义 file sink（几行，见 `src/review.ts`）+ 覆盖率评分 sink（`attachScore`，demo 里确定性打分） |
| 离线复现 | `scriptedClient`（evals 公共面）把模型回合写成 8 步剧本 |

## 两种跑法

```bash
cd <仓库根> && npm install && npm run build   # 先构建框架（依赖是 file:../..，跑的就是工作区这份）
cd examples/code-review && npm install

# A) 离线确定性 demo：零 key、零网络，任何人跑出的数字一致（trace 时间戳除外）
npm run demo

# B) 真模型：读 .env（loadEnvFile 约定，真实环境变量优先）
cp .env.example .env   # 填 ANTHROPIC_API_KEY（或 ANTHROPIC_BASE_URL 指到兼容端点）
npm start
```

## 产物（`out/`，已 gitignore）

- `out/trace.jsonl` —— 一 run 一行完整调用树（span 层级 / tool.input·output 事件 / token 与成本 /
  根 span 上的 `fixture_coverage` score 事件）；
- `out/report.json` —— 结构化评审报告（`result.typed` 原文）。

trace 的消费串起来是这样：

```bash
agentia report out/trace.jsonl                          # 调优报告：哪个能力慢/贵/爱失败
# 改 prompt / 换模型后再跑一遍到 out/trace-b.jsonl，然后 A/B 对比两条调用树：
agentia diff out/trace.jsonl out/trace-b.jsonl          # 有差异退出码 1
```

## 目录结构

```
fixture/                # 评审对象仓库（故意写有 5 处问题，别修 —— 见它自己的 README）
src/
├── config.ts           # 全示例统一模型（AGENTIA_MODEL 覆盖，缺省 deepseek-v4-flash）
├── registry.ts         # 显式注册表
├── review.ts           # 装配 + resultSchema + file/score 两个 sink + runReview（两模式共用）
├── demo.ts             # 离线剧本（scriptedClient 8 步）
├── main.ts             # 真模型入口（loadEnvFile + 默认 Anthropic client）
├── tools/              # @Tool：list_files / read_file / grep_code（路径按示例根解析，越界拒）
├── prompts/rubric/     # @Prompt + rubric.md（评审维度与定级标准）
├── subagents/security-scan/  # @SubAgent + system.md（tools: ['tools/grep_code']）
└── skills/summarize/   # @Skill（ctx.llm 汇总定级）
```

## 真实运行证据

> 2026-09-17 用 DeepSeek 的 Anthropic 兼容端点真跑（`npm start`，对照 `out/trace.jsonl` 与 stdout）；
> fixture 种了 5 处问题，模型全命中并多发现 2 处真实问题（时序侧信道、共享可变状态）。

| 模型 | 主循环回合 | 总 token（入/出/缓存读） | 估算成本 | trace 规模 | 结论 |
|---|---|---|---|---|---|
| deepseek-v4-flash | 5 | 7588 / 5893 / 23168 | $0.00217 | 15 span / 55 事件 | 7 个问题（critical 2 / major 4 / minor 1），定级 high |

真跑与 demo（离线剧本）走**完全相同的装配与引擎链路**，只有模型 client 不同——这正是
「替掉模型，绝不替掉被测的框架链路」的实证。
