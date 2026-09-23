# Changelog

本仓库两包（`@migor/agentia` 与 `@migor/cli`）版本同步发布。
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 SemVer
（0.x 阶段：minor 可含破坏性变更，每个破坏性变更都在对应版本的「迁移」小节里写明）。
决策的完整证据链在 `docs/spec.md` §10（带时间线的决策日志）。

## [Unreleased]

### 新增

- **模板 read-file 能力新增 `list_files` 工具**（与 `read_file` 同一个类、同一个 provider）：
  真用户反馈「面板上换了文件夹，agent 行为好像没变」—— 链路本身是通的（workdir 确实注入），
  缺口在**模型感知**：run 的 prompt 不变、菜单里没有「列目录」的工具，模型不知道自己在哪个
  目录、里面有什么，只能瞎猜文件名。`list_files` 输出的**第一行就是工作目录的绝对路径**
  （模型「知道自己在哪」的通道），目录名带 `/` 后缀，输出有上限（200 条）且截断**明示**；
  越界判定与 `read_file` 共用同一道闸（`safeResolve`）。零框架改动。
- **dev 面板新增「系统选择…」原生文件夹选择器**：浏览器拿不到所选目录的绝对路径，
  所以走 CLI 本机进程拉 OS 原生对话框（契约 `POST /api/fs/pick`），与既有的 `浏览…`
  文本/列表选择并存。客户端断开（刷新 / 关标签页）会收掉在飞的选择框（不留下
  「之后每次都 409」的后遗症）；macOS 的取消判定认错误码 `-128`（不随系统语言本地化），
  不认英文文案。

### 修复

- **面板刷新 / 关标签页后，「系统选择…」不再永久 409**：原来只靠连接断开（`res.on('close')`）
  收掉在飞的原生选择框，而实测（带插桩的产物副本 + 真浏览器）**刷新页面时那条连接还开着**
  —— 服务端收不到 close ⇒ 选择框留在桌面上没人看、之后每次点都报「已有一个文件夹选择框在等」。
  现在面板在 `pagehide` 时显式通知服务端（新端点 `POST /api/fs/pick/cancel`，`sendBeacon` 发的
  **一次新请求**，与服务端看不看得见断开无关），连接断开那条路**保留**作为兜底（进程直接没了 /
  非浏览器客户端断开仍走它）。两条路互补，各有一条确定性用例守着（`packages/cli/test/inspector.test.mjs`）。
- **复核残留修复一组**（无破坏性变更）：`refreshDev` / `refreshSession` 的失败不再静默
  （进可见通道）、徽标过滤失效 token、折叠键混入 sessionId 防张冠李戴、import 反向全覆盖
  扩到 trace-view 产物、`multiTurn` 笔误进 warning 通道、watcher 错误告警、
  `lastError` 不再被通用文案覆盖、也不再**跨代复用**（spawn 时记基线，只有这一代没写出
  新原因才用通用文案；run 成功即把旧错误从告警条摘下）、双 WORKDIR（registry.ts 与 app.ts）
  混用顺序写进注释（同 token 后注册覆盖先注册，拼错顺序会让面板喂的 workdir 被
  `process.cwd()` 静默顶掉）、模板 `safeResolve` 注明不解 realpath 的已知边界等。

## [0.9.2] - 2026-09-22

> 本版主题（窗口 `0.9.1 → 0.9.2`）：**dev 面板的可读性** —— 模型正文按 Markdown 渲染、
> 滚动分层（整页不滚、只滚该滚的那块）、长正文默认折叠。
> **无破坏性变更**：框架公共 API 与脚手架模板形态逐字未变。

### 新增 · dev 面板的正文 Markdown 渲染

- **模型正文按 Markdown 渲染**（最终回复 + 对话视图的助手轮）：标题 / 粗斜体 / 行内码 /
  围栏码（带语言标注）/ 列表 / 引用 / 分隔线 / 链接。此前是一整块 `<pre>` 纯文本，
  长回复里的列表与代码块糊成一坨。
- 解析器是**自己写的**（`packages/cli/src/markdown.ts`，纯逻辑、零依赖、带单测）：
  引 `marked` + `DOMPurify` 等于把两份第三方产物塞进 dev 链路，而且它们**没法被本仓单测验证**；
  这套子集不到 200 行，每条规则都有用例。安全前提是**按构造不产生 HTML** —— 解析器只产出
  token 树（没有「HTML 透传」这一类），渲染层只准用 `createElement` / `textContent`
  ⇒ 模型输出里的 `<script>` 只会是字面文本。链接协议过白名单（`http` / `https` / `mailto`），
  不合法（`javascript:` 等）**整条降级成字面文本**（连 `[]()` 一起显示）。用户轮保持字面 ——
  那是「我打的字」，按 Markdown 重排会像面板改过我的输入。

### 变更 · 面板滚动分层：整页不滚，只滚该滚的那块

- 此前右栏没有高度上限 ⇒ 内容一长就是**整页滚动**，而 `footer` 还粘在底部盖住内容。
  现在改成应用外壳：`html/body` 卡 100vh、`body` 不滚；左栏页签固定、列表自己滚；
  右栏**只有调用树是滚动区**（它随 span 数无界增长），回复 / 能力排行 / 用量固定在下方、
  各有上限（回复很长时在**它自己那块**里滚，而不是把树推出屏幕）。
- 窄屏（≤860px）回落成单列 + 整页滚动 —— 两栏并排在那个宽度下都不可用。

### 变更 · 长消息折叠：明确的「展开 / 收起」

- 超过 12 行或 1200 字符的正文默认折叠（卡 216px + 底部渐隐），下方左对齐一个
  「展开全文（共 N 行）▾」按钮，展开后变「收起 ▴」。**短正文不挂控件**（挂一个是噪声）。
- 判定走纯逻辑 `collapseDecision`（带单测）：按**行数 + 字符数**，不量像素 —— 像素阈值在
  字体 / 缩放 / 窄屏下会漂，同一个回复在不同机器上折叠与否都不一样。展开态活在渲染之外
  （面板每次全量重画，状态留在 DOM 里会被下一次重画合上）。

### 修复

- **CLI 套件里两条文件监视用例在全链下稳定假红**（`packages/cli/test/panel-logic.test.mjs`）：
  夹具原来「**写一次**、然后轮询等满 15 秒」，而真 fs 的监视器**建立是异步的**（`fs.watch`
  返回 ≠ 底下 FSEvents 流已开始投递）—— 那一次写整个漏掉时，**等多久都没用**。复现条件最后
  定位到 **stdout 被管道捕获**（`verify-all.sh` 的 `out=$(bash -c …)` 与 CI 都是这么跑的）：
  管道下稳定红、重定向到文件稳定绿；单跑套件也是绿的。改成 `writeUntilSeen`（反复写、直到
  回调真的来，上限 15 秒）—— **断言没放宽**（那个路径仍必须触发一次回调，只是不再要求
  「第一次写就被看见」），四条「不该触发」的负向用例一条未动。
  ⚠️ **仅测试侧，无使用者可见行为**：生产里 dev 环**先建立监视、再对外服务**，不存在
  「`watchTree()` 一返回用户就改文件」这个窗口。

### 文档

- `docs/usage-guide.md` §2.2：按使用者口吻补三段 —— Markdown 渲染口径（含协议白名单与
  「用户轮保持字面」）、滚动三层各管一段、长正文折叠阈值与展开控件位置。
- `docs/guards.md` §1.4：新增 `markdown.test.mjs` 一行（两条安全断言：按构造不产生 HTML、
  链接协议白名单 + 两条反向验证），并把 `inspector.test.mjs` 那行的反向全覆盖**扩面**记上
  （覆盖所有自建模块 + 四条页面级不变量）—— 是**扩面**，别读成「多了五条守卫」。
- `docs/spec.md` §10 2026-09-22 **⑨**：本轮三处可读性改动的现场证据与修法，外加两条踩坑
  （反向验证的变异体**必须能编译**，否则构建先失败、门禁空跑；对被格式化过的文件做 patch
  时 `old_string` 用了格式化**前**的版本，靠「改完立刻回读」才发现）。
- `docs/plans/2026-09-22-dev-debug-loop.md`：补本轮三处的落地记录。

## [0.9.1] - 2026-09-22

### 新增 · dev 面板的实时右栏（在飞就看得到调用树）

- **右栏从「收尾才有」变成「一个个长出来」**：runner 订阅框架的增量记账出口
  （`onTraceEvent`，0.8.3 已落地）逐笔 `POST /ingest-event` → 父进程**原样**广播
  （SSE 的 `dev` 命名事件多一类 `trace-event`）→ 面板按 `seq` 折回一棵**临时**的树。
  收尾那份整棵 trace 回来时**覆盖**它（缺的 span 由那份补齐）。纪律与框架同名出口一致：
  **不保证送达**，所以刷新页面之后早先那些 span 不会回来（收尾那份会补）。
  计划 §D7 的评审补充点名要求的那条（P1b 面板侧工作）这轮落地。
  折回逻辑是**纯逻辑 + 单测**（`panel-logic.ts` 的 `applyTraceEvent`），e2e-dev 另有一条
  「帧必须先于 run-done 到达，且折回逐字等于收尾的整棵 trace」的真进程断言。

### 变更 · 工作目录选择器：文件可选、隐藏目录可达、`浏览…` 不再是开关

- **文件也能选**：`GET /api/fs` 现在分三类回（`dirs` / `dotDirs` / `files`；文件有上限，
  超限时回 `filesTruncated`）。点文件名 = 工作目录取它**所在的**目录 + prompt 为空时填文件名
  （你已经写好的 prompt **一个字不动**）。旧形态只列目录 ⇒「让 agent 看某个文件」只能靠自己打名字。
- **隐藏目录单列**（不再整批过滤）：`.git` / `~/x/.y` 这类目录以前**根本点不进去**
  （`..` 只能退到它上面，进不去）。
- **`浏览…` 不再当开关**：以前面板开着时再点一次只是把它关掉，于是「在输入框敲了路径 → 点浏览」
  这个最自然的动作是**把面板关掉**。现在点它**总是**按输入框里的路径打开，点面板外面收起。

### 修复

- **跑完的回复被面板自己擦掉（端到端实测 17 ms）**：`run-done` 与「这条 trace 的收尾帧」
  几乎同毫秒到达，而 `open()`（收尾帧触发的自动打开）**无条件**清回复 ⇒ 刚写上去的那句立刻没了，
  表现是「run 完成了，但面板上没有回复」。现在按「这条 trace 是不是这段回复的主人」判
  （`panel-logic.replyBelongsTo`）：打开**别的** run 的 trace 照样清（防张冠李戴），
  打开**刚跑完那一轮**的不清。
- **在飞的树被收尾帧骗成「已完成」**：`playTrace` 以前对根 span 没有 `endedAt` 的树也调
  `finish()`（根被标成 `●` + 耗时），而在飞时那是**假事实**。现在根没结束就不收尾（留 `◌`）——
  该分支只对「在飞 / 截断」的树生效，收尾的整棵 trace 行为逐字未变。

### 文档

- `docs/usage-guide.md` §2.2：补「右栏是实时的」（含两条边界）与工作目录的三个点击语义。
- `docs/guards.md` §1.4：本轮在**既有三行**登记上扩面（`panel-logic.test.mjs` 增四组折回 / 归属 /
  浏览目标 / 选文件后的 prompt，`inspector.test.mjs` 增三项 HTTP 面，`e2e-dev.ts` 增第 7-bis 步），
  见该节 —— 是**扩面**不是新增行，别把它读成「多了五条守卫」。
- `docs/plans/2026-09-22-dev-debug-loop.md`：§D7 那条评审补充标注 **P1b 已落地**（增量出口接线）。
- `docs/spec.md` §10 2026-09-22 **⑧**：本轮三处体验缺陷的现场证据与修法（右栏实时 / 回复被擦 /
  选择器），外加一条发版流程教训（反向验证脚本必须先 commit）。

## [0.9.0] - 2026-09-22

> 本版主题（窗口 `0.8.3 → 0.9.0`）：**dev 调试环落地** —— `agentia dev` 从「`tsx watch` 跑你的
> `main.ts`」变成「**常驻 runner 子进程 + 本地 inspector 面板**驱动你的 `src/app.ts`」，
> 四个控件（能力选择 / 工作目录 / 多轮 / prompt）都在面板上；顺带补上「**中止在飞 run**」与
> 「**清空对话**」两个操作，以及一轮复核修复（9 条，含 5 条严重：窄窗口竞态、收尾路径、
> 同一事实两个表面口径不一致）。
>
> ⚠️ **含破坏性变更，但只在脚手架模板形态上**（下面的迁移小节写了要做什么动作）：
> 模板把「装配」与「启动」拆成两个文件（新增 `src/app.ts` 工厂），老工程不迁移的话
> `agentia dev` 会**明确报错**（不是静默降级成一个驱动不了任何东西的空壳）。
> **框架本体的公共 API 无破坏性变更**：没有删签名、没有改默认行为 —— 已有工程照常
> `npm start`；受影响的是「在工程里敲 `agentia dev`」这条开发期路径。

### 破坏性变更 · 脚手架模板：装配与启动拆开（新增 `src/app.ts`）

**要做的动作**：把老工程 `src/main.ts` 里的 `createApp({...})` 整段搬进新的 `src/app.ts`，
包成一个**工厂函数**；`main.ts` 只留「读 `.env` → 调工厂 → `app.run` → 处理 `result.error`」。

**为什么**：`agentia dev` 的调试环要把「这次调哪个能力 / 工作目录是哪个」喂进 `createApp`，
而**只有调用者能设这些选项**。拆出工厂之后 CLI 才是调用者 ⇒ **工程里一个 dev 文件都不需要**
（只多一个**数据**文件 `src/dev.config.ts`）。不迁移的后果是**明确报错**，不是静默降级：
`agentia dev` 会指出 `src/app.ts` 缺失并打印迁移说明。

**最小迁移**（对着 `agentia create` 新生成的工程看最省事）：

1. 新建 `src/app.ts`：把 `main.ts` 里的 `CAPABILITY_DIRS` + `discover` + `createApp({...})` 搬进去，
   改成 `export async function createAgentApp(opts: CreateAgentAppOptions = {})`。老的那段可以**原样**搬
   —— 第 3 步不做也能跑，只是面板上的「工作目录」旋钮不生效。
2. `src/main.ts` 改薄入口：`import { createAgentApp } from './app.js'`（**注意 `.js` 后缀**）→
   `const app = await createAgentApp();`，删掉 `createApp` 的 import 与 `CAPABILITY_DIRS`。
3. （要「工作目录」真生效就得做）在 `providers` 里加 `{ provide: 'WORKDIR', useValue: opts.workdir ?? <项目根> }`，
   并把需要工作目录的能力从 `discover` 挪到显式 `providers` 声明 `deps: ['WORKDIR']`
   —— **`discover` 自动注册的 provider 没有 `deps`**，拿不到注入值。
