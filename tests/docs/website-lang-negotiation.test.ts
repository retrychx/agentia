import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 服务端语言协商（`packages/website/public/_worker.js`，Pages **advanced mode**）—— 2026-10-09。
 *
 * 为什么值得单独钉：这一段是**代替**客户端 `location.replace` 的（见 `Base.astro` 与设计稿
 * `docs/plans/2026-10-08-website-i18n.md` §9）—— 它决定「英文访客进站看到哪一版」，而且
 * **跑在构建之外**：单测与产物守卫都看不见它，只有**真跑**才看得见。
 *
 * 更要紧的是它是**全站唯一可能把访客关进循环**的一段：英文浏览器点「中」→ 落 `/` → 若服务端
 * 又按 `Accept-Language` 把他弹回 `/en`，用户就**出不来**了 ⇒ 「显式选择优先」那把锁必须在场。
 *
 * 覆盖用户点名的五条 + 一圈「不回归」：
 *   ① `hl=zh` 时 `/` 不跳；② 无 cookie + `Accept-Language: en` ⇒ `/` 302 到 `/en`；
 *   ③ `Accept-Language: zh-CN` 时 `/` 不跳；④ `/en`（本体）不被拦；
 *   ⑤ 手动切换后不再被弹回（上一条循环的回归）。
 * 外加：`Vary` / `cache-control` / query 保留 / 只 GET·HEAD / `/en/` 308 与内容协商不回归。
 *
 * ⚠️ 射程（如实标注）：本文件只管**服务端那一半**。Nav 有没有把 cookie 写下去由
 * `tests/docs/website-i18n.test.ts` 的源码断言守 —— 两者合起来才是「切过去就不再弹回」的完整链。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const WORKER = join(repoRoot, 'packages', 'website', 'public', '_worker.js');

type WorkerMod = {
  default: {
    fetch(
      request: Request,
      env: { ASSETS: { fetch(r: Request): Promise<Response> } },
    ): Promise<Response>;
  };
};

const worker = ((await import(pathToFileURL(WORKER).href)) as unknown as WorkerMod).default;

/** 假 ASSETS：记下每次被问到的 pathname，返回可指定的响应 */
function fakeEnv(respond: (url: string, req: Request) => Response) {
  const calls: string[] = [];
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(req: Request) {
          const url = new URL(req.url).pathname;
          calls.push(url);
          return respond(url, req);
        },
      },
    },
  };
}

