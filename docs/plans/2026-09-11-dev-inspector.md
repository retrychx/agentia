# Dev Inspector（本地调试面板）实现计划

> **状态**：已评审，执行中。注入方式按评审结论改走 **B（preload + `registerDefaultTraceSink`）**。
> **日期**：2026-09-11

**Goal**：`agentia dev` 默认启动一个本地 inspector —— 开发者能在浏览器里看到每次 run 的调用树，以及每个单元（tool / skill / prompt / subagent）的执行情况：入参、出参、耗时、token、cache 命中、状态与错误。

**Architecture**：
1. **框架层加一条「trace 出口缝」**：`TraceSink { export(trace) }` + `AppOptions.sinks` + `registerDefaultTraceSink()`。run 收尾后框架把完整 `Trace` 投给每个 sink（sink 抛错被吞，绝不影响 run）。**框架不含任何 dev/inspector 逻辑，不读 env。**
2. **渲染器抽成新包 `@migor/trace-view`**（零依赖 ESM）：`createTraceView()`（DOM 渲染器）+ `playTrace(view, trace)`（`Trace.spans[]` → 视图指令的归一）。官网与本地面板共用同一份。
3. **CLI `agentia dev`** 起一个零依赖 inspector HTTP 服务（node:http），并用 `NODE_OPTIONS=--import` 注入 **CLI 自带的 preload** —— preload 从用户项目解析框架、`registerDefaultTraceSink(devSink)`；页面复用 `@migor/trace-view`。
4. **官网** playground 改用共享渲染器，消除「模拟树 vs 真实模型」两套渲染的漂移源。

**Tech Stack**：Node（node:http / node:test）、TypeScript（NodeNext ESM）、Astro（官网）。

**非目标（本计划不做）**：live 流式逐 token 推送（P3，SSE 增量）、run 重放执行、历史归档检索。本计划只做「run 结束后可见 + 可回看最近 N 条」。

---

## 关键设计决策（评审点）

### D1. trace 出口缝放在框架，而非 CLI 旁挂
**理由**：`executeRun` 是唯一收口点；OTLP 导出早已有 `export(trace)` 这个形状（`integrations/otlp.ts:26`），但用户得**手动**调（README 就是这么教的，容易漏）。把它升格为框架的一等出口，同时解决「手动 export 易漏」这个既有痛点。

`createOtlpExporter` 天然满足 `TraceSink`，**零改动**即可作为 sink 使用（向后兼容：手动调仍然可用）。

### D2. dev sink 的注入方式：`registerDefaultTraceSink` + `--import` preload（框架不读 env）
`agentia dev` 通过 tsx 起的是**子进程**，sink 必须在**子进程**里注册。**选用 B**：

- 框架只提供一个**通用扩展点** `registerDefaultTraceSink(sink)` —— 不含任何 dev/inspector 逻辑，**不读 env**。
- 注入全部在 **CLI 侧**：`agentia dev` 用 `NODE_OPTIONS=--import <cli>/dist/inspector-preload.js` 起子进程；preload 用 `createRequire(process.cwd())` 从**用户项目**解析 `@migor/agentia`（保证与应用同一模块实例），再 `registerDefaultTraceSink(inspectSink(port))`。
- 端口经 env `AGENTIA_INSPECT_PORT` 传给 **preload**（CLI 自有模块读 env，框架完全不感知）。
- `--import` 需 Node ≥20.6（≥18.19 已回移植）；`dev.ts` 启动前探测版本，不支持时打印明确提示（不静默失效）。
- HTTP sink 实现归 **CLI**（`packages/cli/src/inspector-sink.ts`），不进框架。

**被否方案（备查）**：`AGENTIA_INSPECT_PORT` 由 `createApp` 直接读取、框架内置 dev sink —— 简单但把 dev 逻辑塞进框架、框架依赖 env，与「分层纯净」相悖，弃用。

### D3. 渲染器抽取的边界
`playground.js` 已经把 `traceReset/traceStart/traceEnd/traceEvent/traceFinish/renderUsage` 暴露成 `window.AgentiaPlayground`，且 `playground-real.js` 已用真数据驱动它。抽取边界 = **这套函数 + `renderTrace` + `el/fmtArg/fmtMs/fmtNum` + `.tr-*` CSS**。
渲染器保持**数据无关**：只认「start/end/event/finish」四个动作，谁喂它都行（模拟脚本 or `playTrace`）。

