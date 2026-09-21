# 出站链路传播（`traceparent` 出站）设计

> **状态：待评审** —— 分叉表在 §6，回「都按建议」或逐条给字母即可；拍板前不写分阶段任务计划。
> 关联：`docs/spec.md` §9.2 / §9.4 · `docs/usage-guide.md` §6·§7 · `docs/roadmap.md` R7
> 来源：2026-09-21 弱方向审计 —— 出站传播是**唯一一处「语义已定、只差实现」的开放项**。

## 1. 目标

让 run 内**调用期**的代码（工具体 / skill / subagent / 能力中间件）能拿到**当前 span 的合法 W3C
`traceparent` 串**，带给自己发起的出站请求。效果：下游服务（另一个 agentia，或任何 OTLP 后端）能把
「是谁触发的」记成一条指向**具体 span** 的 link，而不是今天只能拿 `result.trace.traceId` 拼出的
**run 粒度**的头。

一句话口径：**只给读取器，不做自动注入**（框架不创建出站请求，见 §7）。

## 2. 现状证据

| 事实 | 落点 |
|---|---|
| 入站已落地 | `src/transport/http.ts:433-436`（`POST /run`）、`:503-505`（`POST /tasks`）→ `parseTraceparent` → `RunInvocationOptions.traceContext` → run 根一条 `SpanLink`（`src/engine/loop.ts:230-234`） |
| 解析器只认严格 W3C 形状 | `src/core/trace.ts:73` `TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/` |
| **出站为 0** | `grep -rn "traceparent" src/` 全部命中都在入站解析；`docs/usage-guide.md:681` 与 `:1253` 明写「框架**不生成**出站 `traceparent`」 |
| 内部 id 是 UUID | `src/engine/tracer.ts:19` `traceId = randomUUID()`；span id 同为 `randomUUID()`（同文件 `begin()`） |
| 「当前 span」今天拿不到 | `RunContext` 只有 blackboard（`src/runtime/context.ts:27-35`）；`ToolRunContext` 有 `parentSpanId`（`src/core/tool.ts:126-129`），但**普通 `@Tool` 体拿不到 ctx** —— `src/toolkit/tool.ts:80-85` 的 `run: (input) => Reflect.apply(…, [input])`，第二参根本不传 |
| 建 span 的只有三种 | run 根 / `llm.turn` / `capability`（仅 skill、subagent 建，见 `src/toolkit/skill.ts:128`、`src/toolkit/subagent.ts:119`）；普通工具与 `@Prompt` **刻意不建 span**（`src/core/trace.ts:11`） |

### 2.2 ⚠️ 真正的门不是 spec 写的那个（本设计的核心发现）

**① spec §9.2 自相矛盾。** 同一节里：第 135 行写「span 句柄**不放 RunContext**（`RunContext` 只有
blackboard）」，第 146 行又写「出站传播仍开放：缺的前置件是「`RunContext` 暴露当前 span」」。
前者是**锁定的设计决定**（run 级单实例 + ALS 单值 ⇒ 并行工具互相覆盖 ⇒ 父子关系错），后者把它当成
前置件。⇒ 前置件**不是**「RunContext 暴露 span」，而是**另开一条调用期作用域**（分叉 1）。

**② id 宽度对不上，而仓库里已经有一条投影规则。** W3C 要求 trace 32-hex + span **16-hex**；本仓 id
一律 UUID（去横线 32-hex）。trace 位恰好合规（去横线即 32-hex），**span 位对不上（32 > 16）**。
这条 OTLP 导出**早就解决过**：

```
src/integrations/otlp.ts:83-94
  function traceHex(id) { return id.replaceAll('-', ''); }
  function spanHex(id)  { return id.replaceAll('-', '').slice(0, 16); }
```

注释原文：OTLP 契约里 trace id 是 16 字节、span id 是 8 字节……「内部一律用 UUID（32 位 hex），
直接原样发出去会让 collector 判 `invalid span_id`（拒收）或按前 16 位截断」。

