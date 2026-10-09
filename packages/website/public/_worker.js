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
 *  ④ **`/en/` 规范化到 `/en`（2026-10-08 官网英文版）。** `build.format: 'file'` 下
 *     英文首页的产物是**扁平的 `en.html`**（不是 `en/index.html`）⇒ 英文首页的规范地址是
 *     `/en`；而 `/en/` 是很自然的输入（访客看到 `/en/docs` 会猜 `/en/`）。这里 308 到最终形态。
 *
 *     ⚠️ 这条规则**不是**「Pages 自己处理不了才补的」—— 实测（2026-10-08）Pages 会把
 *     `/docs/`、`/en/docs/` 这类「产物里存在 `x.html`」的目录形态 308 到干净形态
 *     （回的是**相对** `location: /docs`），`/en/` 同理。**留下这条规则的理由是响应头**：
 *     Pages 自己那条 308 一个 cache 头都不带，而 `Response.redirect()` 同样只给 `location`
 *     （Node 与 workerd 行为一致，实测过）。由我们发，才能把缓存语义写进去。
 *     （本条初版注释写着「Pages 对 `/en/` 只会回 404」—— 那是**错的**，别照着它往下推。）
 *
 *     ⚠️ 顺带更正一处更早的归因：2026-10-08 部署后 AFDocs 报 `cache-header-hygiene`
 *     「1 of 7 endpoints」时，我先把账算在**这条** 308 头上。**不是它** —— AFDocs 会
 *     **跟随重定向**（它报 `/en/` 的 cacheControl 是跳转后 200 那页的头），逐端点复测
 *     静态资源、`.md`、llms/sitemap 也全部合格。那次的真因是**判据腐烂 ⇒ 在部署传播窗口里
 *     打分**（见 `.github/workflows/ci.yml` 那条轮询判据的注释）。补这个头是**卫生**，
 *     不是那次红的解药。
 *
 *  ⑤ **语言协商（2026-10-09）：按 `Accept-Language` 302 到 `/en`。** 此前这件事由
 *     `Base.astro` 里一段 `is:inline` 脚本用 `location.replace` 做，而那段脚本**留在每一页的
 *     HTML 里**（英文页也有，只是运行期不触发）⇒ AFDocs 的 `redirect-behavior` 逐页判
 *     `js-redirect` FAIL。搬到边缘既修掉它，又省掉「先画中文再闪成英文」。四条边界就写在
 *     `fetch()` 里那段语言协商分支的上方；设计稿 `docs/plans/2026-10-08-website-i18n.md` §9。
 *     ⚠️ **`Vary: Accept-Language` 是这条规则的一部分，不是可选项** —— 同一个 `/` 的响应随该
 *     头而变，少了它 CDN 会把中文那份 200 回给英文访客（跳转直接失效）。
 *
 * 缓存注意：改写走的是**另一个 URL**（`/docs` → `/docs.md`），所以边缘缓存天然按路径分开，
 * 不会把 markdown 回给浏览器；`vary: Accept` 仍写上，把「同一 URL 两种表示」这件事说清楚。
 */

/** 无扩展名的单段/多段页面路径（`/`、`/docs`、`/api`、`/playground`） */
const PAGE_PATH = /^\/[^.]*$/;

/**
 * `Accept-Language` → 访客想读哪一版。三态：`'zh'`（含中文）/ `'en'`（明确非中文）/
 * `'unknown'`（拿不到可判的信息）。**只有 `'en'` 触发跳转** —— 与旧客户端脚本同一条纪律：
 * 「拿不到就不猜」，宁可停在默认的中文版。
 *
 * 刻意**不解析 `q` 权重**：本站只有「中文 vs 非中文」两分，权重排序影响不到结论，
 * 解析它只会多一段会腐烂的代码（只认「有没有中文标签」+「有没有一个像语言标签的项」）。
 */
function languagePreference(header) {
  const tags = (header ?? '')
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase())
    .filter(Boolean);
  // `zh` / `zh-CN` / `zh-Hant-TW` 都算中文（`\b` 落在 `h` 与 `-` 或串尾之间）
  if (tags.some((t) => /^zh\b/.test(t))) return 'zh';
  // 「知道点什么」才敢跳：至少要有一个**像语言标签**的项（`*`、垃圾串不算）
  return tags.some((t) => /^[a-z]{2,3}\b/.test(t)) ? 'en' : 'unknown';
}

