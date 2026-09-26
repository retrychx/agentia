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
