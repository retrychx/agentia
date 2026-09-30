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
| `scripts/tb_task_to_harbor.py` | Python | Terminal-Bench 原生任务 → Harbor 任务（数据集后端不可达时的替代路，见第八节） |
| `scripts/container-install-runtime.sh` | sh | 容器内备好运行时：node（apt → 静态包兜底）+ `ca-certificates` + TLS 自检 |

⚠️ **这个包没有发布到 registry** —— `npm i @migor/agentia-terminal-bench` 会 **404**
（`"private": true`）。它是**示例**，不是框架的发布面；拿到它的方式是**把
`examples/terminal-bench/` 整个目录拷走**（`package.json` 里 `@migor/agentia` 写的是
`file:../..` —— 本仓示例的统一约定，见 [`examples/README.md`](../README.md) 的「依赖」一节）。

---

## 一、前置：它现在能不能跑

**能跑，而且已经真跑过**（真容器 trial 跑过多次，坑与读数见下文「跑出来的坑」）。
之前这里写着「跑不了」，因为当时找不到 Docker —— 后来发现是 **OrbStack** 在提供
docker CLI，只是不在默认 PATH 上：

```bash
export PATH="$HOME/.orbstack/bin:$PATH"     # ← 关键：不加这句 Harbor 会报「没有容器后端」
docker version --format '{{.Server.Version}}'   # 实测 29.4.0
```

⚠️ Harbor 的 `-e apple-container` 这条备选**在这台机器上不通**：它的 `preflight()`
要求 `platform.machine() == "arm64"`，本机是 **Intel x86_64**（`Core i7-1068NG7`），
会直接 `SystemExit`。用 docker（OrbStack）这条路。

还需要两样：

1. **模型 API key**。DeepSeek 就够（见第三节，端点已实测可达）；`DEEPSEEK_API_KEY`
   用 `--ae` 透传进容器。Harbor 不会替你出这份钱。
2. **两份构建都要做**。① 容器里 vendor 的是**工作区里构建好的框架**（见第六节第 1 条）
   ⇒ 先在仓库根 `npm run build`，否则 install 阶段会直接报错；② Harbor **上传**的是**这个示例自己的**
   `examples/terminal-bench/dist/` ⇒ 在示例目录里再 `npm run build`。
   **改了示例源码就必须重建第二份** —— 漏了不报错，只会静默跑旧代码（第六节第 1 条有实测）。

跑一次是这一条（`-a` 给的是 `模块路径:类名`，模块要能被 Harbor 进程 import）：

```bash
cd examples/terminal-bench
npm install && npm run build

export PATH="$HOME/.orbstack/bin:$PATH"
PYTHONPATH="$PWD" harbor run \
  -d terminal-bench@2.0 \
  -a harbor_agent:Agentia \
  -m anthropic/claude-opus-4-1 \
  -n 4 -k 5 \
  --timeout-multiplier 4 \
  --ae ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

`-k 5` 是 Terminal-Bench 的规矩（同任务跑 5 次取平均，分数带 ±），别只跑 1 次。
**先拿单个任务验证链路**再上全套（`-t <task>`，或 `-p <本地任务目录>`）——
一次真容器 trial 是 **5–12 分钟**量级，失败模式下这个成本要乘以次数。

⚠️ **`--timeout-multiplier` 是必需品，不是调优项 —— 而且只设 setup / build 那两项是漏的。**
每个任务自带 `[agent] timeout_sec`（官方 sample 全是 **900s**），而容器里要现装 node、
出网时快时慢，900s 常常不够。实测踩过：命令里写了
`--agent-setup-timeout-multiplier 4 --environment-build-timeout-multiplier 4`，
**就没写 agent 执行那项** ⇒ qemu 两题的 agent 照旧撞 **900s 硬墙**（`AgentTimeoutError`），
看着像「agent 太慢」，其实是这一项压根没乘。⇒ **直接给基数 `--timeout-multiplier 4`**
（它同时乘 agent / verifier / setup / build 四路）；只有要单独调某一项时才用单项 flag。

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
| `AGENTIA_MAX_ITERATIONS` | 循环上限，缺省 **200**（**别退回框架缺省的 40**，见 §六 坑 6） |

⚠️ **单价这一步不能省。** 框架内置价格表只有 `claude-*`
（`src/engine/usage.ts` 的 `DEFAULT_PRICING`），所以不给 `priceOverrides` 的话
DeepSeek 的成本**恒为 0** —— ATIF 的 `final_metrics.total_cost_usd` 会变 0，
「每任务花多少钱」这一维直接废掉，而且**没有任何报错**（框架只在 llm.turn 上记
`usage.unpriced` 事件，是给你查的，不拦你）。缺省值取自框架文档里的 DeepSeek 示例
（`{ in: 0.27, out: 1.10 }`），**不是权威报价**，发榜前请以官方定价为准或用 env 覆盖。

端点可达性已实测：`curl https://api.deepseek.com/models` 返回
`Authentication Fails`（= 到了，只是没 key）。**key 不落进仓库** ——
env / 钥匙串里都没有 `DEEPSEEK_API_KEY`，试跑时用
`--ae DEEPSEEK_API_KEY=...` **逐次从命令行传入**（见 §五），不进任何文件。

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

