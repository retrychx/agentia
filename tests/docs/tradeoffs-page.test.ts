/*
 * 官网「取舍对照」页的守卫（2026-09-29，评审 P1-1）。
 *
 * ## 为什么需要它
 *
 * 评审 §5 P1-1 的原话：**加一页「取舍对照」（不是优势对照）** —— 明写相对 Mastra / LangGraph /
 * Vercel AI SDK **不做什么**、代价是什么、**什么场景该选别人**。验收标准就是两条：
 * 「页面存在」+「含『不适用场景』」。
 *
 * 为什么这也要守卫：本仓的对外表达面**从来没有「不适用场景」**（2026-09-29 实测
 * `grep -rn "不适用" packages/website/src README.md` ⇒ 0 命中）。没有它，读者只能从
 * 「它有什么」反推边界 —— 而反推出来的边界，必然比真实边界宽松。
 * **「我们不做 X」这种句子也和别的承诺一样会腐烂**：页面在，那节被精简掉了，零信号。
 *
 * ## 守什么
 *
 *   ① 页面与片段两个文件都在（缺一个就是构建期才发现的空白页）；
 *   ② 片段里有「**不适用场景**」这一节（评审的验收点，也是这一页唯一必须存在的节）；
 *   ③ 导航 / sitemap / llms.txt **三处都登记了这一页** —— 官网的「页面清单」是为了 agent 与
 *      搜索引擎维护的（详见 `sitemap.xml.ts` 头注），新页面漏登记 = 对它们不存在；
 *   ④ 正文里指向站内的锚点（`docs.html` 的 `id`）真实存在 —— 取舍页的定位就是「指回真源」，
 *      指错路比不给路更坏（与 `deployment.test.ts` 第 ② 条同一条纪律）；
 *   ⑤ 自证：上面抽到的锚点数 ≥ 2（解析器退化 ⇒ 0 命中会让 ④ 静默全绿）。
 *
 * ## 刻意不做的部分
 *
 * **不评价内容写得好不好、竞品名字对不对** —— 那是编辑判断，不是机器判据。
 * 也不校验页面排版。守的是「这一页还在、那一节还在、它指的路还通」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

const PAGE = 'packages/website/src/pages/tradeoffs.astro';
const FRAGMENT = 'packages/website/src/fragments/tradeoffs.html';
const DOCS_FRAGMENT = 'packages/website/src/fragments/docs.html';
const NAV = 'packages/website/src/components/Nav.astro';
const SITEMAP = 'packages/website/src/pages/sitemap.xml.ts';
const LLMS = 'packages/website/src/pages/llms.txt.ts';

describe('官网「取舍对照」页（评审 P1-1）', () => {
  it('页面与片段两个文件都在', () => {
    for (const f of [PAGE, FRAGMENT]) {
      assert.ok(existsSync(join(repoRoot, f)), `${f} 不在场 —— 这一页没了`);
    }
  });

  it('含「不适用场景」这一节（评审的验收点）', () => {
    const html = read(FRAGMENT);
    assert.match(
      html,
      /<h2>不适用场景<\/h2>/,
      `${FRAGMENT} 里没有「不适用场景」节 —— 这一页存在的意义就是它。` +
        '评审 P1-1 要的是「取舍对照」而不是「优势对照」：没有「什么时候别选它」，这一页就退化成广告。',
    );
  });

  it('导航 / sitemap / llms.txt 三处都登记了这一页', () => {
    assert.ok(
      (read(NAV).match(/\/tradeoffs/g) ?? []).length >= 2,
      `${NAV} 里 /tradeoffs 少于 2 处 —— 首页分支与非首页分支各要一个（漏一个 ⇒ 一半页面到不了这页）`,
    );
    assert.match(
      read(SITEMAP),
      /path: '\/tradeoffs'/,
      `${SITEMAP} 没登记 /tradeoffs —— 对搜索引擎与 agent 不存在`,
    );
    assert.match(
      read(LLMS),
      /abs\('\/tradeoffs'\)/,
      `${LLMS} 的文档清单里没有 /tradeoffs —— agent 少一个入口`,
    );
  });

  it('正文里指向站内的锚点真实存在（取舍页的定位就是「指回真源」）', () => {
    const html = read(FRAGMENT);
    const anchors = [...html.matchAll(/href="\/(docs|api|playground)#([A-Za-z0-9_-]+)"/g)];
    // 自证：解析器退化成 0 命中会让下面那条「每个锚点都存在」变成空跑（静默全绿）
    assert.ok(
      anchors.length >= 2,
      `${FRAGMENT} 只解析出 ${anchors.length} 个站内锚点（期望 ≥ 2） —— 抽取正则的锚点坏了`,
    );
    const docsHtml = read(DOCS_FRAGMENT);
    for (const [, page, id] of anchors) {
      const target =
        page === 'docs' ? DOCS_FRAGMENT : `packages/website/src/fragments/${page}.html`;
      const text = page === 'docs' ? docsHtml : read(target);
      assert.ok(
        text.includes(`id="${id}"`),
        `${FRAGMENT} 指向 /${page}#${id}，但 ${target} 里没有 id="${id}" —— 指错路比不给路更坏`,
      );
    }
  });
});
