#!/usr/bin/env node
/*
 * 官网「agent 可读性」产物守卫。
 *
 * 为什么要有它：2026-09-21 用 AFDocs（agentdocsspec.com 的配套打分器）给线上官网打分，
 * 23 项里 5 项 FAIL —— 而**其中没有一项是本仓任何测试会发现的**：它们全是「产物形状」
 * 问题（少 404.html ⇒ Cloudflare Pages 对任意路径回 200 + 首页 HTML；llms.txt 的链接是
 * 根相对地址 ⇒ 校验器整条丢弃）。源码全绿、官网照样在骗 agent。
 *
 * 所以这里按**产物自己的形状**核（不做源码字面匹配，也不复刻 AFDocs 的算法）——
 * 与 scripts/e2e-*.ts 同一条纪律：测产物，就用产物自己的输入。
 *
 * 检查项（13 类）：① 硬 404 的前提（产物里有 404.html）② robots.txt 的绝对 Sitemap 行
 * ③ sitemap 与产物页面集合互为真值 ④ llms.txt 链接全绝对且覆盖全部页面
 * ⑤ llms-full.txt 与单源 docs/usage-guide.md 逐字节相等 ⑥ 每页 llms 指引的形态
 * ⑦ 声明的 URL 不得是 `.html` ⑧ 站内链接必须绝对路径、且不是 `.html` 形态
 * ⑨ 每页 og:url 是干净路径、且与该页在 sitemap 里的 loc 一致
 * ⑩ 每页都有同名 `.md` 变体（404 除外）⑪ 每份 `.md` 首行是 llms 指引（单行 + 链接形态）
 * ⑫ 每份 `.md` 与页面结构对账（无残留标签 / 标题与代码块计数相等 / 标题文本逐条在场）
 * ⑬ 内容协商层 `_worker.js` 在产物里（`.md` 的消费者入口；行为由
 *    tests/docs/website-markdown-negotiation.test.ts 用假 env.ASSETS 真跑守住）
 *
 * ⚠️ 教训（2026-09-21，写在这里免得再犯）：第一版守卫把「站点 URL 的形态」等同于
 * **产物文件名**（`docs.html`），于是把「声明 `.html`」锁成了绿灯 —— 而线上 `.html` 是
 * **会 308 重定向**的形态（Cloudflare Pages 对存在的 `x.html` 一律跳 `/x`）。
 * **产物名对了不等于线上地址对了。** 第 ⑦ 条就是为此补的。
 *
 * 归口：verify-all.sh 第 8 步（`npm run build:website` 之后）。步骤数写在 CI job 名里，
 * 所以新检查一律**折进**已有步骤，不新开第 9 步（见 verify-all.sh 顶部注释）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages', 'website', 'dist');
const guidePath = join(repoRoot, 'docs', 'usage-guide.md');

/** 与 astro.config.mjs 的 `site` 一致；产物里的绝对地址必须落在这个源上 */
const ORIGIN = 'https://agentia-web.pages.dev';

const failures = [];
/** 每项检查都收集失败、不提前退出 —— 一次跑完能看全所有漂移，而不是修一条撞一条 */
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${label} —— ${err instanceof Error ? err.message : String(err)}`);
  }
}
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

if (!existsSync(dist)) {
  console.error(`[website-agent] 找不到 ${dist} —— 先跑 \`npm run build:website\``);
  process.exit(1);
}

const read = (name) => readFileSync(join(dist, name), 'utf8');

/* ── 1. 硬 404 的前提：产物里必须真有 404.html ────────────────────────────
   Cloudflare Pages 在产物里找不到它时，会把**任意**未匹配路径回退成根 index.html
   并以 200 返回（soft 404）。实测（2026-09-21）：/robots.txt、/sitemap.xml、
   /usage-guide.md 拿到的都是同一份 17146 字节的首页 HTML —— agent 因此拿不到
   「这里没有」这个信号，会把首页当正文解析。这个文件的存在就是修复本身。 */
check('404.html 存在（硬 404 的前提）', () => {
  must(existsSync(join(dist, '404.html')), '缺 404.html：Pages 会对任意路径回 200 + index.html');
});