## 六、几个容易踩的坑（都是跑出来的，不是读出来的）

**1. 为什么有两份 package.json，以及为什么容器里不 `npm install`。**
`package.json` 的 `@migor/agentia` 是 `file:../..`（本仓示例的统一约定：跑工作区代码），
但**容器里没有工作区**，这个依赖装不上 ⇒ 多一份 `container-package.json` 充当容器侧的清单
（只要 `type: module`，让 `dist/run.js` 被当 ESM 解析）。

那容器侧怎么拿到框架？**不是联网装，是搬进去。** 这一点是踩了两次才定的形：
一开始 `container-package.json` 写 `"@migor/agentia": "0.10.0"`，让容器 `npm install` ——
连续两次栽在同一处：任务镜像没 node ⇒ `npm install` exit 127；补上 node 之后，
`npm install` 去 registry 拉包又 `ERR_SOCKET_TIMEOUT`（容器出网时快时慢）。
而 Harbor 把这两种都报成同一个 `NonZeroAgentExitCodeError` ——
**看着像 agent 崩了，其实还没走到 agent**。

但框架是**零运行时依赖**（根 `package.json` 没有 `dependencies`）：
`npm install --omit=dev` 唯一要拉的，就是框架本体。既然如此就没有「装」这回事 ——
`harbor_agent.py` 把工作区里**构建好的** `dist/` + `package.json` 按发布态布局
直接铺进 `/installed-agent/agentia-tb/node_modules/@migor/agentia/`，**全程离线**，
`npm` 这个依赖整个去掉。装完还会跑一句**装载自证**（`import('@migor/agentia')`），
让「包搬坏了」当场在 install 阶段报出来，而不是十分钟后再伪装成 agent 失败。

⚠️ 代价：vendor 的是**当前工作区**的构建产物，不是 registry 上那份 tarball。
所以前缀是「先在仓库根 `npm run build`」（或用 `AGENTIA_PKG_ROOT` 指过去）。
要复现某个**已发布版本**的分数，先 `npm pack @migor/agentia@<版本>` 解开、
`AGENTIA_PKG_ROOT` 指过去，别拿工作区当基线。

⚠️⚠️ **是两份构建产物，别只构建一份 —— 而且改完源码必须重建示例那份。**

| 构建 | 命令 | 产出 | 谁用它 |
|---|---|---|---|
| 框架 | 仓库根 `npm run build` | 根 `dist/` | `harbor_agent.py` **vendor 进容器**（`AGENTIA_PKG_ROOT` 指这里） |
| **适配器** | `examples/terminal-bench` 的 `npm run build` | `examples/terminal-bench/dist/` | `harbor_agent.py` **上传的入口**（`PROJECT_DIR/dist` ⇒ 容器里跑的就是它） |

**第二份最容易被漏，而且漏了不报错。** 实测踩过：改了 `src/run.ts` 的循环上限，
`dist/run.js` 却停在 3 小时前 —— 直接重跑 Harbor，容器里执行的**还是旧代码**，
一轮评测白跑，且**没有任何报错**（Harbor 只看到「跑完了、reward=0」）。

