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
 *
 * ⚠️ 那行 `# build: <sha>` **不是装饰**（2026-10-08）：CI 的部署 job 拿**它**判断
 * 「新版是不是真的上线了」——见 `.github/workflows/ci.yml` 的 `deploy-website`。
 * 换掉的那条旧判据是「robots.txt 里有 `Sitemap: ` 行」（其注释写着「它是本轮新增的产物，
 * 只有新版才可能有」）—— 而那一行自 PR #119 起**每一版都有** ⇒ 条件恒为真、从不等待，
 * 于是 AFDocs 在**半传播状态**下打分：2026-10-08 实测第 1 次探测就报「已在线上」，
 * 同时它读到的是**旧的 sitemap**，刷出两条假 FAIL（llms-txt-links-resolve /
 * llms-txt-coverage）。
 * ⇒ 判据不能是「某个只有新版才有的字面量」（那个字面量会随版本变旧而恒真），
 *   只能是「本次运行自己的身份」。
 *
 * ⚠️ 本地构建**不写**这一行（`GITHUB_SHA` 未设）⇒ 「这一行在不在」本身就是
 * 「这份产物是不是 CI 构建的」的判据。**别给它编一个假缺省值**（`'dev'` 之类）：
 * 那样这一行永远在、判据又变回恒真。
 * 两边的契约（标记文本 + 消费方式）由 `tests/scripts/verify-all-wiring.test.ts` 双向核对。
 */
const FALLBACK_SITE = 'https://agentia-web.pages.dev';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL(FALLBACK_SITE)).origin;
  const sha = process.env.GITHUB_SHA ?? '';
  const body = [
    '# Agentia 官网：宣传站 + 使用说明（/llms-full.txt 是纯文本全文）',
    // 只在 CI 里出现，见头注（键名固定为 `build: `，CI 那边按同一条字符串匹配）
    ...(sha ? [`# build: ${sha}`] : []),
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
