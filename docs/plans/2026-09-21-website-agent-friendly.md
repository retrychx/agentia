# 官网 agent 可读性（GEO）加固

> **状态：四档全部落地。** 档 A（外围件）+ 档 B（llms 指引）实现于 2026-09-21；
> **档 C（每页 `.md` 变体）+ 档 D（`Accept: text/markdown` 内容协商）实现于 2026-09-26**
> —— 做法、取舍与实测见 §6（原先那节写的是「有意未做」的理由，现改为落地记录并保留原判断）。
>
> **第二轮（同日，修正自己的错）**：第一轮把 URL 口径定成 `.html` 并让守卫锁了绿灯，
> 线上回读发现 `.html` 恰是 Cloudflare Pages 会 **308** 的形态（§3.2）。已把 `og:url`、
> sitemap、llms.txt、Nav/Footer/正文互链、404 页、README 全部改到**干净路径**，
> 并补两条守卫断言（§5 的 ⑦⑧）。**教训：产物文件名 ≠ 站点 URL 形态。**
>
> 关联：`packages/website`（`404.astro` · `robots.txt.ts` · `sitemap.xml.ts` · `llms.txt.ts` ·
> `layouts/Base.astro` · `components/Nav.astro` · `pages/*.astro` 的 footerLinks · `fragments/*.html` 的互链）
> · `scripts/check-website-agent-readiness.mjs`（折在 `verify-all.sh` 第 8 步）
> · `.github/workflows/ci.yml` 的 `deploy-website`（新增「只报告」的打分步骤）
> · `README.md` / `README.en.md`（官网外链）· `AGENTS.md` 的 packages/website 段
>
> 来源：2026-09-21 —— SoonIter《怎样构建一个 Agent-friendly 的网站》（Rspress 实践）+
> AFDocs（`agentdocsspec.com` 的配套打分器）对线上站的实测。

## 1. 目标

官网的读者**不止人**：Claude Code / Cursor / Codex 已经会直接读 `/docs.html`、`/api.html` 再写
agentia 代码。目标是把「agent 能不能发现、能不能低成本读懂这个站」变成**可验证**的面 ——
不是感觉，是有打分器、有产物守卫、有 CI 观察的面。

一句话口径：**让已有内容被 agent 找到并低成本读取**；本轮**不新增**面向 agent 的内容（那属于档 C）。

## 2. 现状证据（改动前，线上实测）

```
npx --yes afdocs@0.20.0 check https://agentia-web.pages.dev --format scorecard
→ 23 项：11 pass · 3 warn · 5 fail · 4 skip
```

| 检查 | 结果 | 根因（逐条查过，非推测） |
|---|---|---|
| `llms-txt-exists` / `-valid` / `-size` | PASS | `/llms.txt` 已存在且合规（26 KB / 15.6 K 字符）——这条链**起点本来是好的** |
| `http-status-codes` | **FAIL** | 4/4 页对不存在的 URL 回 **200**（soft 404）：产物里没有 `404.html`，Cloudflare Pages 于是把**任意**未匹配路径回退成根 `index.html` 且 200。实测 `/robots.txt`、`/sitemap.xml`、`/usage-guide.md` 拿到的都是同一份 17146 B 的首页 HTML |
| `llms-txt-directive-html` | **FAIL** | 4 页 HTML 里都没有指向 `/llms.txt` 的指引 —— agent 从深层页进来时不知道它存在 |
| `llms-txt-directive-md` | **FAIL** | 依赖「有 markdown 版本」，见档 C（未做） |
| `markdown-url-support` | **FAIL** | 0/4，页面没有 `.md` 变体（档 C） |
| `content-negotiation` | **FAIL** | 0/4，服务端完全忽略 `Accept: text/markdown`（档 D） |
| `llms-txt-links-resolve` | WARN | `llms.txt` 的站内链接是**根相对**地址。读源码定性：`checks/content-discoverability/llms-txt-links-resolve.js` 只统计 `http://` / `https://` 开头的链接 ⇒ 5 条站内链接被**整条丢弃**、同源 0 条 |
| `llms-txt-coverage` | SKIP | 「No sitemap found; cannot assess」—— 站上没有 sitemap |
| `content-start-position` | WARN | 仅 `/playground` 23%（其余 1–9%），无害 |
| `auth-gate-detection` | WARN | **误报**：`/playground` 的 API Key 输入框被认成登录框（`soft-auth-gate`） |