而 `dist/` 在 `.gitignore` 里（第 2 行 `dist/`），所以**「提交完就完事」也不成立** ——
构建产物从不入库。**判据：每次评测前先 `npm run build`，并确认
`grep -c maxIterations dist/run.js` 不为 0 这类「改没进去」的探针通过。**

**2. 长驻 bash 会让 node 不退出 —— 而「收了会话」只是这个坑的一半。**
会话是长驻的 `bash` 子进程 ⇒ node 事件循环永不空 ⇒ 命令早跑完了进程也不退出，
Terminal-Bench 侧的表现是「agent 一直挂着直到超时」。
所以入口写完 ATIF 后必须调 `closeShellSessions()`（第一次跑自检时就被这个坑卡住过）。

⚠️ **另一半是实测第三轮才踩到的**：agent 用 `&` 起的后台进程（`qemu-startup` 里是
`qemu-system`）是 bash 的**孙进程**，同样继承着那组管道 ⇒ **`SIGKILL` 掉 bash 之后，
我们这端照样读不到 EOF** ⇒ `ChildProcess` 句柄一直「活着」⇒ 进程还是不退。

实测形态（这轮读数里最伤人的一条，因为**它把成功记成了失败**）：

| 证据 | 值 |
|---|---|
| 轨迹末步 | 第 35 步是**收尾总结**（"Everything is verified and running…"）、**无待执行工具调用** |
| ATIF | 已落盘、`final_metrics` 齐全 ⇒ `app.run()` **确实返回了** |
| 末步时间戳 | `12:26:48Z`；进程直到 `13:13` 才被杀 ⇒ **空转 47 分钟** |
| Harbor 判定 | `AgentTimeoutError: timed out after 3600.0 seconds` |
| 附带伤害 | `--timeout-multiplier` 调大**只会让空转更久**（900s 墙被抬成 3600s） |

⇒ 两处一起补：`ShellSession.close()` 连**管道一起收 + `unref`**；两个入口在收尾后**硬退**。
**判据**：看到 `AgentTimeoutError` 先别归因「agent 太慢」——去看轨迹**末步是不是收尾总结**；
是，就是进程不退，不是慢。

**3. `node --input-type=module -e` 不按 cwd 解析裸名。**
想验证「包装没装上」，直觉是敲一句 `node --input-type=module -e "import('@migor/agentia')…"`。
**不行**：这么写报 `Cannot find package '@migor/agentia' imported from /…/[eval1]`，
看着像「没装上」，其实只是 `-e` 的 ESM 解析不吃 cwd。**写成文件**（且文件要落在
有 `node_modules` 的那个目录里）才解析得到。自证那句因此是 `printf … > .loadcheck.mjs`。

**4. ⚠️ 装了 node ≠ 能 HTTPS：镜像可能没装 `ca-certificates`（最阴的一个坑）。**
Ubuntu/Debian 的 nodejs 走**系统根证书库**，而任务镜像可能**压根没装 `ca-certificates`**
⇒ 一个可信根都没有 ⇒ **任何 TLS 都报 `SELF_SIGNED_CERT_IN_CHAIN`**。

实测对照（同一台机器、同一个 key、同一批任务）：

| 镜像（官方 `terminal-bench-sample@2.0`） | `ca-certificates` | fetch DeepSeek | 结果 |
|---|---|---|---|
| `regex-log`（ubuntu:24.04） | **没装**（0 个 PEM、无 openssl） | 0/5 全败 | agent `stop=error error=connection`，**0 token**，reward=0 |
| `polyglot-c-py` | 没装 | 0/5 全败 | 同上 |
| `log-summary-date-ranges`（debian:12） | `20230311+deb12u1`（142 个 PEM） | 5/5 通 | 任务**做对**，reward=1 |
| `chess-best-move` | 有 | 5/5 通 | reward=1 |

**因果是分步实测出来的**：只装 nodejs 时 → `SELF_SIGNED_CERT_IN_CHAIN`，且
`/etc/ssl/certs/ca-certificates.crt` **不存在**；补装 `ca-certificates` 后同一句变成
`HTTP 401`（TLS 通了，401 只是没给 key）。

