#!/usr/bin/env node
/*
 * 官网「每页 Markdown 变体」生成器（GEO 档 C）。
 *
 * 为什么有它：AFDocs 打线上官网时 4 项 FAIL 全在 Markdown Availability —— 站点只给
 * HTML（`/docs` 64 KB，其中约 64% 是外壳/导航样板），而 Claude Code / Cursor / OpenCode
 * 这类 agent 会**主动要 markdown**。补齐面 = 每个页面有一份 `.md` 变体（档 C），
 * 由它再支撑 `Accept: text/markdown` 内容协商（档 D，见 public/_worker.js）。
 *
 * 输入是**构建产物**（`dist/*.html`），不是源码片段 —— 两个理由：
 *   ① 打分器比的是「线上 HTML 正文 ↔ markdown」，拿产物转才能与它同源；
 *   ② 产物带上了 Base 外壳，页面结构变了这里跟着变，不需要第二处清单。
 *
 * ⚠️ 三条设计约束，改之前先读（都是实测出来的）：
 *
 *  ① **表格转成「一行一条」而不是 GFM 表格。**
 *     api.html 的 10 张表里有 28 个单元格正文含 `|`（`string | ContentBlockParam[]` 这类
 *     联合类型）。GFM 表格里那个 `|` 必须转义成 `\|`，而打分器的 parity 判定是
 *     「HTML 正文片段是否是 markdown 文本的子串」—— 转义符会让片段**对不上**（一条一 miss）。
 *     本仓库的站内纪律是「宁可排版形式退一步，也不让内容判定失真」，所以用
 *     `- 导出 — 签名 — 说明` 的列表形态：零转义、零丢失，agent 读起来也更好扫。
 *
 *  ② **转出来必须能过 parity（缺失 < 5%）。** 打分器 `markdown-content-parity` 会把
 *     页面 HTML 的正文容器（main/article）切段，逐段要求出现在 markdown 里。所以
 *     正文里的**文字一个都不能丢**：不缩写、不做「省略 N 条」、不删重复。
 *
 *  ③ **剥掉的标签要与打分器一致**（script/style/nav/footer/header?/aside/表单控件）。
 *     多剥了会丢段落（parity 红）；少剥了只是多几行样板（parity 不在乎，但 agent 在乎）。
 *     这里**保留 header**（页面标题与副标题对 agent 有用，且打分器把它剥掉 ⇒ 不在判定内），
 *     **剥掉 aside/nav/footer/script/style/canvas/表单控件**。
 *
 * 用法：`node scripts/build-md-variants.mjs`（构建末尾自动跑，见 package.json 的 build）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist');
/** 与 astro.config.mjs 的 site 一致：.md 里的指引必须写绝对地址 */
const ORIGIN = 'https://agentia-web.pages.dev';

/** 整棵子树都不进 markdown 的元素（外壳/装饰/交互控件） */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'nav',
  'footer',
  'aside',
  'noscript',
  'canvas',
  'svg',
  'iframe',
  'button',
  'input',
  'select',
  'option',
  'label',
  'textarea',
]);

/** 块级元素：决定「递归成多段」还是「当作一段行内文本」 */
const BLOCK_TAGS = new Set([
  'main',
  'article',
  'section',
  'div',
  'header',
  'p',
  'pre',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'blockquote',
  'figure',
  'figcaption',
  'details',
  'summary',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** 折叠行内空白（正文里的换行/缩进 → 单个空格） */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

const isElement = (n) => n.nodeType === 1;
const isText = (n) => n.nodeType === 3;
const tagOf = (n) => (n.tagName ? n.tagName.toLowerCase() : '');

/** 元素是否含块级子元素（含则按多段渲染，否则整段行内渲染） */
function hasBlockChild(el) {
  for (const c of el.childNodes) {
    if (isElement(c) && BLOCK_TAGS.has(tagOf(c))) return true;
  }
  return false;
}

/** 行内渲染：保留文字，用 markdown 表达强调/链接/行内代码 */
function renderInline(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (isText(c)) {
      out += c.text;
      continue;
    }
    if (!isElement(c)) continue;
    const tag = tagOf(c);
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'br') {
      out += '\n';
      continue;
    }
    if (tag === 'code') {
      const code = collapse(c.text);
      out += code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``;
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      out += `**${collapse(renderInline(c))}**`;
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      const inner = collapse(renderInline(c));
      out += inner ? `*${inner}*` : '';
      continue;
    }
    if (tag === 'a') {
      const href = c.getAttribute('href') ?? '';
      const inner = collapse(renderInline(c));
      // 页内锚点（#xxx）对 markdown 读者没有意义（同一个文件里没有锚点），只留文字
      out += href && !href.startsWith('#') ? `[${inner}](${href})` : inner;
      continue;
    }
    out += renderInline(c);
  }
  return out;
}