const zhHtml = () =>
  new Response('<html lang="zh-CN">zh</html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://agentia-web.pages.dev${path}`, { headers });

describe('官网服务端语言协商：_worker.js', () => {
  it('无 cookie + Accept-Language: en ⇒ / 302 到 /en（HTTP 跳转，不是 JS）', async () => {
    const { env, calls } = fakeEnv(zhHtml);
    const res = await worker.fetch(get('/', { 'accept-language': 'en-US,en;q=0.9' }), env);
    assert.equal(res.status, 302, '英文访客的 / 没有 302 —— 客户端脚本删了之后靠它');
    assert.equal(res.headers.get('location'), 'https://agentia-web.pages.dev/en');
    assert.deepEqual(calls, [], '语言跳转是我们自己的规则，不该再去问静态资产');
  });

  it('这条 302 必须带 Vary: Accept-Language 与站内统一缓存头', async () => {
    const { env } = fakeEnv(zhHtml);
    const res = await worker.fetch(get('/', { 'accept-language': 'en' }), env);
    assert.equal(
      res.headers.get('vary'),
      'Accept-Language',
      '少了 Vary，CDN 会把中文那份 200 回给英文访客 —— 跳转直接失效（它是这条规则的一部分）',
    );
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=0, must-revalidate',
      '302 不该单独挑一个 max-age（长 max-age 会把访客钉在旧跳转上）',
    );
  });

  it('Accept-Language: zh-CN ⇒ / 不跳（中文版本体）', async () => {
    const { env, calls } = fakeEnv(zhHtml);
    const res = await worker.fetch(get('/', { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }), env);
    assert.equal(res.status, 200, '中文偏好的访客被跳走了');
    assert.deepEqual(calls, ['/']);
  });

  it('拿不到可判语言（缺头 / `*` / 垃圾串）⇒ 不跳（宁可停在默认中文版，也不猜）', async () => {
    for (const h of [{}, { 'accept-language': '*' }, { 'accept-language': ',,;q=0.5' }]) {
      const { env, calls } = fakeEnv(zhHtml);
      const res = await worker.fetch(get('/', h), env);
      assert.equal(res.status, 200, `Accept-Language=${JSON.stringify(h)} 被误判成英文`);
      assert.deepEqual(calls, ['/']);
    }
  });

  it('显式选择优先：hl=zh ⇒ 永不跳（哪怕 Accept-Language: en）—— 这条防的就是循环', async () => {
    // 回归场景：英文浏览器点「中」→ Nav 写 hl=zh → 落 `/`。
    // 若这里仍按 Accept-Language 跳到 /en，用户会被「弹回去」，永远出不来。
    const { env, calls } = fakeEnv(zhHtml);
    const res = await worker.fetch(
      get('/', { cookie: 'hl=zh', 'accept-language': 'en-US,en;q=0.9' }),
      env,
    );
    assert.equal(res.status, 200, '手动切回中文后又被自动跳转弹回去了 —— 循环回来了');
    assert.deepEqual(calls, ['/']);
  });

  it('显式选择优先：hl=en ⇒ 跳（哪怕 Accept-Language: zh-CN）', async () => {
    const { env } = fakeEnv(zhHtml);
    const res = await worker.fetch(get('/', { cookie: 'hl=en', 'accept-language': 'zh-CN' }), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://agentia-web.pages.dev/en');
  });

  it('英文偏好下深层页也跳：/docs ⇒ 302 到 /en/docs，且保留 query', async () => {
    const { env, calls } = fakeEnv(zhHtml);
    const res = await worker.fetch(get('/docs?from=nav', { 'accept-language': 'en' }), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://agentia-web.pages.dev/en/docs?from=nav');
    assert.deepEqual(calls, []);
  });

  it('/en（英文首页本体）不被拦：原样透传，语言规则不做反向跳转', async () => {
    const html = new Response('<html lang="en">en</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const { env, calls } = fakeEnv(() => html);
    const res = await worker.fetch(get('/en', { 'accept-language': 'en' }), env);
    assert.equal(res, html, '/en 被拦了 —— 它是英文首页本体，语言规则不该碰它');
    assert.deepEqual(calls, ['/en']);
  });

  it('只处理 GET / HEAD：POST 不做语言跳转（回 302 会篡改语义）', async () => {
    const { env, calls } = fakeEnv(zhHtml);
    const req = new Request('https://agentia-web.pages.dev/', {
      method: 'POST',
      headers: { 'accept-language': 'en' },
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['/']);
  });

  it('markdown 请求不走语言跳转（agent 拿到它要的那个 URL 的 .md / 或原样页面）', async () => {
    // ① `.md` 在场 ⇒ 给 `.md`（根本不进语言分支）
    const hit = fakeEnv(
      () => new Response('# hi', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );
    const res1 = await worker.fetch(
      get('/docs', { 'accept-language': 'en', accept: 'text/markdown' }),
      hit.env,
    );
    assert.equal(res1.status, 200);
    assert.deepEqual(hit.calls, ['/docs.md'], '语言规则抢在内容协商前面了');

    // ② `.md` 缺席 ⇒ 按原样回退到**那个 URL** 的页面，而**不是** 302 到 `/en/docs`
    //    （这条才真正压到「非 markdown」那道闸：① 那条走不到它，`.md` 分支先 return 了）
    const html = zhHtml();
    const miss = fakeEnv((url) =>
      url.endsWith('.md') ? new Response('nope', { status: 404 }) : html,
    );
    const res2 = await worker.fetch(
      get('/docs', { 'accept-language': 'en', accept: 'text/markdown' }),
      miss.env,
    );
    assert.equal(res2.status, 200, 'agent 的 markdown 请求被语言规则改道了');
    assert.equal(res2, html);
    assert.deepEqual(miss.calls, ['/docs.md', '/docs']);
  });

  it('不破坏既有两条规则：/en/ 仍 308，且无语言头的普通访问仍原样透传', async () => {
    const { env, calls } = fakeEnv(zhHtml);
    const norm = await worker.fetch(get('/en/'), env);
    assert.equal(norm.status, 308);
    assert.equal(norm.headers.get('location'), 'https://agentia-web.pages.dev/en');
    assert.deepEqual(calls, [], '/en/ 规范化被语言规则截胡了');

    const html = zhHtml();
    const { env: env2, calls: calls2 } = fakeEnv(() => html);
    const passthrough = await worker.fetch(get('/docs'), env2);
    assert.equal(passthrough, html, '无 Accept-Language 的普通访问被重建了响应（会丢边缘缓存头）');
    assert.deepEqual(calls2, ['/docs']);
  });
});