**危害不在于失败，在于它长得像「agent 不行」**：0 token 的 trial 会被算进平均分。
⇒ `scripts/container-install-runtime.sh` 做两件事：① 缺 `ca-certificates` 就补装；
② 末尾对**模型真正要用的端点**做 TLS 自检，**不过就非零退出** —— 让 Harbor 记成
基础设施异常（exception 桶），而不是伪装成 agent 的 0 分。

⚠️ **由此得出的一条通用判据**：任何「装完不算完」的步骤，都要在末尾加一句
**用真实用途去探**的自证（这里是「能不能按裸名 import」+「能不能 TLS 握手」）。
自证不许写「我认为它能行」。

**5. ⚠️ 「0 分」还有第二种来源：验证器自己没跑起来（官方任务上实测，比坑 4 更隐蔽）。**
上面那条讲的是 **agent 侧**——连不上模型，0 token。**验证器侧**另有一类，翻车在两轮官方
`terminal-bench-sample` 的 qemu 两题上（镜像都是 Debian bullseye）：

官方任务自己的 `tests/test.sh` 开头就是 `apt-get update && apt-get install -y curl expect`，
再用 `curl -LsSf https://astral.sh/uv/… | sh` 装 uv，最后 `uv run pytest`。**今天 Debian
bullseye-security 的池子 404** ——

```
E: Failed to fetch …/libnghttp2-14_1.43.0-1+deb11u3_amd64.deb  404  Not Found
E: Failed to fetch …/libcurl4_7.74.0-1.3+deb11u16_amd64.deb    404  Not Found
E: Failed to fetch …/curl_7.74.0-1.3+deb11u16_amd64.deb        404  Not Found
```

⇒ curl 装不上 ⇒ 紧接着 `uv: command not found` ⇒ **pytest 从头到尾没被执行**，
`test.sh` 末尾照样写 `reward.txt = 0`。

**它跟「agent 答错」在结果文件上长得一模一样**（都是 `reward=0`、都烧了 token），
**只有翻开 `verifier/test-stdout.txt` 才分得开**：里面是 `command not found` / apt 报错，
而不是断言失败。

⇒ **通用判据：任何一个 0 分，先看 `verifier/test-stdout.txt` 末尾。**

| 末尾长什么样 | 含义 | 能不能计入能力 |
|---|---|---|
| `FAILED ../tests/…` + 具体 `AssertionError` | 断言真跑了、真没过 | ✅ 真答错 |
| `curl: command not found` / `uv: command not found` / apt 报错 | 验证器没跑起来 | ❌ 假红，不可计入 |

两轮实测（`-k 1`）：`qemu-startup` / `qemu-alpine-ssh` **两轮都是第二类**，同一处 404。
⇒ 10 题里 2 题不可用；诚实的分母是 **可用 8 题**（4 解 / 4 未解 ⇒ 0.500），
而不是面值 10 题的 0.400。这类失败**换台机器、换一天就可能变**（是镜像源状态，不是被测对象），
写榜必须标注。

⚠️ 但这 4 条「未解」还要再分 —— 其中有的是被**循环上限掐断的**（不是答错），见下一条。

**6. ⚠️ 第三种「看着像 agent 不行」的来源：循环上限把长程任务掐死在半路。**
框架的缺省循环上限是 **40**（`src/engine/run-config.ts` 的 `DEFAULT_MAX_ITERATIONS`），
**这对典型用途没问题，对 Terminal-Bench 太紧** —— TB 的任务是长程的。

实测证据（官方 `terminal-bench-sample`，`-k 1`，看**每条轨迹的步数与末步形态**）：

| 步数 | 末步 | 任务 | reward |
|---|---|---|---|
| **41** | **还带 `tool_calls`**（答到一半） | build-cython-ext、qemu-alpine-ssh、qemu-startup | 0 |
| 6 / 13 / 20 / 25 | 干净收尾 | log-summary-date-ranges、regex-log、fix-code-vulnerability、sqlite-with-gcov | **1** |
| 17 / 18 / 21 / 35 | 干净收尾 | polyglot-c-py、configure-git-webserver、chess-best-move | 0 |