⇒ spec 说的「硬造一个会是假的 spanId」在有了这条既有投影之后**不成立**：`spanHex` 出来的 16-hex
**就是我们已经在发给 OTLP 后端的那个 span 身份**。出站头用**同一个**投影，就是**同一个 id 的第二种载体**，
不是假 id。

**③ 硬约束：这两个函数是 `integrations/otlp.ts` 的私有函数（未导出）。** 出站若自己再抄一份，会出现
「同一次调用，collector 里一个 span id、下游 traceparent 里另一个」—— 两个数不一致，而那是跨系统关联
最不能出的错。⇒ 必须提成**单一真源**（分叉 2）。

## 3. 分阶段（顺序即理由）

### Phase A —— id 投影单源化（纯搬运，零行为变化）

把 `traceHex` / `spanHex` 从 `src/integrations/otlp.ts` 提到 **`src/core/trace.ts`**（与
`parseTraceparent` 同处：解析与生成对称），并补一个生成器：

```ts
// src/core/trace.ts（新增导出）
export function wireTraceId(id: string): string;                  // UUID → 32-hex（去横线）
export function wireSpanId(id: string): string;                   // UUID → 16-hex（去横线后截 16）
export function formatTraceparent(traceId: string, spanId: string): string;  // '00-<32hex>-<16hex>-00'
```

- 命名取「**线缆形态**」之意：避免 `traceHex` 与「内部 id 也是 hex」混淆；也把「这是给外部消费的形态」
  写进名字。
- `wireSpanId` 对已经是 16-hex 的输入**幂等**（收到的上游 span id 若被再次转发，不变形）。
- `src/integrations/otlp.ts` 改为 `import { wireTraceId, wireSpanId } from '../core/trace.js'`；
  `integrations → core` 是已有允许边。
- **为什么不新开文件**：`core/trace.ts` 已经是「W3C 字符串形态的唯一落点」（`TRACEPARENT_RE` +
  `parseTraceparent` 都在这），生成器放别处就又把「同一个格式的知识」拆成两处。
- 为什么先做：Phase B 依赖它，且它自己能独立验证（见 §5.1）。

### Phase B —— 调用期 span 作用域 + 公共读取器（唯一的机制改动）

新增 `src/engine/span-scope.ts`：

```ts
/** 调用期「当前 span」作用域：只在被包裹的那次调用内有效（**不是** run 级） */
export function withCurrentSpan<T>(spanId: SpanId, fn: () => T): T;
export function currentSpanId(): SpanId | undefined;
```

**写入点三处**（由粗到细，内层覆盖外层）：

| 位置 | 当前 span | 改动 |
|---|---|---|
| `src/engine/loop.ts`（开 run 根之后） | run 根 | 包住整轮执行 |
| `src/engine/turn.ts`（单工具执行处） | 当回合 `llm.turn`（即今天的 `ToolRunContext.parentSpanId`） | 包住该次工具调用 |
| `src/toolkit/skill.ts:128` / `subagent.ts:119`（`begin('capability', …)` 之后） | 该 capability span | 包住方法体 |

**公共读取器**（`src/index.ts` 新增导出）：

```ts
/** 当前调用期的 W3C traceparent；不在 run / 调用内时 undefined */
export function currentTraceparent(): string | undefined;
```

实现 = `currentSpanId()` 与 `runId` 都在时 → `formatTraceparent(runId, currentSpanId())`，否则 `undefined`。

- **为什么放 `engine/`**：写入者是 engine（`engine → core` ✓）与 toolkit（`toolkit → engine` ✓，已是
  ALLOWED 里的边），读者走 barrel ⇒ **不需要改 `tests/architecture/layering.test.ts` 的 ALLOWED**
  （那个文件有「层数 < 9 即失败」的元守卫，不动它就是零风险）。
- **为什么不是 run 级 ALS**：§9.2 第 135 行的理由原样适用 —— 并行工具调用会互相覆盖。per-call 作用域
  天然正确（每次调用的 async 上下文各一份），这正是分叉 1 选 A 的全部理由，也是 §5.2 要钉的用例。

### Phase C —— 文档与记录收口（仓库原则 2 的硬要求）

