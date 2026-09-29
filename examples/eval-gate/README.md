# @migor/agentia-eval-gate

**评测即发布闸门** —— 把 `defineEval` 的结论对上一版基线，收成一个判据：*这一版能不能发*。

配套文档：[`docs/eval-gate.md`](../../docs/eval-gate.md)（判据规则 / CI 接线 / 边界）。

## ⚠️ 先看这条：怎么拿到它

这个包**没有发布到 registry** —— `npm i @migor/agentia-eval-gate` 会 **404**
（`package.json` 里 `"private": true`，与 `packages/trace-view`、
`examples/observability` 是同一套办法）。它是**本地小包**：把 `examples/eval-gate/` 这个目录
拷进你的工程，并在 `package.json` 里声明 `"@migor/agentia-eval-gate": "file:./eval-gate"`
（本仓库 `examples/` 下各包之间就是这么接的，可以直接照抄）；不想引这个包名，也可以照
`src/gate.ts`（单文件）把判据抄进自己的文件。

**这不是待补的缺口，是决策**：框架的职责到「产出结论」为止，「这一版能不能发」是**宿主的发布流程**
（见下节）—— 所以它是**可拷走的实现**，不是框架要长期维护的发布面。三个不发布的包合起来只有
一条规则：**`private: true` ⇒ 拷目录用，别 `npm i`**。

## 为什么独立成示例

框架的职责到「产出结论」为止：`defineEval` 给 `EvalReport`，`agentia harvest` 给用例骨架，
`agentia diff` 给 A/B。**「这一版能不能发」是宿主的发布流程**，框架不内建
（与「框架不做进程级决策」同一条纪律）——所以它是一份可拷走的实现，不是一个新 API。

它补的是 `EvalReport.ok` 回答不了的两件事：

- **比上一版好还是坏**（`ok` 只说「本次全过」）；
- **「把失败用例删掉」这种过闸门的方式**（`ok` 对它完全无感）。

## 跑起来

```bash
cd ..                     # 仓库根
npm install && npm run build   # 先把框架构建到 dist/

cd examples/eval-gate
npm install               # file:../.. → 拿到刚构建的框架
npm run check             # 对基线判定：通过 ⇒ exit 0
npm run update            # 重写 baseline.json（⚠️ 人工核对后提交）
```

离线、确定性：模型侧是 `scriptedClient`（写死的脚本），不联网、不烧 token。
`npm run check` 的退出码：`0` 通过 / `1` 有回归或删用例 / `2` 基线读不到或解析不了。

## 导出

| 导出 | 说明 |
|---|---|
| `runGate(reports, baseline)` | 纯函数判定 → `GateReport` |
| `baselineFrom(reports)` | 从本次报告生成基线（`--update` 用它） |
| `parseBaseline` / `serializeBaseline` | 基线的解析 / 序列化（形状不对抛错） |
| `formatGateReport` | 人读的一页报告 |
| `caseKey` | 用例键 `<套件名>::<用例名>` |
| `GateBaseline` / `GateCaseDelta` / `GateReport` | 形状 |

## 四个套件（`src/suite.ts`）

1. **工具调用顺序** —— 断言从 trace 读（框架不为此新增埋点）；
2. **成本记账** —— 缓存读 0.1× / 写 1.25× 的**精确值**断言（改乘数立刻红）；
3. **工具失败不中断 run** —— `is_error` 的 tool_result；
4. **一条刻意留着的已知失败** —— 演示「已知坏不拦发布，但谁把它改成『曾经通过』就立刻红」。

第 4 条是刻意留的：闸门的职责是**拦住新的坏消息**，不是替你把历史债一次清完。
