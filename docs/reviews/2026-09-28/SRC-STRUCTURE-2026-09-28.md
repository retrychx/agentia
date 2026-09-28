# src 结构与体量盘点 —— 大文件 / 大方法 / 要不要再加一层

> 2026-09-28 一次性盘点，**未随本仓提交**（与 `DEEP-REVIEW-2026-09-28.md` 等复核报告同惯例）。
> 所有数字都在这台机器上现算，口径写在第 0 节；结论在第 4 节，可以直接只看那节。

---

## 0. 口径（先说清楚「怎么量的」，否则下面的表没法核对）

| 量 | 方法 | 备注 |
|---|---|---|
| 大文件 | `wc -l`，`src/**/*.ts` | 96 文件 / 19854 行 |
| 大方法 | 自算花括号深度取体跨度 | 见下方「为什么不用 AST」 |
| 依赖图 | 相对导入（`from` / 副作用 / `import('...')` 字面量），**含 `import type`** | 与 `tests/architecture/layering.test.ts` 同口径；**345 条唯一文件→文件边**（431 处导入语句）/ 75 个源文件有出边 |

**为什么不用 AST**：本仓库锁的是 TypeScript **7.0.2（原生版）**，包里只剩
`tsc.js` / `getExePath.js` / `version.cjs`，已经没有经典编译器 API
（`require('typescript')` 解析到 `lib/version.cjs`，`ts.ScriptTarget` 是 `undefined`）。
`./unstable/ast` 是通道，但把盘点脚本压在上游 unstable 面上不值当，于是自写扫描器。

**自写扫描器踩的坑，值得记一笔**：第一版把模板串里的 `${...}` 只算了 `{`、没消 `}`，
于是每插值一次深度漂一格 —— `tracer.end`（真身 23 行）被报成 **200 行**、一直算到文件尾。
第二版改成 `code / template / interp` 三层模式栈才对。**下面所有数字都是修正后的**，
并且抽了 `createHttpHandler`、`#executeInner` 两处人工核对边界。

---

## 1. 大文件

`src` 共 19854 行 / 96 文件。前 16 名：

| 行数 | 文件 | 判断 |
|---:|---|---|
| 1690 | `transport/async.ts` | **大类**，不是大方法（见 §2 末） |
| 840 | `transport/http.ts` | **要动**：一个函数占 58%（§2） |
| 759 | `engine/turn.ts` | 尚可：18 个可调用体、最大 92 行 |
| 703 | `integrations/openai.ts` | 尚可：11 个可调用体、最大 80 行 |
| 676 | `integrations/metrics-state.ts` | 尚可：21 个可调用体、最大 136 行 |
| 614 | `integrations/anthropic.ts` | 尚可：14 个可调用体、最大 102 行 |
| 564 | `engine/mcp-server.ts` | **要动**：3 个可调用体、最大 441 行（§2） |
| 562 | `toolkit/module.ts` | 尚可：7 个可调用体、最大 199 行（构造函数） |
| 523 | `engine/loop.ts` | 尚可：9 个块、最大 99 行 + 两个 78/88 行的深块 |
| 463 | `engine/trimming.ts` | 正常 |
| 400 | `engine/tracer.ts` | 正常（6 个可调用体） |
| 378 | `runtime/run.ts` | 正常 |
| 353 / 350 / 340 | `integrations/mcp.ts` / `report.ts` / `metrics.ts` | 正常 |

**判据**（不是「超过 N 行就要拆」，那是伪科学）：一个文件该拆，当且仅当
**它同时装着两个以上互不相干的关注点，且其中之一的体量能独立命名**。
按这条看，`http.ts` 与 `mcp-server.ts` 是唯二「文件大 + 单函数占比极高」的；
`async.ts` 的 1690 行是**同一个关注点做得深**（队列宿主的全生命周期），
拆它要靠**再抽协作者**，不是切方法。

---

## 2. 大方法

