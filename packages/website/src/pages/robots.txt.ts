import type { APIRoute } from 'astro';

/**
 * /robots.txt —— 爬虫与 agent 的入口约定。
 *
 * ⚠️ 在此之前本站**没有** robots.txt：Cloudflare Pages 把未匹配路径回退成根 `index.html`
 * 且状态码 200（soft 404），于是 `/robots.txt` 返回了一份 HTML。爬虫拿到的因此不是
 * 「没有约束」，而是一段伪装成成功的首页 —— 比 404 更糟。配套修复见 `404.astro`。
 *
 * `Sitemap:` 必须是绝对地址（robots.txt 规范要求；相对值会被忽略）。
 * 站点地址取自 `astro.config.mjs` 的 `site`，缺省回落到同一常量（与 `Base.astro` 同款写法）。
 */
const FALLBACK_SITE = 'https://agentia-web.pages.dev';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL(FALLBACK_SITE)).origin;
  const body = [
    '# Agentia 官网：宣传站 + 使用说明（/llms-full.txt 是纯文本全文）',
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${new URL('/sitemap.xml', origin).href}`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