/**
 * 代码块：`<pre>` 的内容被解析器当成 rawText（语法高亮的 span 不算节点），
 * 所以重新解析一次拿到纯文本 —— 与打分器处理 `<pre>` 的方式一致。
 */
function renderPre(pre) {
  const raw = pre.rawText ?? pre.innerHTML ?? '';
  const code = parse(raw)
    .text.replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
  // 代码里若自身出现 ``` 行，就用更长的围栏，别把块提前关掉
  const longest = (code.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 2);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${code}\n${fence}`;
}

/** 列表：`<li>` → `- `（有序列表 → `N. `），嵌套用两空格缩进 */
function renderList(list, depth, ordered) {
  const lines = [];
  let n = 1;
  for (const li of list.childNodes) {
    if (!isElement(li) || tagOf(li) !== 'li') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const nested = [];
    const own = { childNodes: [] };
    for (const c of li.childNodes) {
      if (isElement(c) && (tagOf(c) === 'ul' || tagOf(c) === 'ol')) nested.push(c);
      else own.childNodes.push(c);
    }
    const text = collapse(renderInline(own));
    lines.push(`${'  '.repeat(depth)}${marker}${text}`);
    for (const sub of nested) {
      lines.push(renderList(sub, depth + 1, tagOf(sub) === 'ol'));
    }
  }
  return lines.join('\n');
}

/**
 * 表格 → 一行一条（见文件头约束 ①）。表头行也保留，它是列语义的载体。
 * 单元格内的换行折成空格：markdown 的行是 parity 的分段单位，行内换行会把片段切碎。
 */
function renderTable(table) {
  const lines = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = tr
      .querySelectorAll('th,td')
      .map((c) => collapse(renderInline(c)))
      .filter((t) => t.length > 0);
    if (cells.length > 0) lines.push(`- ${cells.join(' — ')}`);
  }
  return lines.join('\n');
}

/** 块级渲染：一段一张「块」，块之间空行分隔 */
function renderBlocks(node, depth = 0) {
  const parts = [];
  for (const c of node.childNodes) {
    if (isText(c)) {
      const t = collapse(c.text);
      if (t) parts.push(t);
      continue;
    }
    if (!isElement(c)) continue;
    const tag = tagOf(c);
    // Base 外壳里的 sr-only 指引块（class="llms-hint"）不是页面正文：它的内容由本文件开头
    // 自己写一份 markdown 版指引来表达。不剥掉它会在首页（正文容器退到 body）被抄第二遍。
    if ((c.getAttribute('class') ?? '').split(/\s+/).includes('llms-hint')) continue;
    if (SKIP_TAGS.has(tag)) continue;
    if (HEADING_LEVEL[tag]) {
      const text = collapse(renderInline(c));
      if (text) parts.push(`${'#'.repeat(HEADING_LEVEL[tag])} ${text}`);
      continue;
    }
    if (tag === 'hr') {
      parts.push('---');
      continue;
    }
    if (tag === 'pre') {
      parts.push(renderPre(c));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const list = renderList(c, depth, tag === 'ol');
      if (list) parts.push(list);
      continue;
    }
    if (tag === 'table') {
      const table = renderTable(c);
      if (table) parts.push(table);
      continue;
    }
    if (tag === 'blockquote') {
      const inner = renderBlocks(c, depth);
      if (inner)
        parts.push(
          inner
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'),
        );
      continue;
    }
    // 叶子块（p / li 之外的单段容器）：整段走行内渲染，避免被切成碎段
    if (!hasBlockChild(c)) {
      const text = collapse(renderInline(c));
      if (text) parts.push(text);
      continue;
    }
    const inner = renderBlocks(c, depth);
    if (inner) parts.push(inner);
  }
  return parts.join('\n\n');
}

/**
 * 把一页产物 HTML 转成 markdown。
 *
 * @param {string} html  `dist/<page>.html` 的全文
 * @param {{ page?: string, origin?: string }} [opts] `page` 是站点路径（`/`、`/docs`…）：
 *        用于在开头写「本页的 markdown 地址」。
 */
export function htmlToMarkdown(html, opts = {}) {
  const { page = '/', origin = ORIGIN } = opts;
  const root = parse(html);
  // 正文容器：**整棵 body**（剥掉下面的外壳元素）。
  // 为什么不取 <main>：首页没有 <main>，playground 的页面标题（header.pg-head）与
  // 「key 不出本机」那段（div.pg-byok）也在 <main> 之外 —— 只取 <main> 会让这两页的
  // markdown 变成残页（实测 playground.md 只剩 335 字符）。
  // 剥掉的外壳元素与打分器的剥离集合一致 ⇒ 多出来的内容只可能「更全」，不会让 parity 失分。
  const scope = root.querySelector('body') ?? root.querySelector('main');
  if (!scope) throw new Error('产物里既没有 <body> 也没有 <main>');
  const body = renderBlocks(scope);

  // 开头的 llms 指引（AFDocs 的 llms-txt-directive-md：md 里也必须出现 /llms.txt，
  // 且要落在正文前 10% —— 所以放在最前）。
  // ⚠️ 两条约束：
  //   ① 必须是**单行**：打分器的 parity 判定把 `/^for ai agents:/` 开头的整段当噪声过滤掉，
  //      单行才保证「过滤掉的是整段」；拆成多行会留下没被过滤的残句。
  //   ② 这里（markdown 侧）用**链接**形态：AFDocs 判定「这段文本像不像 markdown」时认链接，
  //      而 playground 那种正文极短的页若没有任何链接/标题，整份 .md 会被判为「不像 markdown」
  //      而当作「没有 markdown 变体」。HTML 侧的同类约束相反（那里必须写纯文本，见 Base.astro）。
  const mdPath = page === '/' ? '/index.md' : `${page}.md`;
  const hint =
    `> For AI agents: the complete documentation index is available at [llms.txt](${origin}/llms.txt), ` +
    `the full documentation bundle (plain text, single source) at [llms-full.txt](${origin}/llms-full.txt), ` +
    `and this page as Markdown at ${origin}${mdPath}.`;

  return `${hint}\n\n${body}\n`;
}

/** 走 dist，为每个页面产物写一份同名 `.md`（404 页不写：错误页不该有 markdown 变体） */
function main() {
  if (!existsSync(DIST)) {
    console.error(`[website-md] 找不到 ${DIST} —— 先跑 \`astro build\``);
    process.exit(1);
  }
  const pages = readdirSync(DIST)
    .filter((f) => f.endsWith('.html') && f !== '404.html')
    .sort();
  if (pages.length === 0) {
    console.error('[website-md] dist 里没有页面产物 —— 站点结构变了？');
    process.exit(1);
  }
  const written = [];
  for (const file of pages) {
    const page = file === 'index.html' ? '/' : `/${file.replace(/\.html$/, '')}`;
    const html = readFileSync(join(DIST, file), 'utf8');
    const md = htmlToMarkdown(html, { page });
    const out = file.replace(/\.html$/, '.md');
    writeFileSync(join(DIST, out), md);
    written.push(`${out} (${md.length} 字符)`);
  }
  console.log(`[website-md] 生成 ${written.length} 份 markdown 变体：${written.join(' / ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