阈值 55 行：96 文件 / 523 个块，其中可调用体 32 个、控制流大块 5 个。

### 2.1 可调用体（前 12）

| 行数 | 位置 | 名字 | 占该文件 |
|---:|---|---|---:|
| **489** | `transport/http.ts:327` | `createHttpHandler` | **58%**（841 行） |
| **441** | `engine/mcp-server.ts:124` | `createMcpServer` | **78%**（565 行） |
| **247** | `transport/async.ts:1364` | `#executeInner` | 15%（1691 行） |
| 209 | `integrations/metrics-render.ts:63` | `renderPrometheus` | 67% |
| 199 | `toolkit/module.ts:244` | `constructor` | 35% |
| 196 | `integrations/metrics-otlp.ts:74` | `buildOtlpPayload` | 65% |
| 136 | `integrations/metrics-state.ts:434` | `accumulate` | 20% |
| 131 | `integrations/metrics.ts:210` | `metricsSink` | 38% |
| 118 | `eval/export.ts:94` | `exportRun` | 56% |
| 108 | `toolkit/skill.ts:123` | 匿名闭包 | 46% |
| 102 | `integrations/anthropic.ts:81` | `createAnthropicClient` | 17% |
| 102 | `integrations/report.ts:118` | `buildRunReport` | 29% |

### 2.2 控制流大块（深缩进信号，前 5）

| 行数 | 位置 | 种类 |
|---:|---|---|
| 101 | `integrations/anthropic.ts:416` | `for await` |
| 96 | `integrations/mcp.ts:145` | `for` |
| 88 | `engine/loop.ts:221` | `for` |
| 81 | `engine/turn.ts:640` | `if` |
| 78 | `engine/loop.ts:142` | `if` |

### 2.3 值得单独说的三件事

**① `createHttpHandler` 489 行 = `http.ts` 的 58%，里面是 14 条路由体内联。**
这一刀是全场性价比最高的，而且**仓库里已有先例**：`refactor/cli-inspector-routes`
（#134，已合）做的就是「14 条路由各抽成命名函数」。同一手法搬到 `http.ts`：
路由**判定**已外移到 `http-route.ts`、出入站**形状**已外移到 `http-shapes.ts`，
差的就是最后一块 —— 路由**体**。抽成 `http-handlers.ts`（每个路由一个命名函数）
之后 `createHttpHandler` 只剩装配，`http.ts` 大概率落到 150 行内。
注意这道拆分**不会**碰到 `tests/architecture` 的分层（同层内），但会碰到
`tests/docs/api-page.test.ts:584` 的 `src/transport/http.ts 应当存在`（见 §3.2）。

**② `createMcpServer` 441 行 = 文件 78%**，且 `mcp-server.ts` 只有 3 个可调用体。
它是 MCP 反向桥（app 菜单暴露成 MCP server），按 AGENTS.md 的说法
「落 engine 是因为 integrations 只许依赖 core 装不下 TraceRecorder」——
**这是一个为了依赖方向而被安置的宿主，不是引擎内核**。它同时是 `engine/` 里
唯一 import `integrations` 的两个文件之一（另一个是 `loop.ts`）。

**③ `async.ts` 是反例，别误诊**：1691 行 / **35 个可调用体** / 最大 247 行 / 分布均匀。
这不是「大方法」病，是「**大类**」病 —— 把队列宿主的全部生命周期放在一个类里。
治法与前五个 `refactor/split-async-runner-*` 一致：继续抽**协作者**（下一个候选：
`#executeInner` 那段编排、审批监督、恢复重投），而不是切方法。AGENTS.md 对这批拆分
的表述是「判定面有名字、编排留在原处」——`#executeInner` 的 247 行就是那句「留在原处」
的余额，**它是有意留下的**，动它之前先想清楚编排要不要换地方。

---

## 3. `src` 下要不要再加一层

### 3.1 现状与三条硬事实

