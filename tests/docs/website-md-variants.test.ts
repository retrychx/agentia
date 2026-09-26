import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 官网**每页 markdown 变体**的转换器（`packages/website/scripts/build-md-variants.mjs`）。
 *
 * 为什么值得钉：这份 .md 是给编码 agent（Claude Code / Cursor / OpenCode）读的正文，
 * 它同时还要过 AFDocs 的 `markdown-content-parity`（按「HTML 正文片段是否出现在 markdown 里」
 * 逐段判定，缺失 ≥5% 就降级）。所以「少抄一段」「多加一个转义符」都不是排版问题，是**内容判定问题** ——
 * 而这类失败在构建里完全不报错，只有线上打分器能看见。这里把它按行为钉住：
 * 喂一份**结构可控的夹具 HTML**，断言转换结果。
 *
 * 夹具刻意与真页面同形：`<body>` 里有 sr-only 指引块、nav、aside 侧栏、语法高亮过的 `<pre>`、
 * 含 `|` 的表格单元格、实体转义的代码。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const SCRIPT = join(repoRoot, 'packages', 'website', 'scripts', 'build-md-variants.mjs');
const ORIGIN = 'https://agentia-web.pages.dev';

// 动态 import（路径是变量）：转换器是 .mjs，静态 import 会让类型检查去解析 JS 文件
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  htmlToMarkdown: (html: string, opts?: { page?: string; origin?: string }) => string;
};

const page = (body: string) => `<!DOCTYPE html>
<html lang="zh-CN"><head><title>t</title></head><body>
<div class="llms-hint" style="clip-path:inset(50%)">For AI agents: index at ${ORIGIN}/llms.txt</div>
<div class="grid-lines" aria-hidden="true"><span></span></div>
<nav class="nav"><a href="/">首页</a><a href="/docs">文档</a></nav>
${body}
<footer class="footer">Agentia — 声明式 Agent 服务开发框架</footer>
<script>console.log('x')</script>
</body></html>`;

const FIXTURE = page(`
<header class="hero"><h1>看一次 run 怎么跑</h1><p>右侧就是可观测面本体：调用树与 token 随回放同步生长。</p></header>
<main class="docs-layout">
  <aside class="docs-nav"><p class="dn-title">CONTENTS</p><a href="/docs">快速开始</a></aside>
  <div class="docs-content">
    <h2>四类能力</h2>
    <p>能力是服务的组成部分，<strong>四类能力</strong>对主 agent 都是菜单里的可调用项。</p>
    <h3>表格</h3>
    <table><thead><tr><th>导出</th><th>签名</th></tr></thead><tbody>
      <tr><td>ModelPricing</td><td>{ in: number; out: number }</td></tr>
      <tr><td>ContentBlockParam</td><td>{ role; content: string | ContentBlockParam[] } 等</td></tr>
    </tbody></table>
    <h3>代码</h3>
    <pre><code><span class="cmd">npm</span> i -g @migor/cli
<span class="cmd">agentia</span> create my-app        <span class="cm"># 脚手架：if (a &lt; b &amp;&amp; c &gt; d)</span></code></pre>
    <ul><li>取消传播：signal 一路传到模型请求</li><li>重试退避：缺省开启<ul><li>只重试没吐过字的失败</li></ul></li></ul>
    <p><a href="/docs">使用指南</a>与<a href="#quickstart">页内锚点</a>都在。</p>
  </div>
</main>`);

const convert = (html = FIXTURE, page$ = '/playground') =>
  mod.htmlToMarkdown(html, { page: page$, origin: ORIGIN });

