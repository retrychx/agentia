import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（inspector 的静态资源在 dist/inspector，src 下没有）。
 * 未构建时跳过而非报错 —— 免得只跑 npm test 的人卡在构建前置上。 */
const DIST = fileURLToPath(new URL('../dist/inspector.js', import.meta.url));
let startInspector = null;
let HttpError = null;
if (existsSync(DIST)) {
  ({ startInspector, HttpError } = await import(
    new URL('../dist/inspector.js', import.meta.url).href
  ));
}
const SKIP = !startInspector ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

const sample = (id) => ({
  traceId: id,
  status: 'ok',
  totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  spans: [
    {
      spanId: 'r',
      parentSpanId: null,
      kind: 'run',
      name: 'demo',
      startedAt: 0,
      endedAt: 100,
      status: 'ok',
    },
    {
      spanId: 't',
      parentSpanId: 'r',
      kind: 'llm.turn',
      name: 'm',
      startedAt: 5,
      endedAt: 50,
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
      events: [{ time: 6, name: 'tool.input', body: { tool: 'echo', input: { a: 1 } } }],
    },
  ],
});

/** 带会话根的 trace：run 根 span 的 `session.id` 是 D6 那个 join 的键 */
const sampleWithSession = (id, sessionId) => {
  const t = sample(id);
  t.spans[0].attributes = { 'session.id': sessionId };
  return t;
};

