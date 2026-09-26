/*
 * Cloudflare Pages advanced mode worker —— `Accept: text/markdown` 内容协商（GEO 档 D）。
 *
 * 为什么要有它：Claude Code / Cursor / OpenCode 这类编码 agent 抓页面时会**主动带**
 * `Accept: text/markdown`（不是假想流量，是默认行为）。本站是纯静态站，静态托管不认识这个
 * 请求头，于是 agent 只能拿到 64% 是导航样板的 HTML。这里把同一个 URL 按请求头**改写**到
 * 构建期已经生成的 `.md` 变体（见 scripts/build-md-variants.mjs），返回正确的 content-type。
 *
 * 为什么是 advanced mode（`_worker.js` 放进产物根）而不是平台功能：
 *   Cloudflare 有自带的 "Markdown for Agents"（网络层自动 HTML→MD），但它是**zone 级 + Pro 起**
 *   的功能，本站 canonical 是 `agentia-web.pages.dev`（Cloudflare 自己的 zone）⇒ **够不着**。
 *   `wrangler pages deploy` 只认产物目录里的 `_worker.js`（没有 `functions` 目录参数），
 *   所以这里走 advanced mode。
 *
 * ⚠️ 三条必须守住的边界（改之前先读）：
 *
 *  ① **兜底必须是总的。** advanced mode 下所有请求都经过这个 worker：一旦它抛错，整站
 *     （含 robots/sitemap/首页）都会 500 —— 一个「加个 markdown 变体」的改动不该有这个威力。
 *     所以任何异常一律退回 `env.ASSETS.fetch(request)` 的原样响应。
 *
 *  ② **只改写「无扩展名的页面路径」。** `/llms.txt`、`/robots.txt`、`/sitemap.xml`、
 *     `/favicon.svg`、`/_astro/*` 都不碰 —— 它们本来就是机器可读的，改写只会制造意外。
 *
 *  ③ **`.md` 不存在就照旧。** 改写后拿不到 200 就打回原样，让 Pages 的硬 404 继续生效；
 *     绝不把「没有 markdown 变体」变成「这个页面不存在」。
 *
 * 缓存注意：改写走的是**另一个 URL**（`/docs` → `/docs.md`），所以边缘缓存天然按路径分开，
 * 不会把 markdown 回给浏览器；`vary: Accept` 仍写上，把「同一 URL 两种表示」这件事说清楚。
 */

/** 无扩展名的单段/多段页面路径（`/`、`/docs`、`/api`、`/playground`） */
const PAGE_PATH = /^\/[^.]*$/;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const wantsMarkdown = (request.headers.get('accept') ?? '').includes('text/markdown');

      // `/`（首页）单独放行：它的 pathname 以 `/` 结尾，会被下面那条「尾部斜杠不处理」的规则挡掉
      const isPagePath =
        url.pathname === '/' || (PAGE_PATH.test(url.pathname) && !url.pathname.endsWith('/'));

      if (wantsMarkdown && isPagePath) {
        const mdPath = url.pathname === '/' ? '/index.md' : `${url.pathname}.md`;
        const mdResponse = await env.ASSETS.fetch(
          new Request(new URL(mdPath, url), { method: request.method, headers: request.headers }),
        );
        if (mdResponse.ok) {
          return new Response(mdResponse.body, {
            status: 200,
            headers: {
              'content-type': 'text/markdown; charset=utf-8',
              'cache-control': 'public, max-age=0, must-revalidate',
              vary: 'Accept',
            },
          });
        }
      }
      return await env.ASSETS.fetch(request);
    } catch {
      // 见边界 ①：协商失败（含任何未预期异常）绝不影响站点可用性
      return env.ASSETS.fetch(request);
    }
  },
};
