# agentia × Terminal-Bench（Harbor）

把 agentia 接到 **Terminal-Bench** 上跑，并**原生输出 ATIF 轨迹**。

目录里两半，各管一件事：

| 文件 | 语言 | 职责 |
|---|---|---|
| `harbor_agent.py` | Python | Harbor 适配层：在任务容器里装好、跑起 agent（**没有一行 agent 逻辑**） |
| `src/run.ts` | TS | 真正的 agent：读指令 → 跑主 agent → 把 trace 直译成 ATIF 落盘 |
| `src/bash.ts` | TS | 执行面：一个**有状态**的 bash 会话（`cd` / `export` 跨调用保留） |
| `src/atif.ts` | TS | trace → ATIF v1.8 转换器（本例的核心） |
| `src/model.ts` | TS | 模型侧装配：端点 / 模型名 / 单价收在一处 |
| `src/selftest.ts` | TS | 离线自检：**不需要 Docker、不需要 API key** |
| `src/live-probe.ts` | TS | 真模型试跑（迷你 trial）：**不需要 Docker**，要 key |
| `scripts/verify_atif_schema.py` | Python | 用 Harbor 自己那份 `Trajectory` 模型校验产物 |

---

## 一、先说硬前置：它现在能不能跑

**在这台机器上跑不了**，缺两样东西。这是我实测出来的，不是猜的：

1. **容器**：Harbor 默认 `-e docker`，本机**没装 Docker**。
   备选 `apple-container` 也不通 —— 它的 `preflight()` 要求 `platform.machine() == "arm64"`，
   本机是 **Intel x86_64**（`Core i7-1068NG7`），会直接 `SystemExit`。
   ⇒ 四条路：装 Docker Desktop；装 **podman**（Harbor 有 `-e podman`，与 docker 同一套编排、
   换 CLI，但要 podman machine 起虚拟机，Intel Mac 上更绕）；云沙箱
   （`-e daytona` / `e2b` / `modal`，各需一个 API key）；或者**先不跑容器** ——
   用第四节的 `npm run live` 把链路真跑一遍。
2. **模型 API key**：环境里 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`
   **都没设**（钥匙串里也没有）。Harbor 不会替你出这份钱。
   DeepSeek 端点本身是通的（见第三节）。

装好之后，跑一次是这一条（`-a` 给的是 `模块路径:类名`，模块要能被 Harbor 进程 import）：

```bash
cd examples/terminal-bench
npm install && npm run build

PYTHONPATH="$PWD" harbor run \
  -d terminal-bench@2.0 \
  -a harbor_agent:Agentia \
  -m anthropic/claude-opus-4-1 \
  -n 4 -k 5 \
  --ae ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

`-k 5` 是 Terminal-Bench 的规矩（同任务跑 5 次取平均，分数带 ±），别只跑 1 次。

---

## 二、为什么是「原生出 ATIF」，这有什么不一样

ATIF（Agent Trajectory Interchange Format，RFC-0001，本仓对齐 **v1.8**）是 Harbor 的
统一轨迹格式。它的意义：**不管你跑的是 Claude Code、Codex CLI 还是自己手搓的 scaffold，
Harbor 都把轨迹收成同一个 JSON**，于是「换框架」第一次变得可比对。

多数适配器是**反推**的：跑完之后拿 stdout / `.jsonl` 去猜哪一步调了什么工具。
agentia 不一样 —— trace 本来就是一等公民（spec §9），工具入参 / 出参 / token / 成本
在**跑的时候**就已经按 span 记账好了，所以 `src/atif.ts` 是**无损直译**，不是重建。
同一份 trace 走 `createOtlpExporter()` 就是 OTel。

这对本项目特别划算：Terminal-Bench 只判「测试过没过」（reward 0/1），
而 ATIF 是**过程证据** —— 能回答「它真做对了，还是瞎猫碰上死耗子」。

---

## 三、用 DeepSeek —— 不需要新代码

agentia 自带的 `createOpenAIClient` 就是 **OpenAI 兼容端点**适配器
（`docs/usage-guide.md` §6.5 明写「DeepSeek 等」），所以接 DeepSeek 只换 `baseURL`，
**不新增依赖、不改 `src/`**：

```ts
createOpenAIClient({ apiKey, baseURL: 'https://api.deepseek.com' })
```

本例走 env（`src/model.ts`）：

| env | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 设了就走 DeepSeek；不设则走框架默认（Anthropic） |
| `DEEPSEEK_BASE_URL` | 覆盖端点，缺省 `https://api.deepseek.com` |
| `AGENTIA_MODEL` | 模型名，缺省 `deepseek-chat` |
| `AGENTIA_PRICE_IN` / `_OUT` | 覆盖单价（$/1M tokens），**成对给**才生效 |

⚠️ **单价这一步不能省。** 框架内置价格表只有 `claude-*`
（`src/engine/usage.ts` 的 `DEFAULT_PRICING`），所以不给 `priceOverrides` 的话
DeepSeek 的成本**恒为 0** —— ATIF 的 `final_metrics.total_cost_usd` 会变 0，
「每任务花多少钱」这一维直接废掉，而且**没有任何报错**（框架只在 llm.turn 上记
`usage.unpriced` 事件，是给你查的，不拦你）。缺省值取自框架文档里的 DeepSeek 示例
（`{ in: 0.27, out: 1.10 }`），**不是权威报价**，发榜前请以官方定价为准或用 env 覆盖。