/* ── 2. robots.txt：Sitemap 必须是绝对地址（相对值会被爬虫忽略） ────────── */
check('robots.txt 有绝对 Sitemap 行', () => {
  must(existsSync(join(dist, 'robots.txt')), '缺 robots.txt');
  const body = read('robots.txt');
  must(
    body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`),
    `robots.txt 里没有 \`Sitemap: ${ORIGIN}/sitemap.xml\``,
  );
  must(/^User-agent: \*/m.test(body), 'robots.txt 缺 `User-agent: *` 行');
});

/* ── 3. sitemap.xml：与实际产物页面集合**互为真值** ──────────────────────
   期望集合从 dist 自己枚举（排除 404.html：错误页不该进 sitemap），
   而不是在脚本里再抄一份页面清单 —— 那样加页面时守卫会跟着一起漏。

   ⚠️ 枚举到的是**文件名**（docs.html），要映射成**站点 URL**（/docs）再比对。
   Cloudflare Pages 对产物里存在的 `x.html` 一律 308 到 `/x`，所以站点 URL 是干净形态。 */
const builtPages = readdirSync(dist)
  .filter((f) => f.endsWith('.html') && f !== '404.html')
  .sort();
/** 产物文件名 → 站点 URL 路径（`index.html` → `/`，`docs.html` → `/docs`） */
const toCleanPath = (file) =>
  (file === 'index.html' ? '/' : `/${file}`).replace(/index\.html$/, '/').replace(/\.html$/, '');
const expectedLocs = builtPages.map((f) => new URL(toCleanPath(f), ORIGIN).href).sort();

check('sitemap.xml 与产物页面集合一致', () => {
  must(existsSync(join(dist, 'sitemap.xml')), '缺 sitemap.xml');
  const xml = read('sitemap.xml');
  const locs = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)].map((m) => m[1]).sort();
  for (const loc of locs) {
    must(loc.startsWith(`${ORIGIN}/`), `<loc> 不是本站绝对地址：${loc}`);
  }
  must(
    JSON.stringify(locs) === JSON.stringify(expectedLocs),
    `sitemap 与产物页面不一致\n      产物页面：${expectedLocs.join(', ')}\n      sitemap：  ${locs.join(', ')}`,
  );
});

/* ── 4. llms.txt：站内链接必须绝对（校验器只认 http(s):// 开头） ───────── */
check('llms.txt 的链接全部是绝对地址', () => {
  const body = read('llms.txt');
  const relative = [...body.matchAll(/\]\((\/[^)]*)\)/g)].map((m) => m[1]);
  must(
    relative.length === 0,
    `存在根相对链接（AFDocs 的 llms-txt-links-resolve 只统计 http(s):// 开头的链接，这些会被整条丢弃）：${relative.join(', ')}`,
  );
  const links = [...body.matchAll(/\]\((http[^)]*)\)/g)].map((m) => m[1]);
  must(links.length > 0, 'llms.txt 里一条绝对链接都没有');
});

check('llms.txt 覆盖了全部产物页面', () => {
  const body = read('llms.txt');
  // 按「链接目标集合」精确比对，不能用整文/整行 includes ——
  // 首页 loc（https://agentia-web.pages.dev/）是其它任何 loc 的**前缀**，
  // 删掉首页链接后，/docs 那行仍「包含」这个前缀，前缀匹配会把「丢页」洗成绿灯。
  const linkTargets = new Set([...body.matchAll(/\]\((http[^)]*)\)/g)].map((m) => m[1]));
  const missing = expectedLocs.filter((loc) => !linkTargets.has(loc));
  must(missing.length === 0, `llms.txt 未提及这些页面（与 sitemap 漂移）：${missing.join(', ')}`);
});

/* ── 5. llms-full.txt 必须是单源 docs/usage-guide.md 的逐字节副本 ────────
   「站点上不会出现第二份手写说明」是这条链的全部意义；一旦有人编辑了产物或
   改了生成方式，这里先红。 */
check('llms-full.txt 与单源 docs/usage-guide.md 逐字节一致', () => {
  const built = read('llms-full.txt');
  const source = readFileSync(guidePath, 'utf8');
  must(
    built === source,
    `llms-full.txt 与 docs/usage-guide.md 不一致（产物 ${built.length} 字符 / 单源 ${source.length} 字符）`,
  );
});