**步数恰好到 41 的轨迹，末步都还没收尾；所有做对的都在 40 步以内。** 没有一条超过 41 ——
这是天花板，不是巧合。

⚠️ **但当时那张表把「干净收尾」读成了「真答错」—— 这一条被复跑直接证伪。**
上限抬到 200 后重跑，后来又跑了第三轮（多了「自检修好」与「超时 ×4」两处改动）：

| 任务 | ① 上限 40 | ② 上限 200 | ③ 上限 200 + 超时 ×4 | ④ `-k 5` 干净读数 | 差在哪 |
|---|---|---|---|---|---|
| `build-cython-ext` | 41 步、**被掐**、末步带 `tool_calls`、0 | 66 步干净收尾、**10 过 / 1 败**、0 | 45 步干净收尾、**11 过**、**1** | **0/4** | 上限是第一因；但 ③ 那个 1 是**环境顺**（测试里的 GitHub clone 通了），不是能力 |
| `chess-best-move` | 35 步、0 | 79 步、1 | 81 步、1 | **3/4** | 胜出那条路要 79 步（>40 必被掐）；① 的 35 步是**另一条走歪的路** |
| `configure-git-webserver` | 21 步、0 | 23 步、1 | 44 步、1 | **1/2**（另 3 条验证器死） | 样本不够，**这一题不该下结论** |
| `polyglot-c-py` | 18 步、0 | 17 步、0 | **15 步、1** | **0/5** | 前两轮都错、第三轮过了 —— ③ 那次是**偶然做了清理**，见下 |
| `regex-log` | 13 步、1 | 37 步、1 | 37 步、1 | **4/4**（另 1 条验证器死） | 一直答对，但路径长度差近 3 倍 |

⇒ 三条教训（第二版；**第一版把「两次跑出 5/10 与 8/10」归因成「运行间方差 ≈ ±3 题」，归错了**）：
① 上限抬高确实**能**解锁 —— `build-cython-ext` 从「掐死在 41 步」变成「答完」，
`chess-best-move` 那条 79 步的路在旧预算下**必然**被掐。这条成立。
② **但轮间起伏的主因是环境窗口，不是采样。** ④ 把每题的 5 次并排放出来后看得见：
`polyglot-c-py` **0/5**、`build-cython-ext` **0/4**，而 ③ 那一轮这两条各拿到一个 1
⇒ ③ 是「幸运抽样 + 环境顺」。用同一判据回看四轮的可计面：
**0.500 / 0.714 / 1.000 / 0.767** —— 起伏主要来自**网络**（验证器的自举与 fixture 都要外网，见坑 5 / 坑 8）。
③ 所以 **`-k 1` 的单轮数字既不能用来比 harness，它的方差也不能用来估「agent 方差」**；
要出可比数字就按 §一 的 `-k 5`，且**同窗口**跑（把网络这一个共同变量按住）。

⚠️ **`polyglot-c-py` 的教训值得单列**（它是这 10 题里唯一在 `-k 5` 下**稳定真败**的）。
断言是「工作目录里**只有** `main.py.c`」，而 5 条 trail 全部留下了自测用的编译产物
（`cmain`、`cmain_strict`、`t.c`、`err.txt`、`__pycache__`）；
③ 那次过的唯一原因，是它的**最后一步恰好是** `cd /app/polyglot && rm -rf __pycache__ && ls -la`。
⇒ **差的是「收尾前清理自己造的东西」这条纪律，不是能力。** 这一条对任何 harness 都成立
（mini-swe 在 `-k 5` 下错在**同一断言**、同一原因：`found: ['main.py.c', 'cmain']`）。

危险点：撞上限时框架**做的是对的** —— 如实置 `stopReason='max_iterations'` 并带结构化
`error`（`src/engine/loop.ts`），但 **Terminal-Bench 只读 `reward.txt` ⇒ 记成 0**，
在榜上与「模型答错」**无从区分**。

⇒ `src/run.ts` 因此**显式**抬高到 **200**（`AGENTIA_MAX_ITERATIONS` 可覆盖），并在代码里写明缘由。
**这是配置问题不是框架缺陷**：框架的语义是「到点就停并如实报告」，缺省 40 对典型 agent 够用；
是**适配器**该按目标任务的时长来定这个值。