### 2.2 关键纠错：相对链接只影响「校验」，不影响「发现」

设计阶段一度以为「llms.txt 用相对链接 ⇒ 工具发现不了本站页面 ⇒ 多个分项变 N/A」。**读了源码后否掉**：

```js
// helpers/get-page-urls.js —— 页面发现阶段，根相对链接**是**会被解析的
else if (link.url.startsWith('/')) {
  const base = new URL(file.url);
  record(new URL(link.url, base.origin).toString());
}
```

⇒ 绝对化的收益**只**在 `llms-txt-links-resolve` 这一项（以及 agent 拿到一份可直接跟随的清单），
**不包括**「解锁页面发现」。原始表述把两者混为一谈，已在此更正（也是 §5 守卫用「跑产物」而非
「读源码」来定的原因之一）。

### 2.3 落地后实测（2026-09-21，同一把打分器）

```
改造前  pass 11 · warn 3 · fail 5 · skip 4
改造后  pass 15 · warn 1 · fail 4 · skip 3
```

逐项变化：

| 项 | 前 → 后 | 靠什么 |
|---|---|---|
| `http-status-codes` | FAIL → **PASS** | `404.astro`（`/usage-guide.md` 从「200 + 首页 HTML」变成真 404） |
| `llms-txt-directive-html` | FAIL → **PASS** | `Base.astro` 的 llms 指引块 |
| `llms-txt-coverage` | SKIP → **PASS** | `sitemap.xml`（此前「No sitemap found; cannot assess」） |
| `content-start-position` · `auth-gate-detection` | WARN → **PASS** | 页面前部少了一堆噪声；后者本就是误报，页脚/导航变化后不再触发 |
| `llms-txt-links-resolve` | WARN（同源 0/0）→ WARN（同源 **5/5 解析成功**） | 链接绝对化。残留的 WARN 是**站外** `github.com` 抓取失败 —— 纯环境噪声 |
| `llms-txt-links-markdown` | SKIP → **FAIL** | ⚠️ 见下 |

**⚠️ 必须说清的一处：FAIL 从 5 降到 4，但其中一个是「新暴露」的。** `llms-txt-links-markdown`
此前是 SKIP（原因：「All 1 links are external」—— 链接绝对化之前，工具只认得出那条 GitHub 外部链接，
于是无从判定）。链接绝对化后它开始评估，判定「同源链接指向 HTML 且没有 markdown 替代」⇒ FAIL。
所以净变化是 **−2 修复 +1 暴露**，不是「−1」。这个 FAIL 属档 C（每页 `.md` 未做），
**不是新引入的缺陷，是原本看不见的缺陷**。

### 2.4 第三轮实测（2026-09-26，档 C / 档 D 落地）

⚠️ **读数必须带出处** —— 同一份产地在不同环境会给出不同分数（打分器自己也这么说）：

```
线上（C/D 之前）          https://agentia-web.pages.dev      pass 16 · warn 1 · fail 4 · skip 2
本地 wrangler pages dev   把 _worker.js 从产物里拿掉（对照）    pass 20 · warn 2 · fail 1
本地 wrangler pages dev   装 _worker.js（档 C + 档 D）        pass 22 · warn 1 · fail 0
线上（#142 合并后）        https://agentia-web.pages.dev      pass 22 · warn 1 · fail 0 · skip 0
```

