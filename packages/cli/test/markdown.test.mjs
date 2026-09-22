import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。 */
const DIST = fileURLToPath(new URL('../dist/markdown.js', import.meta.url));
let M = null;
if (existsSync(DIST)) M = await import(new URL('../dist/markdown.js', import.meta.url).href);
const SKIP = !M ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

/** 把块序列压成「类型 + 文本」的浅表示，断言只关心这几样（不钉 token 树的枝形） */
const flat = (blocks) =>
  blocks.map((b) => {
    if (b.type === 'p' || b.type === 'h' || b.type === 'quote')
      return `${b.type}:${inlineText(b.inline)}`;
    if (b.type === 'code') return `code(${b.lang}):${b.text}`;
    if (b.type === 'list')
      return `list(${b.ordered ? 'ol' : 'ul'}):${b.items.map(inlineText).join('|')}`;
    return 'hr';
  });

const inlineText = (inline) =>
  inline
    .map((n) => {
      if (n.type === 'text') return n.text;
      if (n.type === 'code') return `\`${n.text}\``;
      if (n.type === 'link') return `[${n.text}](${n.href})`;
      return n.type === 'strong' ? `**${inlineText(n.children)}**` : `*${inlineText(n.children)}*`;
    })
    .join('');

/** 递归收集全部 token 类型 —— 「没有 HTML 这一类」是安全前提，得能一眼断言 */
const allTypes = (blocks) => {
  const seen = new Set();
  const walkInline = (inline) => {
    for (const n of inline) {
      seen.add(n.type);
      if (n.children) walkInline(n.children);
    }
  };
  for (const b of blocks) {
    seen.add(b.type);
    if (b.inline) walkInline(b.inline);
    if (b.items) b.items.forEach(walkInline);
  }
  return [...seen].sort();
};