const post = (base, path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 用 node:http 发请求 —— fetch 把 Host / Origin 列为禁改头（会被静默丢掉），伪造不了 */
const raw = (port, { method = 'GET', path = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });

describe('inspector 服务', () => {
  it('ingest → 列表 → 单条；面板与静态资源可访问', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;

      assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), [], '初始为空');

      assert.equal((await post(base, '/ingest', sample('t1'))).status, 200);

      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].traceId, 't1');
      assert.equal(list[0].tokens, 15, 'input+output 汇总');
      assert.equal(list[0].ms, 100, 'run 根耗时');
      assert.equal(list[0].ok, true);

      const one = await (await fetch(`${base}/api/runs/t1`)).json();
      assert.equal(one.spans.length, 2, '返回完整 trace');

      assert.match(await (await fetch(`${base}/`)).text(), /Agentia Inspector/);
      assert.match(await (await fetch(`${base}/index.js`)).text(), /playTrace|createTraceView/);
      assert.match(await (await fetch(`${base}/trace-view.css`)).text(), /\.tr-row/);

      assert.equal((await post(base, '/ingest', {})).status, 400, '无 traceId → 400');
      assert.equal((await fetch(`${base}/api/runs/nope`)).status, 404, '未知 run → 404');
    } finally {
      await srv.close();
    }
  });

  it('Host 校验：非本机 Host 一律 403（防 DNS rebinding）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      // fetch 规范把 host 列为禁改头（会被静默丢掉），这里用 node:http 才能真的伪造 Host
      const withHost = (host, method = 'GET', path = '/api/runs', body) =>
        new Promise((resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port: srv.port, method, path, headers: { host } },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      assert.equal(await withHost('evil.example.com'), 403, '外部 Host → 403');
      assert.equal(
        await withHost('10.0.0.9', 'POST', '/ingest', JSON.stringify(sample('h1'))),
        403,
        'ingest 同样被 Host 校验拦住',
      );
      assert.equal(await withHost('localhost'), 200, 'localhost Host 放行');
      assert.equal(await withHost('127.0.0.1:' + srv.port), 200, '带端口的本机 Host 放行');
    } finally {
      await srv.close();
    }
  });

  it('入站校验收紧：spans 非数组 / 缺 startedAt → 400，不进列表', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const bad1 = { traceId: 'b1', spans: 'nope' };
      assert.equal((await post(base, '/ingest', bad1)).status, 400, 'spans 非数组 → 400');
      const bad2 = {
        traceId: 'b2',
        spans: [{ spanId: 'r', parentSpanId: null, kind: 'run', name: 'x' }],
      };
      const res2 = await post(base, '/ingest', bad2);
      assert.equal(res2.status, 400, '缺 startedAt → 400（否则 ms 是 NaN 并被广播）');
      assert.match((await res2.json()).error, /startedAt/);
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 0, '非法 trace 不入库');
    } finally {
      await srv.close();
    }
  });

  it('面板页面不含 innerHTML 拼接 SSE 数据（s.name 是模型可控内容）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const page = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      assert.ok(!page.includes('liveEl.innerHTML'), 'SSE 分支必须走 textContent，不得拼 innerHTML');
    } finally {
      await srv.close();
    }
  });

  it('环形缓冲：超过上限淘汰最旧，最新的在前', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      for (let i = 0; i < 55; i++) await post(base, '/ingest', sample('r' + i));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 50, '上限 50');
      assert.equal(list[0].traceId, 'r54', '最新的在前');
      assert.ok(!list.some((x) => x.traceId === 'r0'), '最旧的已淘汰');
    } finally {
      await srv.close();
    }
  });

  it('SSE /stream：新 run 到达即推一条摘要', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}/stream`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      await post(base, '/ingest', sample('s1'));
      let buf = '';
      const deadline = Date.now() + 3000;
      while (!/s1/.test(buf) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      assert.match(buf, /"traceId":"s1"/, 'SSE 收到新 run 摘要');
      await reader.cancel();
    } finally {
      await srv.close();
    }
  });

  it('CLI 侧记账：noteRun 后摘要带上目标目录与能力组合（读时合并，不假设到达顺序）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // 先记账、后 ingest —— 两条路都经进程内调用，**顺序不该被假设**（这里刻意反着来）
      srv.noteRun('n1', {
        prompt: 'review 一下',
        workdir: '/w/proj',
        toolSources: ['code-review'],
        multiTurn: false,
      });
      await post(base, '/ingest', sample('n1'));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list[0].note.workdir, '/w/proj', 'run 列表要能显示这次动的哪棵树');
      assert.deepEqual(list[0].note.toolSources, ['code-review']);
      // 没有记账的 run（不是 dev 起的）note 为 null，不是 undefined —— 面板据此不渲染那一行
      await post(base, '/ingest', sample('n2'));
      const list2 = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list2[0].note, null, '非 dev 起的 run 没有记账');
    } finally {
      await srv.close();
    }
  });

  it('会话键：run 根 span 的 session.id 上到摘要（D6 那个 join 的键）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      await post(base, '/ingest', sampleWithSession('c1', 'dev'));
      await post(base, '/ingest', sample('c2'));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.find((r) => r.traceId === 'c1').sessionId, 'dev');
      assert.equal(list.find((r) => r.traceId === 'c2').sessionId, null, '没开会话的 run 为 null');
    } finally {
      await srv.close();
    }
  });
});

/**
 * 鉴权（D0）。两道：`Origin` 校验 + per-session token。
 *
 * ⚠️ 这一组必须**带 token** 起服务 —— 不带 token 的 `startInspector()` 是不校验的
 * （留给测试与程序内自用），而 `agentia dev` 一律带。
 */
describe('inspector 鉴权（Origin + token）', { skip: SKIP }, () => {
  const TOKEN = 'tok-abcdef0123456789';

  it('Origin 校验：跨源一律 403（这正是 CSRF 那半条），本机 origin 与缺省放行', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector({ token: TOKEN });
    try {
      const q = `?t=${TOKEN}`;
      assert.equal(
        (
          await raw(srv.port, {
            path: `/api/runs${q}`,
            headers: { origin: 'https://evil.example' },
          })
        ).status,
        403,
        '跨源 Origin → 403（浏览器跨源 fetch 必带 Origin，这半条挡住了任意网页打本地端口）',
      );
      assert.equal(
        (await raw(srv.port, { path: `/api/runs${q}`, headers: { origin: 'null' } })).status,
        403,
        'Origin: null（sandboxed iframe / file://）是浏览器明说的不可信上下文，必须拒',
      );
      assert.equal(
        (
          await raw(srv.port, {
            path: `/api/runs${q}`,
            headers: { origin: 'http://localhost:5173' },
          })
        ).status,
        200,
        '本机 origin 放行',
      );
      assert.equal(
        (await raw(srv.port, { path: `/api/runs${q}` })).status,
        200,
        '缺省 Origin 放行（同源导航与非浏览器客户端）',
      );
    } finally {
      await srv.close();
    }
  });

  it('token 覆盖**所有**接口：缺 token 一律 403，三种携带方式都认', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector({ token: TOKEN });
    try {
      // 读接口也要挡 —— 本机任意网页同样不该读得到 trace 内容，而校验成本为零
      for (const path of ['/api/runs', '/api/dev', '/', '/index.js']) {
        const r = await raw(srv.port, { path });
        assert.equal(r.status, 403, `${path} 缺 token 应 403`);
        assert.match(r.text, /token/, `${path} 的 403 要说清是缺 token（可诊断，不是干瞪眼）`);
      }
      assert.equal(
        (
          await raw(srv.port, {
            method: 'POST',
            path: '/ingest',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        403,
        '写接口同样挡',
      );
      // 三种携带方式：URL query（面板首帧）/ 自定义头（脚本、preload）/ cookie（面板后续请求）
      assert.equal((await raw(srv.port, { path: `/api/runs?t=${TOKEN}` })).status, 200, 'query');
      assert.equal(
        (await raw(srv.port, { path: '/api/runs', headers: { 'x-agentia-token': TOKEN } })).status,
        200,
        '自定义头',
      );
      assert.equal(
        (
          await raw(srv.port, {
            path: '/api/runs',
            headers: { cookie: `agentia_dev_token=${TOKEN}` },
          })
        ).status,
        200,
        'cookie',
      );
      assert.equal(
        (await raw(srv.port, { path: '/api/runs?t=wrong-token-value' })).status,
        403,
        '错 token → 403',
      );
    } finally {
      await srv.close();
    }
  });

  it('面板首帧带 ?t= 时种 cookie（token 不进 URL 历史、不进截图）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector({ token: TOKEN });
    try {
      const page = await raw(srv.port, { path: `/?t=${TOKEN}` });
      assert.equal(page.status, 200);
      const cookie = page.headers['set-cookie']?.[0] ?? '';
      assert.match(cookie, /agentia_dev_token=/);
      assert.match(cookie, /HttpOnly/, 'HttpOnly：面板 JS 读不到它');
      assert.match(cookie, /SameSite=Strict/, 'SameSite=Strict：跨站请求不带');
      // 不带 ?t= 的页面请求（靠 cookie）也放行；不带 cookie 则 403
      assert.equal(
        (await raw(srv.port, { path: '/', headers: { cookie: `agentia_dev_token=${TOKEN}` } }))
          .status,
        200,
      );
      assert.equal((await raw(srv.port, { path: '/' })).status, 403);
      // 不带 token 起服务时不种 cookie（没有可种的）
      const open = await startInspector();
      try {
        const p = await raw(open.port, { path: '/' });
        assert.equal(p.status, 200);
        assert.equal(p.headers['set-cookie'], undefined);
      } finally {
        await open.close();
      }
    } finally {
      await srv.close();
    }
  });

  it('面板逻辑模块可静态取到，且页面 import 的每个名字都真的导出', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      // 页面必须真的引用它们 —— 否则「抽出来」只是抽了、没接上
      const page = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();

      // 反向全覆盖：面板 import 的**每个自建模块**（都在 dist 根、都由本仓编译）里，
      // 页面写进 import 列表的每个名字都必须是该模块的真导出。
      // 为什么要钉：浏览器里「import 一个不存在的导出」是**整块模块求值失败** ——
      // 面板直接白屏，而 node 侧的单测照样全绿（它们各自 import 自己要用的名字）。
      for (const file of ['panel-logic.js', 'markdown.js']) {
        const res = await fetch(`http://127.0.0.1:${srv.port}/${file}`);
        assert.equal(res.status, 200, `面板要能静态取到 ${file}`);
        const src = await res.text();
        if (file === 'markdown.js') {
          // Markdown 解析器是**纯逻辑**：它按构造不产生 HTML，也不该碰 DOM。
          // 这条一红就说明有人把渲染塞进了解析器（安全前提的落点，见 src/markdown.ts 头注）。
          assert.doesNotMatch(
            src,
            /innerHTML|outerHTML|document\./,
            'markdown.js 不许出现 DOM / innerHTML —— 它只负责把正文解析成 token 树',
          );
        }
        const mod = await import(new URL(`../dist/${file}`, import.meta.url).href);
        const names = (
          new RegExp(`import \\{([^}]*)\\} from '\\./${file.replace('.', '\\.')}'`).exec(
            page,
          )?.[1] ?? ''
        )
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        assert.ok(names.length > 0, `没解析出页面 import ${file} 的名单（页面结构变了？）`);
        for (const n of names) {
          assert.ok(n in mod, `${file} 必须导出「${n}」—— 页面 import 了它（缺失 = 浏览器白屏）`);
        }
      }

      /* `./index.js`（trace-view）同一口径：页面 import 的四个符号
       * （createTraceView / playTrace / summarizeTrace / renderSummary）必须都是它的真导出。
       * 它在 dist/inspector/ 下（构建期从 packages/trace-view 拷入，零依赖 ESM），
       * 与上面同一做法：直接 import 构建产物、逐个符号点名。 */
      {
        const res = await fetch(`http://127.0.0.1:${srv.port}/index.js`);
        assert.equal(res.status, 200, '面板要能静态取到 index.js（trace-view）');
        const mod = await import(new URL('../dist/inspector/index.js', import.meta.url).href);
        const names = (/import \{([^}]*)\} from '\.\/index\.js'/.exec(page)?.[1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        assert.ok(names.length > 0, '没解析出页面 import index.js 的名单（页面结构变了？）');
        for (const n of names) {
          assert.ok(
            n in mod,
            `index.js（trace-view）必须导出「${n}」—— 页面 import 了它（缺失 = 浏览器白屏）`,
          );
        }
      }

      /* 中止语义的**接线**判据（2026-09-22 复核补）：判「这一轮失败了吗」必须走
       * `runIsFailure`，不能裸读 `r.ok`。引擎的 `abortedResult()` 刻意给已取消的 run 带
       * 结构化 error（取消不是失败，但原因要可查）⇒ 中止时 `ok === false`：裸读 ok 的两个
       * 表面会一起说谎 —— run 列表给红点、对话视图给红边「（这一轮失败了…）」，
       * 而同一个 run 的通知条写着「已中止」。上面那条 import 名单检查只保证「名字存在」，
       * 不保证「判断走的是它」，所以这条得单独钉。 */
      assert.match(page, /runIsFailure\(/, '面板必须用 runIsFailure 判「失败」，不能裸读 r.ok');
      assert.doesNotMatch(
        page,
        /'run' \+ \(r\.ok/,
        '面板不该再用 `r.ok` 直接决定红点（中止的 ok 也是 false ⇒ 会标成失败）',
      );

      /* 本轮（2026-09-22 复核 ②③①）三条同类接线判据 —— 都是「抽到 panel-logic 了，
       * 但页面必须真的走它」：抽出来不接上等于没抽（浏览器里没人替你发现）。
       * 单测覆盖 panel-logic 的规则本身，这里只钉接线。 */
      assert.match(
        page,
        /if \(!replyBelongsTo\(/,
        '自动 open() 清回复必须先过 replyBelongsTo —— 无条件清会把 run-done 刚写上去的回复擦掉（实测 17 ms）',
      );
      assert.match(
        page,
        /browseTarget\(/,
        '`浏览…` 必须走 browseTarget（否则又变回「开着时点它只是关掉」）',
      );
      assert.match(
        page,
        /promptAfterFilePick\(/,
        '选文件必须走 promptAfterFilePick（不许悄悄改用户已经写好的 prompt）',
      );
      assert.match(page, /kind === 'trace-event'/, '面板必须处理在飞的增量帧（① 实时右栏）');
      assert.match(
        page,
        /applyTraceEvent\(/,
        '在飞增量帧必须折回（applyTraceEvent），不能各写一套',
      );
      assert.match(
        page,
        /state\.live = null/,
        '收尾那份整棵 trace 到达后必须让在飞的那份作废（否则迟到的帧会把树重画成残缺的一棵）',
      );

      /* 2026-09-22 第二轮（Markdown 渲染 / 滚动分层 / 消息折叠）三条同类接线判据。 */
      assert.match(page, /renderMessage\(/, '模型正文（最终回复 / 助手轮）必须走 renderMessage');
      assert.match(
        page,
        /collapseDecision\(/,
        '折叠判定必须走 collapseDecision（纯逻辑、带单测）—— 不许在渲染层量高度',
      );
      assert.match(page, /md-toggle/, '长正文必须有明确的展开控件（在正文下方，不在行尾悬 caret）');
      assert.match(page, /md-clamped/, '折叠态必须真的把正文卡住');
      // 模型正文**一个字节都不许进 innerHTML**：页面里对 innerHTML 的赋值只该有 renderSummary 那一处
      // （summary.js 自己 escape 了）。这条是安全前提的守卫，比「某个变量名没出现」强。
      const innerHtmlAssigns = page.split('\n').filter((l) => /\.innerHTML\s*=/.test(l));
      assert.equal(
        innerHtmlAssigns.length,
        1,
        `页面里对 innerHTML 的赋值只该有 renderSummary 那一处 —— 实际 ${innerHtmlAssigns.length} 处：${innerHtmlAssigns.join(' | ')}`,
      );
      assert.match(
        innerHtmlAssigns[0],
        /renderSummary\(/,
        '唯一那处 innerHTML 必须是 renderSummary',
      );
      // 滚动分层：**整页不滚**（body 卡住），滚的是树（#trace 自己 overflow: auto）。
      // 内容一长就整页滚的话，「看树」与「读回复」会互相把对方推走。
      const css = page.replace(/\s+/g, ' ');
      assert.match(css, /body \{ overflow: hidden;/, '整页不该滚：body 必须 overflow: hidden');
      assert.match(
        css,
        /#trace \{[^}]*overflow: auto/,
        '#trace 必须是那个滚动区（overflow: auto）',
      );
      assert.match(page, /@media \(max-width: 860px\)/, '窄屏必须有单列回退（否则两栏都不可用）');
    } finally {
      await srv.close();
    }
  });
});

/**
 * dev 环的 HTTP 面（`POST /run` / `GET /api/dev` / `/api/fs` / `/api/session`）。
 * 用假钩子测 —— 本文件不该知道子进程、tsx、runner 的存在。
 */
describe('inspector 的 dev 环接口', { skip: SKIP }, () => {
  const mkDev = (over = {}) => {
    const calls = [];
    /** `POST /ingest-event` 转给钩子的那些增量事件（① 实时右栏） */
    const traceEvents = [];
    const dev = {
      state: () => ({
        available: true,
        projectRoot: '/w/proj',
        home: '/w',
        capabilities: ['a', 'b'],
        multiTurn: ['b'],
        warning: null,
        defaultWorkdir: '/w/proj',
        budget: { maxCostUsd: 1, maxTotalTokens: 200000 },
        running: false,
        lastError: null,
        sessionId: 'dev',
      }),
      run: async (req) => {
        calls.push(req);
        return { accepted: true, restarted: false };
      },
      session: async () => ({ messages: [{ role: 'user', content: 'hi' }] }),
      abort: async () => ({ accepted: true, escalated: false }),
      clearSession: async () => ({ sessionId: 'dev-2' }),
      traceEvent: (e) => traceEvents.push(e),
      ...over,
    };
    return { dev, calls, traceEvents };
  };

  it('没有 dev 钩子时：面板不显示输入条、/run 明确 503、目录浏览关闭', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const state = await (await fetch(`${base}/api/dev`)).json();
      assert.equal(
        state.available,
        false,
        '只读面板：available=false，面板据此隐藏输入条（不做空壳）',
      );
      assert.equal((await post(base, '/run', { prompt: 'x' })).status, 503, '没有 runner ⇒ 503');
      assert.equal(
        (
          await post(base, '/ingest-event', {
            seq: 1,
            type: 'span.event',
            spanId: 's',
            event: { name: 'x' },
          })
        ).status,
        503,
        '增量帧同样要 runner 在场才收（没有面板就没人消费它）',
      );
      assert.equal((await fetch(`${base}/api/fs?path=/tmp`)).status, 403, '只读面板不暴露文件树');
      assert.equal((await (await fetch(`${base}/api/session`)).json()).session, null);
    } finally {
      await srv.close();
    }
  });

  it('POST /run：校验 body，通过后交给钩子（202 + restarted）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev, calls } = mkDev();
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      assert.equal((await post(base, '/run', { prompt: '' })).status, 400, '空 prompt → 400');
      assert.equal((await post(base, '/run', { prompt: '  ' })).status, 400, '全空白 prompt → 400');
      assert.equal((await post(base, '/run', { prompt: 'x', toolSources: 'nope' })).status, 400);
      assert.equal((await post(base, '/run', { prompt: 'x', multiTurn: 'yes' })).status, 400);
      assert.equal((await post(base, '/run', { prompt: 'x', workdir: 7 })).status, 400);
      assert.equal((await post(base, '/run', {})).status, 400);
      const ok = await post(base, '/run', {
        prompt: ' review 一下 ',
        workdir: '/w/proj',
        toolSources: ['a'],
        multiTurn: true,
      });
      assert.equal(ok.status, 202, '受理（异步：run 结果经 SSE 回来）');
      assert.deepEqual(await ok.json(), { accepted: true, restarted: false });
      assert.deepEqual(calls, [
        { prompt: ' review 一下 ', workdir: '/w/proj', toolSources: ['a'], multiTurn: true },
      ]);
    } finally {
      await srv.close();
    }
  });

  it('钩子抛错时按其状态码回（409 在飞 / 400 目录不存在 / 500 兜底），不是一律 500', async (t) => {
    if (SKIP) return t.skip(SKIP);
    /* 三个出口各测一遍 —— 这里最容易出的错是「4xx 被吞成 500」：
     * 面板看到 500 会当成「服务器炸了」，而实际只是「你手快点了两下」或「路径写错了」。 */
    const cases = [
      [new HttpError(409, '上一次 run 还在跑'), 409, /还在跑/],
      [new HttpError(400, '工作目录不存在或不是文件夹：/nope'), 400, /工作目录不存在/],
      // 兜底：不带状态码的普通错误必须是 500 —— 不能把内部错误伪装成「你输错了」
      [new Error('炸了'), 500, /炸了/],
    ];
    for (const [err, status, re] of cases) {
      const { dev } = mkDev({
        run: async () => {
          throw err;
        },
      });
      const srv = await startInspector({ dev });
      try {
        const res = await post(`http://127.0.0.1:${srv.port}`, '/run', { prompt: 'x' });
        assert.equal(res.status, status, `${err.message} → ${status}`);
        assert.match((await res.json()).error, re);
      } finally {
        await srv.close();
      }
    }
  });

  it('/api/fs：目录 / 隐藏目录 / 文件分三类列，且不存在与「不是目录」都响亮报错', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev } = mkDev();
    const srv = await startInspector({ dev });
    const dir = mkdtempSync(join(tmpdir(), 'agentia-fs-'));
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      mkdirSync(join(dir, '.hidden'), { recursive: true });
      writeFileSync(join(dir, 'file.txt'), 'x');
      const base = `http://127.0.0.1:${srv.port}`;
      const ok = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir)}`)).json();
      assert.deepEqual(ok.dirs, ['sub'], '普通目录');
      assert.deepEqual(
        ok.dotDirs,
        ['.hidden'],
        '隐藏目录**单列**而不是过滤掉 —— 旧实现整批跳过，于是 ~/x/.y 这类目录根本点不进去',
      );
      assert.deepEqual(ok.files, ['file.txt'], '文件也要列（面板据此提供「选这个文件」）');
      assert.equal(ok.filesTruncated, false);
      assert.equal(ok.path, dir);
      assert.equal(ok.parent, dirname(dir));
      assert.equal(
        (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir + '/file.txt')}`)).status,
        400,
        '「不是文件夹」要响亮报错（工作目录只能是目录）',
      );
      assert.equal(
        (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir + '/nope')}`)).status,
        400,
        '不存在的目录要响亮报错 —— 静默回退会让 agent 对着错的目录乱写（D5）',
      );
      assert.equal((await fetch(`${base}/api/fs`)).status, 400, '缺 path → 400');
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /ingest-event：校验形状、转给钩子并广播（① 实时右栏）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev, traceEvents } = mkDev();
    const srv = await startInspector({ dev });
    // `dev.ts` 的钩子干的是「记一笔 + `emitDev({kind:'trace-event'})` 广播」；这里补上后半
    // （单测用的是假钩子，它自己不会广播）。**真实的那条**（runner → HTTP → 父进程 → SSE）
    // 由 e2e-dev 第 7-bis 步守 —— 这里只保证「/ingest-event 把帧交给了钩子」。
    dev.traceEvent = (e) => {
      traceEvents.push(e);
      srv.emitDev({ kind: 'trace-event', event: e });
    };
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const begin = {
        seq: 1,
        type: 'span.begin',
        span: {
          spanId: 'r',
          traceId: 'tr-1',
          parentSpanId: null,
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          status: 'ok',
          attributes: {},
          events: [],
        },
      };
      // 先连上 SSE，才能断言「广播出去了」而不只是「钩子被调了」
      const ac = new AbortController();
      const stream = await fetch(`${base}/stream`, { signal: ac.signal });
      const reader = stream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const frames = [];
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let cut = buf.indexOf('\n\n');
          while (cut >= 0) {
            frames.push(buf.slice(0, cut));
            buf = buf.slice(cut + 2);
            cut = buf.indexOf('\n\n');
          }
        }
      })();
      const waitFrame = async (needle, ms = 3000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (frames.some((f) => f.includes(needle))) return true;
          await new Promise((r) => setTimeout(r, 25));
        }
        return false;
      };

      assert.equal((await post(base, '/ingest-event', begin)).status, 202, '合法帧 → 202');
      assert.equal(traceEvents.length, 1, '帧应转给 dev 钩子（父进程只转发、不解释）');
      assert.ok(
        await waitFrame('"kind":"trace-event"'),
        `增量帧必须走 SSE 的 dev 命名事件广播给面板。收到的帧：${JSON.stringify(frames)}`,
      );

      // 坏帧一律 400：面板拿这些字段**直接建树**，缺字段的表现是「树上少一个节点」
      // 而不是任何报错 —— 那种症状只能在浏览器里查，所以入口就要拦住
      assert.equal((await post(base, '/ingest-event', { seq: 1 })).status, 400, '不认识的事件类型');
      assert.equal(
        (
          await post(base, '/ingest-event', {
            type: 'span.end',
            spanId: 'x',
            endedAt: 1,
            status: 'ok',
          })
        ).status,
        400,
        '缺 seq',
      );
      assert.equal(
        (
          await post(base, '/ingest-event', {
            seq: 2,
            type: 'span.end',
            spanId: 'x',
            endedAt: 0 / 0,
            status: 'ok',
          })
        ).status,
        400,
        'endedAt 是 NaN',
      );
      assert.equal(
        (await post(base, '/ingest-event', { seq: 3, type: 'span.begin', span: { spanId: 's' } }))
          .status,
        400,
        'span.begin 缺 traceId / name / startedAt',
      );
      assert.equal(
        (await post(base, '/ingest-event', { seq: 4, type: 'span.event', spanId: 's' })).status,
        400,
      );
      const res = await raw(srv.port, {
        method: 'POST',
        path: '/ingest-event',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      assert.equal(res.status, 400, 'body 不是 JSON → 400');
      assert.equal(traceEvents.length, 1, '坏帧一个都不该转给钩子');
      ac.abort();
      await pump.catch(() => {});
    } finally {
      await srv.close();
    }
  });

  it('/api/session 透传钩子结果；钩子抛错按其状态码回', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev } = mkDev();
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const body = await (await fetch(`${base}/api/session`)).json();
      assert.equal(body.session.messages.length, 1);
    } finally {
      await srv.close();
    }
    const { dev: bad } = mkDev({
      session: async () => {
        const e = new Error('会话文件不是合法 JSON');
        e.statusCode = 500;
        throw e;
      },
    });
    const srv2 = await startInspector({ dev: bad });
    try {
      const res = await fetch(`http://127.0.0.1:${srv2.port}/api/session`);
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /不是合法 JSON/);
    } finally {
      await srv2.close();
    }
  });

  it('SSE 的 dev 命名事件与 run 摘要（默认事件）互不干扰', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev } = mkDev();
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}/stream`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      srv.emitDev({ kind: 'runner-restart', reason: '文件变更：src/app.ts' });
      await post(base, '/ingest', sample('s9'));
      let buf = '';
      const deadline = Date.now() + 3000;
      while (
        !(buf.includes('event: dev') && buf.includes('"traceId":"s9"')) &&
        Date.now() < deadline
      ) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      assert.match(buf, /event: dev\ndata: \{"kind":"runner-restart"/, 'dev 事件带事件名');
      assert.match(buf, /"traceId":"s9"/, 'run 摘要仍走默认事件（老面板的 onmessage 照常工作）');
      await reader.cancel();
    } finally {
      await srv.close();
    }
  });

  /* §6 待定 5 的 kill 按钮（中止在飞 run）。三条要守：
   * ① 没有 dev 环 ⇒ 503（与 /run 同一口径，不假装成功）
   * ② 没有在飞 run ⇒ 钩子的 409 原样回（面板据此提示「当前没有在飞的 run」）
   * ③ 方法不对 ⇒ 404，**绝不落到钩子上**（GET 也能中止 run 就太吓人了） */
  it('POST /run/abort：503 / 409 / 202；且方法不对不落钩子', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const noDev = await startInspector();
    try {
      const res = await post(`http://127.0.0.1:${noDev.port}`, '/run/abort', {});
      assert.equal(res.status, 503, '只读面板没有 runner ⇒ 503');
    } finally {
      await noDev.close();
    }

    const { dev } = mkDev({
      abort: async () => {
        const e = new Error('当前没有在飞的 run');
        e.statusCode = 409;
        throw e;
      },
    });
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const busy = await post(base, '/run/abort', {});
      assert.equal(busy.status, 409, '没在飞 run ⇒ 钩子的 409 原样回');
      assert.match((await busy.json()).error, /没有在飞的 run/);
      assert.equal(
        (await fetch(`${base}/run/abort`)).status,
        404,
        'GET 不落钩子（方法不对就是没这个路由）',
      );
    } finally {
      await srv.close();
    }

    // 优雅中止（escalated=false）与升级重启（escalated=true）都是 202 —— 区别在响应体，
    // 面板据此说「trace 保得住」还是「trace 丢了」
    for (const escalated of [false, true]) {
      const { dev: d } = mkDev({ abort: async () => ({ accepted: true, escalated }) });
      const s = await startInspector({ dev: d });
      try {
        const res = await post(`http://127.0.0.1:${s.port}`, '/run/abort', {});
        assert.equal(res.status, 202, '中止是「已受理」：run 真正收尾要走 SSE 的 run-done');
        assert.deepEqual(await res.json(), { accepted: true, escalated });
      } finally {
        await s.close();
      }
    }
  });

  /* §6 待定 3 的「清空对话」。清空 = **换 sessionId**，不动 session.json
   * （那是 store 的账，面板对它只读）—— 所以这里只断言「返回新 id」，不假设旧对话被删。 */
  it('POST /session/clear：503 / 409 / 200 + 新 sessionId', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const noDev = await startInspector();
    try {
      const res = await post(`http://127.0.0.1:${noDev.port}`, '/session/clear', {});
      assert.equal(res.status, 503);
    } finally {
      await noDev.close();
    }

    const { dev } = mkDev({
      clearSession: async () => {
        const e = new Error('有 run 在飞时不能清空对话（它会写回当前会话）');
        e.statusCode = 409;
        throw e;
      },
    });
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await post(base, '/session/clear', {});
      assert.equal(res.status, 409, '在飞时不许清空 —— 否则 run 会写回一份模型没见过的会话');
      assert.match((await res.json()).error, /不能清空对话/);
    } finally {
      await srv.close();
    }

    const { dev: ok } = mkDev({ clearSession: async () => ({ sessionId: 'dev-7' }) });
    const s2 = await startInspector({ dev: ok });
    try {
      const res = await post(`http://127.0.0.1:${s2.port}`, '/session/clear', {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { sessionId: 'dev-7' });
    } finally {
      await s2.close();
    }
  });

  /* 原生目录选择器（POST /api/fs/pick）：面板侧只认这份契约 ——
   * 200 {path} 选了 / 200 {path:null} 取消 / 409 已有一个在等 / 500 其它失败，
   * 鉴权与其它接口同一条缝（cookie/query/header 任一）。服务端由 dev 钩子
   * `pickFolder` 提供（另一批改动并行接入中）：还没接上（404）时形状断言跳过，
   * 接上之后自动开始守；缺 token ⇒ 403 那条与路由是否接上无关，始终断言。 */
  it('POST /api/fs/pick：走 dev 钩子；缺 token 403；路径 / 取消 / 冲突 / 失败四种形状', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const TOKEN = 'tok-picker';
    const mk = (pickFolder) => {
      const { dev } = mkDev({ pickFolder });
      return startInspector({ dev, token: TOKEN });
    };
    const call = (srv, authed) =>
      post(`http://127.0.0.1:${srv.port}`, `/api/fs/pick${authed ? `?t=${TOKEN}` : ''}`, {});

    const srv = await mk(async () => '/picked/dir');
    try {
      assert.equal((await call(srv)).status, 403, '缺 token → 403（与其它接口同一条缝）');
      const probe = await call(srv, true);
      if (probe.status === 404) {
        return t.skip('服务端 /api/fs/pick 还没接上（并行开发）—— 接上后本用例自动生效');
      }
      assert.equal(probe.status, 200);
      assert.deepEqual(await probe.json(), { path: '/picked/dir' }, '选了目录 ⇒ 200 { path }');
    } finally {
      await srv.close();
    }

    const srvNull = await mk(async () => null);
    try {
      const res = await call(srvNull, true);
      assert.equal(res.status, 200, '取消也是 200（不是错误）');
      assert.deepEqual(await res.json(), { path: null }, '取消 ⇒ { path: null }');
    } finally {
      await srvNull.close();
    }

    const srvBusy = await mk(async () => {
      throw new HttpError(409, '已有一个系统选择框在等');
    });
    try {
      const res = await call(srvBusy, true);
      assert.equal(res.status, 409, '钩子的 409 原样回（面板据此提示重重点击）');
      assert.match((await res.json()).error, /在等/);
    } finally {
      await srvBusy.close();
    }

    const srvBad = await mk(async () => {
      throw new Error('系统对话框炸了');
    });
    try {
      const res = await call(srvBad, true);
      assert.equal(res.status, 500, '不带状态码的错误兜底 500（不伪装成 4xx）');
      assert.match((await res.json()).error, /炸了/);
    } finally {
      await srvBad.close();
    }
  });

  /* 客户端断开出口：等待系统选择框期间刷新 / 关标签页 ⇒ 路由必须通知钩子收掉
   * 在飞的选择框。缺了这条：桌面上的对话框没人看、钩子里的「在飞」标志永远不落，
   * 之后每次点「系统选择…」都 409 —— 症状像「功能坏了」，与「面板锁死」同族。 */
  it('POST /api/fs/pick：客户端断开 ⇒ cancelPick 被调，且后续请求不再 409', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const TOKEN = 'tok-picker-drop';
    let cancelled = 0;
    let calls = 0;
    let resolveFirst;
    const { dev } = mkDev({
      // 第一次调用挂住（用户还没选）；取消后才 settle。之后直接给结果（证明不再 409）
      pickFolder: () => {
        calls++;
        return calls === 1
          ? new Promise((r) => {
              resolveFirst = r;
            })
          : Promise.resolve('/next/dir');
      },
      cancelPick: () => {
        cancelled++;
        resolveFirst?.(null);
      },
    });
    const srv = await startInspector({ dev, token: TOKEN });
    try {
      // 裸 socket 发了就毁 —— 「刷新 / 关标签页」是底层连接没了；fetch 的 abort()
      // 走的是受控关闭，不是同一个事件面。
      await new Promise((resolve) => {
        const req = request({
          host: '127.0.0.1',
          port: srv.port,
          path: `/api/fs/pick?t=${TOKEN}`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        req.on('error', () => resolve()); // 对端 RST 也算「断了」
        req.end('{}', () => {
          req.destroy();
          resolve();
        });
      });
      const deadline = Date.now() + 3_000;
      while (cancelled === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(cancelled, 1, '客户端断开必须通知 cancelPick —— 否则选择框挂在桌面上没人收');
      const again = await post(`http://127.0.0.1:${srv.port}`, `/api/fs/pick?t=${TOKEN}`, {});
      assert.equal(again.status, 200, '取消之后再来一次不该 409（在飞标志要落下来）');
      assert.deepEqual(await again.json(), { path: '/next/dir' });
    } finally {
      await srv.close();
    }
  });
});