### D4. CLI 保持零运行时依赖
`@migor/trace-view` 不进 CLI 的 dependencies。做法：trace-view 的浏览器产物（`view.js` ESM + `trace-view.css`）在构建期由脚本**拷贝**进 `packages/cli/dist/inspector/`，inspector 服务从磁盘静态提供。CLI 只 import 自己的 `node:http`。

---

## Phase A —— 框架：trace 出口缝

### Task A1：定义 `TraceSink` 类型

**Objective**：在 core 层加 trace 出口契约（core 不依赖上层，可独立定义）。

**Files**：
- Modify: `src/core/trace.ts`（文件末尾追加）

**Step 1**：追加类型

```ts
/**
 * trace 出口：run 收尾（成功或失败）后，框架把【完整 Trace】交给每个 sink。
 * sink 抛错由框架吞掉，绝不影响 run 结果（与 memory 回写同款防护）。
 * 形状与 OtlpExporter 一致 —— createOtlpExporter() 的返回值天然满足本接口。
 */
export interface TraceSink {
  export(trace: Trace): void | Promise<void>;
}
```

**Step 2**：验证类型可编译

Run: `npm run typecheck`
Expected: 通过（无新错误）

---

### Task A2：`executeRun` 投递 trace 给 sinks

**Objective**：在唯一收口点把 trace 投给 sinks，覆盖成功与失败两条路径。

**Files**：
- Modify: `src/runtime/run.ts`（`ExecuteRunOptions` + `executeRun`）

**Step 1**：`ExecuteRunOptions` 增加字段

```ts
  /** trace 出口（观测）：run 收尾后逐个投递，失败被吞不影响 run */
  sinks?: TraceSink[];
```

**Step 2**：加一个吞错的投递助手（同文件）

```ts
async function flushSinks(sinks: TraceSink[] | undefined, trace: Trace): Promise<void> {
  if (!sinks || sinks.length === 0) return;
  for (const sink of sinks) {
    try {
      await sink.export(trace);
    } catch {
      /* 观测失败不得影响 run（同 memory 回写防护） */
    }
  }
}
```

**Step 3**：在 `executeRun` 两条路径投递

- 成功路径：`run.finish(result)` 之后、`return { run, result }` 之前 —— `await flushSinks(options.sinks, result.trace)`。
- 失败路径：`run.fail(e)` 之后（`run.result` 已生成完整 trace）—— 若 `options.rethrow === false` 先投递再 `return`；否则**投递后再 throw**，保证必投。

**Step 4**：写测试

**Files**：Create `tests/runtime/sinks.test.ts`（node:test + 仓库现有 mock client）

覆盖三条：
1. 成功 run → sink 收到 trace，`trace.spans` 含 run 根。
2. sink 抛错 → run 仍 succeeded、结果不变（吞错生效）。
3. 失败 run（`rethrow:false`）→ sink 仍收到 trace，且 `trace.status === 'error'`。

Run: `npm test`
Expected: 新增用例 PASS，既有 182 个不回归。

**Step 5**：提交

```bash
git add src/core/trace.ts src/runtime/run.ts tests/runtime/sinks.test.ts
git commit -m "feat(trace): 加 trace 出口缝（TraceSink），run 收尾投递"
```

---

### Task A3：`AppOptions.sinks` + `registerDefaultTraceSink`

**Objective**：装配层暴露 sinks，并提供全局默认 sink 注册点（供 dev 工具注入；**框架不含 dev 逻辑、不读 env**）。

**Files**：
- Modify: `src/toolkit/module.ts`

**Step 1**：`AppOptions` 加字段

```ts
  /** trace 出口（观测）：每次 run 收尾投递；与全局默认 sink 合并（本字段在前） */
  sinks?: TraceSink[];
```

**Step 2**：模块级默认注册表（module.ts 顶部）

```ts
const defaultSinks: TraceSink[] = [];

/** 注册全局默认 trace sink（观测/dev 工具用）。createApp 构造期快照合并，已建应用不受后续注册影响。 */
export function registerDefaultTraceSink(sink: TraceSink): void {
  defaultSinks.push(sink);
}
```

**Step 3**：构造函数合并