端点可达性已实测：`curl https://api.deepseek.com/models` 返回
`Authentication Fails`（= 到了，只是没 key）。**key 本身本机没有**：
env 与钥匙串里都查过，没有 `DEEPSEEK_API_KEY`。

---

## 四、真模型试跑：不需要 Docker 的迷你 trial（`npm run live`）

官方 Terminal-Bench 要容器，但「把整条链路真跑一遍」**不需要容器**。
`src/live-probe.ts` 把 Terminal-Bench 的形状缩到最小：

1. 在 `/tmp/agentia-live-<时间戳>/` 预置 `data.txt`（乱序整数：7 10 3 1 42 9）；
2. 让 agent 用 shell **按数值**排序写进 `sorted.txt`（只按字典序排会把 10 排到 9 前 —— 故意设的陷阱）；
3. **读终态文件逐行比对** ⇒ reward 只有 0/1，与 Terminal-Bench 同口径
   （不读模型自称的「已完成」）；
4. 照常产 ATIF，可用 Harbor 的模型校验。

```bash
DEEPSEEK_API_KEY=sk-… npm run build && npm run live
```

输出 `reward=1` 才算「链路 + 任务」都成立；判 0 时脚本**退出码非 0**
（否则「跑完」会被误读成「做对」）。工作目录默认**保留**以便复查
（`AGENTIA_LIVE_CLEANUP=1` 才删）。

⚠️ **这不是沙箱**：真模型 + 本机真 shell，工作目录虽锁在临时目录，
但会话是长驻的，模型技术上可以 `cd` 出去。要真隔离请用容器。

---

## 五、离线自检（现在就能跑）

```bash
npm run build && npm run selftest     # 产 out/atif-sample.json
npm run verify:atif                   # 用 Harbor 的模型校验
```

第二步需要用**装了 harbor 的那个解释器**（harbor 的 venv 是 Python 3.12，和系统 3.13
的二进制扩展对不上，用 `python3` 会 `ModuleNotFoundError: pydantic_core._pydantic_core`）：

```bash
~/.local/share/uv/tools/harbor/bin/python scripts/verify_atif_schema.py
```

自检用框架的 `scriptedClient` 喂写死的模型响应，agent 会**真的**起一个 bash、
真的执行一条命令。它证明了三件事：

- `trace → ATIF` 的直译是对的（入参、出参、正文都在）；
- 产物过得了 Harbor **自己那份** `Trajectory` 模型（不是我们自己抄的 Schema）；
- 校验器不是摆设 —— 做过变异反向验证：step_id 跳号、悬空 `source_call_id`、
  多余根字段，三个变异各被精确判定非法，原文件通过。

**它不证明「agent 能完成任务」**。后者要真模型 + 真容器。别拿自检通过当跑分。

---

## 六、两个容易踩的坑（都是跑出来的，不是读出来的）

**1. 为什么有两份 package.json。**
`package.json` 的 `@migor/agentia` 是 `file:../..`（本仓示例的统一约定：跑工作区代码），
但**容器里没有工作区**，这个依赖装不上。所以多一份 `container-package.json`，
用**已发布版本号**，由 `harbor_agent.py` 在上传时替换成 `package.json`。

**2. 长驻 bash 会让 node 不退出。**
会话是长驻的 `bash` 子进程 ⇒ node 事件循环永不空 ⇒ 命令早跑完了进程也不退出，
Terminal-Bench 侧的表现是「agent 一直挂着直到超时」。
所以入口写完 ATIF 后必须调 `closeShellSessions()`（第一次跑自检时就被这个坑卡住过）。

---

## 七、已知边界

- **交互式命令会挂**（`vim` / `less` / 等 stdin）：靠超时兜底，超时后 SIGKILL 并**重建会话**
  ⇒ 工作目录会丢，这一步如实回给模型让它重新 `cd`。
- **工具 I/O 不截断**（`maxEventChars: false`）：轨迹要全文，`cat` 大文件会让 trace 到几 MB。
- `src/atif.ts` 里的 `tool.input` / `tool.output` **只能写字面量**：这两个是跨层契约常量，
  v0.10.0 收窄 exports 后不在公共出口上。上游一旦改名，这里会**静默归零**
  （过滤器匹配不上 = 「没有工具调用」）。要改先回源核 `src/core/trace.ts`。
- ATIF 的 `message` 只在 `traceContent: 'full'` 时有真值（框架缺省不记正文）。

---

## 八、下一步（要跑分还得做的事）

1. 装 Docker，或选一个云沙箱并给 key；
2. 给模型 key，定 `-m`（同一模型才谈得上和其它 harness 比）；
3. 先 `-t` 单任务跑通（`harbor run -t <task>`），再上全套 `-d terminal-bench@2.0`；
4. 结果上传 / 提交 leaderboard 走 Harbor Hub（`harbor upload jobs/<name>`）。