/* ── 6. 每页都要有 llms 指引，且形态正确 ────────────────────────────────
   AFDocs 的 llms-txt-directive-html 检查的就是这件事：agent 从**深层页**进来时
   是否知道站上还有 /llms.txt。三个形态约束都有实际后果，不是洁癖：
     · 视觉隐藏必须用 clip / clip-path —— display:none / hidden 会被解析器剥离，
       而这条指引正是要能被「HTML→Markdown 的 agent」读到；
     · URL 必须是纯文本（不套 <a>）—— 转换器常丢弃链接标签、只留锚文本；
     · 必须在 <nav> 之前 —— <nav> 整段会被剥离，且离正文越远评分越低。 */
for (const file of [...builtPages, '404.html']) {
  check(`${file} 的 llms 指引形态`, () => {
    const html = read(file);
    const block = /<div class="llms-hint"[\s\S]*?<\/div>/.exec(html);
    must(block !== null, '找不到 <div class="llms-hint">（Base.astro 里被删了？）');
    const text = block[0];
    must(text.includes('clip-path:inset(50%)'), '没有 clip-path:inset(50%)：视觉隐藏方式不达标');
    must(!/display:\s*none/.test(text), '用了 display:none：会被解析器剥离，指引读不到');
    must(!/<a\s/.test(text), 'URL 被套进 <a> 了：HTML→Markdown 转换会丢掉链接标签');
    must(text.includes(`${ORIGIN}/llms.txt`), `缺 ${ORIGIN}/llms.txt 纯文本`);
    must(text.includes(`${ORIGIN}/llms-full.txt`), `缺 ${ORIGIN}/llms-full.txt 纯文本`);
    const hintAt = html.indexOf('class="llms-hint"');
    const navAt = html.indexOf('<nav');
    must(navAt === -1 || hintAt < navAt, '指引排在 <nav> 之后：会被当作导航剥掉 / 判为 buried');
  });
}

/* ── 7. 声明的 URL 不得是「会重定向的形态」（.html） ──────────────────────
   Cloudflare Pages 对产物里存在的 `x.html` 一律 **308** 到 `/x`（实测 2026-09-21：
   /index.html → /、/docs.html → /docs、/404.html → /404）。所以 sitemap 与 llms.txt 里
   声明的必须是**最终地址**，不能是「跳转前的地址」。

   ⚠️ 这条正是上一轮判错的地方。当时守卫拿 dist 的**文件名**去比对声明，把「.html 口径」
   锁成了绿灯 —— **产物名对了 ≠ 线上地址对了**。别再用文件名当站点 URL 的真值。 */
