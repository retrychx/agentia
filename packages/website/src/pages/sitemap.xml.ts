import type { APIRoute } from 'astro';

/**
 * /sitemap.xml —— 站点页面清单（给搜索引擎与 agent 的「地面真值」）。
 *
 * 为什么需要它：AFDocs 的 `llms-txt-coverage` 检查**以 sitemap 为基准**核对 llms.txt 覆盖了
 * 哪些页；本站此前没有 sitemap，该项直接 SKIP（「No sitemap found; cannot assess」）。
 *
 * ⚠️ **URL 一律干净形态**（`/docs`，不是 `/docs.html`）—— sitemap 里必须是**最终 URL**。
 * 上一轮这里判反过：当时以为站点自声明口径是 `.html`（`og:url`、站内互链、README 都用它），
 * 于是声明成 `.html`。线上回读后否掉 —— Cloudflare Pages 对产物里存在的 `x.html` 一律
 * **308** 到 `/x`（实测 /index.html → /、/docs.html → /docs、/404.html → /404），
 * 所以 `.html` 恰是**会重定向**的形态。那一版把三处声明成了跳转前的地址。
 * 同批已把 `og:url` 与站内链接（Nav / Footer / 正文 / 404 页）一并改到干净形态。
 *
 * 增删页面时要同步三处：本清单、`llms.txt.ts` 的「文档」节、以及 `scripts/check-website-agent-readiness.mjs`
 * 的交叉核对（它会断言 llms.txt 里出现了清单中的每一条 URL，任一处漂移即构建红）。
 */
const PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/docs', priority: '0.9' },
  { path: '/api', priority: '0.8' },
  { path: '/playground', priority: '0.7' },
] as const;

const FALLBACK_SITE = 'https://agentia-web.pages.dev';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL(FALLBACK_SITE)).origin;
  const entries = PAGES.map(
    ({ path, priority }) =>
      `  <url>\n    <loc>${new URL(path, origin).href}</loc>\n    <priority>${priority}</priority>\n  </url>`,
  ).join('\n');

  // 不写 <lastmod>：那会让每次构建产出不同字节（无谓的非确定性），
  // 而本仓的守卫是**按字节**核产物的 —— 价值不抵噪声。
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;

  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
