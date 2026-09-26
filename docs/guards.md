# Agentia —— 守卫注册表（约定 → 可执行断言）

> **这份文档回答一个问题：这个仓库的哪些承诺是「机器守着的」，哪些只是「写在文档里的」。**
>
> 起因：`spec.md §10` 记录「我们决定了什么」，但**不记录「这个决定由谁守」**。于是同一类
> 缺陷会以不同面貌反复出现 —— 2026-09-18 的第六轮 review 一次挖出 16 条，全部属于
> 「约定写在文档/注释里，但没有任何门禁」的同一缺口。本文件是该缺口的一次性补齐。
>
> **维护约定**（写进 PR 模板）：新增/修改不变量时，必须在下面登记一行。**守卫不是均匀撒的，
> 它是沿着「你写过文档、写过测试的地方」长的** —— 这份表的作用就是让缺口可见。
> 未登记的「待守」条目在 §2，那是下次 review 的靶子清单。

---

## 1. 已挂守卫（按危险类分组）

### 1.1 架构与形状

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/architecture/layering.test.ts` | 分层单向（`core ← engine ← …`）、依赖图无环、`src` 不 import 到 `src` 之外 | 解析 import 图（`from` / 副作用 / 动态字面量三种），断言允许边集合（`ALLOWED` 是「允许集合」而非「禁止写法」）+ 解析计数下限防真空变绿。**反向验证过（2026-09-26 §1 审计）**：给 `src/store/fsStore.ts` 加一条 `import type … from '../runtime/session.js'`（历史事故那个形态 `store → runtime`）⇒ **恰好**「层间依赖不得越权」那 1 条红，其余 9 条不误伤 | `store → runtime` 这类未声明兄弟依赖悄悄存在（真发生过） |
| `tests/architecture/no-runtime-deps.test.ts` | **零运行时依赖（全仓铁律）**：三个包（`@migor/agentia` / `@migor/cli` / `@migor/trace-view`）的 `src/**` 运行时只能 import 相对路径与 `node:` 内置模块（`import type` 同样计入）；三个 `package.json` 无非空 `dependencies`；`packages/` 下每个包必须登记（IN_SCOPE / EXCLUDED，后者带理由） | 自带**定向扫描器**（`lib/source-scan.ts`）：一遍走完，把注释 / 字符串 / 模板 / 正则遮蔽的同时**在说明符位置把字符串读出来** —— 只遮蔽不读取则说明符自己被吞（这个错真犯过，阳性对照当场红），只读取不遮蔽则 5 处注释/模板假阳性全进来。防真空护栏三条（阳性对照、解析计数下限、逐文件「有行首 import 就必须扫到说明符」）+ 5 处真实假阳性站点的回归钉。**反向验证过**：① 往 `src` 注入 `import { z } from 'zod'` ⇒ 断言①红并精确报出行号；② 根 `package.json` 加 `dependencies` ⇒ 断言②红；③ 建未登记包目录 ⇒ 断言③红；④ 把扫描器换成朴素正则 ⇒ 1/8/9/10/13 五条同时红（恰好是被替换掉的那层防线）；⑤ 把扫描器「打瞎」⇒ 断言①仍绿但 7/9/10/12/16 红 —— 这正是「0 处违规」不可证伪的那个方向，被护栏接住 | 加一行 `import { z } from 'zod'` 就把「零依赖」变成「一个依赖」：`npm test` 全绿、`tsc` 全绿、`npm publish` 照常成功，直到使用者装上包才发现多了一个可能带漏洞、可能与框架版本冲突的传递依赖 |
| `packages/cli/test/structure.test.mjs` | **CLI（`packages/cli`）自身的结构**。它是扁平的 26 个 `.ts` / `.html`、**没有分层**，所以 `layering.test.ts` 那套（允许边 + 无环）不适用；真正会坏的形状是三条：**W1 规模棘轮**（单文件行数 ≤ 基线、总行数 ≤ 基线、每个文件都必须登记在表里）；**W2** 下发浏览器的产物 `panel-logic.js` / `markdown.js` **运行期零 import**；**W3** 源码侧前置 —— 这两个 `.ts` 只许 `import type`，出现值导入或 re-export 即违规 | 读 `src/*.ts` + `*.html` 数**换行符**（与 `wc -l` 同口径，尾换行会让 `split('\n').length` 多 1）比对基线表；产物侧只扫**行首**的 `import` / `export … from`（tsc 保留注释，块注释里可能出现 "import" 字样，行首缩进的才是真语句）。**反向验证过**：往 `panel-logic.ts` 加一条值导入 ⇒ W3 红，`build:cli` 之后 W2 也红。棘轮**只许降不许升**：存量条目要往下调、新增文件必须显式登记；每次抬总量都要在注释里写清为什么（B 阶段 7410→8034、C 阶段 →8062、补 `panel-logic` 欠账 →8102、inspector 路由表拆分 →8242、面板卸载收口 →8290 都留了账） | **面板白屏，而 node 侧单测照样全绿**。⚠️ 白屏有**两类**成因、守的也是**两处**：W2/W3 守「多了一条依赖」（浏览器去取 `/dev-protocol.js` —— `STATIC` 白名单里没有它 ⇒ 404 ⇒ 整块模块求值失败）；`inspector.test.mjs` 的⑦守「页面 import 了一个产物里**不存在**的名字」。后者 **2026-09-23 真发生过**：4 个函数（`filterSelected` / `formatToolSources` / `chatViewVisible` / `turnKey`）只有页面调用点与测试、`panel-logic.ts` 里没实现 ⇒ `tsc` 全绿、`e2e-dev` 全绿（它走 HTTP API、不加载页面），只有⑦抓得到。W1 退化则回到老路：`dev.ts` 长到 1148 行、长出一台 15 个 `let` 的隐式状态机（F1/F4/G1/G2 四条缺陷全是它的后果） |
| `tests/integrations/adapter-parity.test.ts` | **同一契约的两条适配器必须对称**：同一 HTTP 状态在 anthropic / openai 上的 `{classifyError.type, retryable, 尝试次数}` 完全一致；`maxRetries` 的**构造期校验也对称**（坏值矩阵 × 两条适配器成对断言） | 一份场景表（408/409/429/500/503/400 + `retry-after` + `maxRetries:0`）`for (const a of ADAPTERS)` 跑两遍（`ADAPTERS` 里是 `createAnthropicClient` / `createOpenAIClient` **两个真工厂**，跨侧那条按 status 分组后**组内互比**，不是自己跟自己比）；替换 `globalThis.fetch` 作为两侧统一的注入面；`retry-after: 0` 让退避不真 sleep。坏值矩阵：NaN / ±Infinity / -1 / 1.5 一律构造期抛 `TypeError`，`0` 与缺省放行（`0` = 不重试是**有意义的值**，见 §2「`0` 的双重语义」） | 「同一个 429」在 anthropic 打 3 次网络请求、在 openai 打 1 次 —— 成本/延迟随厂商而异却没人发现（真发生过：openai 曾完全没有内层重试）；`maxRetries: NaN` ⇒ `attempt >= NaN` 恒假 = **无限重试**、`Infinity` 永不达到（真发生过，2026-09-21 外部队列复核）。**反向验证过（2026-09-26 §1 审计）**：① 把 openai 侧 `isRetryableStatus` 的 `409` 去掉（两条分叉）⇒ 恰好 3 条红（含**跨侧对称**那条）；② 把 openai 侧 `attempt >= maxRetries` 改成 `>`（多打一次）⇒ 7 条红（跨侧对称 + 各档尝试次数），跨侧那条每次都亮 |
| `tests/architecture/transport-errors.test.ts` | 传输层适配器抛的错误必须带**数值 `status`**（否则被归类为 unknown → 重试层静默失效）；且按约定命名的 `*ApiError` 类必须真的暴露 `readonly status: number`（**命名即承诺**） | 扫 `src/integrations` 的裸 `throw new Error(...)`：文案带 HTTP 状态痕迹即违规；构造期配置校验按文案豁免。**自带三层防真空变绿**：合成样本的阳性/阴性对照 + 裸抛错**计数下限 8** + 注释剥离的回归钉。**反向验证过（2026-09-26 §1 审计）**：① 往 `src/integrations` 注入一处「文案带状态码的裸 Error」⇒ 恰好「传输失败必须带结构化 status」红；② 把 `AnthropicApiError` 的 `status` 改成 `string` ⇒ 恰好「每个 `*ApiError` 必须暴露数值 status」红；③ 注释剥离退回「截到 `//` 为止」⇒ 恰好回归钉红（**订正后才红，见下**） | OpenAI 适配器吃一个 429 就整轮失败、引擎层 3 次重试一次不发生（真发生过）；本守卫上线当天就抓到 `otlp.ts` 的同类漏网。⚠️ **2026-09-26 §1 逐行审计订正：那条注释剥离的回归钉当时是假守卫** —— 合成样本把 URL 放**单独一行**，退回旧实现后它只变成无害的 `const url = 'http:`（括号本来就没开），**用例照样绿**。真实病灶是 `src/integrations/metrics.ts` 里 `//` 与 `throw` **同一行**（`必须给 endpoint（如 http://localhost:4318）`）⇒ 截断连闭合反引号与 `)` 一起切掉 ⇒ 括号配平吃到文件末尾 ⇒ **那一行之后的抛错全部扫不到且不报错**。已把样本改成真实形态（并加「第二处必须被判违规」），退回旧实现才真的红 |
| `tests/architecture/tsconfig-strictness.test.ts` | **承重的 tsconfig 开关不得被关掉**：`exactOptionalPropertyTypes`（显式 undefined ≠ 不传）、`strict`、`types:["node"]` | 读 `tsconfig.json` 断言三个开关。反向验证过：关掉 `exactOptionalPropertyTypes` ⇒ 本测试红，且 `{maxAttempts: undefined}` 赋给 `RetryOptions` 从「编译错」变回「放行」 | 39 处防线无声消失（`retry.ts` 的「显式 undefined 覆盖缺省」重新变成合法代码）；@types/node 缺链导致全仓 Node 类型报错 |
| `tests/architecture/no-legacy-decorator-metadata.test.ts` | **官网首屏那句「0 反射」不得变假**（= `docs/spec.md`「已定决策」段：标准 Stage 3 装饰器，不用 `experimentalDecorators` / `emitDecoratorMetadata` / `reflect-metadata`，元数据一律显式声明、不依赖 `design:paramtypes`）。拆成三面：① **开关面** —— 全仓 12 个 `tsconfig*.json` 无一打开那两个 legacy 开关（**根闸**：不开它 `tsc` 根本不发射 `design:*`）；② **依赖面** —— 四个发布面根的源码不把 `reflect-metadata` 当模块说明符；③ **源码面** —— 不出现 `Reflect.*Metadata` 那 9 个 API。射程四个根：`src/` · `packages/cli/src/` · `packages/cli/templates/`（生成给用户的脚手架，随 CLI 发布）· `packages/trace-view/src/` | 走查**发现式**（递归找 `tsconfig*.json` 与源码文件，新包 / 新模板自动进射程）+ 复用 `lib/source-scan.ts` 的**遮蔽文本**（注释里写「我们不用 reflect-metadata」是**声明**不是用法 —— `src/container/container.ts` 头注正是如此，裸正则必误报）+ 容忍 JSONC 的 tsconfig 解析器（`packages/cli/tsconfig.templates.json` 真带 6 行注释；**解析失败必须抛**，不许「跳过这个文件」）。防真空 + **阳性对照**：9 条合成违规（含 `Reflect.getMetadata('design:paramtypes', …)` 整形态）必须被看见、`import 'reflect-metadata'` 必须被解析成说明符、开着开关的 JSONC 必须被读到 —— 没有这组，「0 处违规」不可证伪。另 3 条回归钉：5 处正当 `Reflect.*`（3 × `Reflect.apply` + 2 × `Reflect.ownKeys`）判零违规、注释里的声明判零违规、`Symbol.metadata` 不在禁令内。再加一条**射程钉**（按**名字**断言走查结果里必须有 `packages/cli/templates/tsconfig.json` / `packages/trace-view/src/index.js` 等 —— 计数下限只保证「够多」，不保证「够到了该够的那几个」）。**反向验证过 5 个探针**：① `templates/tsconfig.json` 开 `emitDecoratorMetadata` ⇒ ① 号红；② `container.ts` 加 `import 'reflect-metadata'` ⇒ ② 号红；③ `tool.ts` 加 `Reflect.getMetadata` ⇒ ③ 号红（同时点亮回归钉）；④ 同一行放进**注释** ⇒ **仍绿**（证明遮蔽真在生效）；⑤ 加一处 `Reflect.apply` ⇒ **仍绿**（证明不过度收紧）。五个探针 `cp` 还原后 `sha256` 逐字节一致（共 **10 个 test**） | 首屏「0 反射」与特性卡的「零反射装饰器」**无声变假** —— 打开 `emitDecoratorMetadata` 后 `tsc` 会为每个被装饰的声明发射 `design:paramtypes`；`reflect-metadata` 一进来还会**同时**破掉零运行时依赖铁律（两条守卫都该红，别只消掉一条）。⚠️ 本守卫**刻意不**禁 `Reflect.ownKeys` / `Reflect.apply` / `Symbol.metadata`：§2 那行原猜的形状（「除 `Reflect.ownKeys` 外不得使用 `Reflect.*`」）**是错的**，会当场误判 3 处正当的 `Reflect.apply`；`Symbol.metadata` 是标准 Stage 3 提案的一部分（`tsc` 的标准装饰器发射自己就写它）。`design:paramtypes` / `design:returntype` / `design:type` 三个键**刻意不在**清单里（它们永远是**字符串字面量**，而遮蔽器按设计遮蔽字符串 ⇒ 放进去等于三条永远匹配不上的死条目；本文件第一版就是这么写的，被 ④ 号阳性对照当场抓出）—— 覆盖论证与这处**已知缺口**写在文件内 ⑦ 号 test 里 |
| `tests/types/message-compat.types.ts` | 自有消息类型族 ↔ `@anthropic-ai/sdk` 的结构兼容（双向 assignability）；含 `@ts-expect-error` **负向对照**（不该过的赋值必须报错） | 针对构建产物 dist 编译的类型断言（`typecheck:types`，node:test 不收）。**反向验证过（2026-09-26 §1 审计）**：① 把 `Role` 里的 `'system'` 去掉 ⇒ 方向一那条 `TS2322`（SDK `MessageParam[]` 赋不进自有 `MessageParam[]`）；② 删掉一条 `@ts-expect-error` ⇒ 露出被它盖住的 `Type '"narrator"' is not assignable to type 'Role'`，证明负向对照真的在挡东西。⚠️ 本文件**没有任何 `any`/`as unknown as` 绕过** —— 那会让整份门禁恒真 | 使用者手里的 SDK 类型喂不进来；SDK 升级改字段无人发现 |
| `tests/types/dx.types.ts` | 类型链路（`fromZod<T>` 校验方法签名、`result.typed` 推导、Blackboard 声明合并后的键补全） | 同上（`typecheck:types`，对 dist）。**反向验证过（2026-09-26 §1 审计）**：① 删掉一条 `@ts-expect-error` ⇒ `TS2345: '"profil"' is not assignable to 'keyof Blackboard'`；② 把 `RunContext.get` 的返回类型退化成 `unknown` ⇒ 两处 `TS2322`。⚠️ **同轮订正**：本文件头注原本写「由 `npm run typecheck:tests` 校验」—— **错的**，`tsconfig.tests.json` 明确 `exclude: ["tests/types"]`，它归 `typecheck:types`。照错的命令跑，整份文件的断言（含全部 `@ts-expect-error`）**一个都不会被检查**，改完还以为通过 | DX 承诺（「编辑器给不给提示」）退化成 `unknown` |
| `tests/core/trace.test.ts` · `tests/integrations/otlp.test.ts` | **id 的线缆形态只有一份投影**：OTLP 导出的 spanId 与出站 `traceparent` 的 span 位必须**逐字相等**（两处都等于 `core/trace.ts` 的 `wireSpanId(…)`） | 两条断言各自引用单源（不就地写 `replaceAll().slice(0,16)`）⇒ 任何一边换切法立刻红。反向验证过：otlp 侧改成 `slice(8,24)` ⇒ 结构用例真红 | 同一次调用在 collector 里是一个 span id、下游收到的是另一个 —— 跨系统关联断在最不该断的地方 |
| `src/transport/http.ts` · `src/transport/http-route.ts` | **判别联合的穷尽性断言**（两处）：`HttpRoute` 里未被 switch 处理的成员只剩 `healthz` / `metrics` / `notFound` 三个字面量（前两个已在免鉴权组提前 return）；`TaskStreamFrame` 的 5 个 `type` 在 `/tasks/<id>/stream` 的 `write` 里逐个 return，故其 `default:` 分支必须是 `never` | **编译期**（`npm run typecheck`）：`const residual: 'healthz' / 'metrics' / 'notFound' = route.kind` 与 `const _never: never = frame`。反向验证过：给任一联合加一个假成员 ⇒ 恰好那一行 TS2322，其余不误伤 | 新增 route `kind` 被**静默吞成 404**；新增流帧 `type` 被**静默丢掉** —— 客户端对着流干等、最后靠超时猜（本批加 `TaskStreamFrame.closed` 时是靠人工记住「三处同步」才没漏，现在编译期会拦住） |

### 1.2 静默失效（最贵的一类）

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/engine/concurrency.test.ts` | **任何 limit 下每个 item 都被处理恰好一次**（含 `0` / `(0,1)` 小数 / `Infinity` / `NaN`） | 边界值矩阵 + 不变量断言。**反向验证过（2026-09-26 §1 审计）**：① `width` 无视 limit（`= items.length`）⇒ 3 条红（`并发数被限制在 limit 内` / `(0,1) 小数` / run 级 `maxToolConcurrency 限制同回合并发`）；② 退回历史事故读法 `Math.floor`（去掉 `Math.max(1, …)`）⇒ **恰好** `(0,1) 区间的小数` 那 1 条红。⚠️ 用例里 worker 内有 `await sleep(5)`，所以 `peak` 是真峰值 —— 若夹具改成瞬时完成，`peak === limit` 会恒真、整条退化成假守卫 | `Math.floor(0.5)=0` → worker 数为 0 → 工具静默丢弃、run 报成功（真发生过） |
| `tests/timeoutLiveness.test.ts` | 「等待的终点」不得 `unref()`（唯一把手时进程会先退出、await 永不 settle） | 干净子进程（`tests/fixtures/timeoutLivenessProbe.ts`，同进程跑测试会被 runner 自己的把手藏住缺陷）+ 空事件循环验三个往返，断言退出码 **且**输出含 `LIVENESS ok:`。**反向验证过（2026-09-26 §1 审计）**：① 给 `withTimeout` 的截止计时器加 `unref()` ⇒ **恰好 2 条**红（engine / mcp），drain 仍绿；② 给 `drain-gate` 的计时器加 `unref()` ⇒ **恰好** drain 那 1 条红。⚠️ 两条实测合起来说明：**三条探针不是同一个站点的三个哨兵** —— 前两条守 `withTimeout`（单源），第三条守 `drain-gate` 自己的计时器（**另一份实现**）。改任一处只需其中一部分变红，别把它当成「三处都会同时报警」 | 调用方什么都拿不到、进程 exit 13（真发生过：CI 上是 `# fail 0, # cancelled 4` + `Promise resolution is still pending but the event loop has already resolved`） |
| `tests/engine/retry.test.ts` | 显式 `undefined` 字段**不得**覆盖缺省（`{maxAttempts: undefined}` 不是「关闭重试」） | 逐字段传 `undefined`，断言回落到缺省 + 退避算得出（`NaN` 会从这里冒出来）。**反向验证过（2026-09-26 §1 审计）**：去掉 `definedOnly`（退回 `{...DEFAULT_RETRY, ...o}`）⇒ **恰好**「显式 undefined 的字段 → 回落到缺省值」那 1 条红（`assert.ok(r)` 先炸 —— 重试被静默关闭），其余 15 条不误伤 | 重试静默关闭，而 trace 记成 `config.retry.maxAttempts: 0`（像是用户主动关的） |
| `tests/toolkit/env.test.ts` | `.env` 解析的分支矩阵（引号 / 引号+行内注释 / 转义 / 不闭合 / 值内含 `#` / CRLF+BOM / `__proto__`）+ `loadEnvFile` 的覆盖口径（**空串也算「已定义」**） | 表格驱动，逐格断言。**反向验证过（2026-09-26 §1 审计）**：① 覆盖判定从 `process.env[key] !== undefined` 退回真值判断 `process.env[key]`（空串被当成「未定义」）⇒ **恰好**「空串也算「已定义」→ 不覆盖」那 1 条红；② 去掉 `__proto__` 拦截 ⇒ **恰好**「`__proto__` 键 → 显式抛错」那 1 条红 | 密钥带字面引号进 `process.env` → 每个请求 401，而文件看上去完全正确（真发生过） |
| `tests/toolkit/subagent.test.ts` · `skill.test.ts` | 嵌套能力必须把 `toolTimeoutMs` 等透传子循环（裁判权交接） | 喂带字段的 ctx（`toolTimeoutMs: 20` vs 慢工具 200ms —— **值刻意不等于缺省**，否则「不转发」也绿），断言子循环按该口径记账。**反向验证过（2026-09-26 §1 审计）**：把 `forwardToolContext` 里的 `toolTimeoutMs` 漏掉（历史事故形态）⇒ **恰好 2 条**红（`subagent.test.ts` 与 `skill.test.ts` 各 1 条），其余 23 条不误伤 | 子循环永不超时 + MCP 桥起自己的兜底计时器 = 双计时器双账本 |
| `tests/toolkit/discover.test.ts` | `asset()` 的 `rel` 必须**真相对 base 解析**：带 scheme（`file:` / `https:`）与**绝对路径**（`/etc/passwd`）都会让 `new URL` 丢掉 base ⇒ 两者都显式拒绝；`../` 仍**放行**（它确实是相对 base 的） | 逐形态断言（scheme / `//` / `\` / `../` 反向对照）。**反向验证过（2026-09-26 §1 审计）**：① 去掉绝对路径拦截（退回只拦 scheme）⇒ **恰好**「绝对路径的 rel 显式拒绝」那 1 条红；② 去掉 scheme 拦截 ⇒ **恰好**「带 scheme 的 rel 显式拒绝」那 1 条红。两条各自独立、互不遮蔽 | 「以为读了能力目录里的文件，实际读了别处」—— 绝对路径那半此前没人守（`/etc/passwd` 在 macOS 上**真能读到**） |
| `tests/core/sse-text-stats.test.ts` · `tests/core/timeout.test.ts` | **「预算非正数 = 机制关掉」在共享原语上一致**：`interruptibleSleep(0, signal)` 不睡（**即使 signal 已中止也 resolve** —— 非正数判先于 aborted 检查）；到点 resolve 时必须摘掉 abort 监听。⚠️ **2026-09-26 §1 逐行审计订正两处**：① **归属写错** —— `withTimeout(p, 0)` / `(p, -1)` 不设超时那半的断言在 `tests/core/timeout.test.ts`（本文件只在注释里引用它），清单原来把两半都挂在本文件上，下一个人会去错地方找；② 本文件那条「带一个常驻监听做对照，防「计数函数恒 0」的假绿」**当时是假的** —— 见「机制」列 | 直接单测原语 + `getEventListeners` 计数。⚠️ **对照监听光挂不算**：原来只把 `baseline` 当比较基准、**从不检查它非零** ⇒ 实测把 `getEventListeners` 打瞎（恒返回 `[]`）后 `baseline=0 / after=0 / ac2=0`，三条断言全过、**用例照样绿**。已补 `assert.equal(baseline, 1)` 把「测量工具还活着」变成判据。反向验证过两个方向：① 打瞎 `getEventListeners` ⇒ 恰好那条红（补之前是**绿**）；② 到点不摘监听器 ⇒ 恰好那条红 | 有人把「已中止 + `ms<=0`」当 bug「修」成 reject ⇒ 破坏与 `withTimeout` 的对称性（2026-09-19 外部复核真误判过一次，被这条用例拦下）。⚠️ 而**对照监听失效**的后果更隐蔽：用例从此对「监听器泄漏」永远是绿的，长 run 里每个回合漏一个监听器也没人发现（`MaxListenersExceededWarning` 只是警告，不是失败） |
| `tests/engine/tracer.test.ts` | `usage()` 与 `snapshot().totalUsage` **逐字同口径**（预算护栏走前者、trace 交付走后者 —— 漂移就是护栏拿错数）。⚠️ **2026-09-26 §1 逐行审计订正：这条原来是假守卫** —— `snapshot()` 的实现就是 `totalUsage: this.usage()`（`src/engine/tracer.ts` 的 snapshot 尾部），同一对象同一个值，那句 `deepEqual` **恒等、永远绿**。实测：把 `usage()` 改成双算 capability（值错成 2 倍）⇒ 变红的是 `inputTokens === 100` 那条（`200 !== 100`），**deepEqual 照旧绿**。所以今天这个不变量是**结构保证（委托）**，不是被断言出来的 | ① **钉委托本身**：子类覆写 `usage()` 数调用次数，`snapshot()` 必须**恰好调一次**（刻意不依赖返回值相等 —— 那正是恒等的那个方向）。反向验证过：把 `snapshot()` 改成内联自己扫一遍 spans（**值仍然正确**）⇒ 恰好那条红（`实测 0 → 0`），而旧 deepEqual 依然绿 —— 证明只有「委托」这件事能被它咬住；② 旧 `deepEqual` **保留但降级标注为「潜在守卫」**（它在「有人把 snapshot 改成自己另算」那一刻才长出牙齿）；③ 真正的对账搬到**调用点**那一层，见下面 `budget.test.ts` 行 | 预算护栏按错的数字判超限 / 该拦不拦。⚠️ 这条是 `guards.md §2` 起手动作①（「逐行问它退化时真会红吗」）**实际抓到的第一个假守卫** —— 而且是**读了实现才发现**的：断言本身是真的、绿的、也是对的，只是它守的是**另一件事**（守住了「两条路今天相等」，没守住「两条路为什么相等」） |
| `tests/engine/budget.test.ts` | **护栏读到的数 = trace 交付的数**（同一个口径，且是**调用点**级别的对账）。这个不变量今天靠「三处调用点都写 `args.recorder.usage()`」（`loop.ts:149` 回合末 / `turn.ts:243` 回合入口 / `tracer.ts:339` 交付）保证，所以真正会被改坏的是**调用点**：换成增量 / 旧拷贝 / 手写的和 —— 护栏按错的数判，trace 交付另一个数，**没有任何报错** | 从产物侧对账：run 根 `budget.exceeded` 事件里的 `totalTokens` / `costUsd` vs `trace.totalUsage`。夹具的缓存两项**刻意非零**（`cacheReadTokens: 5` / `cacheCreationTokens: 7`）—— 护栏的求和与 trace 的求和是**两份实现**，全 0 的话「谁漏加了哪个字段」两边都看不出来。**反向验证过 3 条**：① 护栏求和漏 `cacheCreationTokens` ⇒ 恰好那条红（`护栏 120 vs trace 127`）；② `costUsd` 恒 0 ⇒ 成本那条红；③ 回合入口调用点传非累计值（`inputTokens: 0`）⇒ 恰好那条红（`护栏 57 vs trace 127`） | 护栏按错的数判超限：**该拦不拦（继续花钱）或误伤正常 run**，而 trace 交付的是另一个数 —— 事后拿 trace 对账也看不出护栏当时拿的是什么 |
| `tests/engine/spanScope.test.ts` | 出站 `currentTraceparent()` 的**调用期**作用域：粒度到本回合 / capability（不是 run 根）；并行链互不干扰、内层不外泄；run 结束不残留 | 真跑一轮 + 直测原语（内层链与旁支链各读一次，旁支必须在**内层已进入之后**读）。反向验证过（**2026-09-26 重测订正**）：把作用域退化成 run 级单值存储 ⇒ **「并行不串」那条必红**。实测两种单值实现：不还原的 `let globalScope` 红 **2** 条（并行不串 + run 结束不残留）；同步清除的变体只红**并行不串**那 1 条。⚠️ 粒度与 capability 那两条在单值实现下**仍绿**（写入顺序恰好让它们读到正确的值）—— 所以这条守卫真正不可替代的承重点只有「并行不串」，别把 5 条当成 5 个独立哨兵 | 退回 run 级单值存储 ⇒ 并行工具互相覆盖：下游拿到的 span id 指向**别的**那次调用（spec §9.2 锁定「span 句柄不放 RunContext」正是为此），且没有任何报错 |
| `tests/integrations/otlp.test.ts` | **OTLP/JSON 的 enum 必须整数编码**（`status.code` = 1 / 2、`kind` = 1；规范禁止 enum 名）；且 **HTTP 200 ≠ 全部接收** —— collector 的 `partialSuccess` 必须按失败处理 | ① 断言 payload 里 `status.code` 是整数，并**扫整个 payload 不得出现任何 `*_CODE_*` / `SPAN_KIND_*` 字面量**（假 collector 只做 `JSON.parse`，所以「断言跟着实现一起写错」会假绿 —— 加这条扫是为了堵住形成假绿的机制）；② 假 collector 回 `200 + partialSuccess`：`{}` 与 `rejectedSpans: 0` 算**全部接收**、非空 `errorMessage` 算**拒收**，traces 侧断言走 `onExportError`、metrics 侧断言抛 `MetricsExportError`。**反向验证过（2026-09-26 §1 审计）**：把 `status.code` 退回字符串 enum 名（`'STATUS_CODE_OK'` / `'STATUS_CODE_ERROR'`，即历史缺陷形态）⇒ **恰好 2 条**红（enum 扫描那条 + 结构那条），其余 9 条不误伤 | 严格的 collector 判非法并**整批拒收** ⇒ 观测数据全丢而框架说一切正常；把 200 的部分接收读成成功 ⇒ 看板少一半数据无人知（真发生过，2026-09-21 外部队列复核；两处都发过字符串 enum、都只查 `res.ok`） |
| `tests/integrations/metrics.test.ts` | **CUMULATIVE 指标的 `startTime` 必须随 `reset()` 前移**（同一 startTime 下 counter 只能单调不减） | 同一个 sink 导出两次、中途 `reset()`，断言值回到 1 **且**窗口起点**严格**前进（含同毫秒连按两次 reset）；窗口内不 reset 时起点逐字不变。**反向验证过（2026-09-26 §1 审计）**：把 `windowStart = Math.max(Date.now(), windowStart + 1)` 退回历史缺陷读法 `= Date.now()` ⇒ **恰好**「同一毫秒内连按两次 reset」那 1 条红。⚠️ 同时实测到：**真实时钟那条（`reset 之后导出`）在变异下仍然绿** —— 它两次 reset 之间隔了网络往返，起点必然前进。⇒ 这个角落**只有冻结时钟那条守得住**，别把两条当成两个独立哨兵 | 后端把「新窗口的小值」当成同一区间的分量 ⇒ 算出负增量或丢样本（真发生过：`reset()` 只清计数、起点取 sink 创建时刻的常量，导出值 2 → 1 而 startTime 没变） |
| `tests/integrations/mcpConnector.test.ts` | MCP 连接器**三件只有它能做的事**：spawn 的 `'error'` 是异步事件必须接住 / stdout 必须按 `\n` 攒包 / **协议层 `isError: true` 必须转成抛错**；装配期超时；`close()` **返回即子进程已终止**、且 HTTP 侧 DELETE **挂死时也必须到点返回**（server 半开不得挂住停机路径）；StreamableHTTP 会话过期（`404`）**自愈且只重试一次**、并发 404 共享同一次重握手 | 起**真子进程**夹具（`tests/fixtures/mcp/fake-server.mjs`，env 覆盖 8 种模式，含忽略 SIGTERM 的 `stubborn` + pid 文件）+ HTTP 侧注入 `fetchImpl`；用例本身由 **15 条变异电池**证明会咬 | `isError` 不转抛错 ⇒ 失败的调用被**模型与 trace 一起**记成成功（正好打在本框架「trace 决定你敢不敢上线」的承诺上）；不接 `'error'` ⇒ 命令不存在时未捕获异常把宿主进程带崩；`close()` 不等 reap ⇒ 留孤儿进程；会话过期不自愈 ⇒ 长跑宿主只能重建连接器 |
| `src/core/limits.ts` · `tests/limits.test.ts` | **`0` 的语义只有一份真源**：**20 个**旋钮各属「不限 / 机制关掉 / 立即执行 / 非法配置」四类之一，全部登记在一张可执行的表里；构造期报错文案里那句「（0 = …）」**直接插表里的 `zeroClause`**（文案与实现不可能各说各话） | 表驱动的**穷尽**用例（`Record<LimitKnob, 探针>`）：逐条**驱动真实站点**（`new AsyncRunner` / `mapWithConcurrency` / `resolveMaxRetries` / `Scheduler.every` / `metricsSink` / `createHttpHandler` / `sseWriter` …）对账，探针必须能把声明的读法与相邻读法区分开；新增旋钮不归类 ⇒ `typecheck:tests` 红。反向验证过：`drain-gate` 的 `<= 0` 改回 `< 0`（**历史事故那个读法**）+ `tracer` 的 `< 0` 改 `<= 0` ⇒ 恰好那两条红、其余全不误伤（当时表里 16 条）。**2026-09-26 起手动作② 扫「`0` 的语义」这一族时又补四处**：① 新登记 `Scheduler.every.maxInFlight`（与 `AsyncRunner.concurrency` 同族，`invalid` + 构造期抛错），变异「只拦 `< 0`、放行 `0`」⇒ **恰好 3 条红**；② `Scheduler.every.intervalMs` 的报错文案**表里有 `zeroClause` 却手写了**（单源断了一头），接线后变异「退回手写」⇒ 恰好文案那条红；③④ 新登记 `HttpHandlerOptions.maxBodyBytes` 与 `SseWriterOptions.maxBufferedBytes`（判据沿用同一接口里 `maxConcurrentRuns` 那条「0 ⇒ 全部拒绝 = 配置错误」），三条变异各 ⇒ **恰好 3 / 3 / 2 条红**、不误伤。⚠️ 同一行原先写「15 个旋钮」而真值是 18、且「其余 14 条」与 15 自相矛盾 —— **计数又一次只能靠数**（今天第四次） | 同一个 `0` 各处理解一遍 ⇒ `drain({timeoutMs: 0})` 跨过 deadline 后**永不返回**（真发生过）；`intervalMs` 在 `Scheduler.every` 里是「必须 > 0」、在 `metricsSink` 里却是「立即导出」—— **同名反义**且此前无人登记；⚠️ `maxInFlight: 0` 曾是**静默**的「周期任务永不派发」（既不跑也不失败，实测 60ms 内 0 次、无任何报错/日志），且 `??` 写成 `||` 会反向静默抬成 1 —— **两个方向都在替使用者改配置**；⚠️ `maxBodyBytes: 0` / `maxBufferedBytes: 0` 曾是「每个请求都 413」/「流活不过一帧」，且同样**没有任何测试传过假值**（`??` → `||` 后 84/84 全绿） |
| `src/engine/forwarded.ts` · `tests/types/forwarding.types.ts` · `tests/engine/forwarded.test.ts` | **转发不得漏字段**：`ToolRunContext` → 嵌套能力子循环那七个旋钮取自**唯一取值点**（映射类型 `{[K in Key]-?: …}` 要求七个键全必填），且 `ToolRunContext` 的每个键必须在「转发」或「引擎自装配」里**归类** | 调用点只写 `...forwardToolContext(ctx)`（两处手写清单已删）⇒ 没有可漏的地方；类型层断言「未归类键集 `extends never`」+「少一个键必须报错」。反向验证过：给 `ToolRunContext` 加一个未归类字段 ⇒ `typecheck:types` 真红（TS2322）；取值少一行 ⇒ `typecheck` 真红（TS2741） | `runAgentScoped` 漏 `toolTimeoutMs` 跨 engine → toolkit → ctx 三层无人发现，且后果是**反的**：子循环 `withTimeout(p, 0)` 永不超时 + MCP 桥另起自己的 60s 兜底 = 双计时器双账本（真发生过） |
| `tests/engine/pricing.test.ts` | `costEstimate` 的四组承重常量：**价格表按模型名精确匹配**（带日期的快照 id 与不带日期的别名互不相通）；**缓存乘数**（读 0.1×、写 1.25×）—— 直接决定 `maxCostUsd` 判超限用的那个数；**乘数可逐模型覆盖**（`ModelPricing.cacheRead` / `cacheWrite`，用来表达官方 1h 写的 2× 与逐模型读例外）；**乘数写 `0` 是「乘数为零」不是「未设」**（`??` 与 `||` 的差别**只**落在 `0` 上）；**非法配置在第一次 llm 调用之前就失败**（`client` 被调用 **0** 次） | 非零缓存用量的**精确值**断言（`$6.75` / `$36.75` / `$10.5` / `$6.5`）+ 带日期 id 判未定价 + 非法乘数构造期抛错 + 错误文案印得出 `NaN`（不是 `null`）+ run 级「早失败」断言。四条都反向验证过：① 两个乘数改成 0.5 / 1.0 ⇒ **恰好那条红**（而在此之前全量 1139 个测试**全绿** —— 所有用例的 cache 字段都是 0，公式里那两项恒等于 0，改多少都看不出来）；② 忽略价格表里的覆盖、只用缺省 ⇒ 恰好「乘数可逐模型覆盖」那条红；③ 文案渲染退回 `JSON.stringify` ⇒ 恰好文案那条红；④ 短路校验 ⇒ run 级那条红。**2026-09-26 起手动作② 补上第五条**（`0` 的语义）：⑤ 把 `costEstimate` 里两个 `p.cacheRead ?? CACHE_READ_MULTIPLIER` 改成 `||` ⇒ **恰好「乘数写 0」那条红**（`expected: 0, actual: 6.75`），其余 19 条不误伤 —— ⚠️ 补这条之前本文件 **19/19 全绿**，因为**没有任何一条用例把乘数设成 `0`** | 乘数被改错 ⇒ 成本估算失真且**没有任何测试报警**；宿主照抄官方文档的带日期 id ⇒ 内置表不命中、`maxCostUsd` 静默不触发（会留 `usage.unpriced`，所以**看得见** —— 但护栏本身是关的）；乘数覆盖失效 ⇒ 用了 `ttl: '1h'` 的宿主成本低估 37.5% 而毫无提示；⚠️ **乘数显式写 `0` 被读成「未设」⇒ 回落到 0.1 / 1.25，成本虚高、`maxCostUsd` 提前触发**（账不对，方向上是误伤）—— 而 `0` 是**合法**值（校验是 `finite && >= 0`），同一条纪律在 `src/core/limits.ts` 与 `exactOptionalPropertyTypes` 迁移里各出现过一次：「显式给的 0」与「没给」必须分开；非法配置的「早失败」退化（校验挪到循环中段 / 加个 try-catch 回落）⇒ 先烧掉真实 token 再报错。⚠️ 这条同时订正了文档口径：原话「非法单价在 run 开始即抛错」**实测是错的** —— 它被 `runAgent` 收成 `{status:'error'}` 的 result，不抛给调用方 |
| `tests/integrations/openaiStream.test.ts`（多模态块 C3） | **全仓两处 `JSON.stringify(b)` 兜底不是同一个东西**，口径必须分开守：`engine/trimming.ts` 在**决策路径**（估算/预算）⇒ 兜底**必须有界**；`integrations/openai.ts` 的 `renderUserContent` 在**转发路径**（内容真的交给厂商，厂商自己的 tokenizer 与上限说了算）⇒ **刻意不截断**（原注释：宁可把原文交给模型，也不静默丢内容）。「不截断仍不是缺陷」的**前提**是：大载荷根本走不到兜底 —— 图片块被 `imageUrlOf` 接走了 | 两条：① 未知块**原样**进请求体（含 200 字符 payload）；② base64 大图 → 整份请求体里载荷**只出现一次**（`JSON.stringify(req).split(B64).length - 1 === 1`；兜底若同时命中会变 2）。反向验证过（2026-09-26）：① 兜底改成静默 `void b` ⇒ 恰好「未知块」那 1 条红；② `imageUrlOf` 不再认 base64 ⇒ 恰好 2 条图片用例红 | 有人「顺手统一」把转发侧也改成截断 ⇒ 未知块内容**静默丢失**（模型看不到原文、且没有任何报错）；或把图片块并回 JSON 兜底 ⇒ base64 在请求体里出现两次（体积翻倍）且不再是 `image_url`，**视觉能力静默失效** |
| `tests/engine/trimming.test.ts` | **图片块与未知块：渲染有界、估算不低估**（两个方向刻意分开算）。此前 `contentToText` 只认 text / tool_use / tool_result，`image` 落进 `default: JSON.stringify(b)` ⇒ 一张 200KB base64 截图被估成 **50054** token，且整段 base64 **原样**交给 `compactMessages` 的摘要模型 | 四个方向各一条断言：估算**不随 base64 长度增长**（体积 ×4 估算不变）+ `renderMessages` 产物 < 200 字符且不含 base64 + `summarize` 收到的文本不含 base64 + 未知块「渲染截断但估算按未截断负载」。反向验证过：把图片块退回「未知块」处理 ⇒ 恰好那 3 条红、未知块那条仍绿。⚠️ **2026-09-26 复审补**：以上四个方向**只喂顶层图片块**，而 `tool_result` 的正文可以是块数组（`[text, image]` —— 工具返回截图，生产里最常见的入图路径），那一支仍走 `JSON.stringify(content)` ⇒ 实测渲染 **200 086 字符**、含原始 base64、估算 **50 022 token**（与顶层差 16 倍）⇒ 承诺只兑现了一半而用例全绿。已改为**逐块递归**（渲染走 `blockToText`、估算走 `blockTokens`），并补一条用例钉两端 + 与顶层的口径一致性。⇒ **两条反向验证**：退回 `JSON.stringify` ⇒ 渲染那 1 条红；关掉内嵌估算分支 ⇒ 估算那 1 条红（⚠️ 该断言第一版只写「< 4000」的**单边**判据，退回后回落成占位文本的十几个 token 同样满足它 ⇒ **不咬人**；补上「≥ 3136」才守住「别低估」那一向）。**同族第二个入口（同日一并修）**：`tool_use` 的**参数**此前是裸 `JSON.stringify(tu.input)` ⇒ `write_file` 正文 / 截图 base64 同样灌进摘要器；现按 `TOOL_INPUT_CHARS = 2000`（比未知块的 200 宽松一个数量级：参数前缀是调用意图、摘要需要它）截断并留计数，**估算仍按未截断参数**（方向相反，刻意不统一）；用例含「小参数不许被截断」的阳性对照，两条变异各恰好点名 1 条红。⚠️ **刻意不封顶**：`text` 块与 `tool_result` 的**字符串正文**（摘要器要读的「话」，截断 = compaction 永久丢历史） | 图片块（`usage-guide` 列为 `ContentBlockParam` 一等成员）被当未知块 ⇒ ① token 估算高估约 18×（官方按尺寸计费，与字节数无关）⇒ `maxTotalTokens` 提前误伤、预算策略每回合过度压缩；② 压缩时把每张图的原始 base64 当输入 token 发给宿主的摘要模型（真金白银 + 摘要质量被噪声毁掉）。**内嵌形态漏掉时后果完全相同**，只是入口换成「工具返回的截图」—— 而它比顶层图片更常见 |

### 1.3 宿主与耐久

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `scripts/e2e-deploy.ts` | 崩溃续跑：`SIGKILL` 后同库重启 `resumePending` 必须续跑 | 真起服务、真杀进程、同库重启、断言终态。**反向验证过（2026-09-26 §1 审计，两条承重断言各自独立咬合）**：① `resumeSkipReason` 把 `running` 孤儿也判成 `terminal`（退回只认 `queued` —— 正是「在飞任务死半路无人接管」的形态）⇒ **恰好**「重启应续跑 1 个未完成任务」那条红（脚本把整段 stdout 打了出来，里面确实没有续跑行），此时**终态那条还没轮到**；② 异步任务成功也记 `failed`（`rec.status = out.run.status` 改成三元）⇒ 续跑**照样认领**（stdout 那条**仍绿**）、**恰好**「续跑任务终态」那条红（`续跑任务终态=failed`）。两条互不遮蔽 ⇒ 这个 e2e 真有**两个**哨兵，不是一个 | 「耐久」是句空话（在飞任务死半路无人接管） |
| `tests/transport/host-hardening.test.ts` | 鉴权拦在**读 body 之前**、body 上限、并发闸门、`exposeErrors` | 真 HTTP 请求 + 断言状态码与连接行为。**反向验证过（2026-09-26 §1 审计）**：把鉴权块从「读 body 之前」挪到 `run` 分支的 `parseJsonBody` 之后 ⇒ **恰好**「鉴权先于读 body：同一超限请求，鉴权失败回 401、通过才回 413」那条红（另两条红是这次粗暴变异的副作用：挪走后其他路径干脆没了鉴权）。⚠️ 这条用例的形状是关键：**同一个超限请求跑两次**（鉴权失败 ⇒ 401、鉴权通过 ⇒ 413）才证明得了顺序 —— 只发一次超限 body 断言 413 是证明不了「谁先」的 | 未鉴权请求也会被读进 body；内部拓扑回吐给未鉴权调用方 |
| `tests/transport/async.test.ts` | 幂等键去重、`resumePending` 认领、迟到 reject 不改写终态；**幂等键的进程内认领**：同键并发提交只执行一次、**终态才释放**（挂起仍在等人 ⇒ 不释放）、释放判据按 `taskId` 而非 `claimed`（HITL 恢复段是另一次 `#execute`、异步 store 交出的还是新副本） | 状态机级用例 + `AsyncCopyStore`（异步 store 交出的记录是**反序列化新对象** —— 内存 store 的引用语义会把这类缺陷掩盖） | 同键任务重复执行；成功的 run 被落库失败覆写成 failed；**挂起过的键永久钉在认领表里**（同键再也不执行 + 表无界增长 —— 反向验证时真复现过：释放判据只看 `claimed` 或只比对象同一性，HITL 用例立刻红） |
| `tests/engine/approval.test.ts` · `tests/transport/approval.test.ts` · `tests/transport/httpApproval.test.ts` | HITL 挂起/恢复（2026-09-19 ①）：未决审批 ⇒ **整回合零执行零 tool_result**（协议配平）；`awaiting_approval` 不占槽、不触发 `onFinished`、`resumePending` 不捡、淘汰跳过；`approve` 逐 id 幂等（第一次赢）+ 先落库再派发；惰性超时自动全拒；挂起段照常 flushSinks、恢复段 link 上一段 | 引擎层 mockClient + 宿主层**真引擎**（executeRun）+ 真 HTTP；含「不做什么」断言（onFinished 不开火、普通工具不提前执行）。**反向验证过（2026-09-26 §1 审计）**：把审批闸改成「不挂起、让待决的照常跑」（破坏全有或全无）⇒ **16 条红**（引擎层 7 条 + 宿主层 8 条 + 并发/落库 2 条），覆盖面无死角 | 审批闸被绕过（副作用直接发生）；挂起被当终态通知 webhook；恢复丢决定/重复执行 |
| `scripts/e2e-grpc.ts` | **换宿主时最容易静默丢掉的四处语义**：deadline / 取消 → `signal`（要求服务端的 run **真被 abort**，trace 里 `error.type=aborted`，而不是照跑完）、metadata `traceparent` → run 根 link、同 `session_id` 两轮共享历史、同 `idempotency-key` 不重复执行 | 真构建 + 真起宿主（`PORT=0` 由服务自报端口，没有「探空闲端口再交出去」的抢占窗口）+ 用**示例自带的客户端**跑四个 RPC；模型侧假 Anthropic 端点、trace 落 tempdir（不留产物）；**变异电池 8/8 全部由对应断言抓住**（含一条「被抓住但不是被预期断言抓住」的更正记录，见 spec §10 2026-09-18 ⑪） | 客户端已经走了服务端还把 run 跑完（token 白烧）；跨进程链路在服务边界断掉；错误全塌成一个 UNKNOWN（调用方重试策略失效）；RPC 回了结果但「为什么慢 / 贵 / 失败」没有证据 |

| `tests/transport/queueConsumer.test.ts` | **队列消费者配方的三条承诺**（usage-guide §6.4 那条二十行样板）：同键重投**不重复执行**、`traceparent` 随 `spec.options` 落库使**他进程续跑**仍带得上同一条 link、失败不 ack 要 nack 重投 | 内存版 broker（at-least-once：交付即「在飞」/ `ack` 才算完 / 未 ack 与 nack 一律重投 / `crash()` 模拟崩溃）+ 真 `AsyncRunner` + 真引擎（`executeRun` + `mockClient`）把三条承诺各跑一遍；断言的是**副作用计数**与 `broker.deliveries`（不只 taskId —— 那才证明重投真的发生过）。反向验证（逐条隔离、可复现）：把 **submit 快路径**的复用判据（`async.ts` 的 `existing.status !== 'failed'`）改成 `!== 'succeeded'` ⇒ ①②④ 红、③ 绿（3/4 —— ④ 红是同一行的另一面：**失败**的键必须允许新任务，否则重投永远拿不到第二次执行；③ 的键全程唯一，不碰幂等判据）。按字面改 **`#executeInner` 的采纳判据**（`async.ts` 的 `existing.status === 'succeeded'`）⇒ 四条全绿：该采纳路径只在「异步 store + 同进程认领表未命中」的窄窗口可达，而本文件用同步内存 store，submit 快路径已把去重做完，根本碰不到它 —— 所以它**不是**本文件的守卫对象（此前「四条全红」的记录是把两处判据混为一谈了） | 配方是宿主侧样板、框架侧无可测实现 ⇒ 「文档承诺可跑」此前没人跑过；生产上表现为重投导致**下单两次**（副作用翻倍），或链路在消费者那一跳断掉（`resumePending` 续跑的那次 run 丢了上游 link） |

### 1.4 文档与发布面

| 守卫 | 保护的不变量 | 机制 | 退化了会怎样 |
|---|---|---|---|
| `tests/docs/usage-guide.test.ts` | `usage-guide.md` 的表格**逐项对源码核**（字段名/默认值/类型） | 解析文档 + 断言与源码一致（表格首列名字必须是所点类型的成员、字段名/默认值/类型逐项对源码核）。**反向验证过（2026-09-26 §1 审计）**：把文档里一个真实字段名改成不存在的（`maxToolConcurrency` → `maxToolConcurrancyXX`）⇒ **恰好**「表格标题点名了类型的：首列名字必须是该类型的成员（含继承）」那 1 条红 | 文档承诺了、代码没有（本仓库最主要的对外风险面） |
| `tests/docs/api-page.test.ts` | 官网 `api.html` 对导出面的**反向全覆盖**（每个导出都必须在页面出现）；**页面上所有手写数字**对源码核（`N 个导出` → `src/index.ts` 导出数、`N 个层次` → 页面 section 数、`N 个运行时依赖` → `package.json` 的 `dependencies` 数、`N 类能力` → 四个能力装饰器、`N 类触发` → 三个传输宿主）；以及**第二列的类型形状**对源码成员集核（2026-09-26 新增，见下） | 读导出清单 / 计数 + 扫页面文本（两个 fragment 的 chips 与首屏统计行都覆盖）。**反向验证过（2026-09-26 §1 审计）**：往 `src/index.ts` 加一个导出 ⇒ **恰好 2 条**红（反向全覆盖那条 + 页头统计那条），其余 8 条不误伤。**2026-09-26 起手动作② 补上第三条**：第二列 `<code>{ … }</code>` 的形状按**花括号配平**抽出（`[^}]*` 会把嵌套形状截成半个），**先解 HTML 实体再按 `;` 切段**（`&lt;` 自带分号 —— 不解码时 `Promise&lt;void&gt;` 会被切成两段，`TraceSink` 被误判成「发明了 void」，实测踩过），规则两条：**① 形状里没有 `…` 的 = 自陈穷尽 ⇒ 与源码成员集必须相等**（「补上 or 加 `…` 自陈子集」）；**② 带 `…` / 方法签名 / 嵌套对象的 ⇒ 只做「页面 ⇒ 源码」**（防凭空发明字段）。只认 `interface`/`class`（`type X = A & { … }` 这类 `bodyOf` 只拿得到一支，会把另一支的字段误判成发明）。**反向验证过 3 条**：① 给 `Span` 加一个字段 ⇒ 恰好红（`Span：形状没有「…」…却漏了源码里的 bogusField`）；② 页面里凭空加一个字段 ⇒ 恰好红（`Span：页面写了源码里没有的字段 inventedField`）；③ 把形状解析器打瞎（正则永不匹配）⇒ 计数下限红（`只做了 0 次「相等」比对，预期 ≥40`），且纯函数合成用例同时红。**2026-09-26 起手动作② 同日再补上第四条（散文钉）**：第三列凡同时出现「价格表 / 单价 / `priceOverrides`」与「非法」的行，必须说清这个错**不抛给调用方**，且不得把失败归因到「构造期」—— 规则收在**纯函数** `pricingProseProblems()` 里，**只在踩过的那两处钉**（`DEFAULT_PRICING / buildPricing` 与 `priceOverrides`）。**反向验证过 3 条**：① 删掉 `priceOverrides` 行的「不是抛异常给调用方」⇒ 恰好那条红、报出该行名；② 把 `DEFAULT_PRICING` 行的「第一次 llm 调用之前」改写成「构造期」（**限定语刻意保留**）⇒ 恰好那条红、且只报「构造期」那条（证明两条规则**独立**，不是一条伪装成两条）；③ 把两行的「非法」全改写成「不合规」⇒ **防真空**那条红（`只在 0 行命中「价格表 + 非法值」…预期 ≥2`）—— 触发面归零时钉子会**自己喊**，不会静默退化成永远为真的文字。⚠️ **射程边界**：钉子只在**踩过的那两处**、且触发词是「非法」（换个说法就静默失效）—— 全页散文仍**不在**射程，它只能防**回归**，防不了**新写错的散文** | 新增导出在文档里缺席；「0 个运行时依赖」变成 1、加一类能力后页面继续写 4 —— 这类数字此前靠人眼改（`1 个运行时依赖 → 0 个` 真漂过）；⚠️ 类型形状这条的**历史代价**：`ModelPricing` 少写 `cacheRead?` / `cacheWrite?`、`Span` 少写 `traceId`、`AppOptions` 少写 `onTraceEvent?` 等 **7 行**（真发生过，2026-09-26 靠新守卫一次全查出）—— 读者按页面写代码时会以为这些字段不存在 |
| `tests/docs/no-legacy-terms.test.ts` | 面向使用者的表面（文档 / 官网 / 包 README / CLI `--help` 与报错）不得出现旧伞形术语 | 文本扫描 + 允许标记块（有行数上限）。**反向验证过（2026-09-26 §1 审计）**：往 `docs/usage-guide.md` 注入旧术语 `maxUnits` ⇒ **恰好**「README / usage-guide / 官网 / 示例 / 发布包 里没有旧术语与旧目录约定」那 1 条红 | 一次改名漏扫几处，读者看到两套术语 |
| `tests/docs/run-output-shape.test.ts` | `run` 返回结构的文档形状与实际一致 | 扫描 + 断言。**反向验证过（2026-09-26 §1 审计）**：往 `docs/usage-guide.md` 注入一处「直接用 `run.finalText` 拿最终文本」⇒ **恰好**那条红（`AgentRunOutput = { run, result }` 的形状被守住） | 结构化结果的对外契约漂移 |
| `tests/docs/sse-frames.test.ts` | **SSE 帧名**：usage-guide 里反引号写出的带点帧名（`task.end` / `stream.closed` / `trace.event` …）必须真从 `http.ts` 的 `sse.event('…')` 发出来（单向：文档 ⇒ 实现；`trace.truncated` 是 run 根 attribute **不是**帧，显式排除；无点的 `error` 帧不在射程） | 双向正则抽取 + 集合求差，两侧各有 `size` 下限防真空变绿。反向验证过：往文档文本里注入 `task.bogus` ⇒ 被抓 | 帧名是字符串面、不进类型系统 —— 帧改名或文档写错时，面板/客户端按文档等一条**永远不会来**的帧（2026-09-22 复核记录 §6-5：此前 tests/docs 对帧名零命中） |
| `tests/docs/commit-refs.test.ts` | `docs/**` 里反引号写出的**提交引用**必须真在主干（`origin/main` → `origin/HEAD` → `HEAD`）的祖先链上 | 递归扫 `docs/**/*.md`，抠出 7–40 位十六进制 token；**先用 `git rev-parse --verify` 过滤**（`deadbeef` / `ff00ff` 这类十六进制词不是提交，硬判会误报），再对**真能解析成 commit** 的做 `merge-base --is-ancestor`。`resolved` 下限当**浅克隆探针**（浅克隆下历史不可见 ⇒ 解析数归零 ⇒ 红，并提示 CI 要 `fetch-depth: 0`；`.github/workflows/ci.yml` 的 verify job 已设）。反向验证过：往 `docs/` 放一个含**那个坏哈希**的探针文件 ⇒ **恰好**报 `docs/__guard_probe.md: 83902c2`，同一文件里的合法 `2acd803` 与十六进制词 `deadbeef` **都不误报** | 计划文档引用一个**不在主干上**的提交（squash 合并后，分支提交就从 main 的祖先链上消失），读者 `git show` 会报未知修订 —— 2026-09-23 真发生过：`docs/plans/2026-09-23-cli-structure.md` 写「提交 83902c2」（**这个坏哈希刻意不加反引号** —— 加了就会被本守卫自己抓；同 `guards-registry.test.ts` 头注里那条「举例用假路径要写在行内代码之外」的豁免口径）并一路合进 main，而**当时 `docs/**` 的提交引用不受任何守卫**（`guards-registry.test.ts` 只读 `docs/guards.md`） |
| `tests/scripts/release-scripts.test.ts` | `release.mjs bump` 的**每项替换计数断言**本身可靠 | 直接测护栏（护栏失灵会写坏整棵树，且发生在发版当天）。**反向验证过（2026-09-26 §1 审计）**：把 `scripts/release.mjs` 里 `if (count !== s.count)` 的判据用 `if (false)` 旁路（「计数不符不再当问题」）⇒ **恰好 2 条**红（`计数不符 ⇒ 中止，且**一个字节都没写**` + `工作树脏 ⇒ 拒绝`），另 8 条不误伤 | 一次 bump 把仓库写坏却没人拦 |
| `scripts/e2e-cli.ts` 第 8 步 | 两包 tarball 必须含 `CHANGELOG.md` | `npm pack --dry-run` 断言（临时 npm cache，不依赖宿主缓存健康）。**反向验证过（2026-09-26 §1 审计，两包各一次）**：把 `package.json` 的 `files` 退回历史缺陷形态 `["dist"]`（漏 `CHANGELOG.md`）—— ① 改**根包** ⇒ 恰好 `@migor/agentia 的 npm 包里没有 CHANGELOG.md`（报错把实际清单前 5 项打了出来）；② 改 `packages/cli` ⇒ 恰好 `@migor/cli …` 那条。两次都只红这一条、第 1–7 步全过 ⇒ 循环的**两圈都是活的**（不是只守了第一个包）。⚠️ 输入是 `package.json` 本身、不是派生物，所以**不需要 rebuild** —— 与 `dx.types` / `templates` 那两处坑正相反 | 迁移指南写了但用户看不到（真发生过） |
| `scripts/e2e-cli.ts` 第 4d / 4d-bis 步 | **重复构建不得留下已删除能力的产物**：产物自己的 `npm run build` 必须先清 `dist/`，删掉一个能力再建 ⇒ 旧产物必须消失、本次该有的产物仍在。**命令字面来自生成物 `package.json`**（测试不复刻那三步） | 真删（能力目录 + 注册表那两行都删）→ **真跑 `npm run build`** → 断言旧产物消失 + `dist/main.js` 仍在。反向验证过：把模板 build 里的清 dist 那一步摘掉 ⇒ `SMOKE FAIL: 重复构建后仍留着已删除能力的产物`（真跑过） | 生产入口按自身位置 discover `dist/<分类>/` ⇒ **删掉的能力继续被加载进菜单**（源码里找不到、进程里却能调；tarball 里的幽灵产物同理）—— 这一条不是清理癖，是行为正确性 |
| `packages/cli/test/templates.test.mjs` | **模板目录 ↔ CLI 源码双向引用**：模板目录里每个文件都被源码引用；`templates.ts` 的每个 accessor 都有**调用方**（除访问层本体）；每个 `renderTemplate` 路径真实存在 | 扫模板目录 + 读 `src/*.ts`（掐掉 import 语句后再判「有没有人调」—— `import { cleanMjs }` 也算名字出现过，放行它就等于放行「导入了但从不写」）。反向验证过：删掉 create 里那行 write ⇒ 红；删掉模板文件 ⇒ 红两条 | 模板写了却没被 `create` / `g` 写出去 ⇒ **生成的项目缺文件**（真发生过 2026-09-21：模板目录有 `packages/cli/templates/scripts/clean.mjs`、build 脚本引用它，`create` 忘了写 ⇒ 新工程 `npm run build` 第一步 MODULE_NOT_FOUND） |
| `scripts/verify-all.sh` 第 1 步 | lint 与类型检查折进同一条链（本地链 == CI 链） | Biome + `tsc`。**反向验证过（2026-09-26 §1 审计）**：往 `tests/engine/retry.test.ts` 尾部注入一行 `const   unusedProbe    =    1`（同时触发 `noUnusedVariables` 与格式差），单跑该步的命令 `npm run typecheck && npx biome ci . --error-on-warnings` ⇒ **exit 1**（诊断里同时给出 `lint/correctness/noUnusedVariables` 与 `format ✖ File content differs from formatting output`）；复原后 exit 0 ⇒「lint 折进第 1 步」这条承诺成立，不是只写了句注释 | 「本地 8/8 绿、CI 挂 Biome」（真发生过） |
| `scripts/check-website-agent-readiness.mjs` | **官网产物与单源文档不得漂移**：`llms-full.txt` 必须与 `docs/usage-guide.md` **逐字节相等**（「站点上不会出现第二份手写说明」是这条链的全部意义）；`llms.txt` 的站内链接必须全绝对、且覆盖全部产物页面；`sitemap` 与产物页面集合互为真值；**每页都有同名 `.md` 变体**（GEO 档 C，4 个页面 + robots/sitemap/llms 共 **13 类**产物齐备）；每份 `.md` 首行是 llms 指引（**单行 + 链接形态**）；每份 `.md` 与页面**结构对账**（无残留 HTML 标签 / 标题与代码块计数精确相等 / 每个标题文本逐条在场）；内容协商层 `dist/_worker.js` 在场 | 构建产物对单源做**字节比对** + 按「链接目标集合」精确比对（**刻意不用整文/整行 `includes`** —— 首页 loc 是其它任何 loc 的前缀，前缀匹配会把「丢页」洗成绿灯）；`.md` 那三条取**可精确相等**的量（计数 + 文本在场），只有「数量对上但内容丢了」的形态靠最后那条抓得住。挂在 `verify-all.sh` **第 8 步**（`npm run build:website && node scripts/check-website-agent-readiness.mjs`）。⚠️ 「不得残留 HTML 标签」**不能写成「正文里不许有 `<`」**：api.md 表格里的 `SchemaInput<S>` / `<T>` / `<name>/index.ts` 是正当内容（泛型与占位符）。这一条**收紧过两次**，每次都是被真产物当场打回来（读数）：裸 `<` 扫描 **35 处**假红 → 再剥掉行内代码仍 **9 处**（写在散文里而非代码里）→ 最终判据「已知 HTML 标签名 + 后随 `>`/空白/斜杠」且剥掉代码块与行内代码 ⇒ **0 处** | 单源文档改了却忘了重建 ⇒ 官网 / 包内 `AGENTS.md` 停在旧版本，**同一条事实在仓库里有两个版本**，而读者看到的正是旧那份；`.md` 变体少一份 ⇒ 打分器的 Markdown Availability 整格回退；`.md` 转换开始丢段落 ⇒ agent 读到的正文少一截而构建全绿。⚠️ 这条也是 PR 模板「改了 `docs/usage-guide.md` 时已重建派生物」那句承诺的**唯一机器依据**（发布侧另有 `scripts/release.mjs` 对 tarball 内 `dist/AGENTS.md` 与单源做 sha256 对拍）。**2026-09-26 审查时才发现它此前根本没登记进 §1** —— 属「清单不完整」那一类：`guards-registry.test.ts` 只查「列出的路径在不在盘上」，查不出「盘上有守卫却没列」 |
| `packages/cli/test/dist-guard.mjs` | CLI 去类型移植副本与框架真源的**逐字对拍**不得静默跳过 | 产物缺失时 CI 判失败、本地醒目警告（**刻意不静默 skip** —— 静默跳过 = 假装验过）。**反向验证过（2026-09-26 §1 审计）**：拿一个不存在的路径直接调 `distReadyOrLoud` ⇒ 本地分支返回 `false` 且打醒目警告；`CI=1` 下抛 `AssertionError`。两个分支都实测过 | 对拍变成空断言（「逐字守护」名不副实） |
| CI `import-floor` job（`scripts/check-import-floor.mjs`） | 包在 Node 18/20 上可导入（`engines: >=18` 的声明**是可执行的**）：① 包可导入 ② 关键导出在位 ③ `SqliteTaskStore` 要么可用、要么给出**可读报错**（不是崩） | CI 在**最低支持版本**上真跑导入。**2026-09-26 首次在本地真验**（`npx node@18` / `node@20` 都拿得到，不必再记「没法本地验」）：基线三个运行时各自绿 —— Node 22.22.2 `SqliteTaskStore 可用` / Node 18.20.8 与 20.20.2 `给出可读报错`，全 exit 0。**反向验证过 3 条**：① 退回**历史缺陷形态**（`sqliteStore.ts` 顶层静态 `import 'node:sqlite'`）⇒ **Node 18 exit 1**（`ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`）而 **Node 22 exit 0** —— 旧 Node 专属、**其他任何守卫都看不见它**（CI 主跑 22，正是当年漂到线上的原因）；② 把可读报错改成泛化文案 ⇒ Node 18 exit 1（`旧 Node 上 SqliteTaskStore 应给出可读报错 / expected: /需要 Node ≥ 22\.5/`）；③ 防真空下限 50 → 500 ⇒ exit 1（`导出面过少：79`）。⚠️ 这行读的是 **`dist/`**（派生物）⇒ 变异 `src/` 后**必须先 `npm run build`**；⚠️ 且我第一次的变异脚本用行内 `//` 注释收尾，把同一行的收尾符号一起吞了 ⇒ 变成 `SyntaxError` 也 exit 1 —— **「exit ≠ 0」不等于「真变红」**，已重做（先 `node --check` 再跑） | 旧 Node 上整包加载即崩（`src/index.ts` eager 再导出 `SqliteTaskStore`，而 `store/sqliteStore.ts` 顶层静态 import 了 Node ≥22.5 才有的 `node:sqlite`）——**声明与实现不一致且无人守**（真发生过，`check-import-floor.mjs` 自己的头注记着这次事故） |
| `packages/cli/test/panel-logic.test.mjs` | **面板逻辑可在 Node 里直测**（`panel-logic.ts` 零 DOM 引用），且各条口径逐条钉住：全选/空集 ⇒ `undefined`（`toolSources: []` 是收窄到**空菜单**的陷阱值）、收窄按**字典序**（不是点击序）、多轮初始值 = 所选能力声明的 **OR** 且带来源、**失败轮**靠 run 根的 `session.id` join 回对话流、**`runDoneNotice` 的判别顺序**（先 `stopReason` 后 `ok` —— 中止的 run `ok` 也是 false，反了就把「我按的中止」显示成「run 失败」）、**`nextSessionId` 的轮换与正则转义**。另含 watch 判据：`WATCH_EXT` 允许清单含 `.md`、`WATCH_SKIP` 排除 `dist`/`.agentia`（`shouldWatch` 与 `watchTree` 从 `dev.ts` 导出专供测试，`nextSessionId` 同理），其中**一条用例专测「启动之后才出现」的跳过目录**（`dist/` 与 `.agentia/` 各自一轮、中间等过去抖窗口 —— 不让 `flush` 只报第一条的合并掩盖被测行为），测的是 `watchTree` **自己的**契约「跳过判据对**初始递归**与**动态新增**两条路都成立」；另有 `watchRootEnvFiles`（**项目根**的 `.env` / `.env.local`）：改它必须回调，而项目根的 `README.md` / `package.json`（扩展名**都在** `WATCH_EXT` 里）必须被**名字过滤**挡掉。⚠️ 这两条都只测函数**自己的**契约 ——「调用点接上了没有」只能由 `e2e-dev` 真跑守（根是**调用点**决定的） | 面板 JS 抽成模块、单测 import `dist/` 产物；watch 用例起**真 tempdir** 写真文件（含新建子目录的动态纳入）。反向验证过：`nextSessionId` 改成不轮换 ⇒ 2 条红（`expected 'dev-2' actual 'dev'`）；去掉 base 的正则转义 ⇒ 红（`expected '.dev-2' actual '.dev-5'` —— 未转义时 `.` 变成「任意字符」，`Xdev` 会被当成 `dev` 的下一号）；把 `runDoneNotice` 的两个分支对调 ⇒ 红；把目录跳过判据**只留在初始递归那个调用点**（即摘掉本轮修复）⇒ 恰好那条红（`dist/ 是启动后才出现的跳过目录，里面的写入不该触发重启`），其余 15 条保持绿；把 `watchRootEnvFiles` 的**名字过滤**换成 `shouldWatch`（丢掉「只认名字」）⇒ 恰好那条红（`项目根的非 env 文件不该触发`），其余 16 条保持绿。**2026-09-22 复核这一轮又长四组**（都在同一份纯逻辑里，各带单测）：**在飞 trace 的折回**（`emptyTraceAccumulator` / `applyTraceEvent` / `partialTrace`：手写一段事件流与它对应的收尾 spans，断言「按 `seq` 折回 == 收尾的整棵 trace」—— 复刻框架 `tests/engine/trace-events.test.ts` 那条不变量；边界三条各有用例：`seq` 不前进即丢、指向未知 spanId 即丢、重复 `span.begin` 原地刷新不重复挂树）、**回复归属**（`replyBelongsTo`：同一条 trace 才保留）、**`浏览…` 的目标**（`browseTarget`：永远优先输入框里的值）、**选文件后的 prompt**（`promptAfterFilePick`：只在 prompt 为空时填）。反向验证过：把折回里 `span.end` 那支掐掉 ⇒ 红（`折回结果必须逐字等于收尾的 spans`） | 面板成为仓库里**唯一没有测试的复杂逻辑**（它已是这批工作里最大的一块，比 `dev.ts` 的进程管理还大）；`.md` 掉出允许清单 ⇒ 改 `system.md` **静默无感**（G3b 实测过）；`.agentia/` 进 watch 范围 ⇒ dev 环每轮往 `session.json` 写一次 ⇒ **每次 run 重启一次子进程**的自噬循环。⚠️ 但要说清**两层**：真跑时的第一层是**监视根**（`devServer` 只 `watchTree(<projectRoot>/src)`，而 `.agentia/` 与 `dist/` 在项目根、根本不在范围内），`WATCH_SKIP` 是**第二层**，防的是「哪天有人把根改成项目根」；两条路（初始递归 / 动态新增）都判才叫「判据成立」，只判一条叫「碰巧打不到」（见 §2 尾注 ⑤） |
| `packages/cli/test/markdown.test.mjs` | 面板的 Markdown **解析器**（`packages/cli/src/markdown.ts`，纯逻辑、零依赖）：块级六种（标题 / 围栏码 / 列表 / 引用 / 分隔线 / 段落）+ 行内四种（码 / 粗 / 斜 / 链接）逐条钉住；其中两条是**安全断言** —— ① 整棵树里只可能出现白名单里的 token 类型（`p`/`h`/`code`/`list`/`quote`/`hr`/`text`/`strong`/`em`/`link`），「HTML 透传」这一类一旦被加进来立刻红；② 不合法协议（`javascript:` / `data:` / 大小写变体）的链接**整条降级成字面文本**（含 `[]()` 一起显示 —— 使用者看得出「这里有个链接我没渲染」）。健壮性另有：空串 / `null` / CRLF / 光秃记号 / 50k 单行 / 1 万行围栏（防回溯爆炸，2 s 上限） | 直接 import **构造产物** `dist/markdown.js`（未构建则 skip 并响亮警告，与其它 CLI 测试同款）；用例里的 `flat()` 只压「类型 + 文本」，不钉 token 树的枝形（改内部结构不该红） | 面板要把**模型可控内容**当文档渲染 ⇒ 直接吃 XSS：`<script>` / `<img onerror>` / `javascript:` 链接都是模型输出。引第三方解析器 + 消毒器还会把两份**本仓单测验证不了**的产物塞进 dev 链路（与「零运行时依赖」的承诺直接冲突）。反向验证过**两条**：把 `isSafeHref` 放开成恒真 ⇒ 红（`整条降级成字面文本`）；让解析器产出一个非白名单 token 类型 ⇒ 红（`白名单外的 token`）—— ⚠️ 这个变异体必须用**双重断言**绕过 tsc（直接写 `type: 'html'` 会编译失败 ⇒ 门禁根本没跑到，第一版就空跑了一次） |
| `packages/cli/test/inspector.test.mjs`（dev 环 HTTP 面） | ① **鉴权**：`Origin` **缺失放行** / `Origin: null` **拒绝** / 跨源拒绝，per-session token 在**每个**端点生效、三种载体（`?t=` → `Set-Cookie` 带 `HttpOnly`+`SameSite=Strict` / `x-agentia-token` 头 / cookie）都验；② `POST /run` 的入参校验与**状态码透传**（409 在飞 / 400 目录不存在 / 500 兜底 —— 4xx 不得被吞成 500）；③ `/api/fs` 只列目录、跳过点目录、路径不存在时**响亮报错**；④ SSE 的 `dev` 命名事件与既有 run 汇总帧共存；⑤ `POST /run/abort`（没有 runner ⇒ 503、没在飞 ⇒ 钩子的 409 原样回、`escalated` 两态都 202 透传、**`GET` 不落钩子**）；⑥ `POST /session/clear`（503 / 409 / 200 + 新 id 透传）；⑦ **面板 import 名单的反向全覆盖** —— 页面 `import {...} from './panel-logic.js'` 里每个名字都必须是该模块的真导出 | 真 HTTP + 假钩子（本文件不知道子进程 / tsx / runner 的存在）；伪造 `Host`/`Origin` 一律走 `node:http` 的 `request` —— **fetch 把这两个列为禁改头、会静默丢掉**，用 fetch 写这组用例会**假绿**。⑦ 的机制是「从页面 HTML 里正则抠出 import 名单 → 逐名 `in mod`」：浏览器里 import 一个不存在的导出是**整块模块求值失败**（面板白屏），而 node 侧各用例各自 import 自己要用的名字，**照样全绿** | 未鉴权的本机进程能驱动 agent（任意 prompt × 任意工作目录 = 让 agent 读你整个盘）；面板把「你手快点了两下」显示成「服务器炸了」，真实原因被 500 掩掉；⑤⑥ 的路由若只写在面板里而不在服务端（或反之），点下去**看着像成功了**却什么都没发生 —— 反向验证过：把 `/run/abort` 改成「忽略钩子、一律报 202/不升级」⇒ 红；`/session/clear` 同理 ⇒ 红；⑦ 往页面 import 名单里塞一个不存在的名字 ⇒ 红（`panel-logic 必须导出「runDoneNoticeTypo」`）。**2026-09-22 复核这一轮又长三条**：⑧ `POST /ingest-event` 的入站校验（形状不合法 ⇒ 400、没有 dev 钩子 ⇒ 503）与**原样广播**（接到的就是 `traceEvent` 钩子收到的那个对象）；⑨ `/api/fs` 的**三组**返回（`dirs` / `dotDirs` / `files` + `filesTruncated` 明示截断，点文件名要能拿到它所在的目录）；⑩ 三条**接线**判据（抽进 `panel-logic` 了、页面必须真的走它：`!replyBelongsTo(` / `browseTarget(` / `promptAfterFilePick(` / `kind === 'trace-event'` / `applyTraceEvent(` / `state.live = null`）—— 抽出来不接上等于没抽，而浏览器里没人替你发现。**2026-09-22 第三轮（Markdown / 滚动 / 折叠）**：⑦ 的反向全覆盖从「只查 `panel-logic.js`」扩到**所有自建模块**（`panel-logic.js` + `markdown.js`：逐文件 `curl` 200 + 逐名 `in mod`），并新增四条**页面级不变量** —— ① 全页对 `innerHTML` 的**赋值**只准一处且必须是 `renderSummary(`（模型正文一个字节都不许进 innerHTML —— 这条比「某个变量名没出现」强得多）；② `body` 必须 `overflow: hidden`（整页不滚）；③ `#trace` 必须是那个滚动区；④ 窄屏必须有单列回退；另 ⑤ 被服务的 `markdown.js` 里不许出现 `document.` / `innerHTML`（解析器是纯逻辑，渲染不许塞进它）。反向验证过：把滚动分层的 `body` 改回 `overflow: visible` ⇒ 红（`整页不该滚`）；把正文渲染改成 `body.innerHTML = text` ⇒ 红（`innerHTML 的赋值只该有`）。**2026-09-23 第四轮（面板卸载收口）**：⑪ 两条新判据 —— ① `POST /api/fs/pick/cancel` 真走钩子（`cancelPick` 被调、幂等 200、缺 token 403、**没有 dev 钩子必须 403 而不是 404**：403 = 路由在、被闸挡着；404 才是「路由没接上」，那正是本条要防的）；② **页面接线对拍** —— 页面必须挂 `pagehide` + 用 `sendBeacon`，且路径与服务端 `PICK_CANCEL_PATH` **逐字一致**（页面 import 不到那个常量，不钉就是「页面发了、服务端 404」的静默漏）。为什么必须有它：实测「刷新 / 卸载体」时服务端**收不到 close**（浏览器不关那条连接，`lsof` 上仍 ESTABLISHED）⇒ 只靠断开时选择框留在桌面上、之后每次点都 409。反向验证过三条：摘掉页面的 `pagehide` 接线 ⇒ 红；路径少一个字母 ⇒ 红（逐字对拍）；摘掉服务端那条路由 ⇒ 红；**2026-09-24（选择器返回值透传）**：⑫ 「选完文件夹 → 透传给 run 的就是所选目录」这条链的**两端接线** —— ① **页面接线**：`/api/fs/pick` 的返回值必须写进工作目录控件（`workdirEl.value = body.path`），且 `readControls` 从**控件**取值而不是镜像 `state`（两处各存一份就是「选完不生效」的温床）；② **服务端接线**：把选择器返回的 path 原样喂给 `/run` ⇒ 钩子收到的 `workdir` 就是它（且**不是**回落 `defaultWorkdir`）。为什么必须有它：2026-09-24 真用户反馈「选完之后透传给 agent 的不是所选文件夹」—— 逐环核实后链路是通的（`createApp` 把显式 `providers` 拼在 discover 结果**之后** ⇒ 模板的 `WORKDIR = opts.workdir` 赢；面板 `readControls` 读 DOM 单源），但**当时没有任何守卫钉着这条链**：`scripts/e2e-dev.ts` 第 15-ter 步只覆盖 `POST /run` **直带** workdir，选择器那一跳（返回值 → 控件 → 请求体）全靠人读码 —— 而「抽出来没接上」在浏览器里没人替你发现（与上面 ⑪②、`structure.test.mjs` 的 ⑦ 同一条纪律）。反向验证过**三条**：摘掉页面的 `workdirEl.value = body.path` ⇒ 恰好那条红；摘掉 `parseRunRequest` 的 workdir 转发 ⇒ 红（连带既有那条 `/run` 校验用例一起红 —— 同一行承重）；把 `readControls` 的 `workdirEl.value.trim()` 换成 `state.workdir` ⇒ 恰好那条红 |
| `packages/cli/test/templates.test.mjs`（能力名一致性） | 模板里被装饰的方法名**就是模型看到的工具名** ⇒ 生成物必须统一 snake_case（占位符 `__METHOD_NAME__` 由 `kebabToSnake` 渲染，逐例断言；框架侧只**建议** snake_case、不强制，所以这条守的是本仓生成物的**自洽**） | 扫 `templates/**/*.ts` 的 `@Tool/@Skill/@SubAgent/@Prompt`：按**括号配平**（并跳过字符串字面量 —— 描述文案里一个孤立的 `(` 就再也配不平）跳过装饰器实参，再跳过注释读方法名；`seen >= 5` 防抽词器退化成空断言。反向验证过：`read_file` 改回 `readFile` ⇒ 恰好那条红（15/16 通过） | 同一份生成物里 `doc_reviewer` 与 `readFile` 混着来 ⇒ 使用者在 `dev.config.ts` 的 `multiTurn` 与面板的能力选择器里得先**猜**写法，猜错就是静默不生效（真发生过：本轮模板写成 `readFile`，模板单测全绿，是 `e2e-cli` 的整菜单断言抓出来的） |
| `scripts/e2e-dev.ts` | **`agentia dev` 整条链真跑**（此前**零覆盖**：`rg -ln "agentia dev\|dev-runner" scripts/*.ts` 返回空，`e2e-cli` 只断言了生成物 `package.json` 里有 `dev` 这个 script 名）。前四条都是**行为**断言：① 能力菜单非空且**精确等于** `["hello","read-file"]`（菜单是 runner 经 IPC 报回来的，父进程在 `ready` 前拿的是初值 `[]` ⇒ 非空才等于 IPC 通了）；② 一次 run 成功且 `finalText` 来自假端点；③ 收窄 `toolSources` 后**假端点收到的请求体真的变窄**（收窄前含 `read_file`、之后不含）；④ 改一个 `.md` 触发重启、且重启后能再跑通。另含鉴权边界（无 token ⇒ 403）与 `runner-ready` 广播。**⑤ 中止在飞 run**（第 10 步）：先让假端点**挂住不回复**（否则窗口只有几毫秒，测到的其实是 409 那条分支），再断言「在飞时 `running=true`」「在飞时第二次 `POST /run` ⇒ 409」「`POST /run/abort` ⇒ 202 且 `escalated=false`」「`run-done.stopReason === 'aborted'` 且**带 traceId**」「该 trace 真的出现在 run 列表里」「中止后 `running` 回 false **且 `lastError` 仍是 null**」。**⑥ 清空对话**（第 11 步）：`POST /session/clear` 换 id → 断言 id 已**落盘**且与 `/api/dev` 报的一致 → 再跑一次多轮 → 断言会话写进**新**那本账、**没写进**旧 id，且 `/api/session` 跟着新 id 走。**⑦ 重启次数总账**（第 12 步）：全程只该有 4 次重启（收窄 `toolSources` / 改 `.md` / **改项目根 `.env`** / 回到全量菜单），且每条理由都不得提到 `.agentia` 或 `dist/`。**⑧ 改项目根的 `.env`**（第 9-bis 步）：真改一次 `<工程根>/.env`，必须触发重启且理由里带 `.env` —— 守的是 `WATCH_NAMES` 这条判据的**可达性**（`shouldWatch` 的单测只证明它「认得」，证明不了「够得着」，见下）。**⑨ 实时右栏**（第 7-bis 步）：在飞期间必须真收到增量记账帧、且**先于** `run-done`；折回用的是 **CLI 自己的 `dist/panel-logic.js`**（不在这里重写一遍折回规则），折回的 spans 与 `/api/runs/:id` 的整棵 trace 必须 `isDeepStrictEqual`（要**等链路静默**再比：收尾那份被 await，逐笔那份是 fire-and-forget，最后几笔可能还在路上 —— 轮询到一致为止） | 起真 `agentia dev`（`node <cli> dev`，cwd = 生成工程）+ 本进程内的假 Anthropic 端点（`ANTHROPIC_BASE_URL`）+ SSE 收 `dev` 帧。**凭据只写进工程 `.env`，进程环境里显式 `delete` 掉 `ANTHROPIC_*`** —— 不删的话，本机 export 过 key 的人会拿到一条假绿。全程 `spawn` + await（假端点在本进程里，`spawnSync` 会死锁）；被挂住的响应由 `finally` 收掉（否则 `fake.close()` 的回调永不触发）；第 12 步要**等过「重启延后到 run 结束」的窗口**（`afterRun()` 紧跟在 run-done 之后）再数 | 这一整块（`dev.ts` / `dev-runner.ts` / `inspector-page.html`）重新变成没有守卫的最大块。反向验证过**六条**：`npx tsx` 塞回链路 ⇒ 红（`runner 装配失败："dev runner 退出（code=0）…"`）；把 `loadEnvFile()` 从 `app.ts` 摘掉 ⇒ 红（run 打到真端点、403）；去掉 `runner-ready` 广播 ⇒ 红（`等第 1 条 dev/runner-ready 超时`）；把 runner 的 `run-abort` 处理去掉 ⇒ 红（`escalated:true` —— 顺带证明 5 s 升级重启那条兜底真的在工作）；让 runner 把会话 id 写死 `'dev'` ⇒ 红（`实际 keys：["dev"]`）；把 `!ok` 判据恢复成不排除 `aborted` ⇒ 红（`实际 "run 已被取消"` —— 告警条上会永远挂一条红字）；**摘掉 `watchRootEnvFiles` 的接线**（`.env` 又变回一条够不着的判据）⇒ 红（`等第 4 条 dev/runner-restart 超时（只收到 3 条）` —— 帧转储里那次 `.env` 写入**一条事件都没有**）。⚠️ **第 12 步（重启总账）的反向验证是反例**：把 `WATCH_SKIP` 修复摘掉 ⇒ **e2e 照样绿** —— 不是断言错，而是这条缺陷在 e2e 里**不可达**（监视根是 `<projectRoot>/src`，而 `.agentia/` 在项目根）。所以第 12 步守的是「**监视根保持 `src/`**」，**不守**「`WATCH_SKIP` 判据完整」（后者由 `panel-logic.test.mjs` 的单测守）。两件事都值得守，但**必须说清哪条守哪件**。第 7-bis 步反向验证过：摘掉 runner 的 `onTraceEvent` 接线 ⇒ 红（`run 在飞期间应收到增量记账帧（trace-event），实际 0 条`）。**2026-09-23 复核这一轮再长两步**：**⑩ 工作目录真到工具**（15-ter：假端点发 `read_file` 的 tool_use，A/B 两目录各放内容不同的 `marker.txt`，断言**模型请求体里的 tool_result** 各读各的 —— run 列表上那行目录记账是 CLI 自己写的，证明不了工具看到的根）与 **⑪ lastError 不跨代复用**（15-quater：先造一次带标记的失败 run，再让下一代 runner `process.exit(1)` 一句话不说就死，断言告警条不挂上一代那条。⚠️ 必须用 `process.exit` 而不是「写坏语法」：import 抛错那条路 runner **来得及发 run-error**（无条件写 lastError），新旧实现下归因都对、分不出修复 —— 第一版就踩了这个，反向验证「摘掉修复照样绿」把它抓了出来。反向验证：dist 里把 `errBaseline` 摘掉 ⇒ 恰好这步红（60s 停在带标记的旧错误上）） |
| `packages/cli/test/templates.test.mjs`（`.env` 接线**成对**断言） | `loadEnvFile()` 必须在 `app.ts` **且不在** `main.ts`（dev 环只 import app.ts、从不执行 main.ts）。同一条断言在 `scripts/e2e-cli.ts` 里也成对写（该在哪 + 不该在哪 —— 只写一半就还能被搬到错的一侧） | 锚**精确形态**（`^loadEnvFile\(\);$` 独立调用 + `import {...loadEnvFile...} from`）而不是裸标识符：`main.ts` 的报错文案里就有 `loadEnvFile()` 这个词，裸判会误红。**反向验证过（2026-09-26 §1 审计）**：把 `loadEnvFile()` 从 `app.ts` 搬到 `main.ts`（历史事故形态）⇒ **恰好**「`.env` 三件套：生成 .env / .env.example，且 .gitignore 必须挡住 .env」那 1 条红。⚠️ **必须先 `npm run build:cli`** —— 本用例读的是 `packages/cli/dist/templates.js`（模板内容被烘成字符串），只改 `packages/cli/templates/src/*.ts` 不重建 ⇒ 变异不可见、用例照样绿（**审计时我第一遍就这么被骗了一次**） | 搬错一侧 ⇒ `npm run dev` 静默读不到 `.env`、`npm start` 读得到；用户看到的是「没配 key」，然后去怀疑框架（真发生过：2026-09-22 拆分 app.ts/main.ts 时，而当时那条断言指着 `main.ts`，所以一路绿到真跑探针才发现） |
| `tests/scripts/verify-all-wiring.test.ts` | **工具链的自我描述与 `ci.yml` 互为真值**（谁都不能各说各话）：① `verify-all.sh` 的步骤数 == CI `verify` job 名里写死的那个数字 —— 而那个名字就是分支保护依赖的必需状态检查；② `ci.yml` 的每个 job 都被交代（跑本链的那个 / 脚本的 `ci_only` 清单 / `EXEMPT` 表里**带理由**豁免）；③ `ci_only` 里没有幽灵 id、且每条都是 `<job id>\|<说明>` 形状；④ 收尾消息**不得写死计数**；⑤ **「本链一共几步」在 `CONTRIBUTING.md` / `AGENTS.md` / PR 模板里的每一处抄写**（共 9 处）都要等于真值；⑥ `CONTRIBUTING.md` 的「CI 必须全绿才能合并」括号列表 == 真实必需检查集合，且坑表那行要点名每一个 CI 独有检查；⑦ `AGENTS.md` 的 CI 段落要点名每一个 job、且**圈码数 == job 数**；⑧ **兜底扫描**：任何同时点名 ≥3 个 CI job 的 markdown 必须登记（或带理由豁免） | 窄正则解析两个文件（本仓零运行时依赖、测试侧也没有 YAML 解析器），每条断言都带**防真空**下限（解析出 0 个 job / 0 个步骤时红，而不是空转绿）。**反向验证过 21 条**（M54–M74，各**恰好**点名那条红）：步骤数组加第 9 步 / job 名 `8 步`→`9 步` / `ci.yml` 新增一个 job / 幽灵 id（含**尾逗号**写法）/ 去掉 id 前缀 / `deploy-website` 去掉 `if:`（⇒「豁免理由本身也要成立」那条红）/ 收尾写死「另有 3 个」/ 枚举注释换顺序 / 解析锚点改名 / 删掉 `lint` job / 豁免的 job 被改名；**副本那一组**：PR 模板 `8/8`→`9/8` / `AGENTS.md`「上面 8 步」→7 步 / `CONTRIBUTING` 步骤枚举换顺序 / `CONTRIBUTING` 的 `# 8 步`→9 步 / 必需检查列表删掉一项 / 必需检查列表加幽灵 / 坑表那行删掉 `import-floor` / `AGENTS.md` 段落里 job 改名 / **新建一份点名 5 个 job 的文档** / `AGENTS.md` 的 CI 段落锚点改坏。⚠️ **第一版这里有一条假守卫**：`ci_only` 条目写成 `'…',`（**尾逗号** —— bash 合法、真的会成为一个条目）会被解析器**静默跳过** ⇒ 幽灵条目整条隐形、断言照样绿（M57 第一次跑是 **exit 0**）。已改成「认不出的写法**响亮失败**、不许跳过」。⚠️ **第二处同类（M73 第一次跑也是 exit 0）**：兜底扫描第一版用 `git ls-files` 取文档 ⇒ **新写的文档在 `git add` 之前不在索引里**、扫不到它 ⇒ 本地绿、提交后 CI 才红。已改成 `git ls-files --cached --others --exclude-standard`（已入库 ∪ 未入库但未被 ignore），本地与 CI 同口径。⇒ 两条合起来是同一个教训：**修的是量具，不是断言** | 本地链与 CI 各说各话：步骤数漂了 ⇒ 名字里的数字成假话，而分支保护等的是一个**永不出现的检查** ⇒ **所有 PR 永久卡死**（不是某个测试红，是没人能合并）；新加的必需检查没人登记 ⇒ 本地 8/8 全绿而 CI 挂；`ci_only` 留着已改名的 job ⇒ 收尾提示指向不存在的检查（这正是它诞生那天的病灶：注释说「3 个」而清单只列了 2 个）；而**副本那一组**退化的样子更隐蔽 —— 步数只在一个地方改了、其余 9 处继续说着旧数字（读者会以为是自己跑错了），新加的必需检查没进 `CONTRIBUTING` 的合并契约与坑表（「本地全绿为什么 CI 还挂」的第一处提示失效），`AGENTS.md` 的圈码数对不上（**agent 读的那份说明**先错） |
| `tests/docs/observability.test.ts` + `tests/docs/trace-view-readme.test.ts` | **文档导出表的反向全覆盖**（双向）：`docs/observability.md` 里的 sink 工厂名必须与 `examples/observability/src/index.ts` 的导出**集合相等**；`packages/trace-view/README.md` 的导出表必须与 `packages/trace-view/src/index.js` 的导出**集合相等**（缺一个 / 多一个都红）。⚠️ `trace-view-readme` 第一版是**子串匹配**（`includes(n)`）⇒ 把 `rawArg` 改写成 `rawArgument` 时**照样绿**（M76 exit 0）—— 已改成集合相等 | 从源码抠导出名（`export { … }` / `export { … as … }`），与文档表格第一列做集合求差；两向都查 + 防真空下限（`>= 8` / `>= 5`）。**反向验证过 4 条**：`observability` 文档里工厂名改成超串（`sqliteTraceSinkV2`）⇒ 红（文档多出一个源码没有的）；`trace-view-readme` 把 `rawArg` 改写成 `rawArgument`（旧判据子串绿）⇒ 红、整词删掉 `rawArg` ⇒ 红（源码有的文档缺了）、表里加一个不存在名 `ghostExport` ⇒ 红（文档多出的） | 改了 API 忘了改文档；或者文档里写了一个代码里没有的名字，读者按文档写代码时 `import` 失败 |
| `tests/docs/eval-gate.test.ts` · `scripts/e2e-examples.ts`（第 9 步） | **「评测即发布闸门」的判据不许泄成 `EvalReport.ok` 的转发**：回归（基线通过 → 这次失败）与删用例（基线里有 → 这次没跑）必须判不通过；「基线里本来就失败」必须**放行**（已知债不拦发布）；退出码 `1`（回归）与 `2`（基线坏了）必须是两档 | 单测层 9 条纯函数断言（四类判定 + 一条**反面断言**「`report.ok === false` 但失败在基线里也是失败 ⇒ 闸门必须通过」+ 基线形状五项抛错 + 序列化往返与键排序 + 报告文案）。产物层：`scripts/e2e-examples.ts` 第 9 步真构建 `examples/eval-gate` 再喂**三份被改坏的基线** —— 撒谎（把已知失败记成「曾经通过」）⇒ exit **1** 且点名那条、幽灵键（= 用例被删）⇒ exit **1** 且文案说清为什么、空基线 ⇒ exit **2**。另有文档 ↔ 示例导出面双向覆盖（集合相等）。**反向验证过 3 条**：① `ok: regressions.length === 0 && removed.length === 0` 改成 `ok: list.every((r) => r.ok)`（泄成转发）⇒ **3 条红**（反面断言 + 回归 + 删用例）；② `ok` 去掉 `removed` 条件 ⇒ **恰好**「删用例」那 1 条红；③ 空基线改为静默返回 ⇒ **恰好**「基线形状」那 1 条红 | 判据泄成「用例都过就通过」⇒ 它不再防「删掉失败用例」与「拿旧结论当基线」，而**两条都不报错**（闸门看着在跑、结论永远绿）；`2` 与 `1` 合并 ⇒「基线文件坏了」被读成「我的 agent 退化了」，排查方向当场错 |
| `tests/docs/eval-gate.test.ts`（文档面） | 见上一行的文档部分：`docs/eval-gate.md` 必须覆盖 `examples/eval-gate/src/gate.ts` 的**每一个导出**（双向，防「代码有了文档没写」） | 从 gate.ts 抠 `export function/interface/type/const` + `export type {…}`，与文档做**集合相等**求差；带防真空下限（`>= 8`）。⚠️ 这条不占独立一行：它与上面那条同属「评测即发布闸门」这一个守卫族 —— 计数行数时别把它算成两个守卫（本仓反复踩的「行数 ≠ 守卫条数」） | 读者按文档写代码时引用一个不存在的导出 |

| `tests/docs/website-css.test.ts` + `tests/docs/website-playground-expand.test.ts` + `tests/docs/website-scrollspy.test.ts` | 官网渲染细节**不静默退化**：① API 表签名列必须用 `overflow-wrap: break-word`（不是 `anywhere`——后者会把整个列压成 0 宽）；② playground 展开时必须把 `tool.input` 原样记进游标（不是别的名字）；③ scrollspy 底部判定必须 `>= doc.scrollHeight - 2`（不是 `>` 或更大的偏移） | 各读目标文件做断言。**反向验证过 3 条**：CSS 改回 `overflow-wrap: anywhere` ⇒ 红；游标里 `rawArg` 换成 `fmtArg` ⇒ 红；scrollspy 底部判定改成永不成立（`> doc.scrollHeight + 2`）⇒ 红 | 签名列消失（布局仍在但用户看不到类型）；展开后少一个字段（下游读不到输入）；底部判定失效（导航点永远停在倒数第二节） |
| `tests/docs/website-md-variants.test.ts` + `tests/docs/website-markdown-negotiation.test.ts` | **每页 markdown 变体与内容协商不静默退化**（GEO 档 C/D，2026-09-26 落地）：① 转换器（`packages/website/scripts/build-md-variants.mjs`）的输出要过打分器的 parity 判定 —— 正文一个字不丢、剥壳集合与打分器一致、表格**不做**管道符转义（转义会让「片段是否出现在 markdown 里」整条对不上）、首行指引是**单行 blockquote + 链接形态**；② 内容协商 worker（`packages/website/public/_worker.js`，Pages **advanced mode**）只改写带 `Accept: text/markdown` 的**无扩展名页面路径**，其余原样透传，且**任何异常都退回 `env.ASSETS.fetch(request)`**（advanced mode 下所有请求都过它 ⇒ 兜底被删=整站可被一个转换瑕疵打成 500） | 两个文件都**先读真源码再真跑**（路径用变量动态 `import()`，不看源码文本）：转换器喂结构可控的夹具 HTML（含高亮过的 `<pre>`、含 `|` 的表格单元格、实体转义、**main 之外的正文块**），断言输出形态与幂等；worker 用**假 `env.ASSETS`** 真调 `fetch(request, env)`，断言「改写到了哪个 URL / 方法是不是照旧 HEAD / 失败后有没有回退 / 透传是不是同一个响应对象」。**反向验证过 8 条**（`8/8` 咬人，复原后 sha256 逐字节一致）：去掉 `.llms-hint` 的剥壳 ⇒ **2 条**红（「剥掉外壳」+「首行指引必须单行」—— 指引会以第二处 `/llms.txt` 落进正文）；表格单元格改成 `\|` 转义 ⇒ 1 条红；去掉 worker 的 `try/catch` 兜底 ⇒ 1 条红；把 `PAGE_PATH` 从 `^\/[^.]*$` 放宽成 `^\/.*$` ⇒ 1 条红（`/llms.txt` 那组）。产物守卫那一侧另有 4 条：删掉一份 `.md` ⇒ 3 条红（都是它那一页的）、`.md` 首行改成非链接形态 ⇒ 1 条红、把 `.md` 截断丢掉尾部正文 ⇒ 1 条红（`h2 数量不一致：markdown 13 vs 页面 18`）、产物里 `_worker.js` 去掉兜底 ⇒ 1 条红。⚠️ 判定看的是「红在哪几条」，不是 exit code 一个数 —— `exit ≠ 0` 不等于「真变红」（本仓在 `import-floor` 那次踩过） | 打分器的 Markdown Availability 整格回退（4 项 FAIL）；`.md` 里正文缺段而构建/单测全绿；**最贵的形态是 worker 的兜底消失** —— 它不在构建里执行、单测不跑它就完全看不见，而它坏了整站都 500 |

---

## 2. 待守（已知缺口 —— 下一次 review 从这里开始）

这些是**已经踩过、但还没有机器守卫**的形状。不是「都要立刻建守卫」，而是**改到相关代码时，
必须用手工清单核对**（见 `.github/PULL_REQUEST_TEMPLATE.md` 的自查问）。

| 待守形状 | 历史事故 | 为什么还没有守卫 | 可能的守卫形状 |
|---|---|---|---|
| ~~`SseWriterOptions.maxBufferedBytes` / `HttpHandlerOptions.maxBodyBytes` 的 **`0` 读法未定**~~ | ✅ **2026-09-26 当天判定并建成守卫，移入 §1** —— 判定用的**不是新造的标准**，而是本仓**已经写在同一个选项接口里**的那条：`maxConcurrentRuns` 的注释「0 / 负数则全部 503 —— **都是配置错误**，宁可在构造期响亮失败」。这两处是同一形状，实测：`maxBodyBytes: 0` ⇒ **每个带 body 的请求都 413**（3 条 POST 全 413）；`maxBufferedBytes: 0` ⇒ **流活不过一帧**（判据是写入前的 `pending > limitBytes`：第 1 帧照写、第 2 帧必收口，`closed=true` / `ended=true` / `onBackpressure` 回调 1 次）。两条都判 `invalid` + 构造期抛错，登记进 `limits.ts` 表（含探针 + 文案用例 + 3 条反向验证）。⚠️ 还挡一类事故：`Number('') === 0` —— 空的环境变量会静默变成「拒绝一切」 | — | — |
| ~~`packages/website/src/fragments/api.html` 的**散文口径**（第三列那句话说的事到底成不成立）~~ | ✅ **2026-09-26 当天建成守卫并移入 §1**（与它的「同行另一半」同一轮闭环）—— `tests/docs/api-page.test.ts` 新增「非法单价口径」一条，含 3 条反向验证，见 §1.4 那一行。**但射程很窄**：只在**踩过的那两处**钉、触发词是「非法」、规则是「必须说清不抛给调用方 + 不得归因到构造期」。全页散文仍**没有机器可读的形状** —— 换个说法就静默失效，所以它防的是**回归**、不是「新写错的散文」 | — | — |
| ~~`packages/website/src/fragments/api.html` 的**字段级类型形状**~~ | ✅ **2026-09-26 当天建成守卫并移入 §1** —— `tests/docs/api-page.test.ts` 新增「第二列的类型形状」一条（含 3 条反向验证）。同一轮它一次查出 **7 行漏写字段**（`ModelPricing` / `Span` / `AppOptions` / `RunInvocationOptions` / `ToolRunContext` / `MetricsSinkOptions` / `ModelReport` / `SubAgentSpec`），全部补齐 | — | — |

> ⚠️ **「空」不等于「没有已知缺口」**，它只意味着「**已经踩过、且暂时建不了守卫**」的形状目前为零。
> 最后一次清空：2026-09-23，最后一行「首屏 `0 反射` 这类策略声明」建成守卫并移入 §1
> （`tests/architecture/no-legacy-decorator-metadata.test.ts`）。
> **2026-09-26 重新长出两行**：api.html 的**字段级类型形状**与**散文口径** —— 由起手动作②
> （拿本轮 diff 对 PR 模板自查问）当场发现，**不是**从这张表里挑出来的。
> ⇒ 这恰好印证了下面那句：表空之后，缺口只能靠**主动问**找回来，不会自己冒出来。
> 同一轮里**两半都当天建成守卫并移入 §1**（表里各留一条划线行作记录）：**形状那半**
> 含 3 条反向验证、一次查出 7 行漏写字段；**散文那半**含 3 条反向验证、射程刻意收窄到
> 踩过的那两处。⇒ 两条往返合起来是「§2 → 守卫 → §1」的**标准闭环**。
> ⚠️ 但**闭环不等于覆盖**：散文钉的触发词是「非法」、规则只钉了两处，它防的是**回归**。
> 把「建了守卫」读成「这类形状已经安全」，就是这份文档的下一种退化。
>
> **2026-09-26 晚些时候又长出第三行**（`maxBufferedBytes` / `maxBodyBytes` 的 `0` 读法未定）——
> 这一次**不是**自查问逼出来的，而是**顺着一条刚修好的缺口做同类扫描**扫出来的：
> `costEstimate` 的 `??` 被写成 `||` 而全绿（见 §1.4 `pricing.test.ts` 那条）⇒ 那就把
> `src/` 里所有 `?? <默认>` 的回落点列出来，逐个问「这个旋钮的 `0` / `false` 合法吗、
> 有没有测试传过它」。结果：8 处 `||` 全是正当用法（空文本回落占位符，不是「假值被当未设」），
> 而 `??` 那一族揪出 4 处 —— 3 处当场判定并建成守卫（`Scheduler.every.maxInFlight`、
> `Scheduler.every.intervalMs` 的文案接线、`costEstimate` 的乘数），
> 剩 2 处**读法定不下来** ⇒ 登记到本表。
> ⇒ 可复用的动作：**一条缺口修好之后，问「同一个形状还有几处」** ——
> 单点修复会把「已知类」留在原地，同类扫描一次能清掉大半。
>
> ✅ **当天这一行也判定并闭环了**（表又只剩划线行）。**判定用的不是新造的标准**，而是本仓
> **已经写在同一个选项接口里**的那条：`maxConcurrentRuns` 的「0 / 负数则全部 503 ——
> **都是配置错误**，宁可在构造期响亮失败」。两处是同一形状（`maxBodyBytes: 0` ⇒ 每个带 body
> 的请求都 413；`maxBufferedBytes: 0` ⇒ 流活不过一帧），⇒ 同款判 `invalid` + 构造期抛错。
> ⇒ 补一条可复用的自查问：**遇到「读法定不下来」，先去找同一份接口 / 同一个文件里已经写下的
> 那条判据** —— 与既有判据保持一致比另立一套标准更值钱，而**分歧本身就是发现**。
>
> ⇒ **下一次 review 的起手动作因此变了**：不再是「从上表挑一行建守卫」，而是
> ① 去 §1 **逐行问「它退化时真会红吗」**（`guards.md` 自己就记过两次假守卫：
> 断言是真的、绿的、也是对的，只是它守的是**另一件事**）；
> ② 拿本轮的改动对照 `.github/PULL_REQUEST_TEMPLATE.md` 的自查问，找**新的**形状。
> 表空了就把 review 停掉，是这份文档最容易发生的一种退化。
>
> ✅ **2026-09-26：起手动作① 首次实战，确实抓到了东西** —— 逐行审计 §1 时发现
> `tests/engine/tracer.test.ts` 那条「两条路不得漂移」是**假守卫**：`snapshot()` 的实现就是
> `totalUsage: this.usage()`，那句 `deepEqual` 自己跟自己比、**恒绿**（把 `usage()` 算错 2 倍，
> 红的也是相邻那条字段断言）。已按「钉委托本身 + 把对账搬到调用点」两处修好，
> 见 §1.2 的 `tracer.test.ts` / `budget.test.ts` 两行。
> ⇒ 这条起手动作**不是走过场**：假守卫的特征恰恰是「断言是真的、绿的、也是对的」，
> 不逐行追问「它退化时真会红吗」，它永远发现不了自己。
>
> ✅ **同轮第二处**：`tests/core/sse-text-stats.test.ts` 那条「带常驻监听做对照，防「计数函数
> 恒 0」的假绿」—— **对照光挂不算**，`baseline` 从未被断言非零。实测把 `getEventListeners`
> 打瞎（恒返回 `[]`）后三条断言全过、用例照样绿。已补 `assert.equal(baseline, 1)`，
> 见 §1.2 那一行。**两处的共同形状**：机制被写下了，但**没有一条断言能让「机制本身失效」变红**。
>
> ⚠️ 同轮还抓到一处**归属漂移**（与上面的假守卫不同类）：`sse-text-stats.test.ts` 那行把
> `withTimeout(p, 0)` 的断言也算在自己头上，实际它在 `tests/core/timeout.test.ts`。
> 元守卫（`guards-registry.test.ts`）只查「路径存在」，**查不出「守卫在不在那个文件里」** ——
> 所以「文件存在」不等于「清单指对了」。已订正。
>
> ✅ **同轮第三处**：`tests/architecture/transport-errors.test.ts` 的**回归钉**是假守卫 ——
> 合成样本没复现它声称要守的 bug（URL 与 `throw` 不在同一行 ⇒ 退回旧实现照样绿）。
> 改成真实形态后，退回旧实现才真的红。见 §1.1 那一行。
>
> ⇒ 三条合起来的教训：**假守卫有三种长相**，且都不是「断言写错」——
> ① **自我比较**（`tracer`：拿 `snapshot()` 跟它自己调的方法比）；
> ② **对照没人看**（`sse-text-stats`：挂了对照监听却不断言它非零）；
> ③ **样本不咬**（`transport-errors`：合成样本与真实病灶形态不同）。
> 三种都只能靠「**回退实现 → 确认它真变红**」发现，**读代码读不出来**（三条的代码都写得很对）。
>
> ✅ **2026-09-26 第 4 批（`layering` / `message-compat` / `env` / `subagent`·`skill`）**：
> 这四条**都是真守卫**，各用 1–2 条变异验过（越界依赖边 / 去掉 `Role` 的 `'system'` /
> 删 `@ts-expect-error` / 覆盖判定退回真值判断 / 去掉 `__proto__` 拦截 / 透传漏 `toolTimeoutMs`），
> 全部**恰好**咬点名那条、不误伤。⇒ 说明假守卫**不是普遍现象**：多数守卫是真的，
> 问题集中在「**机制写下了、但没有断言能让机制本身失效变红**」那几处 ——
> 逐行问一遍仍然值得，但它更像是**抽样**而非「处处都坏」。
>
> 📌 **§1 的规模与覆盖度（2026-09-26 审计收口时点）**：§1 共 **55 行**守卫
> （54 行 + 本轮新登记的 `scripts/check-website-agent-readiness.mjs`），
> **55 行全部**有反向验证记录 —— **没有「没法验」的遗留行**。
> ⚠️ **该快照已经过期（同日稍晚）**：§2 清空后又长出过三行（`0` 的读法 ×2 + 散文口径），
> 当天全部闭环；再加上新登记的 `tests/scripts/verify-all-wiring.test.ts`（工具链自我描述的元守卫），
> **当前 §1 = 56 行**（批次 11–13 收口时）。⇒ 又一次印证下面那句自省：**规模数字只能靠数**，
> 连「我刚数过的那个数字」也会在下一小时过期。
> ⚠️ **再次过期（批次 14）**：补上 `tests/docs/observability.test.ts` + `trace-view-readme.test.ts`
> + `website-css.test.ts` + `website-playground-expand.test.ts` + `website-scrollspy.test.ts`
> 共 5 个守卫（合并成 2 行登记）+ `guards-registry.test.ts` 新增第 3 条（货架完整性）⇒ **§1 = 58 行**。
> ⚠️ **「行数」≠「守卫条数」**：本轮又给 `tests/docs/api-page.test.ts` 那一行**加了第 4 条**
> （散文钉），而**行数没变**（`api-page.test.ts` 仍是**同一行**，加的是那行里的第 4 条）—— 所以「规模数字应当由脚本算」还得补一句：
> **数行数只告诉你清单有多长，告诉不了你每行兜住了几条**。别把 55 读成「55 个守卫」。
> 最后一行（CI `import-floor` job）一度被记为「本地没有那套 Node 矩阵，只能靠改 CI 跑」，
> 实际是 **`npx node@18` / `node@20` 本地就能拿到**（18.20.8 / 20.20.2，实测），
> 于是在三个运行时上真跑了一遍并做了 3 条变异（见 §1.4 那一行）。
> ⚠️ **教训**：「没法本地验」这个判断**本身就是没验过的判断** —— 它和「这条守卫是假的」
> 一样，属于**该被反问一次**的话。别把「成本高」写成「做不到」。
> ✅ **同一句话的同类扫描（2026-09-26 收尾）**：上面这条教训当时只写进了**本表**，**没有扫** ——
> 于是「本地无法等价复现」这句话在**代码里还活着两处**：`scripts/verify-all.sh` 的收尾注释
> 与 `.workbuddy-ai/skills/agentia-verify/SKILL.md`。两处都已改，并顺手把那里写死的计数
> （注释说「3 个」而清单只列了 2 个）改成**从清单长度算出来** —— 与同文件上一行
> 「计数**算出来**而不是写死」的纪律对齐。**方向也是反的**：CI 的 `e2e-mcp` job
> **必定走回落夹具**（runner 上没有 uvx，见 `ci.yml` 注释），本机有 uvx 时走的才是**真**
> 第三方 server ⇒ 「本地弱、CI 强」在这里恰好不成立。
> ⚠️ `.workbuddy-ai/` **不被 git 跟踪**，那份 skill 里的同类说法**没有任何守卫**，
> 只能靠这类扫描发现。
> ⇒ 可复用的动作（与「一条缺口修好之后，问『同一个形状还有几处』」同族）：
> **把一条教训写进文档时，顺手 grep 一遍那句话本身** —— 文档写了 ≠ 代码改了。
> ⚠️ **计数订正（两次）**：本审计中途报过「53 行」与「47 有记录 / 6 没有」；收口时用脚本重数 ⇒
> 真实是 **54 行**（4 张子表）；登记完新守卫后变成 **55 行**。**每一次都是「靠数才发现的」** ——
> 包括我写下「54」这一句的下一分钟。这正是下面那条自省要记的事。
> ⚠️ **同日第三次，而且这次是「量具坏了」**：登记完新守卫（`verify-all-wiring.test.ts`）后重数，
> 第一个计数脚本报出 **§1.4 = 28 行**、合计 **63 行** —— 因为它只按 `### ` 分组，`## 附：` 与
> `## 2.` 那几个小节里的表格全被算进了「上一个 `###`」。改成 `## ` 也重置分组后 ⇒ **1.4 = 21**、
> **§1 = 11+18+6+21 = 56 行**（与「加了一行」这个事实相符）。⇒ 教训升级一档：
> **「靠数」还不够，数之前得先把口径钉住** —— 口径不同的两个脚本能在同一天给出 55 / 56 / 63
> 三个都「算出来的」数字。这正是本仓反复讲的「守卫要连**测量工具本身**一起守」。
>
> 📌 **本审计（6 批）净结果**：**假守卫 3 行**（`tracer` / `sse-text-stats` / `transport-errors`，
> 全部已修 + 已登记）、**归属漂移 1 处**（已订正）、**命令指错 1 处**（`dx.types.ts` 头注写的
> typecheck 脚本把它排除在外，已订正）、**未登记的守卫 1 个**（`check-website-agent-readiness.mjs`
> 的「单源逐字节相等」，已补登记）、**真守卫 40+ 行**（各 1–3 条变异验过、不误伤）。
> 另新增/扩充 3 行（`budget` 对账、`openaiStream`、`pricing`/`trimming` 补强）；
> 起手动作② 又做出 **3 条新守卫**：
> - 前两条长在 `api-page.test.ts` **同一行**上 ——「第二列类型形状」（一次查出 7 行漏写）
>   与「非法单价散文口径」（只在踩过的两处钉，含 3 条反向验证）；§2 的两行因此**同一天
>   各自走完 §2 → 守卫 → §1**。
> - 第三条**不在 §2 表里**：`pricing.test.ts` 的「乘数写 `0` 是「乘数为零」不是「未设」」。
>   它是拿**最终** diff 再过一遍自查问时**新找到**的 —— 形状是「`??` 与 `||` 的差别**只**落在
>   `0` 上」，而把 `costEstimate` 里两个 `??` 改成 `||` 时本文件 **19/19 全绿**。
>   ⇒ 这条顺带说明了起手动作② 的正确用法：**它不是只查「文档跟没跟上」，而是拿自查问去问代码** ——
>   尤其是 Q4「边界值走过吗？其中 `0` 有没有被两处代码读成不同语义」。这个形状本仓已经踩过三次
>   （`src/core/limits.ts` / `exactOptionalPropertyTypes` 迁移 / 这里），属**已知类**而非新类 ——
>   但**每一处新的 `0` 都得各自钉**，因为已知类不等于已覆盖。
> ⚠️ **诚实标注**：审计过程中我一度把 §1 的规模报成「12 行 / 18 行」（只数了 §1.2 里翻到的那几行）——
> 真实是 **54 行**。**「清单有多长」也要靠数，不能靠印象**；这也说明为什么这份表的规模数字
> 应当由脚本算（同 `guards-registry.test.ts` 的计数下限思路）。

> 已在本轮补上守卫、从本表移入 §1 的：**成对实现对称**（`tests/integrations/adapter-parity.test.ts`）、
> **浅合并被 `null` 覆盖**（`anthropic.test.ts` 的 usage 用例）、**同步 vs 真实异步 store**
> （`tests/transport/async.test.ts` 的 `AsyncCopyStore`）、**解析器分支矩阵**（`tests/toolkit/env.test.ts`）、
> **`0` 被 `Math.floor` 压成 0 worker**（`tests/engine/concurrency.test.ts`）、
> **`exactOptionalPropertyTypes`**（本轮第七轮迁移，见 §1 与 spec §10 2026-09-18 ⑦）；
> 2026-09-21 双模型复核这一轮又移入 §1 四条：**OTLP enum 整数 + 200 partialSuccess**
> （`tests/integrations/otlp.test.ts`）、**CUMULATIVE 窗口起点随 reset 前移**
> （`tests/integrations/metrics.test.ts`）、**模板重建清 dist**（`scripts/e2e-cli.ts` 4d-bis）、
> **幂等键的进程内认领**（`tests/transport/async.test.ts` 那一行）。
> 2026-09-21 ⑧ 这一轮又移入三条（本表因此只剩一行）：**`0` 的语义真源**
> （`src/core/limits.ts` + `tests/limits.test.ts`，含伴随行「零/负/非有限值的语义统一」）、
> **穷尽转发**（`src/engine/forwarded.ts` + `tests/types/forwarding.types.ts`）、
> **队列消费者配方**（`tests/transport/queueConsumer.test.ts`）。
> 2026-09-22 ②（dev 调试环）又移入三条：**面板纯逻辑可测 + watch 允许清单**
> （`packages/cli/test/panel-logic.test.mjs`）、**dev 环鉴权与 HTTP 面**
> （`packages/cli/test/inspector.test.mjs`）、**生成物能力名一致性**
> （`packages/cli/test/templates.test.mjs` 的能力名用例）。本表**仍只剩一行**。
> 2026-09-22 ③（真跑探针抓出两个缺陷后）再移入两条：**`agentia dev` 整链真跑**
> （`scripts/e2e-dev.ts` —— 上面那三条都拦不住这次的两个缺陷，因为它们是**单元**面：
> 一个问「模板函数返回了什么」、一个拿假钩子测 HTTP，谁都不起真进程、谁都不 import
> 用户的 `app.ts`）与 **`.env` 接线成对断言**（`templates.test.mjs` / `e2e-cli.ts`）。
> 本表**仍只剩一行**。教训记在这里：**「门禁全绿」只覆盖门禁问过的形状** ——
> 本轮改动里最大的一块（dev 环）此前一条守卫都没有，而它一次真跑就露了两个洞。
> 2026-09-22 ④（拿功能文档逐项对照做审计后）**没有新移入 §1 的行**，而是把三条已有守卫
> **扩了面**（同一个文件、同一类断言，只是多了几条口径）：
> `panel-logic.test.mjs` 增 `nextSessionId` / `runDoneNotice`；`inspector.test.mjs` 增
> `POST /run/abort` · `POST /session/clear` · **面板 import 名单的反向全覆盖**；
> `scripts/e2e-dev.ts` 增第 10/11 步（真在飞的中止 + 清空后换账）。
> 这一轮真正的收获不是「又补了测试」，而是**同一条事实的第三个影子**：
> 中止的 run `ok` 是 `false`（引擎的 `abortedResult()` 刻意带结构化 error）——
> 于是面板的反馈语、`dev.ts` 的 `lastError`、终端的日志三处都把它当成了「失败」。
> 判别顺序因此被抽进 `panel-logic.ts` 并配单测（顺序是语义，不是渲染）。
> ⇒ 补一条可复用的自查问：**「一个值有几种写法」查完之后，还要查「它被几个地方各自判过一次」**。
> 2026-09-22 ⑤（追一次瞬时红 → 抓出 `WATCH_SKIP` **半实现**）**没有新移入 §1 的行**，而是把
> `panel-logic.test.mjs` 又扩了一条用例。事故形状：`watchTree` 的目录跳过判据此前只在
> **初始递归**那个调用点执行，watcher 回调里动态 `addDir` 那条路漏了 ⇒「启动时就存在的
> `dist/` 不看、**启动后才出现**的 `dist/` 看」。修法是把判据收进 `addDir` 内部（唯一一处），
> root 由调用方显式豁免（项目根本身叫 `dist` / `.foo` 是合法的，判据只看**目录名**）。
> **更值钱的是验证侧的教训**：我先给 e2e 加了一条「重启次数总账 + 理由里不许出现 `.agentia`」
> 的断言，反向验证时**单测红了、e2e 照样绿**。逐条排除三种解释（修复没生效 / 断言错 /
> **缺陷在这里不可达**）后落到第三种：`devServer` 的**监视根是 `<projectRoot>/src`**，
> 而 `.agentia/` 与 `dist/` 在**项目根**，从来不在范围内 ⇒ 那条 e2e 断言真正守的是
> 「**监视根保持 `src/`**」，它**碰不到** `WATCH_SKIP` 那条路。
> ⇒ **两件事都要守，但必须说清哪条守哪件** —— 否则下一个人看到「有 e2e 钉着」就以为
> 漏判被覆盖了。这正是本仓一直在猎的**假守卫**：断言是真的、绿的、也是对的，
> 只是它守的是**另一件事**。改法是把 dev.ts 的 `WATCH_SKIP` 注释改写成「**第二层**」、
> 把「第一层是监视根」写进注释，e2e 那段注释也照实写明它**抓不到**什么。
> ⇒ 补一条可复用的自查问：写完一条守卫，问「**它在什么形状下才可能红**」；
> 若答案里含一个当前架构下不可达的前提，它就不是这条修复的守卫 —— 要么换个能红的形状，
> 要么**改名**（说清它守的那件事）并注明它不守什么。
> 2026-09-22 ⑥（拿 ⑤ 那条「监视根是 `src/`」去核**每一条**判据 → 又照出一条）**没有新移入 §1
> 的行**，而是把 `panel-logic.test.mjs` 与 `e2e-dev.ts` 各再扩一条。
> 事故形状：`WATCH_NAMES = {'.env', '.env.local'}` 把这两份列进**允许清单**、`usage-guide`
> 也把 `.env` 写进「看什么」，但 `watchTree` 的根是 `<projectRoot>/src`，而 `.env` 在
> **项目根** ⇒ 这条判据**没有任何一个 watch 够得着**（改 `.env` 静默无感，与 G3b 同类；
> `dev.ts` 顶部那张结构图当时写的还是 `fs.watch(src/**, **.md)` —— 连图里都没有 `.env` 的位置）。
> 修法：单开 `watchRootEnvFiles(projectRoot, …)` —— **不递归**且**只认名字**；**不能**把
> `watchTree` 的根抬到项目根（那会让「改任何文档也重启」）。两处 watch 共用抽出来的
> `makeNotifier()` 去抖器。
> ⇒ 可复用的自查问：⑤ 查的是「判据有没有在**每条路**上执行」，⑥ 查的是「判据有没有
> **任何人**执行」—— **判据的正确性**（`shouldWatch` 有单测、写得也对）与**可达性**
> （调用点的根）是两件事，各要各的守卫：前者单测，后者**只能真跑**。
> ⚠️ 附带一条**探针自身**的教训：第一版探针用 `waitDev('runner-restart', …, 2)`（写死等第 3 帧），
> 而它前面已经有一条 `runner-restart`（回到全量菜单）⇒ **立刻拿到旧帧**，报错文案与
> 「`.env` 根本没触发」一模一样，差点据此下错结论。改成「先数当前帧数 N，再等第 N+1 帧」才分辨得开。
> ⇒ 断言「某事件发生了」时，**别用与事件总数耦合的绝对序号**：先取基线、再等增量。
> 2026-09-23（「0 反射」这一行）移入 §1 一条，**本表因此清空**。这一轮值得记的不是「补了守卫」，
> 而是**守卫自己第一版有三处错，全是防真空 / 阳性对照抓出来的**：
> ① 块注释里写了 `examples/` 加 `*` 的 glob 字面量 ⇒ `*` 紧跟 `/` **提前闭合注释**，
> 剩下片段变成代码（`ReferenceError: dist is not defined`）；
> ② 走查只收 `.ts`，而 `packages/trace-view/src` **是纯 `.js`** ⇒ 整个包被扫成 0 个文件
> （「0 处违规」的另一种成因）—— 被 `files.length > 0` 那条防真空断言当场抓住；
> ③ 把 `design:paramtypes` 这类键放进清单，而它们**永远是字符串字面量**、遮蔽器按设计遮蔽字符串
> ⇒ 三条永远匹配不上的**死条目**（看着像保护、实则空转）—— 被阳性对照当场抓住。
> ⇒ 可复用的自查问：**写完「0 处违规」这类断言，先造一个违规证明它会红**；若造不出来，
> 你写的不是守卫，是一段永远为真的文字。以及：**给走查加射程时，先打印它扫到了几个文件**。

> §2 的存在方式很重要：**它是活的**。每轮 review 挖到的形状，若暂时建不了守卫，就登记到这里；
> 建成了就移到 §1 并注明守卫位置。「未登记的形状」= 下次必然重犯。

---

## 附：`exactOptionalPropertyTypes` 迁移（2026-09-18 第七轮，已完成）

**它守什么**：`{foo: x}`（`x: T | undefined`）**不是**合法的 `foo?: T` —— 「不传这个键」与
「传了个 undefined」被区分开。`retry.ts` 的「显式 undefined 覆盖缺省」事故（重试被静默关闭、
退避算出 NaN）正是这条区分缺失造成的。开启后这类写法在**类型上就写不出来**。

**迁移规模（实测）**：39 处 `error TS`（TS2379 ×19 / TS2375 ×10 / TS2412 ×8 / TS2322 ×2），
分布 `transport/` 15、`engine/` 12、`runtime/` 5、`toolkit/` 4、`eval/` 1。

**采用的规则**（后来者照此办理，别反过来）：

| 类型角色 | 修法 | 例 |
|---|---|---|
| **结果/状态记录**（框架总是把字段写进对象字面量） | 必填 `T \| undefined` —— 字段在场、值可无 | `AgentRunResult` / `AgentLoopResult` / `RunMeta` / `RunHttpResponse` / `TurnOutcome` / `ToolEventIO` / `SpanDiff` |
| **内部管道**（缺省与显式 undefined 语义等价） | 可选 `?: T \| undefined`（缺省或显式都给） | `AgentLoopArgs` / `LoopContext` / `Job` / `Record` 类（`TaskRecord` / `RunSpec`）/ `BudgetGuardOptions` / `SseWriterOptions` / `CapabilityCall` |
| **公共入参**（`foo?: T` 的「不提供 = 用缺省」必须有意义） | **保持 `?: T` 不动**，在**调用点**处理：条件展开 `...(x !== undefined ? { x } : {})`，或集中 `omitUndefined({...})` | `RunAgentOptions` / `RunInvocationOptions` / `ExecuteRunOptions` / `RetryOptions` / 各 client options |

**`omitUndefined`**（`src/core/object.ts`）用于「一次转交十几个可能 undefined 的字段」的场景
（如 `AgentApp.run` → `executeRun`）：把 undefined 键摘掉，类型上就能安全赋给 `?: T`，
比十几处条件展开可读。**只过滤 undefined**（`null`/`0`/`''` 保留）。

**门禁**：`tests/architecture/tsconfig-strictness.test.ts` 钉住开关本身（关掉 = 39 条防线无声消失）。
反向验证：关掉开关 ⇒ 该测试红；且 `{maxAttempts: undefined}` 赋给 `RetryOptions` 立刻从
「编译错」变回「放行」（实测 ON=1 错 / OFF=0 错）。


---

## 附 B：两次复审的沉淀（2026-09-20 / 09-21）

原始复核散件已随本附录落盘即删除；此处只留**可复用的结论**，不留过程。

### B.1 「产物存在 ≠ 产物能跑」—— discover 必崩的五层失效分析（09-21，已闭环）

模板曾生成 `discover: ['src/tools', …]`（cwd 相对）：开发态被「cwd 恰好对 + tsx 恰好能吃
`.ts`」两个恰好掩住，生产态 `node dist/main.js` 去 import `.ts` 源码 ⇒ 装饰器不是可擦除
语法，必崩。**≤0.7.2 生成的所有工程带病。** 当时五层门禁逐层失效：

| 门禁 | 为什么抓不到 |
|---|---|
| CLI 单测 | 模板是字符串，不过编译器，对静态检查不可见 |
| e2e tsc 检查生成物 | `'src/tools'` 是合法 string —— 路径是数据，类型检查管不到运行时解析 |
| e2e 真构建 | 只断言「产物存在」，从未执行产物 |
| e2e 装配 + mock run | 测 discover 用的路径是测试脚本自己算的，模板那句有病的表达式根本没被执行 |
| examples e2e | 示例手写、不走脚手架模板 |

**根因一句话：被测形态 ≠ 发布形态，被测输入 ≠ 产物自己的代码。** 闭环（均为 #104/#105）：
e2e-cli 真跑 `dist/main.js` + AGENTS.md「承诺过的 script 必须真跑，且测产物要用产物自己的
输入」硬约定 + 模板从字符串升级为真文件（纳入 typecheck/lint 面）+ 「npm pack → 离线安装 →
装出来的包真跑最小 run」。

### B.2 覆盖率在本仓库的定位：棘轮，不是目标

- 棘轮门禁：`scripts/test-all.mjs`（c8：行 95 / 分支 88 / 函数 95，实测水位
  行 ~98.8 / 分支 ~91.7 / 函数 ~98.3 —— 阈值是防退化的下界，留 ~3pt 防抖余量，
  **别追 100%**；分支/函数曾从 85/92 抬到 88/95：余量 6pt+ 时删掉一整个模块的测试都不触发）。
- **为什么不追**：近几周所有真 bug（HITL×session 毒化、审批竞态、Windows spawn、discover
  必崩）都发生在 100% 覆盖的行上或 e2e/交互层面 —— 覆盖率量「执行过没有」，这个仓库的病
  是「执行了但不对」。追数字只会逼出「执行不断言」的凑数测试 = 真空变绿。
- **它的真实价值**：① 棘轮防退化；② 一次性死角审计 —— 09-21 那次审计靠它挖出两条
  「修复了但承重路径没测到」的真缺口（skill `onAbandoned` 超时收尾 / anthropic 超时链，已补）。
- **工具结论**：node 内建 reporter 的**逐行归属**在 tsx 下漂移（把 interface 声明标成
  未覆盖）不可信，分支 % 与 c8 互证一致（±2pt）可用；审计一律用 c8。工程坑：
  `NODE_OPTIONS='--import tsx'` 会泄漏进测试 spawn 的子进程 —— 覆盖率 flag 只能加在
  `test-all.mjs` 自己的 node 调用上，不可用环境变量注入。
- **刻意不设防清单（审计别再上报、别补测）**：`mcp.ts` 观测记账的 catch 吞错（设计如此）、
  `mcp-stdio.ts` 的 EPIPE 吞掉（次生现象）与 SIGKILL 的 catch（进程已死竞态）、以及所有
  「辅助动作不击穿主路径」的 catch 族。

### B.3 「纯结构拆分」复核清单（09-20，11 件拆分全忠实的核查法）

「搬运」类改动测试抓不住，必须看代码。六条高危点，按踩坑概率排序：

1. **被搬走的状态有没有别的读者** —— grep 旧文件全文，确认没有第二个读写点（拆分最容易
   出事的一类）。
2. **指标名 / 字符串字面量机械对拍**（多重集比对，不靠人眼）—— 静默丢一个指标 = 观测
   能力无声消失，测试几乎不可能发现。
3. **模块级可变状态有没有被复制成两份** —— 拆分特有的静默翻倍风险；闭包状态应收进一个
   实例、常量定义一次各处 import。
4. **循环 import 的 TDZ 风险** —— 被 import 的绑定只在函数体内引用则安全，顶层有读-写
   依赖则炸。
5. **参数化外移的值各调用点有没有传错** —— 方法变自由函数后，逐个调用点核对实参。
6. **旧侧用真实父提交（`git show <sha>^`），不用固定基线** —— 夹在中途的提交会造成假差异。

---

## 3. 守卫的写法（本仓库已验证有效的四条纪律）

1. **宁可窄，不要误报。** 守卫应当断言「**允许集合**」而非「禁止某个写法」（`layering.test.ts`
   的 `ALLOWED` 就是这个形状）。误报的门禁最终会被人加 ignore 关掉，等于没有。
2. **必须能反向证伪 —— 而且是逐条。** 守卫写完要**回退实现、确认它变红**再恢复（见 PR 模板自查第 5 条）。
   没做过反向验证的守卫，很可能是永远绿的空断言 —— 本仓库已有「真空变绿」的教训，
   `layering.test.ts` 的「解析计数下限」就是为它加的。
   ⚠️ **一个用例文件里 N 条承重断言要 N 次反向验证**（摘一处实现只证明一处会咬）：
   用一次性脚本跑**变异电池**（逐条改回坏版本 → 跑测试 → 还原并逐字复核源码），验收标准是
   **0 漏网**。`mcpConnector.test.ts` 的 9 条变异就是这么过的；只做「随便摘一处看它红」
   照样会漏掉一条永远绿的断言。
   ⚠️⚠️ **变异没红时，先怀疑「我验的是不是那个东西」，再怀疑「守卫是不是假的」。**
   2026-09-26 审计一轮里撞到**两次**同一个坑 —— 守卫读的是**派生物**，改了源头不重建 ⇒
   变异不可见 ⇒ 看起来像「守卫不咬」：
   - `tests/types/*.types.ts` 编译的是 **`dist/`** ⇒ 必须 `npm run build` 再 `typecheck:types`；
   - `packages/cli/test/templates.test.mjs` 读的是 **`packages/cli/dist/templates.js`**（模板内容被
     烘成字符串）⇒ 必须 `npm run build:cli` 再跑。
   ⇒ **反向验证的第一步是先确认「被测物是源码还是派生物」，第二步才是变异。**
   （另有同族的一坑：**跑错脚本**。`dx.types.ts` 头注一度写着 `typecheck:tests`，而
   `tsconfig.tests.json` 明确 `exclude: ["tests/types"]` —— 照它跑，整份文件零检查、零报错。）
3. **失败信息必须能定位。** `assert` 消息里带**文件:行号**与修法（`layering.test.ts` /
   `transport-errors.test.ts` 都是这个形状），否则 CI 只留一个 exit 1。
4. **合成样本必须复现真实病灶的形态**（2026-09-26 §1 审计补）。用合成样本做阳性对照 / 回归钉时，
   样本要**照抄真实病灶的形状**，不是「差不多的形状」。
   反例：`transport-errors.test.ts` 的注释剥离回归钉把 URL 放在**单独一行**，而真实病灶
   （`src/integrations/metrics.ts`）是 `//` 与 `throw` **同一行** —— 样本退化成无害形态，
   退回旧实现照样绿，于是这条回归钉**守不住它声称要守的 bug**。
   判据同第 2 条：**回退实现必须变红**；红了，样本才算成立。
   ⇒ 第 2 条的「逐条反向验证」是总纲，本条的补充是：**反向验证能过 ≠ 样本有代表性** ——
   如果变异的是「测试自己的样本」而不是实现，最容易骗过自己。
