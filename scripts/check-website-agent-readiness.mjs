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
   而不是在脚本里再抄一份页面清单 —— 那样加页面时守卫会跟着一起漏。 */
const builtPages = readdirSync(dist)
  .filter((f) => f.endsWith('.html') && f !== '404.html')
  .sort();
const expectedLocs = builtPages
  .map((f) => new URL(f === 'index.html' ? '/' : `/${f}`, ORIGIN).href)
  .sort();

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
  const missing = expectedLocs.filter((loc) => !body.includes(loc));
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

console.log(`[website-agent] 核了 ${builtPages.length} 个页面 + robots/sitemap/llms 共 6 类产物`);
if (failures.length > 0) {
  console.error(`\n[website-agent] ${failures.length} 项不达标：`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log('[website-agent] 全部达标');
