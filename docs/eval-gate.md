# 评测即发布闸门（配方）

> **这份配方补的是定位里最后一句话**：spec §1 说「**trace 决定你敢不敢上线**」。
> 框架已经把「看」给全了（调用树、成本、错误分类、`agentia report` / `diff` / `harvest`），
> 但「**判**」这一脚此前没有产物：`EvalReport.ok` 只回答「本次用例全过」，不回答
> 「比上一版好还是坏」，也防不住「把失败用例删掉」。这份配方把它补成一条**判据**，
> 且**零 engine 改动** —— 判据本身是一段消费公共面的代码（`examples/eval-gate/src/gate.ts`）。
>
> ⚠️ **它不是 roadmap 上已声明的候选**：`docs/roadmap.md` 的 R7 剩余候选是「中间件二次评估」
> 与「Workers 代理版 playground」。这一条是审阅定位时读出来的缺口 —— 属于**建议**，不是仓库欠账。

## 0. 框架给什么 / 不给什么

| 框架给 | 框架不给（这份配方补） |
|---|---|
| `defineEval`：用例 + 断言 → `EvalReport`（每 case 通过与否 + 失败 case 的 trace） | 「本次 vs 上次」的对照 |
| `agentia harvest`：线上 trace → 用例骨架 | 「删掉用例」这一动作的检测 |
| `agentia diff`：两条 trace 的 A/B（差异非空 exit 1） | 退出码语义（CI 里那一步该 0 还是 1） |
| `attachScore` + `metricsSink`：eval 结论自动落 score、聚合成通过率指标 | 基线该长什么样、谁来维护 |

判据**不替你做判断**：它不评价「用例写得对不对」，也不给你一个质量分阈值 ——
它只回答一个问题：**基线里通过的用例，这次有没有变坏；基线里的用例，这次有没有被删掉。**

## 1. 判据：三条规则

判定输入是「本次报告（可多个套件）+ 基线（上一次被接受的结论）」，输出是 `GateReport`：

1. **回归** —— 基线里通过、这次失败 ⇒ **不通过**。这是唯一能让 `ok` 为 false 的新坏消息，
   也是 `regressions` 的唯一来源。
2. **删用例** —— 基线里有、这次没跑 ⇒ **不通过**。否则「删掉那条总失败的用例」就成了
   过闸门最省事的办法，而这正是这套机制最该防住的作弊。
3. **新增用例 / 修好** —— 基线里没有的**新增用例**（`added`）与基线失败这次通过的（`recovered`）
   都**放行**，但各自记账：它们不阻塞发布，却是「该更新基线了」与「这轮变好了」的信号。

「基线里本来就失败」的用例**不拦发布** —— 那说明团队选择了「先记着，先发」。
这条语义是刻意的：闸门的职责是**拦住新的坏消息**，不是替你把历史债一次性清完。
（示例里就留了一条这样的用例，见 §4。）

### API

| 导出 | 说明 |
|---|---|
| `runGate(reports, baseline)` | **纯函数**判定：给报告与基线，出 `GateReport` |
| `baselineFrom(reports)` | 从本次报告生成基线（`--update` 用它）——⚠️ 人工核对后提交 |
| `parseBaseline(json)` / `serializeBaseline(b)` | 基线的解析 / 序列化（形状不对**抛错**：能解析成空基线的坏文件会让闸门永远绿） |
| `formatGateReport(g)` | 人读的一页报告（CI 日志里直接看懂「为什么没过」） |
| `caseKey(suite, case)` | 用例键 `<套件名>::<用例名>`（多套件同名用例不互相串） |
| `GateBaseline` / `GateCaseDelta` / `GateReport` | 基线与报告的形状（`GateReport` 含 `ok` / `regressions` / `recovered` / `added` / `removed`） |

`runGate` 是纯函数（不需要真跑 agent）—— 于是判据本身可以被单测、也能离线拿历史报告比对。

