import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 官网 API 页表格的**版式不变量**（`packages/website/src/styles/global.css`）。
 *
 * 为什么值得单独钉：API 页那次改版上线后，三列表的中列（签名）在**任何**容器宽度下都只分到
 * 55px —— 长签名竖成一列字，一行表高 1294px，手机与 1024px 桌面窗口一样烂。根因是给签名加了
 * `overflow-wrap: anywhere`：`anywhere` 会**参与固有尺寸计算**（`break-word` 不会），把该列
 * 的 min-content 压成 1 个字，于是表格最小宽度锁死在 ~764px，中列永远抢不到空间。
 *
 * 当时没发现，是因为验证只查了「页面有没有横向溢出」—— 表确实没撑破页面（容器在滚），
 * 所以检查全绿而内容已经烂了。**溢出检查查不出「挤死」**。纯 CSS 的这类回归肉眼也看不出来，
 * 所以在这里钉三条不变量：
 *  ① 签名代码片只可 `break-word`，不得用 `anywhere`；
 *  ② 三列都要有 min-width 下限（否则容器一窄就把某一列挤死）；
 *  ③ 窄屏要有卡片化兜底（行变 block、表头隐藏、表格解开 min-width）——
 *     列宽下限只能救「不至于逐字竖排」，救不了「一屏放不下 490px 的首列」。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const CSS_PATH = join(repoRoot, 'packages', 'website', 'src', 'styles', 'global.css');

const raw = readFileSync(CSS_PATH, 'utf8');

/** API 页段落：从「API 参考页」标记注释到文件末尾（playground 的 overflow-wrap 在它之前） */
const MARKER = 'API 参考页';
const markerAt = raw.indexOf(MARKER);
assert.ok(markerAt >= 0, `global.css 里找不到「${MARKER}」标记注释，测试需要更新`);
const api = raw.slice(markerAt).replace(/\/\*[\s\S]*?\*\//g, ''); // 去掉注释：注释里正提到 anywhere

/** 取出所有 `@media (...) { ... }` 块（花括号配平） */
function mediaBlocks(css: string): { query: string; body: string }[] {
  const out: { query: string; body: string }[] = [];
  const re = /@media([^{]*)\{/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    let depth = 0;
    const start = re.lastIndex - 1;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ query: m[1], body: css.slice(start + 1, i) });
          re.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return out;
}

describe('官网 API 页表格版式不变量', () => {
  it('签名列不得用 overflow-wrap: anywhere（它会参与固有尺寸计算，把该列压成 1 个字）', () => {
    const hit = /overflow-wrap:\s*anywhere/.exec(api);
    assert.equal(
      hit,
      null,
      'API 页段落里出现了 `overflow-wrap: anywhere` —— 它会参与 min-content 计算，' +
        '使签名列无论容器多宽都被挤成逐字竖排。要就地断行请用 `break-word`。',
    );
  });

  it('三列都有 min-width 下限（容器变窄时宁可横滑，也不逐字竖排）', () => {
    const floors = new Map<number, number>();
    const re = /\.page-api \.doc-table[^{}]*?nth-child\((\d)\)[^{}]*\{([^}]*)\}/g;
    for (let m = re.exec(api); m !== null; m = re.exec(api)) {
      const col = Number(m[1]);
      const mw = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(m[2]);
      if (mw) floors.set(col, Math.max(floors.get(col) ?? 0, Number(mw[1])));
    }
    for (const col of [1, 2, 3]) {
      assert.ok(floors.has(col), `第 ${col} 列缺 min-width 下限`);
      assert.ok(
        (floors.get(col) ?? 0) >= 120,
        `第 ${col} 列的 min-width 只有 ${floors.get(col)}px，太窄（下限至少 120px）`,
      );
    }
  });

  it('窄屏有卡片化兜底：行变 block、表头隐藏、表格解除 min-width', () => {
    const cards = mediaBlocks(api)
      .map((b) => ({ px: Number(/max-width:\s*(\d+)px/.exec(b.query)?.[1] ?? NaN), body: b.body }))
      .filter((b) => /\.page-api \.doc-table thead\s*\{[^}]*display:\s*none/.test(b.body));

    assert.equal(
      cards.length,
      1,
      '缺少（或多于一处）API 页卡片化断点（判据：`thead { display: none }`）',
    );
    const card = cards[0];
    assert.ok(
      Number.isFinite(card.px) && card.px >= 480 && card.px <= 1024,
      `卡片化断点 ${card.px}px 不合理：须落在 480–1024（太小救不了平板竖屏，太大吃掉桌面）`,
    );
    assert.match(
      card.body,
      /\.page-api \.doc-table tbody tr\s*\{[^}]*display:\s*block/,
      '行未变成块（卡片）',
    );
    assert.match(
      card.body,
      /\.page-api \.doc-table\s*\{[^}]*min-width:\s*0/,
      '卡片模式下未解除表格 min-width',
    );
    assert.match(
      card.body,
      /\.page-api \.doc-table td\s*\{[^}]*display:\s*block/,
      '能力格未变成块',
    );
  });
});

describe('官网手机版折叠菜单：CTA 按钮的边框完整性', () => {
  /**
   * 病例（2026-09-30 用户实报，390px 展开菜单后 GitHub 按钮只有左/上/右三条边）：
   *
   * `.nav-links a:last-child { border-bottom: none }` 的本意是「最后一条普通链接不必再画
   * 分隔线（菜单容器自带 border-bottom）」，但 **CTA 恒为最后一项** ⇒ 这条规则从来没作用在
   * 普通链接上，只每次都把 CTA 的**按钮下边框**抹掉 —— `.nav-links a:last-child` (0,2,1)
   * 压过 `.nav-links .nav-cta` 的 (0,2,0)。纯 CSS 的特异性压制肉眼看不出来（框少一条边
   * 在暗色下很容易当成设计），所以在这里钉两条：
   *  ① `border-bottom: none` 的选择器若用 `:last-child`，必须显式排除 `.nav-cta`；
   *  ② 折叠菜单块里 CTA 必须有四边完整的边框声明。
   */
  const nav = (() => {
    const blocks = mediaBlocks(raw).filter((b) => /\.nav-links \.nav-cta/.test(b.body));
    return blocks[blocks.length - 1]?.body ?? '';
  })();

  it('抹除 border-bottom 的 last-child 规则必须排除 .nav-cta', () => {
    const bare = /\.nav-links a:last-child\s*\{[^}]*border-bottom:\s*none/.exec(raw);
    assert.equal(
      bare,
      null,
      '出现裸 `a:last-child { border-bottom: none }` —— CTA 恒为最后一项，这条规则只会把' +
        '按钮的下边框抹掉（特异性压过 .nav-links .nav-cta）。要表达「最后一条普通链接不画线」，' +
        '请写成 `.nav-links a:not(.nav-cta):last-child`。',
    );
    assert.match(
      raw,
      /\.nav-links a:not\(\.nav-cta\):last-child\s*\{[^}]*border-bottom:\s*none/,
      '缺少「最后一条普通链接不画线」的规则（须以 :not(.nav-cta) 排除 CTA）',
    );
  });

  it('折叠菜单块里 CTA 有四边完整的边框', () => {
    assert.notEqual(nav, '', '找不到含 `.nav-links .nav-cta` 的折叠菜单断点');
    assert.match(
      nav,
      /\.nav-links \.nav-cta\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/,
      'CTA 缺四边 border 声明（`border:` 简写才保证四边一致）',
    );
  });
});