⚠️ **线上那两行是同一把打分器量同一个站，但总分数字都是 `59 / 100 (F)`** —— 因为总分别被
`(Capped: single-page-sample)` 封顶了（见 §6.4）。动的是**逐项**：FAIL **4 → 0**、SKIP **2 → 0**、
Content Discoverability **84 → 100**、Markdown Availability 从「依赖未满足 ⇒ 整格 N/A」变成 4/4 全 PASS
（`markdown-url-support` / `content-negotiation`）。看这个分数排行的读者请注意：**别拿总分当进展读数**，
它被样本量锁住了。

**独立回读**（不看部署 job 的 success 行，逐条 curl 回来）：

```
curl -H 'Accept: text/markdown' /docs        → 200 text/markdown  34572 B（与 /docs.md 逐字节相同）
curl -H 'Accept: text/markdown' /            → 200 text/markdown   4089 B
curl（不带该头）/docs                        → 200 text/html      64270 B（浏览器拿到的一字未变）
curl -H 'Accept: text/markdown' /llms.txt    → 200 text/plain      28258 B（有扩展名 ⇒ 永不改写）
/nope（带该头）                              → 404 text/html（**没**被协商成 200）
/docs.html                                   → 308 → /docs（advanced mode 下路由原样保留）
```

中间那条是**档 D 的 kill 判据**：装 `_worker.js` 前后 `http-status-codes` / `redirect-behavior` /
`cache-header-hygiene` **一条都没回退** —— advanced mode 下 worker 接管**所有**请求，最怕的就是
整站路由（干净路径 / `.html` 的 308 / 硬 404 / 缓存头）被它带歪。三条都不动才算通过。

逐项（本地，档 C → 档 C+D）：

| 项 | 前 → 后 | 靠什么 |
|---|---|---|
| `markdown-url-support` | FAIL → **PASS**（4/4） | 每页 `<page>.md`（首页落 `index.md` —— 打分器给根路径的候选是 `/.md` 与 `/index.md`） |
| `llms-txt-directive-md` | FAIL → **PASS** | `.md` 首行的 llms 指引（单行 + **链接**形态） |
| `markdown-content-parity` | SKIP → **PASS**（avg **0%** missing） | 转换器「正文一个字不丢」+ 表格不做管道符转义 |
| `page-size-markdown` | SKIP → **PASS**（median 24K） | 同上（HTML 那侧 64% 是外壳样板） |
| `llms-txt-links-markdown` | FAIL → WARN → **PASS** | 先靠 `.md` 变体升到 WARN，再由 D 升到 PASS（HEAD + `Accept: text/markdown` 现在返回 `text/markdown`） |
| `content-negotiation` | FAIL → **PASS** | `_worker.js` 的 `Accept: text/markdown` 改写 |

残留 1 条 WARN 是 `auth-gate-detection`（**已知误报**：`/playground` 的 API-key 输入框被认成登录框，
§2 已记）。**另外一处不是缺陷、但要说清**：线上总分会显示 `(Capped: single-page-sample)` —— 站上
只有 4 个页面，而打分器要求 ≥5 个才给页面级类别计分、才不算「单页样本」。那是**测量口径**，
不是站点缺陷；要解开它得给站点加第五个**真页面**（内容决策，不在本方案射程内）。

## 3. 决策

按**依赖关系**排，而不是按文件大小：

| 档 | 内容 | 依赖 | 本轮 |
|---|---|---|---|
| **A** | `404.html` · `robots.txt` · `sitemap.xml` · `llms.txt` 链接绝对化 | 无 | ✅ 做 |
| **B** | 每页 `<body>` 最前的 llms 指引块 | 无（但它是档 C/D 被发现的**前提**） | ✅ 做 |
| C | 每页 `.md` 产物 | 需先解决「没有 markdown 单源」 | ✅ 做（2026-09-26，见 §6） |
| D | `Accept: text/markdown` 内容协商（Pages Function / `_worker.js`） | **依赖 C**（没有 `.md` 可指向） | ✅ 做（2026-09-26，见 §6） |