## 2. 接进你的 CI

```jsonc
// package.json（你的工程）
"scripts": {
  "gate": "node dist/gate-main.js",                  // 判定：有回归或删用例 ⇒ exit 1
  "gate:update": "node dist/gate-main.js --update"   // 重写基线（人工核对后提交）
}
```

```yaml
# .github/workflows/ci.yml（你的工程）—— 挂在既有的必需检查里，别新开一个 job
- run: npm run gate
```

退出码分三档，**刻意把环境错误与回归分开**：

| 退出码 | 含义 | 该怎么办 |
|---|---|---|
| `0` | 无回归、无删用例 | 放行 |
| `1` | 有回归或有删用例 | 看 stdout 的 `✗` 两行：修回行为，或**显式**改基线并说明 |
| `2` | 基线读不到 / 解析不了 | 环境问题，**不是**你的 agent 退化了 —— 先 `npm run gate:update` |

换 prompt / 换模型 / 换工具之后，流程是：跑 `gate` 看有没有回归 → 没有就照常发；
有回归就查 trace（失败 case 自带完整 trace）→ 决定是修回还是接受（接受就 `gate:update`
并**在 PR 里说明为什么这次变坏可以接受**）。

## 3. 与内置件的关系（别重复造）

- **用例从哪来**：线上事故 → `agentia harvest trace.jsonl --failed --out evals/harvested.ts`，
  人工核对断言后进套件（脚手架**不是成品**，见 usage-guide「线上 trace 回流」）。
- **为什么每次都能离线跑**：用例的模型侧是 `scriptedClient`（写死的脚本）⇒ 不联网、不烧 token、
  结论稳定。**要花钱、会抖的门禁没人敢当发布判据** —— 这是它能进 CI 的前提。
- **失败现场**：`EvalCaseReport.trace` 直接给失败那次的完整调用树；要大范围 A/B 用 `agentia diff`。
- **通过率的长期视图**：`defineEval` 已把每条结论 `attachScore` 到 trace 根，`metricsSink`
  聚合成 `agentia_score` 指标族 —— 闸门管「这一版能不能发」，指标管「这段时间在变好还是变坏」。
- **不进框架**：判据是宿主的发布流程，框架**不内建**（与「框架不做进程级决策」同一条纪律）。
  这份配方给的是可拷走的实现，不是一个新 API。

## 4. 示例（`examples/eval-gate/`）

```bash
cd examples/eval-gate
npm install          # 装了 file:../.. 的框架（仓库根先 npm run build）
npm run check        # 对基线判定：通过 ⇒ exit 0
npm run update       # 重写 baseline.json（人工核对后提交）
```

四个套件演示四件事：工具调用顺序、成本记账（含缓存乘数的**精确值**断言）、工具失败不中断 run、
以及**一条刻意留着的已知失败** —— 它的基线记 `false`，于是它不拦发布；谁把那条基线改成 `true`，
闸门立刻判成回归（现场可试：把 `baseline.json` 里那一项改成 `true` 再 `npm run check`）。

## 5. 边界（如实标注）

- **基线是人维护的**：`--update` 会把「这次跑出来的样子」记成标准 —— 包括坏的那些。
  它替代不了 code review，只能保证「变坏这件事不会静默发生」。
- **只覆盖被写成用例的行为**：没进套件的回归它照样看不见（用例覆盖是另一件事，
  `agentia harvest` 只降低写用例的成本）。
- **不做统计显著性**：单次脚本化跑，不做多次采样 / 置信区间 —— 需要那种严格度的场景
  （真实模型的非确定性输出）请自己加重复跑与聚合，本配方不假装能替你判。
- **判据与框架版本无关**：`runGate` 只吃 `EvalReport` 的形状；框架改 `EvalReport` 字段时
  这份示例需要跟着改（它进 `tsconfig.tests.json` 的 `include`，所以**编译期就会红**）。