/** 取本站的语言选择 cookie（`hl=zh` / `hl=en`），其它一律 `undefined`。 */
function explicitLanguage(cookieHeader) {
  const m = /(?:^|;\s*)hl=(zh|en)(?:;|\s|$)/.exec(cookieHeader ?? '');
  return m ? m[1] : undefined;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      // 见边界 ④：英文首页的产物是扁平的 en.html ⇒ 把目录形态收敛到它
      if (url.pathname === '/en/') {
        // query 与 hash 必须带过 308：Base.astro 的检测脚本跳转就保留了它们
        // （location.replace(target + location.search + location.hash)），两边口径必须一致 ——
        // 丢掉的话 /en/?from=x 这类带参入口会被剥光参数。
        // （hash 本来到不了服务器，但 Request/测试里的 URL 可以带它，口径上一起保。）
        const target = new URL('/en', url);
        target.search = url.search;
        target.hash = url.hash;
        // 显式构造而不是 `Response.redirect()`：后者只给一个 `location` 头、
        // 不带任何 cache 头（实测 Node 与 workerd 都是 `[['location', …]]`）——
        // 那正好是 AFDocs 的 cache-header-hygiene 说的「missing cache headers」形态。
        return new Response(null, {
          status: 308,
          headers: {
            location: target.href,
            // 取值与站内其余响应**同一档**（不是为这条特殊挑的）：全站统一成
            // 「可 revalidate」比给一条 308 单独调一个 max-age 更好推理；
            // 长 max-age 也不是选项 —— 这条规则将来若改形态，访客不该被钉在旧跳转上。
            'cache-control': 'public, max-age=0, must-revalidate',
          },
        });
      }
      // 媒体类型按 RFC 9110 大小写不敏感（`Text/Markdown` 与 `text/markdown` 同义）⇒ 先归一
      const wantsMarkdown = (request.headers.get('accept') ?? '')
        .toLowerCase()
        .includes('text/markdown');

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

      // ── 语言协商（见边界 ⑤）：按 Accept-Language 把中文路径 302 到 /en ────────────
      //
      // ⚠️ 四条边界（改之前先读，设计稿 §9.3）：
      //   ① **只从中文路径跳到 `/en`，不反向。** `/en` 是目标本体、永不拦 —— 否则英文页会在
      //      「中文偏好」的访客上被弹回 `/`，多一条跳转路径就多一个循环面（也正是下面
      //      「显式选择优先」那把锁存在的理由）。代价如实标注：中文偏好访客循外链落到 `/en`
      //      时**不会**被送回 `/`（旧客户端脚本会）—— 这是有意收窄。
      //   ② **只在非 markdown 请求上做。** 带 `Accept: text/markdown` 的 agent 要的是「我请求的
      //      那个 URL」的 markdown；替他改道会让内容协商不可预测。所以这一段排在 md 分支**之后**。
      //   ③ **显式选择优先于自动检测。** cookie `hl=zh` ⇒ 不跳（这把锁防的就是循环：英文浏览器
      //      点「中」→ 落 `/`，若自动检测又弹回 `/en`，用户就出不来了）；`hl=en` ⇒ 跳；
      //      两者都没有才看 `Accept-Language`。cookie 由 `Nav.astro` 的中 / EN 切换控件写。
      //   ④ **只处理 GET / HEAD**（对其它方法回 302 会篡改语义），且**不加长 `max-age`**
      //      （与站内其余响应同一档）。
      //
      // `Vary: Accept-Language` **必须**带上：同一个 `/` 的响应随该请求头而变，少了它 CDN 会把
      // 中文那份 200 回给英文访客（跳转直接失效）。代价是这两条 URL 的边缘命中率下降
      // （每语言各存一份）—— 已知并接受的取舍。
      const isEnPath = url.pathname === '/en' || url.pathname.startsWith('/en/');
      const isGetOrHead = request.method === 'GET' || request.method === 'HEAD';
      if (!wantsMarkdown && isPagePath && !isEnPath && isGetOrHead) {
        const explicit = explicitLanguage(request.headers.get('cookie'));
        // 显式选择优先：`hl` 在场就听它的，否则用 Accept-Language 的判定
        const wantEn = explicit
          ? explicit === 'en'
          : languagePreference(request.headers.get('accept-language')) === 'en';
        if (wantEn) {
          const target = (url.pathname === '/' ? '/en' : `/en${url.pathname}`) + url.search;
          return new Response(null, {
            status: 302,
            headers: {
              location: new URL(target, url).href,
              'cache-control': 'public, max-age=0, must-revalidate',
              vary: 'Accept-Language',
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