⚠️ 判据（与坑 5 并列）：**读数先分桶，再分列**；而且**逐条判、别按题取并集**。
⚠️ 后者是踩过的：把「本题里有一条假红」取成「本题是假红」，等于把环境问题记成 agent 不会做。

逐条 trial 按**这个顺序**判，先命中先算（可复算的实现：`python3 .workbuddy/probes/tb-job-buckets.py <job_dir>`）：

1. **`result.json` 的 `exception_info` 非空 ⇒ 不进能力分母。** 这一桶里再分：
   `NonZeroAgentExitCodeError` 且 message 是 install 那句命令 ⇒ **还没到 agent**（坑 7）；
   `AgentSetupTimeoutError` / `NetworkConnectionError` ⇒ 装自己那步的网络问题（坑 7）；
   `AgentTimeoutError` ⇒ 先看轨迹**末步是不是收尾总结**（坑 2 —— 是，那就是做完不退）。
2. **否则看 `verifier/test-stdout.txt` 里有没有 pytest 形态的断言证据**
   （`N passed` / `N failed` / `PASSED` / `FAILED`）：
   - **有** ⇒ 这条**可计**，`reward` 才算数（真过 / 真败，下一步再分）；
   - **没有，且**输出里有 `command not found` / `Unable to fetch` / SSL 报错 ⇒ **验证器假红**（坑 5 / 坑 6）；
   - **没有，也没有**自举失败痕迹 ⇒ 记 `no-evidence`，**得人看**，别当 0 用。
3. ⚠️ **「可计」不等于「可归因于 agent」** —— 断言跑了、也真 assert 了，**失败根源仍可能是环境**（坑 8）。
   形态是 error 里出现 clone / fetch 失败，而不是「交的东西不对」。

**7. ⚠️ 第四种：还没到 agent 就挂了（install 阶段）。**
坑 4 讲的是「装完 node 连不上模型」，坑 5 讲的是「验证器没跑起来」。这一条是
**中间那段**——运行时装不上、自检自己出错。它们的共同外观：

`result.json` 里 `exception_info.exception_type = NonZeroAgentExitCodeError`，
而 message 那句命令一眼能认出是 install：

```
cd /installed-agent/agentia-tb && sh .install-runtime.sh && … node .loadcheck.mjs
```

**判据：message 是这句 ⇒ 与 agent 能力无关，整条剔出分母**（别去读轨迹，那里面什么都没有）。
同一轮实测撞到两种：

| 形态 | 日志里长什么样 | 根因 |
|---|---|---|
| apt 装 nodejs 撞 404 | `E: Failed to fetch …/libnghttp2-14…deb 404`，回退静态包后 `attempt 1/2/3 failed: … handshake timed out` | 与坑 5 **同一处** bullseye-security 404，只是这次打在了 agent 侧（容器里连 node 都还没有） |
| TLS 自检探错端点 | `[runtime] TLS self-check: https://api.anthropic.com/v1/models` → `FAILED after 3 tries: ECONNRESET` | 适配器自己的 bug，见下 |

第二条**是适配器的 bug，已修**。自检的本意是「打本次真正要用的那个端点」，可它读的是
**宿主进程**的 `os.environ`；而 README 推荐的跑法用 `--ae DEEPSEEK_API_KEY=…`，
这个 key 只落在 **agent 的 `extra_env`** 上 ⇒ 宿主读不到 ⇒ **静默**回落到 Anthropic 的端点。
代价实测：一轮 10 条里 2 条被记成异常，其中一条是本该算数的已解出任务；
而且它长得像「机器抽风」，不翻 install 日志根本看不出来。

修法就是按 Harbor 自己的优先级取（`extra_env` 覆盖 `os.environ`，与 `BaseAgent._env_sources()` 一致）。

⇒ **通用教训：凡是「按环境变量决定行为」的代码，先问一句「这个变量在这一层看得见吗」。**
`--ae` 注入的 key 在 agent 层，不在宿主层；读错层**不报错**，只会静默走错分支 ——
这类 bug 的代价不是崩溃，是**悄悄换掉被测对象**。

**8. ⚠️ 第五种：验证器的「测试」自己要外网（五种里最隐蔽的）。**