**为什么切在这里**：A + B 全是**外围件**，一碰页面正文都不碰、不引入任何运行期，
却关掉「现在就在骗 agent」的那条（soft 404）+ 让已有 `/llms-full.txt`（117 KB 全文，
单源 `docs/usage-guide.md`）**第一次可被 agent 发现**。

### 3.2 URL 口径：**干净路径**（`.html` 是错的 —— 上一轮判反过，此处留证）

> ⚠️ 这一节的第一版写的是「统一到 `.html`」，**已被线上实测推翻**。原文保留在下面「为什么判反」里。

**结论：站内一律用干净路径**（`/docs`，不是 `/docs.html`）。理由是实测的，不是偏好：

```
curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}' https://agentia-web.pages.dev/docs.html
308 -> https://agentia-web.pages.dev/docs
```

Cloudflare Pages 对**产物里存在的** `x.html` 一律 **308** 跳到 `/x`。实测全表（2026-09-21）：

| 请求 | 结果 |
|---|---|
| `/index.html` · `/docs.html` · `/api.html` · `/playground.html` · `/404.html` | **308** → `/` · `/docs` · `/api` · `/playground` · `/404` |
| `/` · `/docs` · `/api` · `/playground` | 200（最终地址） |
| `/robots.txt` · `/sitemap.xml` · `/llms.txt` | 200（本就不是 HTML 页） |

⇒ `.html` 是**会重定向**的形态，所以：

- `sitemap.xml` 必须声明**最终 URL**（sitemap 里放跳转前地址是错的）；
- `llms.txt` 给 agent 的清单同理，不该让它先跳一次；
- `og:url` 指到 `.html` 等于声明一个「跳转前的地址」（`Base.astro` 已改为去掉扩展名）；
- 站内每一处点击都多一跳 —— Nav / Footer / 正文互链 / 404 页已全部改为绝对干净路径。

**为什么判反**（原文）：当时认为「站点自声明口径是 `.html`（og:url、站内互链、README 全用它），
所以声明也该用 `.html`」。错在把**产物文件名**当成了**站点 URL 的真值** —— 文件名是构建产物，
URL 形态由平台的重写规则决定。当时那句「afdocs 会归一化两种写法所以不介意」
（`normalizeUrlPath` 确实会剥 `.html`）还起了误导作用：它只说明**打分器不介意**，
不代表**索引器和人**看到的不是两份声明。

**为什么守卫没拦住**：第一版守卫拿 `readdirSync(dist)` 的**文件名**去比对声明，
于是把「`.html` 口径」锁成了绿灯。现已补两条断言（见 §5 的第 ⑦⑧ 条），
它们正是为这次错误写的 —— 反向验证时也确实咬住了「页面里塞回 `/playground.html`」这一条。

> 另外一条与直觉相反的发现：**AFDocs 的链接校验只认绝对地址，但页面发现阶段会解析相对链接**
> （见 §2.2）。所以「相对 ⇒ 发现不了」是错的，「`.html` ⇒ 只是先跳一次」也是错的 ——
> 两条都靠读源码/实测定性，没有靠推测。

## 4. 落点

