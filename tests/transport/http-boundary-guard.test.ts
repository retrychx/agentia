import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **HTTP 宿主的三件事各在其位**（源码级守卫，2026-09-28 拆分第三步的收口）。
 *
 * 背景：`src/transport/http.ts` 走到 840 行，其中 `createHttpHandler` 一个函数占 489 行、
 * 全文 58% —— 而它其实是**四件事**挤在一个闭包里：宿主契约、宿主状态、准入与停机、
 * 以及九条路由的**体**（读 body → 调 runner → 写响应 → 选状态码）。于是「新加一条端点」
 * 的默认姿势是往这个函数里再塞一段，拆分前两轮（#99 外移形状、#100 外移判定）
 * 移走的都是**纯件**，而占大头的那一半（不纯的路由体）原地不动 —— 文件从 533 又长回 840。
 *
 * 第三步把路由体连同收发原语分别外移，于是：
 * - `http.ts`          = 宿主契约 + 宿主状态 + 准入/停机（**不含任何一条路由的体**）；
 * - `http-endpoints.ts` = 走到这条路上做什么（派发表 + 九条体）；
 * - `http-io.ts`        = 怎么收发（读 body / 写 JSON / 405 / 413 / 503 / 500）。
 *
 * 本用例把这三条边界变成断言 —— 不靠记性，也不靠「AGENTS.md 里那句散文」。
 * 与 `dispatch-guard.test.ts` 同款：**只读源码文本**（不改行为、不碰运行期）。
 *
 * 自带两层护栏防真空变绿：① 先断言三份源码真的解析出来了（正则失效时本用例会**永远绿**，
 * 那种守卫比没有更糟）；② 「必须缺席」的每条断言都配一条「必须在场」的**反向断言**
 * （记号若被改名/搬家，反向那条先红，而不是缺席那条假绿）。
 */

const HOST = fileURLToPath(new URL('../../src/transport/http.ts', import.meta.url));
const ENDPOINTS = fileURLToPath(new URL('../../src/transport/http-endpoints.ts', import.meta.url));
const IO = fileURLToPath(new URL('../../src/transport/http-io.ts', import.meta.url));

/** 去掉注释后的源码（注释里提到某个记号不算使用 —— 与 dispatch-guard 同口径） */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('HTTP 宿主边界守卫（源码级）：宿主 / 端点 / 原语 三件事各在其位', () => {
  const host = codeOf(HOST);
  const endpoints = codeOf(ENDPOINTS);
  const io = codeOf(IO);

  it('真空护栏：三份源码都真解析出来了（否则下面全是假绿）', () => {
    assert.ok(host.length > 3_000, `http.ts 解析出 ${host.length} 字符 —— 太短，守卫已失效`);
    assert.ok(
      endpoints.length > 8_000,
      `http-endpoints.ts 解析出 ${endpoints.length} 字符 —— 太短，守卫已失效`,
    );
    assert.ok(io.length > 2_000, `http-io.ts 解析出 ${io.length} 字符 —— 太短，守卫已失效`);
    // 抽词口径的锚：三个文件各认一个「本文件独有的真东西」
    assert.match(host, /export function createHttpHandler/, '宿主文件认出了 createHttpHandler');
    assert.match(endpoints, /export async function handleRoute/, '端点文件认出了 handleRoute');
    assert.match(io, /export function sendJson/, '原语文件认出了 sendJson');
  });

  it('端点体只许落户 http-endpoints.ts（宿主文件里必须一个记号都不剩）', () => {
    // 「写一条路由体绕不开的记号」：想按 kind 分支就得读 `route.kind`（派发表本身）、
    // 想发帧就得调 `sse.event(`、想读 body 就得过那三个形状解析器。
    // 少任何一样都写不出一个端点 —— 所以这组记号在场 = 端点体回流。
    const leaks = [
      'route.kind', // 派发表（switch (route.kind)）
      'sse.event(', // 往 SSE 流里发帧
      'toTaskSubmitBody(', // POST /tasks 的形状闸
      'parseApproveBody(', // POST /tasks/<id>/approve 的形状闸
      'parseEventBody(', // POST /tasks/<id>/events 的形状闸
    ];
    for (const token of leaks) {
      assert.ok(
        endpoints.includes(token),
        `${token} 不在 http-endpoints.ts 里 —— 记号被改名/搬家了？先更新本守卫（这条是防假绿的反向断言）`,
      );
    }
    // 一次报全（而不是断言在循环里、撞到第一个就停）：退化时想看到的是完整清单
    const leaking = leaks.filter((token) => host.includes(token));
    assert.deepEqual(
      leaking,
      [],
      `这些记号出现在 http.ts：${leaking.join('、')} —— 端点体只能落在 http-endpoints.ts；` +
        '宿主文件只管「谁准进」和「怎么起停」，不管「走到路上做什么」',
    );
  });

  it('准入判定（免鉴权豁免）只许留在宿主文件里 —— 端点表不认识鉴权', () => {
    // 「谁免鉴权」是**安全判据**，真源只有 `http-route.ts` 的 isPreAuthRoute，调用点只有
    // 宿主文件的 handler 一处。它若出现在端点文件里，说明这条判据长出了第二个落点 ——
    // 而那正是「/healthz 忘了豁免」或「某条路径偷偷不过闸」这类事故的温床。
    assert.ok(
      host.includes('isPreAuthRoute('),
      '宿主文件没在用 isPreAuthRoute( —— 鉴权闸去哪了？这条断言的前提没了',
    );
    assert.ok(
      !endpoints.includes('isPreAuthRoute('),
      'isPreAuthRoute( 出现在端点文件里 —— 端点表该只认「这条 kind 回什么」，不认鉴权',
    );
  });

  it('派发表必须留在端点文件且穷尽：`const _never: never = route` 在场', () => {
    // 为什么这条只能靠文本钉：**删掉 switch 的 default 分支，编译期不报错** ——
    // 函数签名是 Promise<void>，switch 落空就等于这个请求谁都没回（客户端挂到超时，
    // 而 typecheck / lint 全绿）。类型系统只能保证「写了的 case 都对」，
    // 保不了「有一个兜底把落空这件事说出来」。
    assert.match(
      endpoints,
      /const _never: never = route;/,
      'http-endpoints.ts 的派发表缺少穷尽性断言（`const _never: never = route`）—— ' +
        '删掉它之后新增 route kind 会被静默吞成「无响应」，且编译期不报错',
    );
  });

  it('原语层零内部依赖（兄弟模块可以随便引它而不可能引成环）', () => {
    // `http-io.ts` 是**叶子**：只 import `node:http` 的类型。这条不变量是依赖图无环的
    // **构造性**保证（不是碰巧无环）：宿主与端点都引它，它谁都不引 ⇒ 不可能成环。
    // 想给它加内部依赖之前，先想清楚「谁引谁」——多半是要把那个东西也变成叶子。
    const relative = io.match(/from\s+'(\.[^']+)'/g) ?? [];
    assert.deepEqual(
      relative,
      [],
      `http-io.ts 出现了相对导入：${relative.join('、')} —— 原语层要保持零内部依赖`,
    );
    // 反向断言：它确实还在用 node:http（否则上面的正则可能什么都没匹配到）
    assert.match(io, /from 'node:http'/, 'http-io.ts 没在 import node:http —— 抽词口径失效了？');
  });
});