| 文件 | 改什么 |
|---|---|
| `docs/usage-guide.md` §6「跨进程关联」 | 补一节「出站怎么给」：`headers: { traceparent: currentTraceparent()! }` + gRPC metadata 一行（与已有入站对称） |
| `docs/usage-guide.md:681`、§7 边界行 `:1253` | 改写为如实口径：从「不生成出站」→「出站**只给读取器、不自动注入**；id 宽度经 `wireSpanId` 投影到 16 位」 |
| `docs/spec.md` §9.2 | 改掉 `:146` 那句自相矛盾的前置件表述 + 标「已落地」；§10 加当日决策记录 |
| `docs/roadmap.md` R7 状态行 | 出站传播从「仍开放」移出 |
| `packages/website/src/fragments/api.html` | 导出表加 `currentTraceparent`，**页头手写计数 `:29` `<b>211</b> 个导出` 必须 +1**（`tests/docs/api-page.test.ts:235` 会红） |

改文档前先读 `tests/docs/usage-guide.test.ts` 的收集规则：**首列是非标识符散文的行会被解析器跳过**，
只有纯反引号标识符的第一格才被拿去对 `src/index.ts` 的导出面 —— 新加的散文行安全，写 `currentTraceparent`
的地方必须是真导出。

## 4. 与仓库硬约束的核验

| 约束 | 结论 |
|---|---|
| 分层单向（`tests/architecture/layering.test.ts:39`） | 不新增层、不改 ALLOWED：`core/trace.ts` 是叶子、`engine/span-scope.ts` 只引 `node:async_hooks` |
| 零运行时依赖（roadmap 原则 3） | 只用 `node:async_hooks`（`runtime/context.ts` 已在用同一 API），**不新增任何依赖** |
| 运行时核心语义稳定（原则 1） | Phase A 纯搬运；Phase B 是**加法** —— 作用域只在被包裹的调用内可见，没人调 `currentTraceparent()` 时行为逐字不变；不改 `RunContext` / `ToolRunContext` / `Span` 任何既有契约 |
| 框架不读 env、不做进程级决策 | 无 env、无新增旋钮（flags 恒 `00`，见分叉 4） |
| 文档单源 | usage-guide 改动经 `scripts/copy-assets.mjs` 派生成 `dist/AGENTS.md` 与官网 `llms.txt` ⇒ 改完 `npm run build` 后 grep 新标题在**每一份**派生件里都在 |
| verify-all 步数写死在 CI job name 里 | **不加第 9 步**，新用例折进已有链路 |
| 多 agent 同仓作业 | 结论钉到 commit；门禁跑在隔离导出树（`git archive` + 软链 `node_modules`）；只 `git add` 自己动过的文件 |

## 5. 测试策略

1. **单源（承重）**：`core/wire-ids` 形态直测 + 一条「OTLP 导出与出站头用的是同一个投影」的断言。
   ★ **承重性反向验证**：把 `otlp.ts` 改回私有副本 ⇒ 这条必红。
2. **作用域正确性**：并行两个工具各自读 `currentTraceparent()` **互不串**；嵌套（skill 体内拿到的是自己的
   capability span，不是发起它的 turn）；run 外 → `undefined`；工具抛错 / 超时后作用域不残留。
3. **往返闭环（最有说服力）**：`parseTraceparent(currentTraceparent()!)` ===
   `{ traceId: wireTraceId(runId), spanId: wireSpanId(currentSpanId()) }` —— 出站串能被我们自己的入站
   解析器吃下，形状合规是**机器证明**的，不靠肉眼比位数。
4. **OTLP 一致性**：同一次 run 导出后，出站头里的 span id 与 OTLP 里该 span 的 `spanId` **逐字相等**。
5. 门禁：`bash scripts/verify-all.sh` 全绿（8/8），不新增步骤。
6. 可选：`examples/grpc-host` 补一行 metadata 出站（它已有入站解析，正好对称），`scripts/e2e-grpc.ts` 加一处断言。

## 6. 分叉表