```ts
this.sinks = [...(opts.sinks ?? []), ...defaultSinks];
```

**Step 4**：`AgentApp.run()` 的 `executeRun({...})` 调用加 `sinks: this.sinks`

**Step 5**：`src/index.ts` 登记导出：`TraceSink`(type)、`registerDefaultTraceSink`

**Step 6**：测试 `tests/toolkit/sinks.test.ts`
- 构造 app 前 `registerDefaultTraceSink(fake)` → 该 app 的 run 把 trace 投给 fake。
- `AppOptions.sinks` 与默认 sink 都收到；投递顺序 opts 在前。
- 构造 app **之后**再注册的默认 sink，不影响已建 app（快照语义）。

**Step 7**：验证 + 提交

Run: `npm run typecheck && npm run build && npm test`
Expected: 全绿

```bash
git add src/toolkit/module.ts src/index.ts tests/toolkit/sinks.test.ts
git commit -m "feat(trace): AppOptions.sinks + registerDefaultTraceSink 全局注册点"
```

---

### Task A4：同步文档

**Files**：
- Modify: `docs/spec.md`（§9 补 trace 出口描述；§10 加决策记录）
- Modify: `docs/roadmap.md`

**§10 决策记录条目**（照既有格式）：

```md
- 2026-09-11：**trace 出口缝（Dev Inspector 前置）**。`TraceSink { export(trace) }` 升格为
  框架一等出口（形状复用 `OtlpExporter`，`createOtlpExporter()` 返回值天然满足）；
  `executeRun` 成功/失败两条路径均投递，sink 抛错吞掉不影响 run。装配层 `AppOptions.sinks`
  与 `registerDefaultTraceSink()`（全局默认，构造期快照合并）。**框架不读 env、不含 dev 逻辑**：
  dev 注入由 CLI 侧 `--import` preload 完成（`registerDefaultTraceSink` 为公开扩展点）。
```

Run: `git add docs/ && git commit -m "docs(spec): trace 出口缝决策记录"`

---

## Phase B —— 新包 `@migor/trace-view`

### Task B1：建包骨架

**Files**：
- Create: `packages/trace-view/package.json`
- Create: `packages/trace-view/src/index.js`

```json
{
  "name": "@migor/trace-view",
  "version": "0.2.2",
  "private": true,
  "type": "module",
  "description": "Agentia trace 调用树渲染器（框架无关，零依赖）—— 官网 playground 与 CLI inspector 共用",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./style.css": "./dist/trace-view.css"
  },
  "files": ["dist"],
  "scripts": { "build": "node scripts/build.mjs", "test": "node --test test/*.test.js" },
  "license": "MIT"
}
```

> `private: true`：本包先不发布（与 CLI 一起发版时再定），官网与 CLI 都走 workspace 引用。

**Step 2**：`src/index.js` 先导出占位，`npm install` 让 workspace 链接生效。

---

### Task B2：抽出渲染器（数据无关）

**Files**：
- Create: `packages/trace-view/src/view.js`（从 `packages/website/src/scripts/playground.js` 迁移）
- Modify: `packages/website/src/scripts/playground.js`（改为引用共享模块 —— Phase D 做）

**迁移内容**（逐字搬迁，不加新逻辑）：
- `el / fmtNum / fmtMs / fmtArg`
- 节点模型：`traceRoot`、`node.order`、`node.{kind,name,arg,done,status,error,usage,ms}`
- `traceReset(sc) / traceStart / traceEnd / traceEvent / traceFinish / renderTrace / renderUsage`
- 事件行语义（`tool.input` 先于其触发的 unit span、`tool.output` 后于它）
- 四类标识符 `UNIT_ICO = { tool:'⚙', skill:'◆', prompt:'¶', subagent:'⊕' }` + `unitTypeOf`
- LIFO 工具配对（`pending` 栈）**不迁移** —— 那是模拟脚本回放器的职责，属 host 侧

**导出形态**：

```js
export function createTraceView(rootEl, opts = {}) {
  // opts: { onUsage(acc), price: {input, output}|null }
  return { reset, start, end, event, finish, render, usage };
}
```

**Step 3**：CSS 迁移
- Create: `packages/trace-view/src/trace-view.css`（把 `global.css` 里 `.tr-*` 段整体搬出）
- Modify: `packages/website/src/styles/global.css`（删除 `.tr-*` 段，改引包 css）