4. （可选）新建 `src/dev.config.ts` 声明多轮（`export default { multiTurn: ['trip-planner'] }`），
   并给 `.gitignore` 补一行 `.agentia/`（dev 环的对话历史落盘处）。

### 新增

- **面板的「中止」按钮：中止在飞的 run（`POST /run/abort`）。** 此前只做了「在飞时拒绝第二次
  `POST /run`（409）」这一半 —— 后果不是小事：**一个卡住的 run 会让面板永久锁死**，
  此后每次运行都 409，而面板**没有任何办法**解开它。
  实现走 IPC 让 runner 自己 `abort()`，**不是**父进程杀子进程 —— 理由是 **trace**：
  `RunInvocationOptions.signal` 是契约字段（原样送进引擎），中止后在回合边界以
  `stopReason='aborted'` **正常返回**（`engine/loop-result.ts` 的 `abortedResult()`）
  ⇒ **trace 照常落盘**。杀进程那条路会把这次 run 的 trace 整个丢掉。
  ⚠️ signal 是**协作式**的：工具不读它就没人理（「MCP 在途中止 ⇒ Promise 永不 settle」正是这一类），
  `running` 会永远为 `true` ⇒ 所以补一条兜底：**5 s（`ABORT_GRACE_MS`）后仍没结束就重启进程**，
  此时这次 run 的 trace 会丢，面板**明说**这一点（不静默）。
- **面板的「清空对话」按钮（`POST /session/clear`）。** 清空 = **换一个 `sessionId`**，
  **不删** `session.json` —— 后者是 `SessionStore` 的账，面板对它**只读**（写它会造出
  「面板显示的对话」与「模型真正看到的对话」不一致）。旧对话仍在盘上、run 列表里也还指得到，
  只是模型不再带着它跑。当前 id 落盘到 `.agentia/dev-session-id`（**不是** `session.json` 的一部分）：
  只放内存的话，重启 `npm run dev` 之后刚清空的对话会**自己回来**；该路径已在监视排除清单里，
  写它不触发重启。id 由**父进程**决定并经 IPC 下传 —— 它是面板级状态，必须跨 runner 重启稳定。

### 变更

- **`agentia dev` 从「看 trace」补上「驱动 run」**：面板上多四组输入 —— prompt 输入框（带 `↑`/`↓` 历史）、
  能力多选（缺省全选；收窄的是**菜单**，主 agent 仍在环里 —— 别的能力 `tools` 里的显式引用仍能调到
  被排除的那个）、工作目录选择器、多轮开关（按能力声明，混选取 **OR** 且面板**标出来源**）。
  `npm run dev -- "你的问题"` 仍可直接带上第一句。
- **文件监视收编进 CLI**：`agentia dev` 不再叠一层 `tsx watch`（旧形态有**两个重启主人**，保存的瞬间
  恰好点运行会双双 spawn），自己按**允许清单**看文件 —— **`.md` 必须在里面**：文本资产
  （`@Prompt` 拉的 `.md`、子 agent 的 `system.md`）不在 tsx 的 import 图里，旧实现改它们
  **静默无感**（改了没反应、也不提示）。排除 `node_modules` / `dist` / `.git` / `.agentia` / `coverage`
  —— `.agentia` 那条不是洁癖：它是 dev 环自己的对话历史，看它就变成「每次 run 重启一次」的自噬循环。
- **重启与不重启的边界**：改代码或改**能力选择** ⇒ 重启子进程；改**工作目录** / prompt / 多轮 ⇒ 不重启。
  在飞 run 期间的重启**延后**到它结束。⚠️ 重启能力选择的理由**不是贵**（进程内重建实测 **2.6 ms**，
  初稿的「几秒」高估约两个数量级），而是**回收口**：框架没有 `AgentApp.close()`，MCP 连接器由用户代码
  持有 ⇒ 进程内反复重建会攒孤儿 MCP 子进程。配套硬约定（写进模板注释）：**进程外资源一律在模块作用域
  创建并注入**，不许在 provider 构造函数里建。
- **dev 环鉴权（两层，零依赖）**：`Origin` 校验（**缺失放行** / `Origin: null` **拒绝** / 跨源拒绝）
  + **每次启动生成的一次性 token**（首帧 `?t=` → `HttpOnly; SameSite=Strict` cookie；脚本走
  `x-agentia-token` 头；`timingSafeEqual` 比较），**每个端点**都校验。token 挡的是**本机其它进程**
  （它们能 `curl`、不受 `Origin` 约束），**别把它当网络边界** —— 面板只绑 `127.0.0.1`。
- **dev 环缺省预算护栏**：面板上「点一下 = 一次**真** run」⇒ 缺省套
  `{ maxCostUsd: 1, maxTotalTokens: 200_000 }`（可用 `dev.config.ts` 的 `budget` 覆盖）。
- **模板 `@SubAgent` 的 `system` 改函数形态**（`() => asset(...)`）：值形态在**类定义时**求值 ⇒
  `system.md` 要重启进程才生效，而 `.md` 不在 tsx 的 import 图里 ⇒ 静默失效。
  通则：**模块加载期读 = 冻；调用期读 = 热**。
- **去掉 `NODE_OPTIONS=--import` 注入**：子进程改跑 CLI 自己的 `dev-runner.js`，
  连带那条 Node ≥ 20.6 / ≥ 18.19 的版本闸与字符串拼接一起删掉。
  ⚠️ 代价是顺序变成**承重的**：必须在 import 用户 `app.ts` **之前** `await registerTraceSink()`
  —— `createApp` 在构造时就把 `defaultSinks` 快照下来了。
- **脚手架自带 `read-file` 工具**：读**工作目录**下的文本文件，根由 DI 注入（`WORKDIR`）——
  它是「面板上那个文件夹选择器真的生效」的接线。越界**响亮报错**，不静默截断。
- **脚手架自带 `src/session-store.ts`**（`FileSessionStore`，**原子写**：临时文件 + rename）
  与 `src/dev.config.ts`（**数据**，不是逻辑）。

### 修复（dev 环真跑一次抓出来的 —— 上面那些改动全绿时它们照样在）

- **`agentia dev` 起不来：`npx` 吞掉了 IPC 通道。** 子进程原本是 `spawn('npx', ['tsx', runner])`，
  而 `npx` 是包装器、**不给孙进程转发 fd 3** ⇒ runner 里 `process.send` 是 `undefined`，
  代码写的是 `process.send?.()`（可选链）⇒ 所有协议消息**静默丢弃**：面板等不到 `ready`、
  `POST /run` 永远不回来，且进程会以 `code=0` **干净退出**（看起来像「用户代码跑完了」）。
  改成 `node <tsx/cli>` 直起（`resolveTsxCli()`：用户工程优先，退到 CLI 自身；不走
  `node_modules/.bin/tsx` —— Windows 上那是 `.cmd` shim，会绕回 CVE-2024-27980 那个坑）。
- **`npm run dev` 读不到 `.env`（`npm start` 读得到）。** 上一节把模板拆成 `app.ts` / `main.ts` 时，
  `loadEnvFile()` 留在了 `main.ts`，而 dev 环只 import `app.ts`、**从不执行 `main.ts`**。
  失败形状是静默的：用户看到「没配 key」，然后去怀疑框架。已挪进 `src/app.ts`。
  ⚠️ 当时**两处**断言都钉着这件事，但都指着 `main.ts` —— 断言存在 ≠ 钉对了位置，现已改成成对断言。
- **面板能力选择器空着且无解释。** `DevEvent` 有 restart / error / run-start / run-done，
  **唯独没有「就绪」**；而面板加载时只查一次 `/api/dev`，那时 runner 还没装配完
  （拿到的是父进程初值 `[]`）⇒ 菜单要等用户先跑一次才填上。新增 `{ kind: 'runner-ready' }` 广播。
- **「runner 没起来就退出」广播了一句更没用的原因。** `exit` 处理器先 `fail()`（reject）再同步
  `emit`，而那时 `lastError` 还是 `null` ⇒ 面板收到笼统的「意外退出」，真正的原因只进了终端
  （reject 要到下一个微任务才被 catch 接住）。改成先写 `lastError` 再 reject。
- **新增 `scripts/e2e-dev.ts`**：`agentia dev` 整条链真跑（此前**零覆盖**），四条行为断言
  （IPC 就绪 / `.env` 生效 / 能力收窄真的收窄了请求体 / 改 `.md` 触发重启且能恢复）。
  折进 `verify-all.sh` 第 7 步（`npm run e2e`），不加步骤。
- **中止的 run 被三个地方各自当成「失败」（同一个事实的三个影子）。** 引擎的 `abortedResult()`
  **刻意**给已取消的 run 带上结构化 `error`（取消不是失败，但原因要可查），而 runner 的
  `ok` 定义是 `!result.error` ⇒ **中止时 `ok` 也是 `false`**。于是：
  ① 面板把「我按的中止」显示成「run 失败（aborted）：run 已被取消」；
  ② `dev.ts` 把它写进 `lastError` ⇒ 告警条上永远挂一条红字、且不会再消；
  ③ 终端打成「run 失败（stopReason=aborted）」。
  三处统一为「**先认 `stopReason` 再认 `ok`**」，并把面板那一处的判别抽进 `panel-logic.ts`
  （顺序是**语义**，不是渲染 —— 面板那份没有单测）。
  判别口径此前只活在注释里，且**写错了**（写成「中止是正常返回、`ok` 两者都是 true」——
  那是把「不抛异常」误当成「不设 `error`」）。
- **`watchTree` 的目录跳过判据是「半实现」的**（追一次**瞬时红**追出来的 —— 一次完整门禁里
  CLI 套件红过一次、重跑又绿，没当噪声放过，连跑三次复现后隔离到 watch 用例）。
  `WATCH_SKIP` / 点开头此前**只在「初始递归」那一个调用点**执行，而 watcher 回调里发现新目录时
  调 `addDir` 走的是**另一条路**、那条路上一次判据都没有 ⇒ 行为是「启动时就存在的 `dist/` 不看、
  **启动后才出现**的 `dist/` 看」。判据已收进 `addDir` **内部**（唯一一处），`root` 由调用方
  显式豁免 —— 判据只看**目录名**、不看路径段（项目根本身就叫 `dist` / `.foo` 是合法的；
  用绝对路径段去认 `dist` 会把整个项目判成「不该看」）。
  ⚠️ 真跑时的**第一层**防护是**监视根**：`devServer` 只 `watchTree(<projectRoot>/src)`，
  而 `.agentia/` 与 `dist/` 在项目根、根本不在范围内。`WATCH_SKIP` 是**第二层**，两层都要有 ——
  只靠根的话，哪天有人把根改成项目根，`.agentia/session.json` 会立刻变成
  「每次多轮 run 重启一次子进程」的自噬循环。
  ⚠️ **这一轮最值钱的不是修好，而是照出一条「假守卫」**：我给 e2e 加了一条「重启次数总账 +
  理由里不许出现 `.agentia` / `dist/`」的断言，反向验证时**单测红了、e2e 照样绿** ——
  逐条排除后确认不是「修复没生效」也不是「断言写错」，而是这条缺陷在 e2e 里**不可达**
  （监视根是 `src/`）。也就是说那条断言真正守的是「**监视根保持 `src/`**」，它**碰不到**
  `WATCH_SKIP` 那条路。断言是真的、绿的、也是对的，只是它守的是**另一件事** ——
  所以 dev.ts 与 e2e 两处的注释都已照实改准（说清哪条守哪件、以及它**不守**什么）。
- **改 `.env` 不会重启（文档承诺了、代码够不着）。** `WATCH_NAMES` 把 `.env` / `.env.local`
  列进允许清单、`usage-guide` 也把 `.env` 写进「看什么」，但 `watchTree` 的根是
  `<项目根>/src`，而这两份文件在**项目根** ⇒ 这条判据**没有任何一个 watch 够得着**，
  改 `.env` 静默无感。与上面那条是同一类的两个面：**判据认得它**（`shouldWatch` 有单测、
  写得也对）≠ **有人够得着它**（根在调用点决定）。
  新增 `watchRootEnvFiles()` 单开一个 watch：**不递归**、且**只认名字**（不认扩展名 ——
  项目根的 `package.json` 也不该由它管）。刻意**不**把 `watchTree` 的根抬到项目根：
  那会把 `README.md` / `docs/` / `examples/` 全收进来，「改代码要重启」就变成「改任何文档也重启」。
  两处 watch 共用抽出来的去抖器（各写一份会漂 —— 比如只有一处清理 `timer`，停机后仍会回调一次）。
  ⚠️ **这条只有真跑能守**：根是**调用点**决定的，`watchTree` 自己无从知道该看哪儿 ——
  所以钉它的是 `scripts/e2e-dev.ts` 第 9-bis 步（真改一次项目根的 `.env`）。

### 修复（复核轮：四条窄窗口 / 口径缺陷 + 两条顺手抓出的）

同一天对这轮 dev 环改动做了一次逐条回读代码的复核（决策链见 `docs/spec.md` §10 2026-09-22 ⑦）。
下面每条都补了**反向验证**（把修复摘掉 ⇒ 新加的门禁真的会红）：

- **并发闸没盖住「换能力选择 ⇒ 重启」那条路径**（双击运行会真并发两次）。受理到 run 真正发出去之间
  有 `await restart(...)`，而 `running` 只在 run 发进通道之后才置位 ⇒ 两个请求双双通过检查，
  runner 里两个 run 并发、`currentAbort` 被覆盖、CLI 侧记账挂到别人的 traceId 上。
  现在多了个只给闸看的 `launching` 占位（刻意不并进 `running`：「中止」按钮据此仍只在真在飞时出现）。
- **Ctrl+C 会丢掉 SIGKILL 兜底 ⇒ 不响应 SIGTERM 的子进程树活成孤儿**。旧的 SIGINT 处理器固定
  50 ms 就 `process.exit(0)`，而 `stopChild()` 给子进程的宽限期是 3 s（SIGTERM 后等满才补 SIGKILL）——
  父进程先没，那段宽限连同兜底一起消失，`process.on('exit')` 那条也已空转。现在等收尾真的做完再退
  （另有 5 s 硬上限兜「面板连接没关掉」这类卡死，再按一次 Ctrl+C 立即硬退）。
- **「中止」落在装配窗口里会被静默丢弃**。`runOnce` 是先 `await ensureApp(...)` 再建 AbortController，
  窗口内到达的中止只能看到「没有在飞的 controller」⇒ run 照跑，而父进程 5 s 后把这次**健康的** run
  升级成重启兜底（trace 丢掉、原因还写成「工具不响应 signal」）。现在窗口内的中止会被记住并立即补上。
- **被中止的 run 在面板上被标成「失败」**（通知条已修好，但 run 列表的红点与对话视图的红边走的是
  `ok` —— 中止的 `ok` 同样是 `false`）。判别统一到 `panel-logic.runIsFailure`（先 `stopReason` 后 `ok`），
  且**中止轮仍留在对话视图里**（框架只在成功路径回写会话，排除它会显示一份少了一轮的对话）。
