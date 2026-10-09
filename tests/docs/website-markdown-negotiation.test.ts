import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `Accept: text/markdown` 内容协商（`packages/website/public/_worker.js`，Pages advanced mode）。
 *
 * 为什么值得钉：这个 worker 一旦抛错，**整站**（含 robots / sitemap / 首页）都会 500 ——
 * 「给 agent 补一个 markdown 变体」这级改动不该有把官网打挂的威力。而它在构建里完全不执行，
 * 单测与全链都看不见它。所以这里把真源码拿进来、喂假 `env.ASSETS` 真跑：
 *   · 该改写的改写（含 content-type 与 vary）
 *   · 不该碰的一律原样透传（有扩展名的路径、没 .md 变体的路径、无该请求头的普通访问）
 *   · 协商失败/抛异常 → 退回静态资产，**绝不把 404 变成 200、也不把请求打成 500**
 *   · `/en/` → `/en` 那条例外规则（边界 ④）的状态码 / 目标 / **缓存头** ——
 *     它当初就是因为「Pages 自己那条 308 与 `Response.redirect()` 都不带 cache 头」
 *     才由我们接手的，所以缓存头是这条规则的**存在理由**，不能只核个状态码。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const WORKER = join(repoRoot, 'packages', 'website', 'public', '_worker.js');

type AssetsCall = { url: string; method: string };
type WorkerMod = {
  default: {
    fetch(
      request: Request,
      env: { ASSETS: { fetch(r: Request): Promise<Response> } },
    ): Promise<Response>;
  };
};

const worker = ((await import(pathToFileURL(WORKER).href)) as unknown as WorkerMod).default;

/** 假 ASSETS：记下每次请求的 URL，返回可指定的响应 */
function fakeEnv(respond: (url: string, req: Request) => Response) {
  const calls: AssetsCall[] = [];
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(req: Request) {
          const url = new URL(req.url).pathname;
          calls.push({ url, method: req.method });
          return respond(url, req);
        },
      },
    },
  };
}

const ok = (type: string, body = '# hi\n\nsome markdown body') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

const get = (path: string, accept?: string) =>
  new Request(`https://agentia-web.pages.dev${path}`, {
    headers: accept ? { accept } : {},
  });