| 文件 | 做什么 |
|---|---|
| `packages/website/src/pages/404.astro` | **这个文件的存在本身就是修复**：有了它，Pages 才对未匹配路径回真 404（soft 404 的开关就是「产物里有没有 404.html」） |
| `packages/website/src/pages/robots.txt.ts` | `User-agent: *` + **绝对** `Sitemap:` 行（robots 规范要求绝对，相对值会被忽略） |
| `packages/website/src/pages/sitemap.xml.ts` | 4 个页面的 `<loc>`；**不写 `<lastmod>`**（会让每次构建产出不同字节，而守卫按字节核产物） |
| `packages/website/src/pages/llms.txt.ts` | 「文档」节的链接改成由 `Astro.site` 拼的**绝对 + 干净路径** |
| `packages/website/src/layouts/Base.astro` | `<body>` 最前的 `<div class="llms-hint">`：`clip` / `clip-path:inset(50%)` 视觉隐藏、URL 写纯文本不套 `<a>`、必须在 `<nav>` 之前（三条约束各有实际后果，见文件内注释）；另：`og:url` 去 `.html`、favicon 改绝对路径 |
| `packages/website/src/components/Nav.astro` · `components/Footer` 的 links · `pages/{index,docs,api,playground}.astro` 的 footerLinks · `fragments/{index,api,docs}.html` 的正文互链 · `pages/404.astro` | 站内链接一律改为**绝对干净路径**（`/docs`）。两个理由：`.html` 多一跳 308；相对路径在「以任意路径送出的 404 页」上会解析错 |
| `README.md` · `README.en.md` | 三处官网外链从 `/docs.html`、`/playground.html` 改为干净路径（改前查过 `scripts/release-surface.mjs` **不数**网站 URL，改它不会动发版面的计数） |
| `scripts/check-website-agent-readiness.mjs` | 按**产物形状**核 8 类不变量（见 §5），折进 `verify-all.sh` 第 8 步 —— **不加第 9 步**（步骤数写在 CI 必需检查名里） |
| `.github/workflows/ci.yml` | `deploy-website` 尾部加「Agent 可读性打分（只报告，不阻断）」：先轮询等新部署真上线（信号 = `robots.txt` 出现 `Sitemap:` 行），再 `afdocs@0.20.0` 打分 |

## 5. 守卫为什么是「跑产物」而不是「读源码」

`scripts/check-website-agent-readiness.mjs` 的 8 类断言：

1. `404.html` 存在（硬 404 的前提）
2. `robots.txt` 有绝对 `Sitemap:` 行
3. `sitemap.xml` 的 `<loc>` 集合 **==** dist 里实际的 `*.html` 集合（排除 404）**映射到干净路径后**
4. `llms.txt` 的站内链接**全部绝对**，且覆盖了全部产物页面
5. `llms-full.txt` 与单源 `docs/usage-guide.md` **逐字节相等**
6. 每页的 llms 指引：存在 · 有 `clip-path` · 无 `display:none` · 无 `<a>` 包裹 · URL 纯文本 · 在 `<nav>` 之前
7. **声明的 URL 不得是 `.html`**（线上会 308）—— 为 §3.2 那次判反补的
8. **站内链接必须绝对路径、且不是 `.html` 形态** —— 同上

两条纪律：

- **期望集合从产物自己枚举**（`readdirSync(dist)` 里的 `*.html`），脚本里**刻意不另抄一份页面清单**
  —— 那样「加了页面忘了改 sitemap」时，守卫会跟着一起漏。
- **不复刻 AFDocs 的算法**（位置百分比等由线上打分器给），只核不会被它替代表达的产物不变量。

**反向验证（实测，非推断）**：逐个把产物改坏，确认恰好对应的断言变红。

第一轮 7/7：删 `404.html` / 链接改回相对 / 指引加 `display:none` / 指引挪到 `<nav>` 之后 /
`llms-full.txt` 改一个字节 / sitemap 少一个 `<loc>` / URL 套进 `<a>`。

第二轮 5/5（针对第 ⑦⑧ 条）：sitemap 塞回 `.html` / llms.txt 塞回 `.html` / 页面塞回相对 href /
页面塞回 `.html` href / 404 页 favicon 改回相对。

> ⚠️ 第 4 条那个「页面塞回 `.html` href」在第一版守卫下**没有咬住** —— 当时的第 ⑧ 条只查
> 「是否相对」，不查「是否 `.html`」，而站内 `.html` 链接正是这轮要消灭的东西。
> **是反向验证把它抓出来的**（不是设计时想明白的），已补上并重跑 5/5。