- **会话文件损坏时只在 dev 环告警**（`FileSessionStore` 自己会响亮抛错，但框架在 load / append 里
  刻意吞掉会话侧异常 —— 既定口径「辅助动作不击穿 run」）⇒ 历史被当成「第一轮」且新历史写不进去，
  全程无声。现在 runner 在**启动期**探测一次，把原因送进既有的 warning 通道（面板告警条）。
- **`agentia dev -- "你的问题"`**：裸 CLI 形状会把分隔符 `--` 当成 prompt 传给模型
  （`npm run dev -- "…"` 那条因为 npm 吃掉 `--` 而一直是对的，两条形状都文档化了）。现在两者都取到真 prompt。
- **模板 `read-file` 未归一化工作目录**：工作目录带尾斜杠时（面板输入框 / `dev.config.ts` / 从 Finder
  粘过来都常见），越界判定 `abs.startsWith(root + '/')` 恒为假 ⇒ **每一次**调用都报「路径越出工作目录」。
  那不是误报，是工具整个变坏，且错误归因会把模型带偏。
- **模板 subagent 的 `system.md` 补上「你的回复就是报告」约定**：模板这轮把 `system` 改成了**函数形态**
  （改 `.md` 立刻生效），而框架只对**值形态**追加 `REPORT_HINT` ⇒ 函数形态下子代理不知道自己的最终回复
  就是交回主 agent 的交付物，措辞差异没有任何测试看得见。约定现在写在模板自己那份 `system.md` 里。

### 修复（#121 第十一轮复核收口 —— **发布时漏记，2026-09-23 补记**）

- **`GET /tasks/:id/stream` 新增 `stream.closed` 帧（流级收尾，API 面）**：任务在**别的进程**
  跑、且还**没到终态**时，旧实现发一帧 `stream.unavailable` 之后没人关流 —— 心跳照打、
  连接永挂。现在紧跟一帧 `stream.closed` 并关闭连接。刻意**不**发 `task.end`：
  那是「任务终态」的语义，拿来收尾等于伪造终态。
- **MCP stdio 连接器：请求在途中被中止时 Promise 永不 settle**（旧实现只删簿记不 reject，
  响应帧按 id 找不到人）⇒ 直接 `await` 连接器 API 的宿主**永久挂起**。现在中止即 reject
  `AbortError`，与 HTTP 连接器同口径。
- **`AsyncRunner.streamBufferEvents` / `TaskEventStreams.retainTerminal` 的坏值不再静默**：
  `0` / 负数 / 小数 / `NaN` / `±Infinity` 一律**构造期抛 `TypeError`**。旧实现里 `NaN`
  在两条链上失效方向相反且都静默：前者是「每任务内存闸整条不拦」，后者是「无订阅者的
  终态流全被清空」。`0` 的读法两者刻意不同：`streamBufferEvents` = invalid（配置错误），
  `retainTerminal` = disabled（「不留终态流」是有意义的设定）。
- **指标**：同毫秒连按两次 `reset()`，窗口起点也**严格前进**（`windowStart` 收为 `private`，
  唯一写者是 `reset()`）；`dropped()` / `onDrop` 补了可测面（丢弃计数与回调同口径，
  错误 run 永不丢且不计）。
- 内部：e2e 端口 TOCTOU 修根因（删 `freePort`，改 `PORT=0` + 解析就绪日志，顺带拆掉
  上一轮的 `startExampleRetrying()` 症状补丁）；官网守卫把 `og:url` 纳入 URL 口径、
  llms.txt 链接从前缀匹配改为链接目标集合精确比对（旧判定下删掉首页链接照样绿）。

### 文档

- `docs/usage-guide.md` §2.1 / §2.2（新）：脚手架文件分工 + `agentia dev` 的四组输入 / 监视规则 /
  重启边界 / 鉴权 / 成本 / 会话历史；§6.4 补「对话历史从哪来」与**两层「历史」**的区别
  （prompt 回显模型看不见；对话历史真的进上下文，且只在开了多轮时出现）。
  §2.2 另补一条「**看哪里**」—— 此前只写了「看什么扩展名」，没写监视根（`<项目根>/src` 整棵树
  ＋ 项目根单独的 `.env` / `.env.local`）⇒ 读者无从知道「改项目根的 `README.md` 不触发重启」。
- `docs/spec.md` §10 2026-09-22 ②：本轮决策记录，含「**P0–P2 全程零框架改动**」的逐项核对。
  §10 2026-09-22 ③：真跑探针抓出的两个缺陷与三条修复（含反向验证记录）。
  §10 2026-09-22 ④：拿功能文档逐项对照做审计 —— 又抓出两处「文档里有、代码里没有」，
  以及「同一条事实的第三个影子」（中止的 `ok` 是 `false`）。
  §10 2026-09-22 ⑤：追一次瞬时红 → `WATCH_SKIP` 的半实现 + 那条「守了另一件事」的假守卫。
  §10 2026-09-22 ⑥：拿 ⑤ 的「监视根」去核每条判据 → `.env` 是一条**够不着**的判据
  （含「判据的正确性 vs 可达性」与「探针别用写死序号」两条可复用的教训）。
- `docs/guards.md` §1.4：新增五条守卫登记（面板纯逻辑 + watch 允许清单 / dev 环鉴权与 HTTP 面 /
  生成物能力名一致性 / `agentia dev` 整链真跑 / `.env` 接线成对断言），并随 ④ 扩面
  （`nextSessionId` / `runDoneNotice` / `POST /run/abort` / `POST /session/clear` /
  面板 import 名单反向全覆盖 / e2e 第 10-11 步）、随 ⑤ 再扩面（`watchTree` 的**动态新增目录**
  用例 + e2e 第 12 步重启总账，并注明 e2e 第 12 步**不守**什么）、随 ⑥ 三度扩面
  （`watchRootEnvFiles` 的名字过滤用例 + e2e 第 9-bis 步改项目根 `.env`）。
  §2 尾注补三条可复用的自查问。
- `docs/plans/2026-09-11-dev-inspector.md`：非目标清单修订 —— **`run 重放执行` 仍然不做**，
  面板做的是「发一次**新的** run」，两者相邻但不同。

## [0.8.3] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.2 → 0.8.3`，含 #115 与 #116）：**增量 trace 出口落地**。记账与交付之间
> 此前**没有缝** —— `TraceRecorder` 的唯一出口是收尾的 `snapshot()`，所以「等不了 run 收尾」
> 的消费者（终端面板 / SSE 前端 / 异步任务进度流）拿不到任何东西。本版补上那条缝，顺手把
> spec §7 F3 的两条后置项与 §9.4 的记录成本问题同日收口。
> **框架 API 无破坏性变更**：只新增（`onTraceEvent` / `traceLimits.maxEvents` /
> `AsyncRunner.streamBufferEvents` / `GET /tasks/:id/stream` / `/run` SSE 的 `trace.event` 帧），
> **既有签名、既有三帧 SSE、既有默认行为逐字不变** —— 不认识新帧的老客户端行为零变化。
> #116 全部落在**仓库自身**（守卫 + 一次行为等价的重构），不含任何运行时行为变更。

### 新增

- **`onTraceEvent`：run 进行中逐笔拿记账事件**。`RunInvocationOptions.onTraceEvent`（单次）与
  `AppOptions.onTraceEvent`（应用级缺省）**叠加**（应用级在前）而不是覆盖 —— 观察者是注册不是
  值覆盖，覆盖会让「某次 run 顺手传了个面板回调」把应用级那条静默顶掉。载荷是
  `TraceRecordEvent`（`span.begin` / `span.end` / `span.event` / `span.attribute` / `span.link`，
  **增量 + 此刻的拷贝**）。
  四条纪律：同步派发不 await（订阅者是观察者，不该把 run 变成它的调度）、抛错被吞（与
  `flushSinks` 同款）、无订阅者零派发、**seq 每次记账动作都占号**（与有没有订阅者无关 ——
  否则「订阅晚的人」看到的序号会与一直订阅的人不一致，重放与去重都会错位）。
  它与 `TraceSink` **不互相替代**：sink 是收尾拿整棵、不保证运行期可见；这条是运行期逐笔、
  不保证送达。要「收尾的整棵」继续用 sink。
- **`POST /run` 的 SSE 新增一族 `trace.event` 帧**。帧名取**一族** + body 里带 `type`，而不是
  每类型一帧：将来加新事件类型时，老客户端只是漏掉一种 `type`，而不是漏掉一种**帧名**（后者
  更隐蔽）。既有三帧（`text.delta` / `run.end` / `error`）逐字未变。
- **`GET /tasks/:id/stream`：异步任务的进度流**。从头重放 → 转实时 → 终态以 `task.end` 收口关流；
  `Last-Event-ID` / `?from=` 指**流自己的序号**（一个任务可能跨多个 run 段 —— HITL 挂起→恢复、
  崩溃重投，每段是独立的一次 run、`seq` 从 1 重来，而流的读者要的是一条**连续的**流）。
  四条边界：`awaiting_approval` **不是终态**（流继续开着 —— 关掉的话「等审批结果的前端」正好在
  最需要的时候断线）；这条流的读者是**旁观者**，背压 / 断开**不 abort 任务**（与 `/run` 的 SSE
  刻意相反：那里的下游是 run 的所有者，背压等于「别继续烧 token 了」）；跨进程（别的 runner 跑的
  任务、同一个 store）→ 一帧 `stream.unavailable` + 终态 `task.end`，**不假装实时**；缓冲超限 →
  丢最旧并先发一帧 `stream.truncated`（**不静默**）。缓冲用 `AsyncRunner` 的
  `streamBufferEvents` 调（缺省每任务 500 条；终态流只留最近 16 条）。事件**不落 store** 是有意
  的：实测事件数 = 2 × 工具调用、正文 KB 级 ⇒ 每条工具调用要把 KB 级正文写库两次（写放大），而
  宿主本来就有自己的总线（`onTraceEvent` 就是给它的缝）。
- **`traceLimits.maxEvents`：整条 trace 的事件总数上限**。超限即**停止记账**，交付时在 run 根写
  一笔 `trace.truncated{droppedEvents, limit}` —— 缺口位置可预测（尾巴）且**有计数**。
  刻意**不做**环形缓冲（丢最旧、留最近）：那会让 trace 中间出现空洞，而空洞比「尾巴截断」难解释
  得多（「这一回合怎么没有工具事件」）。`0` = 一条都不记（**有意义的值**，仍有计数）；不设 = 不限。
  坏值（NaN / ±Infinity / 负数 / 小数）在 run 入口抛 `TypeError` —— 静默接受会让闸门**形同不存在**
  （`NaN` 让 `>=` 恒假），而使用者以为自己设了上限。
  与既有的 `maxEventChars` **正交**：一个管「单个事件正文多长」、一个管「多少」。

### 文档

- `docs/usage-guide.md`：`onTraceEvent` / `traceLimits` / `streamBufferEvents` 与
  `GET /tasks/:id/stream` 的用法；§7 边界表补任务进度流的边界（内存 / 跨进程）。
- `docs/observability.md`：采样在「不内建」之外补上**可算 + 可数** —— §2.3 新增采样率换算表，
  示例 `sampleSink` 增加丢弃计数（`dropped()` / `onDrop`）。**框架仍然不内建采样器**（既有决策
  不变：采样是配方 2.3，`examples/observability` 已有成品；再造一个就是同一件事的两份实现）。
- `docs/spec.md` §9.4 从「唯一剩下的开放问题」变为**决定**：默认全量、截断默认开、采样不内建，
  框架侧只新增「数量上限 + 丢弃计数」这一件 —— 让「少记了数据」可数。
- **一处面向使用者的说明被更正**：`formatTraceparent` 的 flags 继续恒 `00`，但理由从「本框架
  不采样」改为**「运行期不可知」** —— 记录 / 导出决策发生在**收尾之后**，出站调用发生在
  **运行期**，那时没有答案。所以它**不会**跟随采样率变成 `01`：原理由在采样成为推荐配法后已不
  严谨，若照它改成「跟随采样」反而是错的。

### 仓库自身（不面向使用者）

- **`docs/guards.md` §2 从 4 行清到 1 行** —— 三条待守形状建成了机器守卫（`0` 的语义真源 /
  穷尽转发 / 队列消费者配方门禁），细节见该文件 §1.2 / §1.3。顺带登记了两个此前无人写明的事实：
  `intervalMs` 在 `Scheduler.every`（必须 > 0）与 `metricsSink`（`0` = 立即导出）里**同名反义**；
  数量类旋钮里只有 `mapWithConcurrency` 把 `0` 读作「不限」（`maxRetries` / `maxEvents` /
  `maxIterations` 都是「就是不做」）。
- `scripts/verify-all.sh` 与 CI 的**步数不变**：新增检查一律折进已有步骤（步骤数写在 CI 的必需
  状态检查名里，加一步就要同时改 workflow 与分支保护）。

**迁移**：无（框架 API 无破坏性变更，既有代码不需要任何改动）。若你的宿主自己解析 `/run` 的 SSE，
它**不需要**认识新的 `trace.event` 帧 —— 不认识就忽略，行为与升级前逐字一致。要消费增量事件，
新接 `onTraceEvent`（程序内）或 `GET /tasks/:id/stream`（远程看进度）即可。

## [0.8.2] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.1 → 0.8.2`，含 #112）：**外部双模型复核逐条复现收口** —— 9 条真缺陷
> （7 条复核成立 + 改的过程中照出的 2 条），全部落在「不报错地不干活」这一类：静默丢观测数据、
> 静默无限重试、无声永久挂起、生成出来的工程一跑就崩。
> **框架 API 无破坏性变更**：只新增一个选项（`createOtlpExporter({ onExportError })`），
> 既有签名与行为在「你没传坏值 / 没按 200 当全部成功」的前提下逐字不变。
> **一处需要你确认的收紧**：`maxRetries` 的坏值改在**构造期抛错**（见「修复」与「迁移」）。

### 修复（观测出口 —— 三条都属于「看板少数据而框架说一切正常」）