**Step 4**：验证（Phase D 完成后才有视觉回归）—— 本任务只要求 `npm run typecheck` 不炸。

---

### Task B3：`playTrace(view, trace)` 归一（Trace → 视图指令）

**Objective**：真实 `Trace.spans[]` 驱动渲染器。这是「同一份渲染、两种数据源」的桥。

**Files**：
- Create: `packages/trace-view/src/fromTrace.js`

**算法**（关键：全局时间线 + 稳定 tie-break）：

```js
/** 把框架的 Trace.spans[] 归一成渲染动作序列，按时间线性化喂给 view。
 *  tie-break：同一毫秒内 start 先于 event 先于 end —— 保证 tool.input 落在
 *  它所属 turn 打开之后、turn 收尾之前。 */
export function playTrace(view, trace) {
  const items = [];
  for (const s of trace.spans) {
    items.push({ t: s.startedAt, ord: 0, s, kind: 'start' });
    if (s.endedAt != null) items.push({ t: s.endedAt, ord: 2, s, kind: 'end' });
    for (const ev of s.events || []) items.push({ t: ev.time, ord: 1, s, kind: 'event', ev });
  }
  items.sort((a, b) => a.t - b.t || a.ord - b.ord);
  // run 根必须最先开：把 root 的 start 提前
  // （下接：按 kind 分派到 view.start/end/event，最后 view.finish(trace.totalUsage)）
}
```

**Step 2**：单测

**Files**：Create `packages/trace-view/test/fromTrace.test.js`

用一个手写 fixture Trace（含 run 根 → llm.turn → subagent unit → 内部 llm.turn + tool.input/tool.output）断言：
- 动作顺序：`root.start` 最先；`tool.input(turn)` 在对应 turn 的 `start` 之后、`tool.output` 之前。
- `unitTypeOf` 从 span.name 前缀取到正确类型。
- `finish` 收到 `trace.totalUsage`。

Run: `cd packages/trace-view && npm test`
Expected: PASS

**Step 3**：提交

```bash
git add packages/trace-view
git commit -m "feat(trace-view): 抽共享调用树渲染器 + Trace 归一"
```

---

## Phase C —— CLI inspector

### Task C1：inspector HTTP 服务

**Files**：
- Create: `packages/cli/src/inspector.ts`

**接口**（node:http，零依赖）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 面板页面（HTML） |
| GET | `/api/runs` | run 摘要列表（id/name/status/ms/usage） |
| GET | `/api/runs/:id` | 单次 run 的完整 Trace JSON |
| GET | `/trace-view.js` `/trace-view.css` | 静态资源（从 `dist/inspector/` 读） |
| POST | `/ingest` | 接收 preload 侧 sink 投来的 Trace，入环形缓冲（默认 50 条），广播 SSE |
| GET | `/stream` | SSE：新 run 到达时推摘要，页面自动刷新列表 |

**验证**：`packages/cli/test/inspector.test.mjs` —— 起服务 → POST /ingest → GET /api/runs 含该 run → GET /api/runs/:id 返回完整 trace。

---

### Task C2：dev 命令挂钩 + 注入器

**Files**：
- Modify: `packages/cli/src/dev.ts`
- Create: `packages/cli/src/inspector-sink.ts`（HTTP POST sink，CLI 自有）
- Create: `packages/cli/src/inspector-preload.ts`（从 cwd 解析框架 → registerDefaultTraceSink）

**改动**：
1. 起 inspector 服务，拿到端口。
2. Node 版本探测（`--import` 可用性）；不支持则打印明确提示。
3. spawn 时注入 env：
   `{ ...process.env, AGENTIA_INSPECT_PORT: String(port), NODE_OPTIONS: merge(existing, '--import ' + pathToFileURL(preload).href) }`
4. 打印 `Inspector: http://127.0.0.1:<port>`（沿用现有 stdio:inherit + 信号转发）。
5. 子进程退出 → 关闭 inspector 服务。

**preload 关键点**：

```js
const req = createRequire(join(process.cwd(), 'package.json'));
const entry = req.resolve('@migor/agentia');       // 必须从【用户项目】解析，保证与应用同一实例
const mod = await import(pathToFileURL(entry).href);
mod.registerDefaultTraceSink(createInspectSink({ port: Number(process.env.AGENTIA_INSPECT_PORT) }));
```