这一种和坑 5 / 坑 6 都不一样：**验证器跑起来了、pytest 汇总行也印了、断言也真的 assert 了**，
只是失败的根因在测试自己的 fixture 里。

实例：`build-cython-ext` 的 `test_pyknotid_repository_tests` 会先
`git clone --depth 1 --branch 0.5.3 https://github.com/SPOCKnots/pyknotid.git <tmp>`，
再去跑 `<tmp>/tests`。网络差时 clone 没下来 ⇒ pytest 报
`ERROR: file or directory not found: /tmp/tmpXXXX/tests` ⇒ `returncode 4` ⇒ 断言失败、`reward` 0。
光看「断言跑没跑」是分不出来的（汇总行长得完全正常）。实测一轮 `-k 5` 里 4 条全栽在这上面，
而**同样配置的前一轮它 11/11 全过**。

**判据：error 文本里出现 clone / fetch / 拿不到目录（而不是「交的东西不对」）⇒ 剔出能力分母。**
⚠️ 别把「失败的事实」和「失败的原因」混起来：
`returncode 4`（用法错 —— 目录根本不存在）与 `returncode 1`（测试真的没通过）是**两件事**，
实测那一轮两个 harness 在同一题上恰好各中一个，不细看就会读成「两边都败」。

**同一窗口下两个 harness 的 `-k 5`（10 题 × 5 次，`deepseek-chat`）**

| | `agentia` | `mini-swe-agent` |
|---|---|---|
| **走到真验证器的 trial** | **34 / 50 = 0.680** | **15 / 50 = 0.300** |
| 面值（Harbor 报的 Mean） | 0.460 | 0.220 |
| 可计面（只算验证器真跑过的） | 0.676（23/34） | 0.733（11/15） |

- **唯一可测量的差异是「存活率」**：34/50 vs 15/50，Fisher 精确检验 **p = 0.00027**。
- **能力上测不出差异**：可计面 0.676 vs 0.733 ⇒ **p = 0.75**；
  再剔掉 `build-cython-ext`（那题两边都没干净数据）⇒ 0.767 vs 0.846，**p = 0.70**。
- ⇒ **面值那 0.24 的差距全部来自存活率，不是谁更会做题。** 直接拿面值写榜会得出「agentia 强一倍」，是错的。
- 存活率差在哪：mini-swe **每条 trial 都要联网重装自己**（`curl astral.sh/uv | sh` + `uv tool install`），
  这轮网络差 ⇒ 13 条 `AgentSetupTimeoutError`（正文 `Agent setup timed out after 1440.0 seconds` ——
  **4 倍加成下 24 分钟没装完**）+ 12 条 `NetworkConnectionError` + 10 条 `NonZeroAgentExitCodeError`，共 35 条。
  agentia 侧是把 `dist/` + `package.json` 直接铺进容器的 `node_modules/`（**离线 vendor**）⇒ agent 阶段只 1 条异常。
- 两边**共同的真答错**只有 `polyglot-c-py`，且错在**同一断言、同一原因**（留下 `cmain`，见坑 6）。

⚠️ 这张表的价值建立在**同一个网络窗口**上 —— 那些网络型假红**同等**作用于两个 harness，
「可计面」这一列才可比。**换个窗口重跑面值会变，但这两列的结论不该变。**

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

## 八、拿数据集：`-d` 走不通时怎么办（本机实测）

`harbor run -d terminal-bench@2.0` 默认走 **Harbor Hub**（Supabase 后端，`registry/client/harbor/harbor.py`）。
本机这条链路**通不了**：

```
Dry run failed: Error getting dataset terminal-bench@2.0
```

排查结论（别急着当「网络抖动」重试，实测重试 5 次全败）：

- 端点 `https://hlqxxzsirfrgeqasvaps.supabase.co`（Cloudflare）在**宿主机与容器里都**握手失败：
  `[SSL: UNEXPECTED_EOF_WHILE_READING]`，裸 TCP 连得上、TLS 被 reset。
- 宿主机的 Bash 环境**强制走本地代理**（`HTTP(S)_PROXY=127.0.0.1:xxxxx`），代理对 github/raw 也是坏的；
  `git` 走 HTTPS 却**正常** —— 所以「curl 通不通」不能代表「git 通不通」。