check('声明的 URL 不得是 .html（线上会 308 重定向）', () => {
  const bad = [];
  for (const name of ['sitemap.xml', 'llms.txt']) {
    for (const m of read(name).matchAll(/https?:\/\/[^\s)"'<>`]+/g)) {
      if (/\.html?(?=$|[?#])/.test(m[0])) bad.push(`${name}: ${m[0]}`);
    }
  }
  must(bad.length === 0, `声明了会重定向的 .html 地址（应写干净形态 /docs）：${bad.join(', ')}`);
});

/* ── 8. 站内链接必须是绝对路径，且不得是 `.html` 形态 ─────────────────────
   两个理由都有实测后果：
     · `.html` 结尾会多一跳 308（见第 7 条）—— 而且是**全站每一处点击**都跳；
     · **相对地址**（`./docs`）本站一律不该用 —— 404 页会以**任意**请求路径被送出
       （/foo/bar/baz 也回它），浏览器按 /foo/bar/ 解析 `./docs` ⇒ 又落回 404。 */
check('站内链接必须是绝对路径，且不是 .html 形态', () => {
  const bad = [];
  for (const file of [...builtPages, '404.html']) {
    for (const m of read(file).matchAll(/\shref="([^"]*)"/g)) {
      const href = m[1];
      // 放行：页内锚点、以及任何带 scheme 的绝对地址（http/https/mailto/…）
      if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      if (!href.startsWith('/')) {
        bad.push(`${file}: ${href}（相对路径）`);
        continue;
      }
      if (/\.html?(?=$|[?#])/.test(href)) bad.push(`${file}: ${href}（.html 会 308）`);
    }
  }
  must(bad.length === 0, `站内链接不合格：${bad.join(', ')}`);
});

/* ── 9. 每页 og:url：必须是干净路径，且与该页在 sitemap 里的 loc 一致 ──────
   第 7 条只扫 sitemap / llms.txt 里的 URL，第 8 条只扫 HTML 的 href ——
   HTML 头部的 og:url 此前两头不靠：它若回退成 `.html` 形态（会 308 的「跳转前地址」，
   见第 7 条），其余检查照样全绿。这里把自声明地址也纳入守卫。
   404.html 不进 sitemap（见第 3 条），对它只核「干净路径」不核 loc 一致。 */
for (const file of [...builtPages, '404.html']) {
  check(`${file} 的 og:url 是干净路径且与 sitemap 一致`, () => {
    const html = read(file);
    const og = /<meta\s+property="og:url"\s+content="([^"]*)"/.exec(html);
    must(og !== null, '找不到 <meta property="og:url" content="…">（Base.astro 里被删了？）');
    const url = og[1];
    must(url.startsWith(`${ORIGIN}/`), `og:url 不是本站绝对地址：${url}`);
    must(!/\.html?(?=$|[?#])/.test(url), `og:url 是 .html 形态（线上会 308）：${url}`);
    if (file !== '404.html') {
      const expected = new URL(toCleanPath(file), ORIGIN).href;
      must(url === expected, `og:url 与 sitemap 的 loc 不一致：${url} ≠ ${expected}`);
    }
    // canonical 目前没生成；一旦出现就同口径核（干净路径 + 与该页 loc 一致）
    const canonical = /<link\s+rel="canonical"\s+href="([^"]*)"/.exec(html);
    if (canonical !== null) {
      const href = canonical[1];
      must(href.startsWith(`${ORIGIN}/`), `canonical 不是本站绝对地址：${href}`);
      must(!/\.html?(?=$|[?#])/.test(href), `canonical 是 .html 形态（线上会 308）：${href}`);
      if (file !== '404.html') {
        const expected = new URL(toCleanPath(file), ORIGIN).href;
        must(href === expected, `canonical 与 sitemap 的 loc 不一致：${href} ≠ ${expected}`);
      }
    }
  });
}

/* ── 10. 每页都要有 markdown 变体（GEO 档 C）─────────────────────────────
   为什么守：AFDocs 的 Markdown Availability 那一格（4 项）在只有 HTML 时全 FAIL ——
   而静态站补这一格**没有别的办法**，只能每个页面真有一份 `.md`。
   404 页刻意不产出：错误页不是内容，给它 markdown 变体只会让 agent 把「这里没有」
   当成一章读。 */
const mdPages = builtPages.map((html) => ({ html, md: html.replace(/\.html$/, '.md') }));

check('每个页面产物都有同名 .md 变体（404 页除外）', () => {
  const missing = mdPages.filter((p) => !existsSync(join(dist, p.md))).map((p) => p.md);
  must(
    missing.length === 0,
    `缺 markdown 变体：${missing.join(', ')}（构建末尾的 scripts/build-md-variants.mjs 没跑？）`,
  );
  must(!existsSync(join(dist, '404.md')), '404 页不该有 markdown 变体（错误页不是内容）');
});

/* ── 11. 每份 .md 的首行是 llms 指引 ─────────────────────────────────────
   AFDocs 的 llms-txt-directive-md 判定两件事：md 里出现 `/llms.txt`，且落在正文前 10%。
   形态两条约束各有实测后果（见 scripts/build-md-variants.mjs 注释）：
     · 必须**单行** —— 打分器按「整段是否以 `for ai agents:` 开头」过滤噪声，
       拆行会留下没被过滤的残句（那些残句要嘛变成 parity 的必答项，要嘛需要额外剥壳）；
     · 必须是**链接**形态 —— 打分器判「这段像不像 markdown」只认标题/链接/围栏，
       playground 那种正文极短的页若没有链接会被整份判为「不是 markdown」。 */
for (const p of mdPages) {
  check(`${p.md} 的首行是 llms 指引`, () => {
    const first = read(p.md).split('\n')[0] ?? '';
    must(first.startsWith('> '), `首行不是 blockquote 指引：${first.slice(0, 60)}`);
    must(first.includes(`${ORIGIN}/llms.txt`), '缺 llms.txt 绝对地址');
    must(first.includes(`${ORIGIN}/llms-full.txt`), '缺 llms-full.txt 绝对地址');
    must(first.includes(`[llms.txt](${ORIGIN}/llms.txt)`), 'llms.txt 不是链接形态');
    const selfPath = p.html === 'index.html' ? '/index.md' : `/${p.md}`;
    must(first.includes(`${ORIGIN}${selfPath}`), `缺本页 markdown 地址 ${selfPath}`);
    must(
      read(p.md)
        .split('\n')
        .filter((l) => l.includes('/llms.txt')).length === 1,
      '指引被拆成多行（打分器只过滤整段，残句会污染 parity 的必答项）',
    );
  });
}

/* ── 12. .md 与页面结构对账 ──────────────────────────────────────────────
   这一条是「内容别在转换里静默丢」的兜底。判据都取**可精确相等**的量：
   标题计数、代码块计数、以及每个标题的文本必须逐条出现在 md 里。
   （数量对上但内容丢了的形态，只有最后那条抓得住。）
   ⚠️ 「不得残留 HTML 标签」不能写成「正文里不许有 `<`」：api.md 的表格里
   `SchemaInput<S>`、`<T>`、`<name>/index.ts` 是**正当内容**（泛型与占位符），
   所以判据是「已知 HTML 标签名 + 后随 `>`/空白/斜杠」，且代码块与行内代码先剥掉。 */
const HTML_TAG = new RegExp(
  `<\\s*/?\\s*(?:a|abbr|aside|b|blockquote|body|br|button|canvas|code|dd|div|dl|dt|em|figcaption` +
    `|figure|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|li|link|main|meta|nav` +
    `|ol|option|p|pre|script|section|select|small|span|strong|style|svg|table|tbody|td|textarea` +
    `|th|thead|title|tr|ul)(?=[\\s/>])`,
  'i',
);
const stripCode = (md) =>
  md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/(?<!`)``(?!`)[\s\S]*?(?<!`)``(?!`)/g, '')
    .replace(/(?<!`)`(?!`)(?:[^`]|`{2,})+(?<!`)`(?!`)/g, '');

for (const p of mdPages) {
  check(`${p.md} 与页面结构对账（标题/代码块/标题文本）`, () => {
    const md = read(p.md);
    const html = read(p.html);
    const count = (s, re) => (s.match(re) ?? []).length;

    const leftOver = (stripCode(md).match(HTML_TAG) ?? []).length;
    must(leftOver === 0, `正文里残留 HTML 标签（转换漏了某个标签分支？）`);

    const pairs = [
      ['h2', /^## /gm, /<h2[\s>]/g],
      ['h3', /^### /gm, /<h3[\s>]/g],
      ['代码块', /^`{3,}\n/gm, /<pre[\s>]/g, 2], // 每块一开一闭两条围栏
    ];
    for (const [label, mdRe, htmlRe, factor = 1] of pairs) {
      const a = count(md, mdRe);
      const b = count(html, htmlRe) * factor;
      must(a === b, `${label} 数量不一致：markdown ${a} vs 页面 ${b}（有内容被静默丢弃）`);
    }
    for (const m of html.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/g)) {
      const text = m[2]
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) must(md.includes(text), `标题文本在 markdown 里丢了：${text.slice(0, 40)}`);
    }
  });
}

/* ── 13. 内容协商层的产物入口在场 ────────────────────────────────────────
   `dist/_worker.js` 是 Pages advanced mode 的入口 —— 它不在，`.md` 变体就只剩「知道
   `.md` 路径的人能用」这一条路，编码 agent 默认带的 `Accept: text/markdown` 会拿到 HTML。
   这里只核**在场**与最基本的形态；行为（改写/透传/兜底）由 tests/docs/
   website-markdown-negotiation.test.ts 用假 `env.ASSETS` 真跑守着 —— 守卫查形状，用例查行为。 */
check('内容协商层 _worker.js 在产物里', () => {
  const worker = join(dist, '_worker.js');
  must(existsSync(worker), '缺 _worker.js：Accept: text/markdown 的请求会拿到 HTML');
  const body = readFileSync(worker, 'utf8');
  must(body.includes('text/markdown'), '_worker.js 里没有 text/markdown 协商');
  must(
    body.includes('env.ASSETS.fetch(request)'),
    '_worker.js 缺静态资产兜底（advanced mode 下抛错会打挂整站）',
  );
});

console.log(`[website-agent] 核了 ${builtPages.length} 个页面 + robots/sitemap/llms 共 13 类产物`);
if (failures.length > 0) {
  console.error(`\n[website-agent] ${failures.length} 项不达标：`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log('[website-agent] 全部达标');