| # | 分叉 | 选项 | 推荐 | 一句话理由 |
|---|---|---|---|---|
| 1 | 「当前 span」怎么暴露 | **A** 新开**调用期**作用域（per-call ALS）+ barrel 读取器 / **B** 塞进 `RunContext` / **C** 给 `@Tool` 加第二参 ctx / **D** 维持现状（用户自己拼头） | **A** | B 被 §9.2 自己否掉（并行工具互相覆盖）；C 是公开签名破坏 + 违背「ctx 不层层下传」；D 不解决 span 精度 |
| 2 | id 投影 | **A** 复用 OTLP 那条投影、提成 `core/trace.ts` 单一真源 / **B** 把 spanId 生成改成 W3C 原生 16-hex / **C** 另发一对 W3C id 记进 run 根 attributes | **A** | ① 与 collector 里的 id 天然同一个数；② B 会造出两套口径且历史数据对不上；③ C 是一个东西两个 id |
| 3 | 出口形态 | **A** `currentTraceparent(): string \| undefined` / **B** 结构化 `currentTrace(): { traceId, spanId } \| undefined` / **C** 两个都给 | **A** | 与 `parseTraceparent` 对称（一个解析、一个生成）；要结构化就 `parseTraceparent(f()!)`，要 B3 等格式时再谈 |
| 4 | flags 位 | **A** 恒 `00` + 文档写明「本框架不采样」 / **B** 加 `sampled` 选项 | **A** | 框架没有采样机制；`parseTraceparent` 连 flags 都不读 ⇒ 这个旋钮今天没有接收方 |
| 5 | 范围 | **A** 只给读取器（框架不创建出站请求 ⇒ 无注入点） / **B** 顺手给 HTTP 宿主加 webhook 出站注入 | **A** | B 与已记档的「webhook 后置、用 sink + 用户自己的 `fetch`」冲突 |

### 最想听你意见的是分叉 2

它把**已发布**的 `integrations/otlp.ts` 里两个私有函数挪进 `core/trace.ts`（行为零变化，但位置触及
已发布模块）。若你认为「不该为出站去动 OTLP 的代码」，替代方案是出站自带一份投影 + 一条「两份必须相等」
的对拍测试 —— 成本是**多一份要守的副本**（本仓对副本的成见很明确：CLI 的 harvest / diff 副本是**逐字对拍**
守着的）。我倾向直接搬；这条你要是不同意，我按对拍走。

## 7. 非目标（YAGNI —— 本轮不做，也不该顺手做）

- **自动注入出站请求**：框架不创建出站 HTTP / gRPC 调用（模型客户端那次调用不该带我们的 traceparent）。
  给读取器 = 宿主自己的 `fetch` / metadata 里一行。
- **采样与 flags 可配**：框架无采样机制；spec §9.4 那条「全量记录成本 vs 采样阈值」是**另一个**开放问题
  （§8），不是本设计的答案。
- **B3 / Jaeger 等其他传播格式**：先只 W3C —— 入站也只认 W3C，对称。
- **跨 run 聚合 / 看板**：spec §10 已明确不做。
- **把 span 塞进 `RunContext`**：分叉 1 的 B，被 §9.2 否。

## 8. 与其它开放项的关系（避免下一轮重复三角）

- **spec §9.4**「全量记录成本 vs 截断/采样默认阈值」：不被本设计覆盖。
- **增量 trace 出口**：`grep -rn "onSpan\|onEvent\|onTrace\|streamTrace" src/` = **0 命中** ⇒ 支撑不了
  `GET /tasks/:id/stream`（被后置两次）。那是**内核级**的一件（改 tracer 的消费模型），**另立项**，
  本设计不顺带做。
- **guards.md §2 三项待守**（`0` 的双重语义 / 转发漏字段 / 队列配方无门禁）：与本设计无重叠，另轮处理。

---

## 验证与复现

本设计的每条事实都可复跑：

```bash
grep -rn "traceparent" src/ | grep -v parse      # 出站 0 命中
sed -n '83,94p' src/integrations/otlp.ts         # 既有投影规则
sed -n '133,148p' docs/spec.md                   # §9.2 的两句自相矛盾
sed -n '78,86p' src/toolkit/tool.ts              # 普通 @Tool 拿不到 ctx
node --import tsx --test "tests/**/*.test.ts" 2>&1 | grep -E '^ℹ (tests|pass|fail)'
```