## 6. 档 C 与档 D（2026-09-26 落地）

### 6.1 档 C：选了 C1（构建期 HTML→MD），不选 C2

原先写在这里的**代价结构判断保留**（它是对的）：`docs.html`(58 KB) / `api.html`(68 KB) 是
**手写 HTML**，与 `usage-guide.md` **不是同一份**（实测：`docs.html` 有 18 个 `<h2>`，
`usage-guide.md` 只有 9 个 `##`；`mapWithConcurrency` 只在 `api.html` 出现）。所以只有两条路：

- **C1 构建期 HTML→MD**（剥 `<aside>`/`<nav>`/`<script>`）—— 便宜、可测，但**正是 Rspress 那篇
  明确否掉的路**（*「将 HTML 转为 Markdown 往往效果不佳」*）。前提是「HTML 自己写的、结构稳定」，
  且**必须先确认 `markdown-content-parity` 过得去**。
- **C2 给 docs/api 立 markdown 单源**，页面由它渲染 —— 质量最高，代价大一个量级（重写两个页面，
  即动官网视觉层，而那层另有守卫）。

**选 C1，判据是实测而不是偏好**：parity 的 PASS 线是「缺失 < 5%」、FAIL 线是「≥ 20%」，本站产物
跑出来是 **avg 0% missing（4 页全 pass）** —— 那句「往往效果不佳」的风险在本站**没有兑现**，
因为转换器是**按打分器的口径写的**（而不是通用转换器）。落点
`packages/website/scripts/build-md-variants.mjs`，构建末尾跑（已串进 `npm run build:website`）。

三条关键实现决定，每条都有实测后果：

1. **输入取产物、剥壳集合与打分器一致**：打分器比的是「线上 HTML 正文 ↔ markdown」，所以读
   `dist/*.html`；正文容器取 **`body`**（不是 `<main>`）—— 首页压根没有 `<main>`，playground 的
   页面标题与「key 不出本机」那段也在 `<main>` 之外，只取 `<main>` 会让这两页变成残页
   （实测第一版 `playground.md` 只剩 335 字符）。剥掉的元素（`nav`/`footer`/`aside`/`script`/
   `style`/表单控件/sr-only 指引块）**全是打分器也会剥的** ⇒ 多出来的内容只可能「更全」，
   不会让 parity 失分。
2. **表格转「一行一条」，不转 GFM 表格**：`api.html` 的 10 张表里有 **28 个单元格正文含 `|`**
   （`string | ContentBlockParam[]` 这类联合类型）。GFM 表格里那个 `|` 必须转义成 `\|`，而 parity 判的是
   「HTML 正文片段**是否作为子串**出现在 markdown 里」—— 转义符会让片段整条对不上。列表形态
   零转义、零丢失，agent 读起来也更好扫。
3. **`.md` 首行的 llms 指引：单行 + 链接形态**。单行是因为打分器按「整段是否以 `for ai agents:` 开头」
   过滤噪声，拆行会留下没被过滤的残句；链接形态是因为它判「这段像不像 markdown」只认标题/链接/围栏
   三者之一，而 `playground.md` 正文极短，没有链接会被**整份**判为「不是 markdown」
   （实测：第一版用纯文本，该页在 `llms-txt-directive-md` 里被判「没有 markdown 版本」）。
   ⚠️ HTML 侧（`Base.astro` 的指引块）的约束**相反** —— 那里必须写纯文本，因为 HTML→MD 的
   转换器会丢锚标签。

### 6.2 档 D：`_worker.js`（Pages advanced mode）

**平台功能仍然够不着**（此判断不变）：Cloudflare 有平台级 *Markdown for Agents*（自动 HTML→MD，
带 `x-markdown-tokens` / `content-signal`），但它是 **zone 级功能、要自持域名 + Pro 起**；本站
canonical 是 `agentia-web.pages.dev`（README / `package.json` / `astro.config.mjs` / `Base.astro`
全用这个），**不是自持 zone**。所以只能自建 —— 落点 `packages/website/public/_worker.js`，
构建时进 `dist/_worker.js`：

