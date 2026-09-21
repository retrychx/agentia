# 官网 agent 可读性（GEO）加固

> **状态：已落地（2026-09-21）。** 档 A（外围件）+ 档 B（llms 指引）已实现；档 C（每页 `.md`）
> 与档 D（`Accept: text/markdown` 内容协商）**有意未做**，理由与触发条件见 §6。
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

## 3. 决策

按**依赖关系**排，而不是按文件大小：

| 档 | 内容 | 依赖 | 本轮 |
|---|---|---|---|
| **A** | `404.html` · `robots.txt` · `sitemap.xml` · `llms.txt` 链接绝对化 | 无 | ✅ 做 |
| **B** | 每页 `<body>` 最前的 llms 指引块 | 无（但它是档 C/D 被发现的**前提**） | ✅ 做 |
| C | 每页 `.md` 产物 | 需先解决「没有 markdown 单源」 | ❌ 缓 |
| D | `Accept: text/markdown` 内容协商（Pages Function / `_worker.js`） | **依赖 C**（没有 `.md` 可指向） | ❌ 缓 |

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

## 6. 未做：档 C 与档 D

它们是一对**有依赖关系的**工作（协商要先有 `.md` 可指向），合起来单独立项。缓的理由不是难，是**代价结构**：

- **Rspress 的做法是从源 AST 渲染 Markdown**，而本站 `docs.html`(58 KB) / `api.html`(68 KB) 是
  **手写 HTML**，且与 `usage-guide.md` **不是同一份**（实测：`docs.html` 有 18 个 `<h2>`，
  `usage-guide.md` 只有 9 个 `##`；`mapWithConcurrency` 只在 `api.html` 出现）。所以只有两条路：
  - **C1 构建期 HTML→MD**（剥 `<aside>`/`<nav>`/`<script>`，只转 `<main>`）—— 便宜、可测，
    但**正是 Rspress 那篇明确否掉的路**（*「将 HTML 转为 Markdown 往往效果不佳」*）。
    对本站风险可控（HTML 自己写的、结构稳定），但需要先确认 `markdown-content-parity` 过得去。
  - **C2 给 docs/api 立 markdown 单源**，页面由它渲染 —— 质量最高，代价大一个量级（重写两个页面）。
- **档 D 最便宜的实现本站够不着**：Cloudflare 有平台级 *Markdown for Agents*（自动 HTML→MD，
  带 `x-markdown-tokens` / `content-signal`），但它**是 zone 级功能、要自持域名 + Pro 起**；
  本站 canonical 是 `agentia-web.pages.dev`（README / `package.json` / `astro.config.mjs` / `Base.astro`
  全用这个），**不是自持 zone**。⇒ 只能自建 `_worker.js` / Pages Function，那会给一个纯静态站
  **引入运行期**，且需要另立一条 `wrangler pages dev` 下的测试路径。

**触发条件**：真出现「agent 反复抓 52 KB HTML 才能拿一次 API 清单」的迹象，或档 D 的平台前提
（自持域名 + Pro）发生变化时再做。当下的替代品已经够用：`/llms-full.txt` 是全文单源，
档 B 的指引让它**可被发现**。

## 7. 为什么不换 Rspress

SSG-MD 是 Rspress 的一等能力，但本站是 4 页 Astro 宣传站：为它换 SSG，收益是 C/D 两档，
代价是整站重写 + 丢掉既有 `.html` 外链与全部版式守卫（`tests/docs/website-css.test.ts` 等）。
等价物自己能做（§6），不划算。

同样**不采纳**：把 AFDocs 的 100/100 当目标（若干净脆是「少于 5 页」——本站就 4 页，
工具自己会提示「may not represent the site」；`auth-gate-detection` 对本站还是误报）、
Mintlify Agent Score 的 MCP 可发现性检查（YAGNI）。