- **OTLP 导出的 `status.code` 从名字符串改成整数**（`'STATUS_CODE_OK'` / `'STATUS_CODE_ERROR'`
  → `1` / `2`）。OTLP 规范对此是**明文 MUST**，而且专门点出它与 protobuf 的通用 JSON 映射不同：

  > *Values of enum fields MUST be encoded as integer values.*
  > *Unlike the standard Protobuf JSON Mapping, which allows values of enum fields to be encoded as
  > either integer values or as enum name strings, only integer enum values are allowed in OTLP JSON
  > Protobuf Encoding; the enum name strings MUST NOT be used.*
  > —— [OTLP 规范 · JSON Protobuf Encoding](https://opentelemetry.io/docs/specs/otlp/)

  （同期 `kind` 一直是整数 1，只有 `status` 漏了。）**后果取决于你那侧 collector 的宽容度**：
  照规范校验的实现会判非法并**整批拒收**（也就说这些 span 在采集端**根本没落库**，而框架侧只看得到
  「HTTP 200」）；按通用 protobuf JSON 映射的宽容实现（enum 名与整数都收）能落库。
  受影响范围：**`v0.2.2` → `v0.8.1`**（`createOtlpExporter` 自 `v0.2.2` 起就带这个错）。
  动作：升级即可，不需要改代码。**但请顺手去采集端确认一眼**这期间（用严格 collector 的话）
  的 trace 是否为空 —— 你的实现属于哪一档，看那里比看本文档准；丢掉的**历史数据补不回来**。
- **HTTP 200 不再等于「全部接收」**：collector 可以回 `200 + partialSuccess` 表示「收了一部分」。
  此前 `res.ok` 为真就算成功 ⇒ 少了一半数据也没人知道。现在「**真拒收**（键在场且值 > 0）
  **或**非空 `errorMessage`」判为导出失败；`{}` 与 `rejectedSpans: 0` 仍算全部接收
  （有 collector 恒发这种形状，不能反着误报）。
- **新增 `createOtlpExporter({ onExportError })`**（与 `metricsSink` 的同名选项对称）：
  不给，维持既有行为（抛出 → `flushSinks` 吞掉，观测失败不击穿业务）；给了，**所有**导出失败
  （非 2xx / 超时 / **HTTP 200 但部分接收**）都交给它。存在的理由：`TraceSink` 的失败缺省是
  **静默**的，「导出其实少了一半数据」这类消息得有人能收到 —— 否则它和「一切正常」在监控上
  看不出区别。
- **`metricsSink` 的 `reset()` 语义明确为「开启新窗口」**：计数清零**且**数据点起点前移。
  此前 `reset()` 只清计数、而数据点的 `startTimeUnixNano` 取自 sink **创建时刻的常量** ⇒
  同一 `startTime` 下 counter 从 2 退到 1（CUMULATIVE 指标的契约是「同一区间单调不减」，
  后端会算出负增量或直接丢样本）。同一毫秒内连按两次 `reset()` 时起点也**严格**前进。

### 修复（其余）

- **`maxRetries` 的坏值改在构造期抛 `TypeError`**（`createAnthropicClient` /
  `createOpenAIClient`，两条适配器共用一份判定）。重试判定是 `attempt >= maxRetries`，于是
  四类坏值此前被**静默接受**、后果各不相同：`NaN` ⇒ 比较恒假 ⇒ **无限重试**；`Infinity` ⇒
  永不达到 ⇒ **无限重试**；`-1` ⇒ 静默变成「不重试」；`1.5` ⇒ 实际只允许 1 次（读数上看不出来）。
  使用者以为自己设了上限，实际没有 —— 429 场景下每多一次重试都是真金白银。
  **`0` 与不传仍然合法**（`0` = 不重试，是有意义的值；缺省 2）；坏的是「非整数 / 负数 / 非有限」。
- **已中止的 MCP 调用不再发请求、不再永久挂起**：此前的写法是「把 pending 条目删掉、然后照样
  `write`」⇒ ① 副作用请求**仍然送达** server（取消在传输层是无效的）；② 返回的 Promise
  **永远不 settle**（条目已删，没人能 resolve/reject）⇒ 调用方**永久挂起**
  （引擎侧靠 `toolTimeoutMs` 兜底才没炸）。现在判据在 `write()` **之前**，以 `AbortError` 收场
  （取消不是超时，记账仍归 `aborted`）。发送**之后**才中止的，请求已在路上、取消不了 ——
  那是「不等了」，与 `toolTimeoutMs` 同口径。
- **异步 store 下同键并发提交不再重复执行**：`submit` 是**同步门面**、无法 await 异步 store 的
  `byIdempotency`，而 `#executeInner` 只采纳已 `succeeded` 的既有记录 ⇒ 「同时提交两个相同
  `idempotencyKey`」在异步 store（Redis / SQLite）下**两次都执行**（文档承诺的同键去重实际只对
  同步 store 成立）。现在补一张**进程内认领表**：认领在同步前段完成（两次连续 `submit` 之间
  没有窗口），且**只在终态释放**（挂起还在等人，放了会让同键另起一个任务）。
  **边界（同时写进 `usage-guide` §7）**：修的是「同进程内并发提交」这一档；**跨进程并发**与
  **终态之后重提同键**仍是 at-least-once（store 的 idem 索引 last-wins）。
- **`@migor/cli`：模板漏写 `scripts/clean.mjs`**。本版首次给脚手架模板加「构建前先清 dist」，
  并在发布前发现 `create.ts` 忘了把该脚本写出去 —— 生成的新工程 `npm run build` **第一步就
  `MODULE_NOT_FOUND`**。**已发布版本（≤0.8.1）的模板不含这一步，你此前生成的工程不受影响**，
  也不需要改；本版发布的是修好的形态。仓库自身与模板的构建现在都先清 dist（`tsc` 不会删除
  它不再产出的文件 —— 目录重构后旧产物会原样进包），并新增「模板目录 ↔ 源码双向引用」守卫
  （模板文件必须被引用、每个 accessor 必须有调用方）与 e2e 的**真删能力再重建**对照。

### 仓库自身（不面向使用者）

- e2e-cli 的构建步骤从「测试复刻 `clean → tsc → copy-assets` 三步」改成**字面跑产物自己的
  `npm run typecheck` / `npm run build`** —— 这条改法当场照出上面那条真缺陷（测试复刻命令的
  版本照不出来）。同时删掉一条会在合法重构时误报的字面量断言。
- `docs/guards.md` §1 增补五条守卫（OTLP enum + partialSuccess、CUMULATIVE 窗口起点、模板重建
  清 dist、幂等键进程内认领、模板 ↔ 源码双向引用）；`docs/spec.md` §10 ⑤ 记逐条定性、
  反向验证与「报告自称已证伪」的抽查范围。
- `tests/docs/usage-guide.test.ts` 把 `OtlpExporterOptions` 登记进成员表校验 —— 新增选项自此
  被文档守卫钉住（注入假成员验证过会红）。

**迁移**：无（框架 API 无破坏性变更，既有代码不需要任何改动）。唯一需要动作的是 `maxRetries`：
如果你此前给它传过 `NaN` / `±Infinity` / 负数 / 小数，升级后**构造期会抛 `TypeError`** ——
这是有意的（它此前是静默失效），改成非负整数即可；传 `0` 或不传的代码不受影响。

## [0.8.1] - 2026-09-21

### 变更

> 本版主题（窗口 `0.8.0 → 0.8.1`，含 #107–#110）：**出站链路传播** —— spec §9.2 那条
> 「出站传播仍开放」的项收口。**无破坏性变更**：只新增一个公开函数；既有 API、trace 形状、
> OTLP 导出值与 id 生成本身全部逐字不变（id 投影只是从 `integrations/otlp.ts` 的私有函数
> **上移到** `core/trace.ts` 成为单一真源，取值一字未改）。

### 新增

- **`currentTraceparent(): string | undefined`**（出站链路传播）：给出**当前调用期** span 的
  W3C `traceparent`（`00-<32位trace>-<16位span>-00`），自己带在出站请求上（`fetch` 头 / gRPC
  metadata）。下游若也是 agentia（或任何认 `traceparent` 的服务），就能把「谁触发了这次调用」
  关联到**具体 span**，而不是只到 run 粒度：

  ```ts
  import { currentTraceparent } from '@migor/agentia';

  const tp = currentTraceparent();
  await fetch(url, { headers: { ...(tp ? { traceparent: tp } : {}) } });
  ```

  粒度：普通工具与 `@Prompt` **不建 span**，取到的是发起它们的那次 `llm.turn`；`@Skill` /
  `@SubAgent` 方法体内取到的是自己的 `capability` span（内层覆盖外层）。入站那一半
  （`traceparent` 头 → run 根 `links`）已随 0.6.2 落地，本版把出站补上，跨服务关联从此双向。

### 已知边界（同时写进 `usage-guide` §7）

- **只给读取器，不替你做注入** —— 框架不创建出站请求，注入那一行是宿主的（与「webhook 用
  sink + 你自己的 `fetch`」同一条既有决策）。
- `run` 根 span 由 `runAgent` 打开 ⇒ 更早的 `contextInit` / 记忆水合取到 `undefined` —— 那时
  确实还没有 span 可指，不编造。
- flags 位恒 `00`：本框架不采样（每次 run 全量记账），不替下游声明「已采样」。
- id 宽度：内部 id 是 UUID，出站与 OTLP 共用**同一份**投影（trace 去横线 32-hex、span 截
  16-hex）⇒ 下游收到的 span id 与 collector 里那个**是同一个数**（各写一份会让同一次调用在
  两个系统里出现两个 span id）。

### 仓库自身（不面向使用者）

- 第七 / 第八轮复审散件沉淀进 `docs/guards.md` 附录 B，并立「多 agent 同仓作业」三条纪律
  （结论钉 commit / 门禁跑隔离导出树 / 不碰别人的未提交改动）。
- 出处链更正：spec §10 的「132 条直接用例」→ **127**（逐文件计数，独立复核不可复现 132），
  全仓口径改引「+140 条（`tests/` 增量）」；覆盖率棘轮分支 85→88 / 函数 92→95。
- 新增两条守卫并入册：id 投影**单源**（OTLP 与出站必须同一个数）、出站**调用期作用域**
  （并行不串 / 内层不外泄），两条都做过承重性反向验证。
- 发布面清单的 lock 项改为**按包名锚定**：裸 `"version"` 计数会被**恰好同版本号的第三方
  依赖**撞网（本次真发生：`@grpc/proto-loader` 恰好 @0.8.1 ⇒ 闸门报「4 处应为 0.8.1，实际
  命中 5 处」，读起来像漏项）。夹具同步加了同版本诱饵，断言它既不被替换、也不进网。

**迁移**：无。既有代码不需要任何改动；要开始用出站传播，就在出站请求上加一行 `traceparent`。

## [0.8.0] - 2026-09-21

### 变更

> 本版主题（窗口 `0.7.2 → 0.8.0`，含 #83–#105）：**CLI 机器可读面 + 脚手架生产路径修复**。
> 框架运行时 API 零变化；窗口内 23 个提交里 13 个是纯结构拆分（AsyncRunner / turn / loop /
> http 外移判定面，零行为变化），其余大多是仓库自身的门禁与测试加固。
> **一条必须看的修复**：用 ≤0.7.2 的 `agentia create` 生成过工程的，
> `npm run build && npm start` 一跑就崩（discover 目录是 cwd 相对写法，生产形态下会去加载
> `src/` 的 `.ts` 源码）。缺陷在**生成出来的工程里**，升级 CLI 不会自动修好已有工程 ——
> 迁移办法见下方「迁移」。

### 新增（CLI）

- **`agentia --version` / `-v`**：打印 CLI 版本（读包自身 `package.json`）。
- **`report` / `diff` / `doctor` 支持 `--json`**：stdout 只输出一个 JSON 文档，可直接进
  管道与 CI；出错仍走 stderr + 退出码 1，且 stdout 保持空。`harvest` 刻意不加
  （它的 stdout 本身就是产物）；`dev` 额外参数原样透传给用户脚本。
- **脚手架把 `@migor/cli` 写进生成工程的 devDependencies**（与框架同 `^` 版本），`dev`
  script 改为 `agentia dev`：`npx agentia …` 走本地 bin —— 离线可用，且版本被 pin 住与
  框架同批（不 pin 的话老工程会被 npx 拉到最新 CLI）。

### 修复

- **脚手架生成工程的 discover 目录按本文件位置解析，不再是 cwd 相对字符串**（本版最高
  优先级）：旧模板生成的工程 `npm run build && npm start` 必崩
  "Invalid or unexpected token"（生产形态下去加载 `src/` 的 `.ts` 源码，而装饰器不是
  可擦除语法），换个 cwd 启动连目录都找不到。**0.7.2 及之前所有版本生成的工程都带此
  缺陷。** 新写法按 `import.meta.url` 相对本文件解析（开发态 `src/`、构建后 `dist/` 都
  成立），并过滤不存在的分类目录（空分类 tsc 不产出 `dist/<分类>/`，「这类暂时没有能力」
  不该让启动失败）。

### 迁移

- **用 ≤0.7.2 的 `agentia create` 生成过工程的**：把工程 `src/main.ts` 的 discover 段
  换成新模板的写法（重新 `agentia create` 一个同名工程对照抄过来即可 —— 核心是目录按
  `new URL(d + '/', import.meta.url)` 解析 + `existsSync` 过滤这两处）。
  框架 API 本身无破坏性变更，`@migor/agentia` 与 `@migor/cli` 升到 `^0.8.0` 即可。

### 内部（不影响使用者）

- 纯结构拆分 13 件：AsyncRunner 五步（SlotPool / approval-policy / DrainGate /
  resume-policy / TaskWaiters）、`turn.ts` 四步、`loop.ts` 三步、`http.ts` 两步 ——
  判定面有名字、编排留在原处，零行为变化（#85–#100）。
- Biome 零告警闸门：93 warnings + 12 infos → 0，verify-all 第 1 步与 CI lint job 翻
  `--error-on-warnings`（#84）。
- 计时断言不再卡预算边界、改用单调时钟量（#102 / #103）。
- 覆盖率棘轮门禁（c8：行 95 / 分支 85 / 函数 92）+ e2e-cli 折入「npm pack → 离线安装 →
  装出来的包真跑最小 run」（#104）。
- CLI 模板从字符串升级为真文件（`packages/cli/templates/`，生成产物逐字节不变）（#105）。

## [0.7.2] - 2026-09-20

### 变更

> 本版主题（窗口 `0.7.1 → 0.7.2`，含 #77–#81）：**第九轮评审收口** —— 一条高优先级的
> **HITL × `sessionStore` 组合破口**（挂起任务恢复后历史翻倍、成功后又把坏会话写回去），
> 外加六条中/低优先级的静默失效修复；其余是纯结构重构、回归测试补课与依赖升级。
> **无破坏性变更，不需要改代码**：所有修复都是「旧行为本来就不该那样」。
> **两处错误归类收紧（记账口径，不是行为变更）**：Anthropic 流内 4xx 不再落成可重试的
> `server`，异步宿主的 `runTimeoutMs` 超时不再落 `unknown`。宿主若按 `error.type` /
> `errorKind` / `retryable` 分支（重试、告警、看板），取值会更准 —— 见下方两条。
> 本条目的多数内容**是在本次发版时回填的**：窗口内 5 个 PR 都没写 CHANGELOG，
> 条目按各提交正文重建。

### 修复（第九轮评审收口）

- **HITL × `sessionStore`：挂起任务恢复后会话历史翻倍 + 成功后毒化会话**（本版最高优先级）：
  恢复段曾把 session 再注入 `app.run`，而挂起段落库的 `suspendedMessages` 已含完整历史 ⇒
  run 层 `loadSession` 又 prepend 一遍（历史翻倍、token 复利）；且成功后 `appendSession`
  会把含未决 `tool_use` 的整段扩展历史写回会话 —— 该会话**下一轮直接撞 API 400**
  （孤立 `tool_use` + 连续 assistant）。现在恢复段不再注入 session，会话回写改由
  `AsyncRunner` 按「本轮用户输入 + 最终回复」补，口径与 `run.ts` 的三条不变量一致。
- **惰性审批超时 `#expireAndResume` 补重入闸 + 进闸后重读 store**：异步 store 下两个并发
  `poll` 各拿到一份 `awaiting` 副本 ⇒ 双双填超时拒绝、**双双派发**（同一任务跑两遍）。
  现在与 `approve` 共用同一把 per-taskId 在飞闸。
- **MCP StreamableHTTP 连接器不再丢弃 `abandoned`**：`tools/call` 把引擎的「放弃等待」
  信号透传到在飞 `fetch`（含会话 404 自愈那次重试）—— 裁判放弃后真能掐掉请求，
  而不是继续在后台烧。stdio 侧 #75 的 `pending` 出簿修复这次补上了回归用例。
- **Anthropic 流内 `error` 事件的 status 反推补 4xx 档**：`invalid_request_error` /
  `authentication_error` / `permission_error` / `not_found_error` → 400（归 `api`、
  **不可重试**），与 `openai.ts` 同口径。此前这些确定性病因落 500 + `retryable:true`，
  引擎会白重试 3 次（3 次网络请求 + 3 倍等待）。
- **异步宿主 `runTimeoutMs` 的超时错误不再落 `unknown`**：改用 `core/timeout.ts` 的
  `TimeoutError`（`code='timeout'`），与引擎工具超时 / MCP 桥兜底同口径。归类由
  `unknown`（`retryable:false`）变为 `timeout`（`retryable:true`）—— 这只是**记账口径**：
  超时按定义属可重试故障，框架**不会**因此自动重跑整个 run，要不要重试仍由宿主决定。
- **`FileTaskStore.save` 改为先落盘、成功后再更新内存**：落盘失败时内存不再推进，
  避免内存与磁盘两本账、重启后静默回退（`get` / `byIdempotency` 查不到未落盘的记录）。
- **Anthropic SSE 组装拦畸形 `content_block_start.index`**：超大 index（如 `1e9`）会造出
  稀疏数组、后续 `for...of` / `reduce` 按 `length` 空转；现在畸形 index（负数 / 非整数 /
  超上限）响亮抛 `AnthropicApiError(500)`。

### 重构（纯结构，零行为变化）

- `integrations/metrics.ts`（1050 行）→ `metrics-state.ts` / `metrics-render.ts` /
  `metrics-otlp.ts` / `metrics.ts`（只留选项校验、定时器与组装）；
  `integrations/mcp.ts`（897 行）→ `mcp-stdio.ts` / `mcp-http.ts` / `mcp.ts`
  （桥 + 共享 helper + re-export 两个连接器工厂）。**公共面与运行时行为不变**。

### 测试

- 补上 #75 遗留的回归用例：stdio MCP 连接器「裁判放弃等待 ⇒ `pending` 记账出簿」的防泄漏
  修复此前**没有任何用例守着**（夹具新增 `silentcall` 模式：握手 / `tools/list` 正常、
  `tools/call` 永不回包）。

### 依赖

- 开发依赖：`@anthropic-ai/sdk` → 0.126.0、`@biomejs/biome` → 2.5.14、
  `@types/node` → 26.6.1、`zod` → 4.6.5（均不影响运行时面）。
- 官网（不随包发布）：`astro` → 7.3.3。

## [0.7.1] - 2026-09-19

### 变更

> 本版主题（窗口 `0.7.0 → 0.7.1`，含 #71–#75）：**HITL 人工审批**（挂起 / 恢复、跨进程耐久）、
> **gRPC 宿主配方与可跑示例**，以及**连续四轮复审收口**（第八轮「时间维度」、外部四路复审、
> 外部复核的复核）。这批改动绝大多数是同一族病灶 —— **「不报错地不干活」**：超时不清簿记、
> 重试不排空响应体、非流式回落零校验、回调通道缺失、幂等键赢家跨重启易主、门禁被 `&&`
> 短路静默跳过。
> **两处使用者会遇到的行为变更**：① OpenAI 兼容端点返回 legacy `function_call` 形态时，
> 不再静默以 `end_turn` 收尾，而是抛 400（确定性不兼容 ⇒ 不重试），见下方
> 「legacy `function_call` 形态响亮失败」；② MCP / 预算护栏 / 异步宿主的若干语义收紧
> （会话过期自愈加互斥、`close()` 超时不挂死、未配 `sessionStore` 时 `submit` 响亮失败），
> **都不需要改代码**。
> **一处破坏性变更（仅类型面，运行时行为不变）**：`RecorderBackend` 新增必填成员 `usage()`；
> `BudgetGuard.check` 入参由 `Trace` 收窄为 `{ readonly totalUsage: Usage }` ——
> 迁移写法见本节末的「迁移」小节。

### 修复（外部四路复审收口：文档承诺了代码没做的事）

- **`AsyncRunner.approve` 补并发重入闸 + 真落库再派发**（HITL 补丁）：并发 approve
  （双击「批准」/两个审批人同时批）曾在 store 往返窗口内各自判「决定齐了」、
  **各派发一次**（同一任务重复执行）；且它用着吞错的 `#safeSave` 却在注释里承诺
  「先落库再派发」。现在并发调用共享在飞那次（第一次决定赢），落库失败 ⇒
  调用方收到 reject、**绝不派发**。
- **MCP StreamableHTTP 连接器：`tools/call` 不再起第二个计时器**（`timeoutMs` 只管
  装配期的握手/`tools/list`，与 stdio 侧对称；工具调用的裁判仍是引擎的
  `toolTimeoutMs`）。顺带修复：非 SSE 响应的 id 改为**等值配对**（原只验「id 是
  number」，串包时会把别的请求的结果当本次的返回）。
- **gRPC 示例 `getTask` 补 try/catch**：grpc-js 不接管 async handler 的 Promise，
  store 抛错会以 unhandledRejection 终止进程。
- **soak 脚本两处假绿**：采样不足时「跳过内存断言」却照打「内存有界」⇒ 采样间隔
  随时长缩放、样本不足硬失败；宽区间失败率断言换成**逐笔对账**（每个不可重试故障
  恰好杀死一个 run：`failed ≥ 注入数` 且超出部分 ≤ 请求的 0.1%）。
- 文档对齐：usage-guide 曾写同步 `/run` 返回「含 `suspendedMessages`」（响应体没有
  该字段）—— 改文档：要审批请走 `POST /tasks` 异步宿主。

### 修复（第八轮复审：时间维度的三处破口）

- **子 agent / skill 被 `toolTimeoutMs` 超时后，capability span 在交付的 trace 里永不收尾，
  且后台继续烧的 token 不进任何观测面**。新增 `ToolRunContext.abandoned`：引擎「放弃等待」
  时 abort 它 —— @SubAgent / @Skill 收到信号即中止子循环（在飞请求被掐掉），capability
  span 立刻以 `error`（`timeout`）收尾（trace 是浅拷交付的，等子循环自己 settle 再关
  就进不了已交付的那份）。自定义工具要「真停」同样监听它。
- **Scheduler 的 `at()` / `every()` 挡 32 位定时器溢出**：超过 2³¹-1ms（约 24.86 天）的
  延迟会被 Node **静默**钳到 1ms —— `at(30 天后)` 变成立即触发、`every(34 天)` 退化成
  每毫秒空转。现在构造期抛错（与 `runTimeoutMs` 同款防线）。
- **skill 方法体 `try/catch` 掉 `ctx.llm()` 失败并降级时，capability span 不再被误标
  error**（旧实现把「子运行失败」提前烙进 span，幂等守卫让整体成功的调用翻不了案）。

### 新增（HITL 人工审批：挂起/恢复，跨进程耐久）

- **审批 = 异步 tool_result**：`@Tool({ approval: 'required' })`（或裸 `AgentTool` 的 `approval`
  字段）声明后，模型每次调用该工具都会把任务**挂起**：run 状态变为 `awaiting_approval`，
  **整个回合一个工具都不执行**（回合级全有或全无 —— 协议要求每个 tool_use 配对 tool_result）；
  完整消息历史（末尾是含未决 tool_use 的 assistant 消息）与待决清单（`pendingApprovals`）
  随 `TaskRecord` 落库，进程重启不丢。
- **恢复**：`runner.approve(taskId, decisions, { decidedBy? })` 或
  `POST /tasks/:id/approve`（body `{ decisions: { <tool_use_id>: { approved, reason? } }, decidedBy? }`）。
  **逐 tool_use_id 幂等**（第一次决定赢）；决定齐了整个回合恢复执行：批准的工具正常执行
  （工具体内经 `ToolRunContext.approval` 读到决定），拒绝的得 `tool_result(is_error,
  '审批被拒绝：…')`（理由回给模型，可自行换路）。恢复后再遇未决审批 ⇒ 再次挂起（可等多轮）。
  引擎侧的恢复是**通用**的：任何「assistant 结尾带 tool_use」的消息历史喂给
  `runAgent` / `app.run` 都会先解决这些 tool_use 再调模型。
- **状态语义**：`awaiting_approval` 是**非终态**（`awaitTask` 继续等）、不占并发槽、
  不触发 `TaskSink.onFinished`、`resumePending` 不捡（它不是孤儿，是在等人）、
  InMemory 淘汰跳过、同幂等键重复 submit 返回等待中的任务。挂起段的 trace **照常投递
  sinks**；恢复段是一棵新树，经根 span 的 `links` 挂到上一段 runId。
- **审批超时兜底**：`new AsyncRunner(app, { approvalTimeoutMs })`（缺省 0 = 一直等）。
  **惰性判定、不起定时器**：`approve` / `poll` / `resumePending` 读到过期挂起任务时，
  自动把全部待决项写成「拒绝：审批超时」并恢复执行。
- 新公共面：`ApprovalDecision` 类型；`RunAgentOptions.approvals` / `RunInvocationOptions.approvals`；
  `AgentRunResult.suspendedMessages` / `pendingApprovals`（字段恒在场，未挂起为 `undefined`）；
  `AgentStopReason` 与 `RunStatus` 各增 `'awaiting_approval'`；`AsyncRunner.approve` /
  `approvalTimeoutMs`；trace 事件 `approval.requested` / `approval.decided`（带 waitedMs）。
- 已知边界（详见 usage-guide §7）：超时惰性判定；指标按段计；批准后崩溃 ⇒ at-least-once
  重执行；预算口径在恢复段重新起算；嵌套能力（子 agent / skill 子循环）内的审批工具
  不支持挂起整个 run；同步 `POST /run` 撞上审批会带 `awaiting_approval` 返回（要审批请走
  `/tasks`）。

### 修复（外部复核的复核 + 三条一致性缺口收口）

对上一轮「四路复审」的修复（31 个文件）逐条复核并实测通过；另补三条「守卫没覆盖自己
声称范围」的缺口与一处护栏开销：

- **MCP HTTP `close()` 的 DELETE 现在过 `guard`**：此前直接 `await fetchImpl(...)`，外层
  `catch` 只兜得住**抛错**、兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
  `close()` 就永久挂住，而调用方是**宿主停机路径**（挂住比失败更糟）。fetch 与 body 排空
  一起进 guard（只护住响应头，`readText` 照样能卡）。摘掉修复 ⇒ 新用例在 8s 测试预算下
  被 `cancelledByParent` 取消。
- **`asset()` 拦绝对路径**：守卫此前只拦带 scheme 的 `rel`，但 `/etc/passwd` 与
  `file:///etc/passwd` 是同一类（`new URL` 会把 base 的路径部分整个丢掉）——
  「以为读了能力目录里的文件，实际读了别处」（macOS 上**真能读到**）。`../` 仍放行
  （它是相对 base 解析的，base 没被忽略）。
- **预算护栏改走廉价 usage**：新增 `TraceRecorder.usage()`（只扫 spans 求和、不拷
  attributes/events），`snapshot().totalUsage` 改为调它 ⇒ 两条路不可能漂移。护栏每回合
  要判**两次**（回合入口 + 回合末，是不同决策点，**刻意不合并**），此前每次都全量
  `snapshot()` ⇒ O(回合 × 累计事件量) 的白拷。
- 测试基建：`mcpConnector` 的 stdio 握手缺省预算 5s → 20s（`node --test` 按文件并行，
  重负载下**子进程启动**本身就可能吃掉数秒；断超时行为的那条用例自带 `timeoutMs`）。
- 复核结论一条「查过但不改」：`interruptibleSleep(0, 已中止的 signal)` 仍 **resolve** ——
  它与 `withTimeout(p, 0)` 的「非正数 = 机制关掉」是同一口径，不是缺口（本轮曾误改，
  被既有用例拦下后回退；那条用例的断言已从隐式 `await` 改成显式 `assert.doesNotReject`
  并写明理由，见 spec §10 2026-09-19 ④）。

**迁移（自己实现这两个结构面时）**

- `BudgetGuard.check` 的入参由 `Trace` 收窄为 `{ readonly totalUsage: Usage }`。
  **传整份 `Trace` 的调用方不受影响**（结构上满足）；自己实现 `BudgetGuard` 的代码需把
  签名改宽，且**不得再读 `spans`**（类型上已读不到 —— 「只看 totalUsage」由注释变成约束）。
- `RecorderBackend` 新增必填成员 `usage(): Usage`。自己实现该结构面（或自建 recorder
  替身）的代码需补上。

### 新增（gRPC 宿主配方与可跑示例）

- **不对 Kafka / gRPC 做「服务包」**，但把真缺的那一块做成配方 + 可跑示例：gRPC 宿主必须
  自己接上的**四处**（deadline / 取消 → `signal`、`metadata` 的 `traceparent` → `traceContext`、
  框架错误 → gRPC 状态码、trace → sink），四处漏掉**都不报错**。判别规则只有一条 ——
  客户端是不是标准库（MCP 用 `spawn` + `fetch` 所以能内置，gRPC / Kafka 要引第三方客户端），
  决策见 spec §10 2026-09-18 ⑪。
- `docs/usage-guide.md` §6.2 新增「gRPC 宿主」配方；`examples/grpc-host/` 给了 proto + 宿主 +
  客户端 + README（一元 / 服务端流 / 异步投递 / 查任务，`PORT=0` 自报端口、无抢占窗口）；
  `scripts/e2e-grpc.ts` 真构建真起宿主、用它自带的客户端跑四个 RPC，并入 `npm run e2e` 第四步。

### 修复（OpenAI 兼容端点：legacy `function_call` 形态响亮失败）

- 兼容端点把工具调用放在 `message.function_call` 时，适配器只读 `tool_calls` ⇒ 此前落进
  `default: return 'end_turn'`，**模型要调的工具被丢掉、run 却以成功收尾**（模块头写的正是
  「上游故障绝不映射成成功」）。现在 `function_call` 抛 `OpenAICompatApiError(400)`：这是
  **确定性不兼容** ⇒ 落 `classifyError` 的 `api` / 不可重试（用 500 会被引擎重试三次，每次
  都重复丢弃同一个调用）；也**不做 legacy 兼容**——请求侧只发 `tool_calls`，回灌的
  `role:'tool'` legacy-only 端点同样吃不下，半吊子支持比不支持更糟。`default` 仍是有意的
  `end_turn`（未知值**且有正文**），并补 `eos_token` 用例把这个有意默认钉住，防后人顺手改成抛错。

## [0.7.0] - 2026-09-18

### 变更

> 本版两个主题：**MCP 连接器出厂自带**（新增公共 API：`createStdioMcpConnector` /
> `createStreamableHttpMcpConnector` / `McpConnector` / `MCP_CLOSE_GRACE_MS`），
> 以及一轮复审与「已知边界」收口。**两处行为变更，都不需要使用者改代码**：
> ① StreamableHTTP 会话过期从「抛错、需重建连接器」变成**自愈**（多了个可选的
> `onSessionExpired` 钩子）；② `close()` 从「到点即返回」变成「返回即子进程已终止」。
> **无破坏性变更** ⇒ 不需要迁移动作。

### 修复（MCP 连接器两条「已知边界」收掉）

- **StreamableHTTP 会话过期不再需要人工重建连接器**（`404` 自愈）。带会话 id 收到 `404` 的语义是
  「这个会话我不认识」⇒ **该请求没有被 server 执行** ⇒ 连接器丢会话、重新握手、把**这一次**重试一次
  （**只一次**，第二次再 404 直接抛，不循环）—— 这也是 MCP 规范对客户端的要求。
  此前按不可重试的 `api` 错抛出，长跑宿主的会话一过期就得**重建整个连接器**。
  自愈本身是静默的，所以给了 **`onSessionExpired`** 钩子：不挂它就没人知道恢复发生过 ——
  「静默恢复」和「静默失效」在监控上看不出区别。
- **`close()` 现在保证返回时子进程已终止**（stdio）。此前「到点即 resolve」：SIGTERM → 等
  `MCP_CLOSE_GRACE_MS` → SIGKILL **并立刻返回**，此刻子进程往往还在（未回收）—— 调用方以为
  进程没了，实际留下一个孤儿。现在 SIGKILL 之后**继续等真正的 `'exit'`**（SIGKILL 不可被捕获，
  该事件必达）。
- 验证：`tests/integrations/mcpConnector.test.ts` 27 → 31 例；
  **变异电池 6/6 全部被抓到、0 漏网**（删自愈分支 / 丢掉 `sessionId !== null` 前置 / 重试透传
  `allowReinit`（无限重试）/ 去掉 `onSessionExpired` / `close()` 恢复不等 reap / 夹具不再忽略
  SIGTERM ⇒ 证明那条用例真在测 SIGKILL 路径）。

### 修复（官网手写数字：补上真正没被守的那几个）

- `api.html` 的 `0 个运行时依赖` / `4 类能力` 与 `index.html` 首屏的 `4 类能力` / `0 个运行时依赖` /
  `3 类触发` **此前没有任何断言** —— 加一个运行时依赖、增删一类能力或触发宿主，页面会继续写旧数字
  而没人拦。现在逐条对源码核（`package.json` 的 `dependencies` 数 / 四个能力装饰器 / 三个传输宿主）。
  变异电池 3/3 会咬（改成 1 / 5 / 4 各判红一次）。
  ⚠️ 顺带**更正一处过度声明**：`210 个导出` 与 `9 个层次` **本来就有守卫**
  （`api-page.test.ts` 已有：前者对 `src/index.ts` 导出数、后者对页面 section 数）——
  它们从来不是缺口。首屏 `1:1 run ↔ trace`（真守卫在 `traceLink.test.ts`）与 `0 反射`
  （策略声明，无法从源码计数推导）**刻意不推导**，已在 `guards.md` §2「待守」登记。

### 新增（MCP 连接器**出厂自带**：stdio + StreamableHTTP）

- **`createStdioMcpConnector(cmd, opts?)`** / **`createStreamableHttpMcpConnector(url, opts?)`**
  —— MCP 的两种传输现在随框架发布。此前只有 `mcpTools()` 那条 duck-typed 桥，**连接器要自己写**：
  官方示例只有 `scripts/e2e-mcp.ts` 里一份 94 行的最小参考（还是内联在脚本里的私有副本）。
  公共面另加 `McpConnector`（`McpClientLike` + `close()`）与 `MCP_CLOSE_GRACE_MS`。
  **只用标准库**（`node:child_process` + 全局 `fetch`）⇒ 不新增任何第三方依赖，「零运行时依赖」不变；
  也**没有**放宽「第三方 SDK 对用户不可见」—— 一个 MCP SDK 都没 import，`McpClientLike` 这条缝原样保留
  （接官方 SDK / 远程 server / 自研传输照旧走它）。
- **本条反转了 2026-09-11 的 F7**（「连接器放独立可选包 `@migor/mcp`」）。那个包**从未发布**，
  而仓库里有 5 处注释把它当既成事实引用（含 `src/index.ts` 的公共面注释）—— 现在全部改正。
  为什么反：F7 的理由「守住零运行时依赖」不成立（该口径 = 不依赖**第三方包**；`spawn` / `fetch` 都是
  标准库），且 `store/` 的三层形状里「只用标准库的平台能力」一律内置（`FileTaskStore` / `SqliteTaskStore` /
  HTTP 宿主），独立包才是那个例外。完整论证与可逆性判据见 `docs/spec.md` §10 **2026-09-18 ⑨**。
- **连接器替你兜住三件只有它能做的事**（此前只活在 `scripts/e2e-mcp.ts` 那段内联副本里，无门禁守着）：
  ① spawn 失败的 `'error'` 是**异步事件**，不接住就是未捕获异常（真实宿主进程直接崩，没有 try/catch
  接得住）；② stdout 必须按 `\n` **攒包**（一条报文可能跨多个 chunk）；③ **协议层 `isError: true`
  转成抛错** —— 否则模型收到一条「成功」的结果、trace 也把这次失败的调用记成成功。
- **连接器的 `timeoutMs` 只管装配期**（握手 + `tools/list`）：那两步此前**没有任何裁判**，server 卡住会让
  `createApp` 永久挂起；`callTool` 的裁判仍是引擎 / 桥（延续「一次调用只有一个裁判」）。
- **已知边界**：StreamableHTTP 会话过期（带会话 id 收到 `404`）**不自动重握手**，按不可重试的 `api` 错抛出；
  `close()` 幂等且**有界**（SIGTERM → 2000 ms 后 SIGKILL），但**不保证等到子进程被 reap**。
- 验证：新增 `tests/integrations/mcpConnector.test.ts` 27 例（stdio 侧起**真子进程**）；
  **变异电池 9/9 全部被抓到、0 漏网**；`npm run e2e:mcp` 改为走出厂连接器后真第三方 server 全绿 ——
  此前那条端到端证明测的是它自己那份私有副本，现在测的是用户拿到的东西。

### 修复（第七轮复审收口：三处「不报错地不干活」）

- **Anthropic 适配器：流被截断 / 空流现在抛带 `status` 的错误**（`AnthropicApiError(500)`）。
  此前两处抛裸 `Error` ⇒ `classifyError` 判 `unknown` + `retryable:false`：上游故障被记成「模型的
  协议问题」（排障方向被带偏），且**引擎层重试一次都不会发生**。更糟的是「已吐出半句之后断流」——
  内容非空使旧判据（`!started`）不触发，`stop_reason: null` 落 `unknown_stop_reason`（同样不可重试）。
  现在按 openai 侧同款判据：**既无 `message_stop`、也无 `message_delta` 的 `stop_reason` ⇒ 抛 500 可重试**。
- **OpenAI 适配器：流内 error 分片的 status 反推分三档**（此前只把限流判 429、其余一律 500 + 可重试）。
  `invalid_request_error` / `context_length_exceeded` / `model_not_found` / 鉴权 / `content_filter` 这类
  **改配置才有救**的 4xx 病因现在判 400 且**不可重试**（此前白重试 3 次、trace 记成 `server` 而非 `api`）。
- **OpenAI 适配器：非流式路径的「200 + 空补全」不再记成成功**。`choices[0].message.content = null`
  + `finish_reason: 'stop'` 此前映射成「空文本 + end_turn」成功收尾，而同一响应在**流式**路径上会被判
  失败 —— 两条路径结论相反，且与模块头「上游故障绝不映射成成功」相反。`content_filter` 的合法空回复
  仍豁免（与流式同款例外）。
- **`AsyncRunner.resumePending` 补重入闸**：并发/重入调用现在**共享同一次扫描的结果**（返回在飞那个
  Promise，而不是谎报 0）。「先落库再派发」只堵住了**串行**重扫 —— 认领是异步的，两个并发调用都在任一
  `save` 落地前 `list()` 到旧快照，`ownerId` 过滤双双失效 ⇒ 同一任务被派发两次（副作用与花费翻倍）。
- **`metricsSink`：基数折叠在 `/metrics` 上可见** —— 新增 gauge 家族
  `agentia_dropped_keys{kind="capability"|"model"|"score"}`（Prometheus 与 OTLP 两侧都出，恒定发三个样本）。
  此前 `droppedCapabilities/Models/Scores` 只存在于 `snapshot()`，而文档让用户把 `metricsSink()` 接到
  `GET /metrics`（只消费 `render()`）⇒ Prometheus-only 的部署**完全看不见折叠发生**（静默丢失）；
  对照：同一份文件对「算不出成本的 turn」专门发了 `model_unpriced_turns_total`。
- **`metrics.ts` 的 OTLP 导出失败改抛 `MetricsExportError`（带数值 `status`）**：裸 `Error` 被判
  `unknown`，宿主在 `onExportError` 里拿不到 status，无法区分「collector 拒收（4xx，改配置）」与
  「collector 挂了（5xx，等它回来）」。

### 修复（守卫自身的洞 —— 本版主题是「把没门禁的约定收口」，而守卫自己有洞）

- **`tests/architecture/transport-errors.test.ts` 的注释剥离会瘫痪整份文件的扫描**（严重）：
  旧实现把每行「截到 `//` 为止」，而 `//` 会出现在**字符串里**（最典型是 URL）。截断会切掉该行闭合的
  `)` 与反引号 ⇒ `bareErrorThrows` 的括号配平一路吃到文件末尾 ⇒ **那一行之后的每一处抛错都再也扫不到、
  且全程不报错**。实测 `src/integrations/metrics.ts`：8 处裸抛错只剩 2 处可见，被吞掉的正好包括
  `OTLP metrics 导出失败: HTTP ${res.status}`（本守卫存在的理由）。改为「整行丢弃注释行」，
  并以合成样本复现该机制作回归钉（旧实现下会红）。
- `tests/docs/guards-registry.test.ts` 的**条目密度下限由 8 提到 24**（实测 32）：旧下限意味着删掉
  注册表 §1.1–§1.3 整整三节仍会绿 —— 防「抽词器退化」的护栏同时替「整节被删」放了行。

### 仍未做（如实标注，下一轮）

- `tests/integrations/adapter-parity.test.ts` 的矩阵**结构上测不到「缺省 `maxRetries` 对称」**：
  `make(maxRetries: number)` 是必填、所有场景都显式 `a.make(2)` ⇒ 把 openai 的缺省改成 0 仍全绿。
  而该矩阵被造出来正是为守这件事（修法：加一条走缺省的场景）。
- `maxToolConcurrency` 是否该随 `ToolRunContext` 透传给嵌套能力（`docs/guards.md` §2 已登记的
  「手写转发列表不得漏字段」形状，历史事故 = `runAgentScoped` 漏 `toolTimeoutMs`）—— 待口径判定：
  转发，或在 `types.ts` 注明「只作用本层循环」。


## [0.6.3] - 2026-09-18

> 本版主题：把第六轮 16 条的共同根因（「约定写在文档里、但没有门禁」）收口 ——
> 守卫注册表 + 三个新架构守卫 + 适配器对拍矩阵；`exactOptionalPropertyTypes` 全量迁移；
> OpenAI 适配器补齐客户端内层重试（与 anthropic 对称）。**无破坏性变更**。

### 新增（守卫基建 + 适配器对齐）

- **守卫注册表 `docs/guards.md`**：「哪类危险由谁守」的单源清单（§1 已挂守卫 → 保护的
  不变量 → 退化后果；§2 待守缺口；§3 写法纪律），配套 PR 模板的「危险类自查 5 问」。
- **两个新架构守卫**：`tests/architecture/transport-errors.test.ts`（`integrations` 的
  传输抛错必须带数值 `status`，否则 `classifyError` 判 unknown、重试层静默失效 ——
  上线当天即抓到 `otlp.ts` 的同形漏网）与 `tests/architecture/tsconfig-strictness.test.ts`
  （`exactOptionalPropertyTypes` / `strict` / `types:["node"]` 三个承重开关不得被关）。
  另有元守卫 `tests/docs/guards-registry.test.ts` 防注册表本身腐化。
- **`OpenAIClientOptions.maxRetries`（缺省 2）**：OpenAI 适配器补齐**客户端内层重试**
  （408/409/429/5xx + `retry-after` 尊重，与 `createAnthropicClient` 逐字对齐）——
  此前同一个 429 在 anthropic 打 3 次网络请求、在 openai 只打 1 次（引擎层那一次）。
  对称性由 `tests/integrations/adapter-parity.test.ts` 守住（一份场景表跑两侧 + 跨侧
  对称断言）。
- **`exactOptionalPropertyTypes` 开启并完成迁移**（39 处 `error TS` 全清）：结果/状态
  记录改必填 `T | undefined`、内部管道 `?: T | undefined`、**公共入参签名不动**（调用点
  条件展开或 `omitUndefined`）。「显式 undefined ≠ 不传」从此是类型级约束 ——
  `retry: { maxAttempts: undefined }` 静默关重试这类写法在编译期就写不出来。

### 修复

- **`createOtlpExporter` 非 2xx 改抛 `OtlpExportError`**（带数值 `status`）：此前裸
  `Error` 会被 `classifyError` 判 `unknown` + 不可重试（与 OpenAI 适配器同形的病，
  由新守卫抓到）。

### 重构

- 两条适配器的 client 层退避（`backoffMs` / `interruptibleSleep`）单源收进
  `core/timeout.ts` —— 此前曾短暂存在 anthropic / openai 两份逐字副本；「不与引擎层
  `backoffDelay` 合并」的例外仍在（±25%+retry-after vs ±20%，策略不同）。

## [0.6.2] - 2026-09-18

> 本版主题：第六轮全量 review 收口 —— 16 条「不报错地不干活」修复（含两处**语义变更**，见下）、
> eval 分数进指标的 `beforeFlush` 时序缝、metrics 三维度基数封顶、trace 跨进程入站关联。
> **无破坏性变更**：两处语义变更（OpenAI 流式截断判据、MCP 桥对显式 `toolTimeoutMs: 0` 的裁判）
> 都是「此前错误的行为被改正」，正常用法不受影响。

### 修复（第六轮全量 review：「不报错地不干活」一次收口）

- **OpenAI 兼容端点的引擎重试此前整体失效**：非 2xx 抛的是裸 `Error`（无结构化 `status`），
  `classifyError` 一律归 `unknown + 不可重试` —— 兼容端点吃一个 429 就整轮 run 失败。
  现在抛 `OpenAICompatApiError`（带数值 `status`，与 `AnthropicApiError` 同形；module 级导出，
  不进公共面），429 → `rate_limit` 可重试；流内 `error` 分片（塞进 200 的流里的故障）按
  `type`/`code` 反推 status（`rate_limit` / `insufficient_quota` / `too_many` → 429）。
- **OpenAI 流式截断不再被记成成功**（**语义变更**）：终止判据从「累积为空」换成
  「既无 `[DONE]` 也无 `finish_reason` ⇒ 上游故障」—— 此前截断发生在已吐出半句之后时，
  半截输出被 `end_turn` 收尾上报。反向也对齐：正常终止但空的流若 `finish_reason=content_filter`
  不再误抛，与非流式路径同样记 `refusal`。
- **Anthropic 适配器的 usage 合并不再被显式 `null` 清零**：网关型端点的 `message_delta`
  带 `input_tokens: null` 时，浅合并会把 `message_start` 的真实计量抹掉，该回合 input/cache
  token 与 `costEstimate` 归零（`maxCostUsd` 护栏随之失效）。现在 `mergeUsage` 跳过
  `null`/`undefined` —— 缺值的语义是「保持已有值」，不是「清空已有值」。
- **`maxToolConcurrency` 的 (0,1) 小数不再静默丢弃全部工具**：`Math.floor(0.5) = 0` 曾意味着
  零 worker、工具一次都不执行。现在正数一律至少 1 个 worker；run 根快照记**生效的整数**
  （不限记 `'off'`，不再把 `NaN` / `-1` 写进 trace）。
- **`.env` 引号值 + 行内注释不再把字面引号写进值**：`A="sk-..." # prod` 曾被解析成含引号的
  `"sk-..."`（每个请求 401，文件看上去完全正确）。引号判定改为「扫到闭合引号为止，其后只允许
  空白或 `#` 注释」；未闭合 / 有残留回退未加引号分支，不猜。
- **`toolTimeoutMs` 现在透传给子 agent / skill 的子循环**：此前嵌套 run 里工具**永不超时**，
  且 MCP 桥找不到引擎预算会另起 60s 兜底 —— 双计时器 + 双账本。
- **MCP 桥裁判判据改为 `!= null`**（**语义变更**）：显式 `toolTimeoutMs: 0`（引擎表态「不限」）
  时桥不再自作主张判 60s —— 说了不限就该不限。
- **异步任务的崩溃恢复不再可能重复派发**：`resumePending` 认领时**先落库再派发** —— 此前认领
  只改内存，对 `list()` 返回反序列化新对象的 store（sqlite/redis），窗口内第二次扫描会把
  同进程正在跑的任务再派发一遍（重复执行、重复副作用、重复花费）。
- **优雅停机不再可能永不返回**：`handler.drain({ timeoutMs })` 在 deadline 已过时直接返回
  `false`，不再把「已到点」透传给 `0 = 不限` 的语义（SIGTERM 容器被强杀、在飞任务硬切）。
- **显式 `undefined` 不再覆盖重试缺省**：`{ maxAttempts: undefined }` 这类透传组装曾把重试
  静默关闭（快照记 0，像用户主动关的）/ 让退避算出 `NaN`。现在显式 `undefined` 回落缺省。
- **静态 `@Prompt` 不再被同名实例方法静默撞掉**：静态扫描改为按**解析后的菜单名**去重，
  实例↔静态真重名交给装配期抛「菜单能力重名」（对齐 spec §7「重名即抛」）。
- **`tool_use_no_blocks` 收尾现在带结构化 `error`**（`type:'agent_error'`）—— 此前该分支
  `status:'failed'` 但 `result.error` 是 `undefined`，HTTP body / 任务记录里看不出为什么失败。
- **`POST /tasks` 的 store 落库故障不再回 400 + 内部原文**：新增 `TaskInputError`（module 级，
  不进公共面）区分「调用方参数错」（400 + 原因）与「服务端故障」（500 + 走 `exposeErrors`
  策略）；读 body 期间开始停机的竞态回 503。
- **长上下文压缩不再切出孤儿 `tool_result`**：`compactMessages` 的切点校验换成「保留段工具
  自洽」—— 非相邻工具对（tool_use 与 tool_result 中间隔着普通消息）此前会切出孤儿块、下一次
  请求被 API 400；退无可退时照 `trimToolPairs` 先例整体放弃本次压缩。

### 新增（质量闭环收尾 + 指标基数封顶）

- **`beforeFlush(trace, result)`**（`RunAppOptions` / `ExecuteRunOptions`，可选）：sinks 冲刷
  **之前**的最后一笔 —— 「拿到 run 结果才判得出的结论」（典型是 `defineEval` 的 score）在这个
  时点挂上，`metricsSink` 才聚合得到。**此前 eval 的 score 挂在冲刷之后，永远进不了
  `agentia_score` 指标族**（usage-guide / roadmap 承诺的「eval → trace → 监控」链路是断的）。
  宿主漏透传该字段时 `defineEval` 退回「跑完再断言」：断言照做，不误报全挂，只是分数进不了指标。
- **`metricsSink` 三个维度的键空间都封顶**：新增 `maxModels`（缺省 50）/ `maxScores`（缺省 200），
  与 `maxCapabilities` 同口径 —— 超限键折叠进 `__other__`（**量不丢，只丢标签粒度**），
  snapshot 新增 `droppedModels` / `droppedScores`（各自最多记账 1024 个不同键，满了以后是下界）。
  此前 `models` / `scores` 无上限，与 usage-guide 承诺的内存上界不符。

### 重构（内部去重下沉 core，公共面不变）

- `sseLines` / `percentile` / `capabilityKindOf` / `textOf` / 可中断 `sleep` 各只剩一份
  （`src/core/{sse,stats,trace,text,timeout}.ts`）—— `integrations` 只准依赖 `core`，core 是让
  两处重复合一的唯一合法落点。`textOf(message, separator)` 三个调用点各传各的原值，行为零变化；
  两份 backoff（引擎 ±20% 均匀抖动 vs client ±25% 且尊重 `retry-after`）**刻意不合并** ——
  合并即改行为。

### 新增（trace 跨进程关联：`traceparent` → run 根 span links）

- **入站链路上下文**：`RunInvocationOptions.traceContext`（`{ traceId, spanId? }`）与 HTTP 请求头
  `traceparent`（W3C）现在会记成 run 根 span 的一条 **`links`**（新类型 `SpanLink`），
  `createOtlpExporter` 映射为 OTLP **span links** —— 于是「这条 run 是被谁触发的」在跨进程 / 跨服务
  时也可查。**不改 `traceId == runId` 的 1:1 不变量**：run 仍是自洽的一棵新树，上游是被**链接**
  而不是被**继承**成父 span（理由与取舍见 `docs/spec.md` §10 2026-09-17 ⑤）。
- 新增 `parseTraceparent(value)` 导出：把 `traceparent` 头解析成 `TraceContext`。
  **非法 / 缺失 / 版本 `ff` / 全零 id / 位宽不符一律返回 `undefined`**（不抛）——
  链路是观测行为，不该把业务请求打成 400。`createHttpHandler` 在 `POST /run` 与 `POST /tasks`
  上自动用它；`POST /tasks` 的 body 里显式给的 `options.traceContext` 优先于该头。
- **异步宿主零改动即继承**：`traceContext` 随 `spec.options` 落进 `TaskRecord`，所以另一个进程
  `resumePending` 续跑的那次 run 也带得上（队列消费者场景）。
- `TraceRecorder.addLink()` 记为公共能力；没记 link 的 span **没有 `links` 键**（不是空数组）。
- **已知边界（如实标注）**：只做**入站** —— 框架不生成出站 `traceparent`（运行中没有「当前 span」
  可导出，硬造会给出假 spanId）；link 只落 run 根，不自动跨进程传播（队列场景由调用方把
  `traceContext` 传下去）。

### 文档

- `docs/usage-guide.md`：新增「跨进程关联」小节（含队列消费者配方与「只做入站」的边界）、
  `app.run` 选项表补 `traceContext`、已知边界补一条；官网 API 页补 `TraceContext` / `SpanLink` /
  `parseTraceparent` 三行并把 `Span.links` 写进签名。

## [0.6.1] - 2026-09-17

### 文档（对外文案不再暴露内部流程；使用说明按用途重排）

> 随包发布的 `dist/AGENTS.md`（单源即 `docs/usage-guide.md`，也是 `agentia create` 写进新项目的
> 那份）一并更新 —— 装上本版即可看到，不必等下一次发版。

- **删掉讲本仓库自身流程的内容**：`§9 提交前自检`（它列的是本仓库门禁 —— `typecheck:tests` /
  `test` / `e2e` 三步链 —— 而脚手架生成的项目并没有这些 script，照抄必然失败）、前言里
  「文中 API 名由框架仓库的测试对着源码校验」句，以及散在正文里的内部路线图代号（`（R7）`）。
- **相对上一版的措辞改成陈述句**：「不再混进 connection」「不再静默映射成成功」这类只有用过旧版
  才读得懂的写法，改为直接陈述现状。
- **结构**：加顶层目录；「运行时 API」的 33 个子节按用途拆成六组（运行时上下文与装配 / 触发与宿主 /
  上下文预算与成本 / 观测与调优 / 集成 / 横切缝）；「框架只给缝、不建子系统」的口径集中到一处讲，
  不再逐个标题辩白。
- 官网（不随 npm 包发布）：API 页 `classifyError` 措辞、docs 页侧栏按用途分组、以及**滚到页面底部时
  末条导航不高亮**的修复。
- `@migor/trace-view`（不单独发布，随 CLI 构建期拷贝）README 补齐漏写的 `rawArg` 导出，
  并加一份「README 必须覆盖导出面」的守卫防再漏。


### 变更（超时有了自己的 `errorType`：`connection` → `timeout`）

- `classifyError` 对超时（内建 `DOMException('TimeoutError')` —— `AbortSignal.timeout()` 与默认 client 的
  超时合成信号；以及任何 `code === 'timeout'` 的错误）现在返回 **`type: 'timeout'`**，不再归进 `connection`。
  **`retryable` 保持 `true`** ⇒ **自动重试行为不变**（超时本来就是可重试故障）；变的是**记账**：
  按 `span.error.type` 分流的看板 / 告警会把超时类从 `connection` 挪到 `timeout`，`trace-diff` 比对旧 trace
  时超时会显示为「类型变了」。取证与决策见 `docs/spec.md` §10 2026-09-17 ②。
- 顺带把 `isTimeoutError` 的契约写清（三条判据，全鸭子类型）：框架 `TimeoutError` 实例 /
  `code === 'timeout'` / `name === 'TimeoutError'`；引擎的工具级 catch 用它 ⇒ 工具自判的超时与引擎判的
  超时记同一类账（`errorKind='timeout'`）。
- ⚠️ **更正**：此前一版说明里「模型调用超时在 `span.error` 上是 `type:'unknown'`（不可重试）」是**错的** ——
  它一直判 `connection` + 可重试（`engine/errors.ts` 的 `isConnectionError` 专门认 `name === 'TimeoutError'`）。
  该错误说明已从 `docs/spec.md` 删除，以 2026-09-17 ② 为准。

### 变更（MCP 超时单源化 —— 一次调用只有一个裁判）

- **原语单源**：`TIMED_OUT` / `withTimeout` 下沉到 `src/core/timeout.ts`，`engine/concurrency.ts`
  原样再导出（`import` 路径与名字对使用者与测试都不变）。MCP 桥的 `withDeadline` 改为它的**薄封装** ——
  此前桥自带一份**纯竞速**实现，于是 2026-09-14 的「超时是硬的」收紧只落进引擎，桥能把**超预算**的
  MCP 调用记成成功（确定性可复现；取证与决策见 `docs/spec.md` §10 2026-09-17 ①）。
- **⚠️ 行为变更（迁移注意）**：引擎设了 `toolTimeoutMs` 时，`mcpTools({ timeoutMs })` **不再参与判定**
  （即使桥的 `timeoutMs` 更短）—— 一次调用只有一个裁判，此前「谁短谁生效」让同一件事在 trace 里
  落成两种账。要收紧某个 MCP server 的时限，请设 `toolTimeoutMs`（或把该工具单独包一层）。
  桥的 `timeoutMs`（缺省 `MCP_DEFAULT_TIMEOUT_MS` = 60000）只在「桥脱离引擎单用」或
  「引擎没设 `toolTimeoutMs`」时作为兜底，且兜底同样走**实测耗时**判定。
- **超时归一类账**：工具自判的超时（抛 `code === 'timeout'` 的错误，桥的兜底超时即是）从
  `errorKind='threw'` + `error(unknown)` 变为 `errorKind='timeout'` + `error(timeout): …`，
  与引擎判的超时同类、同样**不杀 run**。按 `errorKind` 分流看板的查询请知悉这一变化。

### 修复（第五轮 review：三条「功能静默失效」+ 一批边界）

- **`app.run` 丢掉 `signal`（取消全线失效）**：运行期入参是逐字段手抄进 `executeRun` 的，
  唯独漏了从 `RunInvocationOptions` 继承来的 `signal`（TS 不报错）。后果是**三处宿主与三份文档
  都假设的取消全都不生效**：HTTP 客户端断开不中止、`drain` 收口只关流不灭 run、
  `AsyncRunner.runTimeoutMs` 只 race 掉结果而在飞请求继续烧 token。已补上转发 +
  真 `AgentApp` 路径的回归用例（宿主侧测试用的是**假 app**，正好绕过了这一跳）。
- **OTLP 的 `spanId` 宽度错**（`otlp.ts`）：内部 UUID（32 hex）被原样当作 span id，
  而 OTLP 契约里 span id 是 8 字节（**16 hex**，trace id 才是 32）—— 真 collector 会判
  `invalid span_id` 拒收或截断。已按两种宽度分开转换。
- **OTLP 对能力 span 一条 `gen_ai.*` 都不发**：`genAiAttributes` 按 `span.name.startsWith('subagent:')`
  判类型，而生产代码写的是**裸能力名 + `attributes.subagent` / `skill`**（metrics / report /
  trace-view 三个消费者都读 attributes，只有这里读前缀）⇒ 子 agent 的 `gen_ai.agent.name`、
  skill 的 `gen_ai.tool.name` 在生产里从未发出。已改为读 attributes，并把测试夹具改成生产形状。
- **`gen_ai.evaluation.score.name` 不是 semconv 键**（真实 key 是 `gen_ai.evaluation.name`）——
  已修正并同步文档（实测 `@opentelemetry/semantic-conventions` 全量键名里无前者）。
- **`costEstimate` 命中原型链 → NaN**：模型名恰为 `constructor` / `toString` 时
  `pricing[model]` 拿到函数（真值）而 `.in` 为 undefined ⇒ 成本 NaN，`maxCostUsd` 的
  `NaN > x` 恒 false 而静默失效，NaN 还会进 trace / OTLP。改为 `Object.hasOwn` 查找。
- **`mcpTools` 两处**：外部 server 的 `description` 不是 string 时装配期崩 `TypeError`
  （同循环里 name / inputSchema 都有类型防御）；`mcp.tool` 单值 attribute 在同回合并行调多个
  MCP 工具时互相覆盖 ⇒ 新增 `mcp.tool.<菜单名>`，审计 / 回放不再丢原名。
- **`combineSignals` 同源重复时残留监听器**（去重后走单源快路径）；
  **`session.append` 展开传参的 12 万项 RangeError**（同 `replaceMessages` 已规避过的坑）；
  **`harvest` 把缺 `tool` 的事件回填成 `'unknown'`**（会在生成物里造出一个真的、且断言必然
  通过的工具调用 —— 骨架自我自洽、永不报错）与**注释行裸插 name / source**（含换行即破产物）；
  **`replay` 放行数组型 `tool_use.input`**（API 要求对象）。

### 新增

- **脚手架补齐生产构建链**：`agentia create` 生成的项目此前只有 `dev`/`typecheck`，没有
  打包工具（连模板自己的 .env 注释都引用了不存在的 `npm start`）。现在生成
  `build`（tsc → `dist/` + `scripts/copy-assets.mjs` 跟随拷贝 .md 文本资产）与
  `start`（`node dist/main.js`），tsconfig 带 `rootDir`/`outDir`；e2e-cli 新增 4d 步
  真跑这条链（emit + 资产拷贝 + dist 产物断言）。

### 修复（第四轮 review：文档面错到「照抄就坏」+ 边界条件）

- **`app.run` 支持 `memory`（新增选项，非破坏）**：官网手写页与单源指南一直用
  `app.run(messages, { memory })` 演示跨 run 记忆，但 `RunAppOptions` 里**没有**这个字段
  —— 照抄的代码 TS 直接报「对象字面量只能指定已知属性」，硬绕过去则运行期**静默不生效**
  （记忆从不水合、也不回写）。现在与 `session` 完全对称：`app.run` 也水合/回写，
  边界同样只在程序内（store 不可序列化，不进 transport 的 `RunInvocationOptions`）。
- **`compactMessages` 不再劈开「工具对在索引 0」的历史**：回退循环的 `cut > 1` 让它停在 1
  时，`tool_use` 被折进摘要、尾部留下**孤立 `tool_result`**（并与摘要构成连续两条 `user`）
  —— 正是该函数 docstring 明说不产出的两种形态，下一次请求会被 API 400 拒。
  现在回退到 1 仍落在 `tool_result` 上就**放弃本次压缩**（原样返回）。
- **`agentia create` 撞同名普通文件**：此前 `readdirSync` 抛原始 `ENOTDIR` 栈（栈里全是
  `node:fs` 内部帧），那句「目录已存在且非空」的友好文案根本轮不到；现在先判路径类型。
- **子命令 `--help`**：`agentia report --help` 此前把 `--help` 当文件名去读，报
  `读不到文件 --help（ENOENT）`；现在 8 个子命令都回自己的用法串（与 `fail()` 共用同一份常量）。
- **`agentia harvest --out` 默认不覆盖**：产物是「人工核对后再进 CI」的脚手架，重跑一次会
  静默抹掉你手改过的断言与 input；目标已存在时报错，要覆盖显式加 `--force`。
- **`agentia report` 缺 CLI 资源时的报错**：`dist/inspector/summary.js` 缺失时给出人话 +
  补救动作（此前是原始 `ERR_MODULE_NOT_FOUND`，路径全在 dist 内部，用户读不出该做什么）。
- **文档面形状**：官网 `docs.html` 与单源 `usage-guide.md` 的「出参护栏」示例读的是
  `out.finalText`，而 run 输出是 `{ run, result }` —— 判断恒为 `undefined`、**护栏恒不触发**，
  页面上却像在生效；改为 `out.result.finalText`，并新增定向守卫
  `tests/docs/run-output-shape.test.ts`（手写片段此前没有任何东西在编译它）。
  `tests/docs/api-page.test.ts` 的行匹配器同时放宽（`<tr class="…">` 此前整行静默跳过）。

### 修复（发布面与证据可核性）

- **CHANGELOG 进 npm 包**：npm 的「总是包含」只覆盖 README/LICENSE（实测 `npm pack` 不含
  CHANGELOG）——根包 `files` 登记 + CLI 包构建期拷贝到包根，`e2e-cli` 新增两包 pack 内容断言。
- **bump 闸门**：`check-release.mjs` 新增「要发的版本必须高于 npm 已发布版本」（查官方
  registry，E404 首发放行）——此前只验四处一致、不验高低。
- **code-review 证据签入**：真跑 trace 与报告落 `examples/code-review/evidence/`（此前 `out/`
  被 gitignore，README 的数字无从核）；README 表格数字全部改为可从产物复核的值。

## [0.6.0] - 2026-09-17

### 破坏性变更与迁移

- **公共消息类型自有化**：框架不再从 `@anthropic-ai/sdk` 导出/引用类型，`ModelClient` 契约、
  `RunAgentOptions.messages`、`traceToMessages` / `forkMessages` 的入出参等全部改用
  `@migor/agentia` 自有类型（`MessageParam` / `ContentBlockParam` / `Message` / `ToolParam` /
  `MessageUsage` 等 15 个，见 `src/core/message.ts`）。
  **迁移**：代码里写 `import type Anthropic from '@anthropic-ai/sdk'` 并标注
  `Anthropic.MessageParam` 的，改从 `'@migor/agentia'` import 同名类型（`Tool` → `ToolParam`、
  响应 usage → `MessageUsage`）。只传对象字面量（`{ role: 'user', content: '…' }`）的代码**无需改动**——
  自有类型与 SDK 结构兼容（有 `tests/types/message-compat.types.ts` 双向 assignability 门禁），
  SDK 类型的值可直接喂进来。
- **默认 client 自研化（fetch + SSE 手写，不再实例化 SDK）**：
  `AnthropicClientOptions` 的索引签名保留（旧代码编译不炸），但 SDK 构造参数**不再被消费**，
  只有 `apiKey` / `baseURL` / `maxRetries` / `timeout` 四个已知名生效，多余键静默忽略。
  module 级的 `splitSignal` 随 SDK 包装层删除（它从未进公共导出面）。
  **行为对齐 SDK 缺省**：重试 408/409/429/5xx、缺省 `maxRetries=2`、指数退避 + 抖动、尊重
  `retry-after`；`signal` 直传 fetch（中止语义不变）。
  **迁移**：依赖「SDK 特有的构造参数」（如 `authToken`、`defaultHeaders`）的，改用
  `baseURL` 指向网关或自带 `client`（`RunAgentOptions.client`，契约见 usage-guide「多模型」节）。
- **错误分类改鸭子类型**（`classifyError` 不再 `instanceof` SDK 错误类）：带数值 `status` 的
  错误按 HTTP 语义归类（429→rate_limit、5xx→server，可重试；其余 4xx→api 不可重试）。
  **已知边界**：使用者自装 SDK 并让它把 `APIConnectionError` 抛到引擎时，该错误无 status 可判，
  归类退化为 `unknown`（不可重试）——默认 client 不产生此类错误，仅影响自装 SDK 的场景。

### 新增

- **trace diff**：`diffTraces(a, b)` —— 两条 run 调用树的 A/B 比对（run 级 summary + 逐 span
  字段差；llm.turn 配对忽略模型名，capability 按 `kind:name`；缺省忽略墙钟）。
  CLI `agentia diff a.jsonl b.jsonl`（差异非空 exit 1，可进 CI 挡轨迹漂移）。
- **分叉重放**：`forkMessages(trace, { atTurn, append? })` —— 主循环第 N 回合前截断重放历史、
  拼新消息喂回 `app.run`（新 run，不是续跑；trace 不记 assistant 文本与原始输入）。
- **canCall 能力级能力边**：`@SubAgent` / `@Skill` 的 `tools` 在 provider token 之外接受
  `'token/能力名'` 路径（只引单个能力，装配期校验 + 可用名单报错）。
- **零运行时依赖达成**：`@anthropic-ai/sdk` 退出 dependencies（留 devDependencies 只为类型
  兼容门禁）；`npm i @migor/agentia` 不再连带任何运行时依赖。
- 官网文档站新增「场景指南」区（HTTP 服务上线 / 监控 / 离线评测与回流 / A/B / HITL）。
- **`examples/code-review/` 真实案例**：代码评审 agent 服务（四类能力 + 能力级 tools 路径 +
  预算护栏 + 自定义 file sink 产 trace.jsonl），离线 demo（scriptedClient）与真模型两种跑法；
  已用真端点实跑并在 README 记录真实 token/成本/trace 数据（验证证据）。

### 修复

- CLI Windows：`npmBin` 只加 `.cmd` 后缀在 CVE-2024-27980 后裸 spawn 必 EINVAL —— 改
  `npmSpawn`（cmd.exe 包装 + 逐参数脱敏，不用 `shell:true`）。
- CLI doctor 的 import 识别只认 default import（named/namespace/别名/跨行形态的悬空条目
  静默漏检）——已全形态支持。
- 脚手架模板纳入真 `tsc` 检查（e2e-cli 第 4 步）；CLI 对拍测试在产物缺失时不再静默跳过
  （CI 判失败，本地醒目横幅）。
- 引擎 `agentLoop` 拆分（433 行循环体 → 8 个有名字的函数 + `turn.ts` 独立成文件），纯重构
  零语义变更。
- 官网 playground 单价对齐框架内置价格表；正文链接色统一主题色。

## [0.5.0] - 2026-09-16

### 新增（R7 质量闭环）

- **score 一等公民**：`Score` + `attachScore`（评分挂 run 根 span 的 `score` 事件）；
  `defineEval` 结论自动落 score；metricsSink 聚合 `agentia_score` / `agentia_score_total` 指标族。
- **OTLP 对齐 OTel GenAI semconv v1.37**（additive 保留旧 `usage.*` 键；score 译
  `gen_ai.evaluation.result`）。
- `session.id` 提升为 trace 根属性（OTLP 映射 `gen_ai.conversation.id`）；
  `PromptSpec.version` → run 根 `prompts.versions`。
- **线上 trace 回流 eval**：CLI `agentia harvest <file.jsonl> [--failed] [--limit N] [--out]`。
- `examples/observability/grafana-dashboard.json` 随仓库发布。

## [0.4.2] - 2026-09-15

### 修复（发布后更正）

- `RedisTaskStore` 的 TTL 在 node-redis 上完全不生效（0.4.1 把 TTL 挪到 `SET` 位置参数，
  node-redis 只声明三个形参、多余参数被静默丢弃）—— `set` 只传两参，TTL 一律走
  `expire(key, seconds)`；设了 `ttlSeconds` 却没给 `expire` 时构造期抛错。
- `e2e-deploy` 端口 TOCTOU flake（`EADDRINUSE` 曾被误报为「示例进程启动即退出」）。

## [0.4.1] - 2026-09-15

### 修复（深度审查修复轮，40+ 处，无新公开 API）

- metricsSink 的 Prometheus 文本每个家族只发一次 HELP/TYPE（重复即整次 scrape 硬失败）。
- 预算护栏（`maxTotalTokens` / `maxCostUsd`）经 `ToolRunContext` 真透传到子 agent / skill 循环。
- CLI inspector：SSE 路径 `innerHTML` → `textContent`（XSS）+ Host 头校验。
- `drain` 强制关 SSE 现在真 abort 对应 run；示例 Dockerfile 补 `COPY docs`；新增
  `scripts/e2e-deploy.ts`（崩溃续跑验证）。

## [0.4.0] - 2026-09-14

### 新增

- trace 事件正文可展开：`maxEventChars` opt-in 开关（缺省截断值逐字不变，`false` = 不截断），
  CLI inspector 与官网 playground 两个宿主都真展开。

### 修复

- 默认 client 从不转发 `signal`（中止在飞 run 失效、超时 run 继续烧 token）——
  `splitSignal` 把 signal 搬到 SDK RequestOptions；门禁为本地假端点测试。
- `withTimeout` 收紧为硬保证（只看实测耗时）；截止计时器不得 `unref()`（四处）。
- CI 抖动根因修复（toolTiming 计时器赛跑改确定性形态）。

## [0.3.0] - 2026-09-14

### 新增

- `.env` 一等配置入口：显式 `loadEnvFile()`（框架不自动读），零依赖手写解析，真实环境变量
  优先；脚手架生成 `.env` / `.env.example` 并 gitignore。

## [0.2.2] - 2026-09-14

首个公开发布：`@migor/agentia` + `@migor/cli`（scope `@migor/*`），两包版本同步。
框架本体单包；CLI 独立成包（workspaces）。

[Unreleased]: https://github.com/retrychx/agentia/compare/v0.9.2...HEAD
[0.9.2]: https://github.com/retrychx/agentia/releases/tag/v0.9.2
[0.9.1]: https://github.com/retrychx/agentia/releases/tag/v0.9.1
[0.9.0]: https://github.com/retrychx/agentia/releases/tag/v0.9.0
[0.8.3]: https://github.com/retrychx/agentia/releases/tag/v0.8.3
[0.8.2]: https://github.com/retrychx/agentia/releases/tag/v0.8.2
[0.8.1]: https://github.com/retrychx/agentia/releases/tag/v0.8.1
[0.8.0]: https://github.com/retrychx/agentia/releases/tag/v0.8.0
[0.7.2]: https://github.com/retrychx/agentia/releases/tag/v0.7.2
[0.7.1]: https://github.com/retrychx/agentia/releases/tag/v0.7.1
[0.7.0]: https://github.com/retrychx/agentia/releases/tag/v0.7.0
[0.6.3]: https://github.com/retrychx/agentia/releases/tag/v0.6.3
[0.6.2]: https://github.com/retrychx/agentia/releases/tag/v0.6.2
[0.6.1]: https://github.com/retrychx/agentia/releases/tag/v0.6.1
[0.6.0]: https://github.com/retrychx/agentia/releases/tag/v0.6.0
[0.5.0]: https://github.com/retrychx/agentia/releases/tag/v0.5.0
[0.4.2]: https://github.com/retrychx/agentia/releases/tag/v0.4.2
[0.4.1]: https://github.com/retrychx/agentia/releases/tag/v0.4.1
[0.4.0]: https://github.com/retrychx/agentia/releases/tag/v0.4.0
[0.3.0]: https://github.com/retrychx/agentia/releases/tag/v0.3.0
[0.2.2]: https://github.com/retrychx/agentia/releases/tag/v0.2.2