describe('官网 markdown 变体：转换器', () => {
  it('第一行是 llms 指引（单行 blockquote，含绝对 llms.txt 与本页 .md 地址）', () => {
    const md = convert();
    const firstLine = md.split('\n')[0] ?? '';
    assert.ok(firstLine.startsWith('> '), `首行不是 blockquote: ${firstLine}`);
    assert.ok(firstLine.includes(`${ORIGIN}/llms.txt`), '缺 llms.txt 绝对地址');
    assert.ok(firstLine.includes(`${ORIGIN}/llms-full.txt`), '缺 llms-full.txt 绝对地址');
    assert.ok(firstLine.includes(`${ORIGIN}/playground.md`), '缺本页 .md 地址');
    // 必须是**链接**形态：打分器判「这段像不像 markdown」时只认标题/链接/围栏三者之一，
    // playground 那种正文极短的页若没链接会被整份判为「不是 markdown」
    assert.ok(
      firstLine.includes(`[llms.txt](${ORIGIN}/llms.txt)`),
      'llms.txt 没写成 markdown 链接',
    );
    // 必须是**单行**：打分器按「整段是否以 for ai agents: 开头」过滤噪声，拆行会留下没被过滤的残句
    assert.equal(md.split('\n').filter((l) => l.includes('/llms.txt')).length, 1);
  });

  it('首页的 .md 地址是 /index.md（根路径的候选形态）', () => {
    assert.ok(convert(FIXTURE, '/').includes(`${ORIGIN}/index.md`));
  });

  it('剥掉外壳：sr-only 指引块 / nav / footer / script / aside 侧栏都不进正文', () => {
    const md = convert();
    assert.ok(!md.includes('For AI agents: index at'), 'llms-hint 被抄进正文（会与首行指引重复）');
    assert.ok(!md.includes('首页'), 'nav 链接混进正文');
    assert.ok(!md.includes('声明式 Agent 服务开发框架'), 'footer 混进正文');
    assert.ok(!md.includes("console.log('x')"), 'script 内容混进正文');
    assert.ok(!md.includes('CONTENTS'), 'aside 侧栏混进正文');
    // 反面：main 之外的正文块**必须**保留（playground 的标题就在这里）
    assert.ok(md.includes('# 看一次 run 怎么跑'), 'main 之外的 header 标题被误丢');
  });

  it('标题层级与计数与 HTML 一致', () => {
    const md = convert();
    assert.equal((md.match(/^# /gm) ?? []).length, 1);
    assert.equal((md.match(/^## /gm) ?? []).length, 1);
    assert.equal((md.match(/^### /gm) ?? []).length, 2);
    assert.ok(md.includes('## 四类能力'));
  });

  it('表格转成一行一条，且**不做管道符转义**（转义会让 parity 的片段判定对不上）', () => {
    const md = convert();
    assert.ok(
      md.includes('- ModelPricing — { in: number; out: number }'),
      '表格行没按「一行一条」输出',
    );
    assert.ok(
      md.includes('{ role; content: string | ContentBlockParam[] } 等'),
      '含 | 的单元格被改动',
    );
    assert.ok(!md.includes('\\|'), '出现了管道符转义（会破坏 parity）');
  });

  it('代码块：围栏取 pre 的原始文本（剥掉高亮 span、解实体），不留 HTML', () => {
    const md = convert();
    assert.ok(md.includes('```\nnpm i -g @migor/cli\n'), '代码块内容不对');
    assert.ok(md.includes('if (a < b && c > d)'), '实体没解码（&lt; / &amp; / &gt;）');
    assert.ok(!md.includes('<span'), 'markdown 里残留 HTML 标签');
    assert.equal((md.match(/^```$/gm) ?? []).length, 2, '围栏不配对');
  });

  it('列表：嵌套用缩进，行内强调/链接/锚点各按 markdown 表达', () => {
    const md = convert();
    assert.ok(md.includes('- 取消传播：signal 一路传到模型请求'));
    assert.ok(md.includes('  - 只重试没吐过字的失败'), '嵌套列表没缩进');
    assert.ok(md.includes('**四类能力**'), 'strong 没转成强调');
    assert.ok(md.includes('[使用指南](/docs)'), '站内链接没保留');
    assert.ok(md.includes('页内锚点') && !md.includes('](#quickstart)'), '页内锚点该只留文字');
  });

  it('输出不含任何 HTML 标签，且幂等', () => {
    const md = convert();
    assert.ok(
      !/<\/?[a-z][a-z0-9]*[\s>]/i.test(md.replace(/```[\s\S]*?```/g, '')),
      '正文里有 HTML 标签',
    );
    assert.equal(convert(), md, '同输入两次结果不同（不幂等）');
  });

  it('输入没有 body/main 时响亮失败，而不是产出空文件', () => {
    assert.throws(() => mod.htmlToMarkdown('<html><head></head></html>'), /没有 <body>/);
  });
});