现状：`core` 14 / `engine` 27 / `transport` 14 / `integrations` 14 / `toolkit` 11 /
`store` 5 / `runtime` 5 / `eval` 4 / `container` 1。**只有 `engine/` 的 27 个文件算宽。**

**事实 A：加一层对现在的守卫是「隐形」的。**
`layerOf()` 取的是**路径第一段**（`tests/architecture/layering.test.ts:69-73`）。
`src/engine/trace/tracer.ts` 仍然映射到层 `engine` ⇒ 分层守卫、无环守卫、
「未登记层」守卫**全部照常通过**。也就是说：新目录**不产生任何约束力**，
只产生路径变长（`../core/x.js` → `../../core/x.js`）与一次 AGENTS.md 改写。

**事实 B：加一层是要付路径税的，且税是可枚举的。**
仓库有「**按名字推路径**」的文档守卫，搬文件会直接踩：

- `tests/docs/api-page.test.ts:576` —— `src/toolkit/{tool,skill,subagent,prompt}.ts` 必须存在
- `tests/docs/api-page.test.ts:587` —— `src/transport/{http,async,scheduler}.ts` 必须存在
- `tests/docs/boundary-table.test.ts:443,448` —— 写死 `src/integrations/metrics-state.ts`、`metrics-otlp.ts`
- `tests/docs/guards-registry.test.ts` —— `docs/guards.md` 里**每个反引号路径 token 都必须存在**（当前实测 ≥32 个）

前三条命中 7 个具体文件；第四条意味着 `docs/guards.md` 的路径引用要跟着搬家。
另有 `docs/plans/*.md` 里 146 处 `src/...` 引用（历史设计稿，按仓库惯例不追改，
但会变旧）。

**事实 C：这个仓库对「单元过大」的既有解法是「外移纯件」，不是「加目录」。**
`refactor/split-*` 系列已合 **15 个 PR**（loop / turn / http / async-runner 四大块），
AGENTS.md 用大幅篇幅逐文件写「为什么它在 engine 而不是 transport」。
**这家仓库表达边界靠的是文件名 + AGENTS.md 的散文，不是目录层级。**
现在贸然改结构，等于把已建成的表达方式换掉一半。

### 3.2 结论：**先不加。** 但给出「如果要加，加在哪、必须同时做什么」

**分目录看：**

| 目录 | 加一层？ | 理由 |
|---|---|---|
| `core/` `store/` `runtime/` `eval/` `container/` | **不加** | 4–14 个内聚小文件；加层只换来更长的相对路径 |
| `toolkit/` | **不加** | 11 个文件，且 `tool/skill/subagent/prompt` 已被 §3.1-B 按名钉死；「能力实现按名成文件」本身就是它的组织原则 |
| `integrations/` | **不加** | 14 个文件的**前缀已经是分组**（`openai`/`anthropic`/`adapter-options` = 模型客户端；`mcp*`；`metrics*`/`otlp*`）。加层等于把前缀再抄一遍成目录名 |
| `transport/` | **暂不加** | 14 个文件但有 `{http,async,scheduler}.ts` 的路径钉死；且 9 个抽出来的纯件是 42–124 行的判定件，埋进子目录反而更难找 |
| `engine/` | **唯一候选，但现在不加** | 27 文件 / 5415 行；确实存在三簇（见下），但现在加是「有成本、无约束」 |

**`engine/` 内部的三簇（真要加时的边界就按这个切）：**

1. **回合编排**：`loop.ts` `turn.ts` `turn-request.ts` `tool-context.ts` `tool-events.ts`
   `stop-reason.ts` `retry.ts` `loop-result.ts` `run-config.ts` `resume-input.ts` `spec.ts` `types.ts`
2. **trace 记账**：`tracer.ts` `trace-diff.ts` `span-scope.ts` `forwarded.ts` `replay.ts` `usage.ts`
3. **反向桥**：`mcp-server.ts`（就是 §2.3-② 那个「为了依赖方向寄居在此的宿主」）