- **为什么是 advanced mode**：`wrangler pages deploy <dir>` 只认**产物目录里**的 `_worker.js`
  （没有 `functions` 目录参数），而部署命令正是 `pages deploy packages/website/dist`。
- **兜底必须是总的**：advanced mode 下**所有**请求都过它，一旦抛错整站（含 robots / sitemap / 首页）
  都会 500。所以任何异常一律退回 `env.ASSETS.fetch(request)` —— 「给 agent 补个 markdown 变体」
  这级改动不该有把官网打挂的威力。
- **只改「无扩展名的页面路径」**：`/llms.txt`、`/robots.txt`、`/sitemap.xml`、`/favicon.svg`、
  `/_astro/*` 一律不碰；`.md` 拿不到 200 就打回原样，让硬 404 继续生效
  （**绝不把「没有变体」变成「这个页面不存在」**）。
- **缓存不会串**：改写指向**另一个 URL**（`/docs` → `/docs.md`），边缘缓存天然按路径分开，
  浏览器不会拿到 markdown；`vary: Accept` 仍写上，把「同一 URL 两种表示」说清楚。

### 6.3 验证（三层）

- **单测（真跑，不看源码文本）**：`tests/docs/website-md-variants.test.ts`（转换器 9 条）、
  `tests/docs/website-markdown-negotiation.test.ts`（worker 喂**假 `env.ASSETS`** 真调 `fetch` 9 条）。
- **产物守卫**：`scripts/check-website-agent-readiness.mjs` 新增第 ⑩–⑬ 类，折在 verify-all **第 8 步**
  —— **不加第 9 步**（步骤数写在 CI 必需检查名里）。
- **部署前实测**：本地 `wrangler pages dev` 起**同一份产物**测两遍（拿掉 / 装上 `_worker.js`），
  再对着真打分器量，即 §2.4 那三行读数。装 worker 那遍同时就是档 D 的 **kill 判据**。

### 6.4 留下的（如实）

- **线上总分仍显示 `(Capped: single-page-sample)`**：站上只有 4 个页面，打分器要求 ≥5 个才给页面级
  类别计分。那是**测量口径**、不是站点缺陷；要解开得给站点加第五个**真页面**（内容决策，本方案不做）。
- **`auth-gate-detection` 那条 WARN 是误报**（playground 的 API-key 输入框被认成登录框），见 §2。
- **`llms.txt` 的「文档」链接仍指向干净 HTML 页**（不改指 `.md`）：那是站点 canonical、与 sitemap 一致，
  markdown 由档 D 的协商提供。副产物是 `llms-txt-links-markdown` 这一项**依赖档 D**（只有 C 时是 WARN，
  C+D 才 PASS）—— 这是**刻意**的耦合，不是遗漏。
- **`/playground.md` 的内容天然很短**（那一页的正文大半在交互控件里，而控件是壳）。它够用
  （打分器要的是「存在且是 markdown」），但对 agent 的价值远不如 `/docs.md`、`/api.md`。

## 7. 为什么不换 Rspress

SSG-MD 是 Rspress 的一等能力，但本站是 4 页 Astro 宣传站：为它换 SSG，收益是 C/D 两档，
代价是整站重写 + 丢掉既有 `.html` 外链与全部版式守卫（`tests/docs/website-css.test.ts` 等）。
等价物自己能做（§6），不划算。

同样**不采纳**：把 AFDocs 的 100/100 当目标（若干净脆是「少于 5 页」——本站就 4 页，
工具自己会提示「may not represent the site」；`auth-gate-detection` 对本站还是误报）、
Mintlify Agent Score 的 MCP 可发现性检查（YAGNI）。
