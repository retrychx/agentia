import type { APIRoute } from 'astro';

/**
 * /sitemap.xml —— 站点页面清单（给搜索引擎与 agent 的「地面真值」）。
 *
 * 为什么需要它：AFDocs 的 `llms-txt-coverage` 检查**以 sitemap 为基准**核对 llms.txt 覆盖了
 * 哪些页；本站此前没有 sitemap，该项直接 SKIP（「No sitemap found; cannot assess」）。
 *
 * ⚠️ **URL 口径是 `.html`**，不是干净路径。理由：站点自声明口径（每页 `<meta property="og:url">`
 * 由 `Base.astro` 按 `Astro.url.pathname` 算出 → `/docs.html`）、站内所有互链（Nav/Footer/正文）
 * 以及 README / package.json 的 homepage 全都用 `.html`。这里必须跟它们一致 ——
 * 两处口径不一致时，afdocs 只是把两种写法归一化后比对，但**人和索引器看到的是两份声明**。
 *
 * 增删页面时要同步三处：本清单、`llms.txt.ts` 的「文档」节、以及 `scripts/check-website-agent-readiness.mjs`
 * 的交叉核对（它会断言 llms.txt 里出现了清单中的每一条 URL，任一处漂移即构建红）。
 */
const PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/docs.html', priority: '0.9' },
  { path: '/api.html', priority: '0.8' },
  { path: '/playground.html', priority: '0.7' },
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