**如果将来要加 `engine/trace/` 等层，必须同一步做完这三件事，否则就是纯搬家：**
- ① 扩 `tests/architecture/layering.test.ts`，让允许边集合**能表达子目录**（例如
  `engine/turn → engine/trace` 允许、反向禁止），否则新目录零约束；
- ② 把 §3.1-B 那四条路径断言一并改掉（它们是「按名钉文件」的有意设计，改要改得明白）；
- ③ 在 AGENTS.md 的布局段登记新层并写明**为什么这一层的边界值得守**。

**它们都做不完的话，收益只是「目录树好看」，成本是 7 处守卫 + 一份 4000 字的布局文档。**

### 3.3 顺带量到的两件事（不是缺陷，但守卫有盲区）

**① 文件级依赖环（全在层内），而守卫只守了层间环。**
`tests/architecture/layering.test.ts:158` 的「依赖图无环」跑在**层聚合图**上，
层**内部**的环没人管。实测存在 3 个（SCC ≥ 2）：

- `integrations/`：`mcp.ts` ↔ `mcp-http.ts` ↔ `mcp-stdio.ts` —— ⚠️ **真实值环**（见下订正）
- `runtime/`：`context.ts` ↔ `run.ts`
- `engine/`：`mcp-server.ts` ↔ `mcp-server-{stdio,http}.ts`

⚠️ **2026-09-28 订正 —— 本报告初稿写「两个环的回边都是 `import type`」是错的。**
逐条打开看导入语句：`mcp.ts:350/352` 是 `export { … } from './mcp-stdio.js'`（**re-export 值**），
而 `mcp-stdio.ts` 又**值导入**桥的 7 个 helper ⇒ **`integrations/mcp` 那条是运行期值环**
（靠 ESM 函数提升与调用时机侥幸无恙，**不是**「编译期 type 边」）。另两条
（`context ↔ run`、`engine/mcp-server ↔ transports`）的回边才真的是 `import type`、运行期无环。
初稿错在**只看 SCC、没打开文件看**（SKILL.md 那条「逐条看导入语句再下结论」正防这个）。
⇒ 该值环已在落地第 4 件时断开（协议面抽到 `src/integrations/mcp-protocol.ts`），
并加 `tests/architecture/file-cycles.test.ts` 按「值边才计环」的口径钉住层内盲区。

**② `docs/guards.md` 的路径清单守卫很硬**（`guards-registry.test.ts`），
这正是 §3.1-B 那条「路径税」的来源 —— 它守住了文档不腐化，代价是搬文件要同步搬文档。

---

## 4. 建议的落地顺序（按性价比）

1. **`http.ts` 拆路由体**（489 → 装配）——收益最大、与 `refactor/cli-inspector-routes` 同法，
   记得同步 `tests/docs/api-page.test.ts:587`。**先做这条。**
2. **`mcp-server.ts` 拆 `createMcpServer`（441 行）** —— 顺带把「它为什么在 engine」
   这件事再确认一遍（AGENTS.md 的理由还成立吗）。
3. **`#executeInner`（247 行）** —— 但这是有意留下的「编排」，动之前先定编排归属。
4. **补一条「文件级无环」守卫**（现值是层间无环；层内的 3 个环中 1 个是**真实值环**、需先断，
   另 2 个是 `import type`。守卫按「**值边才计环**」的语义写，把这层盲区关掉）。
   ✅ **已落地（2026-09-28）**：`tests/architecture/file-cycles.test.ts` + 抽 `mcp-protocol.ts` 断环。
5. **`src` 加层：不做。** 除非 1–3 做完 `engine/` 还是过宽，再按 §3.2 的三簇动，
   并同一步做完那三件事。

---

## 5. 本轮附带完成的仓库清理

见 §6 的移交说明；一句话：**远端 103 个分支 + 本地 72 个分支回收完毕**，
恢复凭据在 `.workbuddy/branch-backup-2026-09-28.txt`（已 gitignore，含每个分支的 tip SHA）。