describe('官网内容协商：_worker.js', () => {
  it('带 Accept: text/markdown 命中 .md 变体，并给出正确的 content-type 与 vary', async () => {
    const { env, calls } = fakeEnv(() => ok('text/markdown; charset=utf-8'));
    const res = await worker.fetch(get('/docs', 'text/markdown'), env);
    assert.deepEqual(calls, [{ url: '/docs.md', method: 'GET' }], '没有改写到 .md');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(res.headers.get('vary'), 'Accept');
  });

  it('根路径改写到 /index.md（打分器给根页的候选就是这个）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/markdown'));
    await worker.fetch(get('/', 'text/markdown'), env);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/index.md'],
    );
  });

  it('Accept 里混着其它类型也能命中（真实浏览器/agent 的形态）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/markdown'));
    await worker.fetch(get('/api', 'text/markdown, text/html;q=0.9, */*;q=0.8'), env);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/api.md'],
    );
  });

  it('媒体类型大小写不敏感（RFC 9110）：Text/Markdown 同样命中', async () => {
    const { env, calls } = fakeEnv(() => ok('text/markdown'));
    await worker.fetch(get('/docs', 'Text/Markdown, text/html;q=0.9'), env);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/docs.md'],
    );
  });

  it('改写字面量协商的请求头带过去（HEAD 只判类型，必须照旧是 HEAD）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/markdown'));
    const req = new Request('https://agentia-web.pages.dev/docs', {
      method: 'HEAD',
      headers: { accept: 'text/markdown' },
    });
    const res = await worker.fetch(req, env);
    assert.deepEqual(calls, [{ url: '/docs.md', method: 'HEAD' }]);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  });

  it('没有该请求头 ⇒ 原样透传（浏览器/爬虫拿到的还是 HTML）', async () => {
    const original = ok('text/html; charset=utf-8', '<html>hi</html>');
    const { env, calls } = fakeEnv(() => original);
    const res = await worker.fetch(get('/docs'), env);
    assert.deepEqual(calls, [{ url: '/docs', method: 'GET' }], '不带请求头也被改写了');
    assert.equal(res, original, '透传的响应被重建了（会丢掉边缘缓存的头）');
  });

  it('/llms.txt 这类有扩展名的路径永不改写', async () => {
    for (const p of [
      '/llms.txt',
      '/llms-full.txt',
      '/robots.txt',
      '/sitemap.xml',
      '/favicon.svg',
    ]) {
      const { env, calls } = fakeEnv(() => ok('text/plain'));
      await worker.fetch(get(p, 'text/markdown'), env);
      assert.deepEqual(
        calls.map((c) => c.url),
        [p],
        `${p} 被改写了`,
      );
    }
  });

  it('尾部斜杠路径不改写（避免 /docs/.md 这种不存在的形态）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/html'));
    await worker.fetch(get('/docs/', 'text/markdown'), env);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/docs/'],
    );
  });

  // ── 边界 ④：`/en/` → `/en`（2026-10-08 官网英文版）──────────────────────
  //
  // 为什么值得单独钉：这条 308 是**我们**发、而不是交给 Pages 自己那条规范化的，
  // 全部理由就在响应头（见 _worker.js 边界 ④）。所以判据除了状态码与目标，
  // 必须**含缓存头** —— 少了这一条，把实现换回 `Response.redirect()` 也不会红，
  // 而那正是会退化成「裸 308」的那一步。
  it('/en/ 由我们 308 到 /en，且带着缓存头（不交给 Pages 的裸 308）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/html'));
    const res = await worker.fetch(get('/en/'), env);
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('location'), 'https://agentia-web.pages.dev/en');
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=0, must-revalidate',
      '这条 308 丢了缓存头 —— Pages 自己那条 308 与 Response.redirect() 都不带，' +
        '接手它的理由就是补上这个头',
    );
    assert.deepEqual(calls, [], '/en/ 是我们的规则负责的，不该再去问静态资产');
  });

  it('/en/ 的规范化与 Accept 无关（带 text/markdown 也是 308，不会给 .md）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/markdown'));
    const res = await worker.fetch(get('/en/', 'text/markdown'), env);
    assert.equal(res.status, 308);
    assert.deepEqual(calls, [], '规范化没做，反而去协商了 markdown');
  });

  it('/en/ 的 308 保留 query 与 hash（与 Base.astro 检测脚本的跳转同口径）', async () => {
    const { env, calls } = fakeEnv(() => ok('text/html'));
    const res = await worker.fetch(get('/en/?from=x#frag'), env);
    assert.equal(res.status, 308);
    assert.equal(
      res.headers.get('location'),
      'https://agentia-web.pages.dev/en?from=x#frag',
      '308 丢了 query/hash —— Base.astro 的检测脚本跳转是带上它们的，两边口径必须一致',
    );
    assert.deepEqual(calls, [], '/en/ 是我们的规则负责的，不该再去问静态资产');
  });

  it('/en（无尾斜杠）不拦：它是英文首页本体，必须原样透传', async () => {
    const html = ok('text/html; charset=utf-8', '<html>en</html>');
    const { env, calls } = fakeEnv(() => html);
    const res = await worker.fetch(get('/en'), env);
    assert.equal(res, html, '/en 被拦了 —— 它是英文首页本体，不是待规范化的目录形态');
    assert.deepEqual(calls, [{ url: '/en', method: 'GET' }]);
  });

  it('没有 .md 变体 ⇒ 退回原样：404 仍是 404，绝不变成 200', async () => {
    const notFound = new Response('<html>404</html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
    const { env, calls } = fakeEnv((url) =>
      url.endsWith('.md') ? new Response('nope', { status: 404 }) : notFound,
    );
    const res = await worker.fetch(get('/nope', 'text/markdown'), env);
    assert.equal(res.status, 404);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/nope.md', '/nope'],
      '失败后没有回退到原始路径',
    );
  });

  it('取 .md 时抛异常 ⇒ 退回静态资产，不把整站打成 500', async () => {
    const html = ok('text/html; charset=utf-8', '<html>hi</html>');
    const { env, calls } = fakeEnv((url) => {
      if (url.endsWith('.md')) throw new Error('boom');
      return html;
    });
    const res = await worker.fetch(get('/docs', 'text/markdown'), env);
    assert.equal(res, html, '异常路径没有回退到静态资产');
    assert.deepEqual(
      calls.map((c) => c.url),
      ['/docs.md', '/docs'],
    );
  });
});