⇒ 绕开它的路是 **`--registry-path`**（`RegistryClientFactory` 见 `registry_path` 就换本地 JSON 客户端，
不走 Supabase）。官方 registry 就是仓里那个文件：

```bash
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/laude-institute/harbor.git /tmp/harbor-repo
cd /tmp/harbor-repo && git sparse-checkout set --no-cone registry.json && git checkout HEAD -- registry.json

harbor download terminal-bench@2.0 --registry-path /tmp/harbor-repo/registry.json --export -o /tmp/tb-official
harbor run -p /tmp/tb-official/terminal-bench -a harbor_agent:Agentia -m deepseek-chat \
  --registry-path /tmp/harbor-repo/registry.json -d terminal-bench@2.0
```

实测（2026-09-30）：registry.json 有 **80 个数据集**；`terminal-bench@2.0` = **89 个任务**
（`laude-institute/terminal-bench-2`，pin 在 commit `69671fbaac6d`）；
`terminal-bench-sample@2.0` = **10 个**（`terminal-bench-2-0-sample` @ `7e917f35c281`）。
`harbor download` 10 个任务 16 秒、89 个 1 分 41 秒，**全程不用 docker**。

### 三条路，优先级从高到低

1. **`--registry-path`（首选）**：官方任务、官方镜像、官方 `test.sh`，分数可比。
2. **`scripts/tb_task_to_harbor.py`（替代路）**：`-d` 与官方 registry 都拿不到时，
   把 TB 原生任务（`task.yaml` + `Dockerfile` + `tests/`）转成 Harbor 任务。
   ⚠️ 转换会**改掉验证口径**，分数**不能**与官方榜并列（见脚本 docstring 与下方注意事项）。
3. `-d` 直连 Harbor Hub：本机不可用。

### 转换脚本的注意事项（都实测过，别照抄当等价）

- **构建上下文 = TB 任务根整份**，不是只有 Dockerfile：扫 236 个 Dockerfile 里有
  32 个 `COPY task-deps/`、18 个 `COPY tests/`，还有 `etc/ src/ resources/ data/`…
  TB 的 compose 没写 `context:` ⇒ 默认就是任务根。只搬 Dockerfile 会直接 build 失败。
- **WORKDIR 只在 Dockerfile 完全没写时才补 `/app`**：TB 基础镜像**自带** `WORKDIR=/app`
  （实测 python-3-13 与 ubuntu-24-04 都是），152/236 自带、84 个靠镜像默认。
  无条件追加会把任务自己的 WORKDIR（实测有 `/workspace`、`/home/alice`）顶掉。
- **verifier 不 `cd`**：TB 的 `run-tests.sh` 也不 cd，测试里的相对路径依赖容器 WORKDIR。
  官方任务的 `test.sh` 同样不 cd（读 `terminal-bench-sample` 确认）。
- **pytest 装进任务镜像**，不在 verifier 里现装：官方 `test.sh` 是
  `curl astral.sh/uv | sh` + `uv add pytest==8.4.1`（**要出网 + 要 curl**，两个基础镜像都没 curl）；
  转换版改在构建期分层兜底装（有 pip 走 pip 装 `pytest==8.4.1`，否则 apt 装 `python3-pytest`）。
  差半个 pytest 版本对断言无影响，但口径要写出来，别假装等价。
- **缺 pytest 时故意不写 reward**：让 Harbor 报 `RewardFileNotFoundError`（基础设施问题），
  而不是 `reward=0`（看着像 agent 做错了）。

---

## 九、下一步

1. 定 `-m`（同一模型才谈得上和其它 harness 比），先 `-t` 单任务、再 `-k 5` 取均值
   （TB 的规矩：同任务跑 5 次，分数带 ±）；
2. 全量：`terminal-bench@2.0` 89 个任务；`-n` 控制并发（本机 OrbStack 实测 `-n 3` 稳）；
3. 结果上传 / 提交 leaderboard 走 Harbor Hub（`harbor upload jobs/<name>`）——
   ⚠️ 上传走的是同一个 Hub，本机这条链路待验。