describe('面板的 Markdown 解析（纯逻辑，零依赖）', { skip: SKIP }, () => {
  it('标题 / 段落 / 分隔线：`---` 是分隔线，不是列表项', () => {
    assert.deepEqual(flat(M.parseMarkdown('# 标题\n\n正文一\n\n---\n\n## 二级 ##')), [
      'h:标题',
      'p:正文一',
      'hr',
      'h:二级',
    ]);
    // 段落内的换行**保留**（模型正文里的软换行是它自己的排版，不该被压成一行）
    assert.deepEqual(flat(M.parseMarkdown('a\nb')), ['p:a\nb']);
  });

  it('围栏码块：带语言标注；**未闭合**的一路吃到文末（不静默丢内容）', () => {
    assert.deepEqual(flat(M.parseMarkdown('```ts\nconst a = 1;\n```')), ['code(ts):const a = 1;']);
    assert.deepEqual(flat(M.parseMarkdown('~~~\n裸的\n~~~\n')), ['code():裸的']);
    // 模型输出被截断时最常见的就是未闭合围栏 —— 内容必须留着（而不是变成一个空块）
    assert.deepEqual(flat(M.parseMarkdown('```\n没关\n第二行')), ['code():没关\n第二行']);
    // 码块里的 `#` `**` 都不再解析（这是码块的意义）
    assert.deepEqual(flat(M.parseMarkdown('```\n# 不是标题\n**不是粗体**\n```')), [
      'code():# 不是标题\n**不是粗体**',
    ]);
  });

  it('列表：无序 / 有序各收一段；缩进 ≥2 的续行并进上一项', () => {
    assert.deepEqual(flat(M.parseMarkdown('- a\n- b\n\n1. x\n2. y')), [
      'list(ul):a|b',
      'list(ol):x|y',
    ]);
    assert.deepEqual(flat(M.parseMarkdown('- 第一项\n  续行\n- 第二项')), [
      'list(ul):第一项续行|第二项',
    ]);
  });

  it('引用：连续 `>` 行合成一段；行内换行保留', () => {
    assert.deepEqual(flat(M.parseMarkdown('> 引用一\n> 引用二')), ['quote:引用一\n引用二']);
  });

  it('行内：行内码 / 粗体 / 斜体 / 链接 / 自动链接', () => {
    assert.equal(inlineText(M.parseInline('用 `npm run dev` 起', 0)), '用 `npm run dev` 起');
    assert.equal(inlineText(M.parseInline('**粗**与*斜*', 0)), '**粗**与*斜*');
    assert.equal(
      inlineText(M.parseInline('见 [文档](https://example.com/a)', 0)),
      '见 [文档](https://example.com/a)',
    );
    assert.equal(
      inlineText(M.parseInline('裸链 <https://example.com> 也是链接', 0)),
      '裸链 [https://example.com](https://example.com) 也是链接',
    );
    // 行内码里的记号不再解析
    assert.equal(inlineText(M.parseInline('`**不是粗体**`', 0)), '`**不是粗体**`');
  });

  it('**安全性**：整棵树里只可能出现白名单里的 token —— 没有任何「HTML 透传」这一类', () => {
    const blocks = M.parseMarkdown(
      '# t\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
    );
    // 白名单就是全部 token 类型（块 + 行内）。多出任何一个都意味着有人加了「原样透传」的路径。
    const ALLOWED = new Set([
      'p',
      'h',
      'code',
      'list',
      'quote',
      'hr',
      'text',
      'strong',
      'em',
      'link',
    ]);
    const unexpected = allTypes(blocks).filter((t) => !ALLOWED.has(t));
    assert.deepEqual(unexpected, [], `出现了白名单外的 token 类型：${unexpected.join(', ')}`);
    // 尖括号与引号都只是文本，渲染层用 textContent 写出去 ⇒ 字面显示
    // （空行把这两行拆成两段，所以按段拼回来比）
    assert.equal(
      blocks
        .slice(1)
        .map((b) => inlineText(b.inline))
        .join('\n'),
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>',
    );
    // 「HTML 透传」这类 token 一旦被加进来，这条会立刻红（安全前提的守卫）
    assert.ok(!allTypes(M.parseMarkdown('<div>a</div>')).includes('html'));
  });

  it('**安全性**：不合法协议的链接整条降级成字面文本（含 []() 一起显示）', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'JaVaScRiPt:alert(1)',
      'vbscript:x',
    ]) {
      assert.equal(M.isSafeHref(bad), false, `${bad} 不该过白名单`);
      const inline = M.parseInline(`[点我](${bad})`, 0);
      assert.equal(inline.length, 1);
      assert.equal(inline[0].type, 'text', `${bad} 必须降级成文本，不能是可点链接`);
      assert.equal(
        inline[0].text,
        `[点我](${bad})`,
        '字面保留原文，使用者看得出这里有个链接没渲染',
      );
    }
    for (const ok of ['https://x.dev/a?b=1', 'http://x', 'mailto:a@b.c']) {
      assert.equal(M.isSafeHref(ok), true, `${ok} 应在白名单内`);
    }
  });

  it('健壮性：空串 / CRLF / 光秃记号 / 超长单行 / 深嵌套，都不抛且不吞内容', () => {
    assert.deepEqual(M.parseMarkdown(''), []);
    assert.deepEqual(M.parseMarkdown(null), []);
    assert.deepEqual(flat(M.parseMarkdown('a\r\n\r\n# b\r\n')), ['p:a', 'h:b']);
    // 光秃的记号不该被吃掉
    assert.equal(
      inlineText(M.parseInline('* 未闭合的粗体 ** 与 ` 反引号', 0)),
      '* 未闭合的粗体 ** 与 ` 反引号',
    );
    // 深嵌套有递归上限（无上限时一条构造出来的正文就能把面板卡死）
    const deep = '*'.repeat(40) + 'x' + '*'.repeat(40);
    assert.doesNotThrow(() => M.parseInline(deep, 0));
    // 超长单行不产生块级爆炸
    const long = 'x'.repeat(50_000);
    assert.deepEqual(flat(M.parseMarkdown(long)), [`p:${long}`]);
  });

  it('解析是线性的：1 万行围栏内容不会退化成指数（防 ReDoS 的粗判）', () => {
    const big = '```\n' + 'x\n'.repeat(10_000) + '```';
    const t0 = Date.now();
    const blocks = M.parseMarkdown(big);
    assert.equal(blocks.length, 1);
    assert.ok(
      Date.now() - t0 < 2_000,
      `1 万行解析耗时 ${Date.now() - t0}ms，超了 2s 说明有回溯爆炸`,
    );
  });
});