失败要**静默降级**（面板没挂上不能阻断 dev），但打印一行 `[agentia] inspector 未挂载：<原因>`。

---

### Task C3：面板页面 + 构建集成

**Files**：
- Create: `packages/cli/src/inspector-page.html`（左栏 run 列表 / 右栏调用树，深色，`<script type="module">` import `./trace-view.js`）
- Modify: 根 `package.json` scripts：`build:cli` 追加 trace-view 产物拷贝到 `packages/cli/dist/inspector/`

**拷贝逻辑**（node 脚本，零依赖）：
```
packages/trace-view/dist/{view.js,index.js,fromTrace.js,trace-view.css}
  → packages/cli/dist/inspector/
```

**验证**：`npm run build:cli` 后 `search_files packages/cli/dist/inspector` 三个文件在位。

---

### Task C4：端到端验证（真实浏览器）

**Step 1**：`npm run typecheck && npm run build && npm run build:cli && npm test && npm run e2e` → 全绿

**Step 2**：造一个样例项目（`scripts/e2e-cli.ts` 已会脚手架 + mock run），`agentia dev` 起面板，用真实浏览器打开 → 断言：
- run 列表出现该 run；
- 调用树含 run 根 / llm.turn / unit / tool 事件行；
- 面板零横向溢出（`clientWidth == scrollWidth`）。

**Step 3**：提交

```bash
git add packages/cli
git commit -m "feat(cli): agentia dev 内置 inspector 面板"
```

---

## Phase D —— 官网改用共享渲染器

### Task D1：playground.js 去重

**Files**：Modify `packages/website/src/scripts/playground.js`
- 删除已迁移的渲染函数，改为 `import { createTraceView } from '@migor/trace-view'`；
- 保留：场景脚本、模拟回放引擎（含 LIFO 配对）、终端面板（`panelThink/panelTool/...`）；
- `window.AgentiaPlayground` 暴露面**保持不变**（`playground-real.js` 不受影响），内部改为转发到共享 view。

### Task D2：playground-real.js 去重
同款：删掉本地 trace 渲染转发，直接调共享 view（`traceStart/traceEnd/traceEvent/traceFinish` 语义不变）。

### Task D3：CSS 去重
`global.css` 里 `.tr-*` 段删除，改为 `@import '@migor/trace-view/style.css'`（Astro 处理）。

### Task D4：构建 + 线上验证

Run: `npm run build:website && npm run deploy:website`
线上实测（真实浏览器，三场景）：
- 树形、事件顺序、四类标识符与当前一致（**回归**）；
- 零横向溢出；
- bundle 里无重复渲染器（`tr-ev` 只应出现在共享产物里）。

---

## 最终验收（全部 Phase 完成后）

| 项 | 命令 | 期望 |
|---|---|---|
| 框架 | `npm run typecheck && npm run build && npm run build:cli && npm test && npm run e2e` | 全绿 |
| 新包 | `cd packages/trace-view && npm test` | PASS |
| CLI | `packages/cli/test/inspector.test.mjs`（并入 `npm test` 或独立跑） | PASS |
| 官网 | `npm run build:website` | 成功 |
| 线上 | 真实浏览器跑 playground 三场景 + dev inspector | 树形/事件/标识正确，零溢出 |
| 文档 | `docs/spec.md` §10 有决策记录；`roadmap.md` 状态更新 | 已同步 |

## 风险与回退

| 风险 | 回退 |
|---|---|
| Node <20.6（`--import` 不支持） | `dev.ts` 版本探测后**明确提示**（不静默）；文档给降级路径（升级 Node，或手动 `registerDefaultTraceSink`） |
| preload 解析到的框架与 app 不是同一模块实例 | preload 强制从 `process.cwd()` 解析；dev 启动时断言注册已生效（探测一次，失败则告警） |
| 渲染器抽取后官网视觉回归 | Phase D 最后做，且线上逐项比对；出问题可先只上 Phase A–C（本地面板独立可用） |
| 无全局 `fetch` 的 Node（18.0–17 末） | `inspector-sink.ts` duck-type：无 `fetch` 时降级 `node:http.request` |
