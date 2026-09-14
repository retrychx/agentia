/**
 * 版式不变量（CSS 层）。为什么需要这份用例：
 *
 * 这个渲染器有两处缺陷**只存在于 CSS 里** —— JS 一行不用改就能复现，任何 DOM 用例都照不到：
 *
 *   ① 「压成窄缝」：正文用 `overflow-wrap: anywhere`，min-content 只有 1 个字符宽；一旦
 *      `.tr-open .tr-io` 没了 min-width，flex 会把它压到 16px（59 个字符挤成 34 行）。
 *      页面 scrollWidth === clientWidth、构建与部署全绿 —— 溢出检查一条都查不出来，只是读不了。
 *   ② 「caret 藏进 hover」：`.tr-caret` 静止 opacity 回到 0，可展开这件事就只剩已知者可见。
 *
 * 两处都是**已发布过**的缺陷（① 线上跑过一版，仓里现在这行注释就是它的墓碑）。所以按
 * 仓库里 `tests/docs/website-css.test.ts` 的既有做法，把它们钉成可执行的不变量。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const raw = readFileSync(new URL('../src/trace-view.css', import.meta.url), 'utf8');
// 注释先剥掉：注释里出现的 `{`/`}` 会把「按大括号切规则」的解析带偏
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某条选择器的声明块（同一条选择器可能出现多次，全部返回） */
function decls(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[},])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  return [...css.matchAll(re)].map((m) => m[1]);
}

/** 声明块 → 属性 map（值去空白，`!important` 一并去掉） */
function props(block) {
  const out = {};
  for (const part of block.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part
      .slice(i + 1)
      .replace(/!important/g, '')
      .trim();
  }
  return out;
}

const openIo = () => decls('.tr-row.tr-open .tr-io').map(props);
const caret = () => decls('.tr-caret').map(props);

describe('trace-view 版式不变量', () => {
  it('.tr-row.tr-open .tr-io 有非零 min-width —— 「压成窄缝」的判据', () => {
    const blocks = openIo();
    assert.ok(blocks.length > 0, '找不到 .tr-row.tr-open .tr-io 规则');

    const mins = blocks.map((p) => p['min-width']).filter(Boolean);
    assert.ok(
      mins.length > 0,
      '.tr-open 的正文必须显式声明 min-width：缺了它，overflow-wrap:anywhere 会让 flex 把正文压成一条 1 字符宽的窄缝',
    );
    for (const v of mins) {
      assert.notEqual(
        v,
        '0',
        'min-width: 0 正是窄缝的成因（可读宽度下限被抹掉了）—— 折叠态靠它出省略号，展开态不能沿用',
      );
    }
  });

  it('.tr-row.tr-open 允许换行（flex-wrap: wrap）—— min-width 才有落点', () => {
    const blocks = decls('.tr-row.tr-open').map(props);
    assert.ok(
      blocks.some((p) => p['flex-wrap'] === 'wrap'),
      '没有 flex-wrap: wrap 时，min-width 撑出来的宽度只会变成横向溢出，而不是换到下一行',
    );
  });

  it('.tr-caret 静止时是**满不透明度**的 --faint（常显且达 3:1）', () => {
    const blocks = caret();
    assert.ok(blocks.length > 0, '找不到 .tr-caret 规则');

    // 不写 opacity（默认 1）是允许的；写小了不行 —— 这条不是口味，是门槛：
    // caret 是交互指示器，WCAG 1.4.11 要求非文本 UI 组件 ≥3:1，而 0.75 的 --faint
    // 在官网 #0c0c0e 面板上实测只有 2.77:1（满不透明度 4.04:1）。
    const dimmed = blocks
      .flatMap((p) => (p.opacity === undefined ? [] : [p.opacity]))
      .filter((v) => Number(v) < 1);
    assert.equal(
      dimmed.length,
      0,
      `caret 静止 opacity=${dimmed.join('/')} —— 调暗或归零都等于「只有已经知道的人` +
        '才看得见这一行能展开」，且跌破非文本 UI 的 3:1 门槛（实测 2.77:1）。',
    );
  });

  it('caret 常显 ⇒ 正文右端留了窄槽，省略号不会被 ▸ 压住', () => {
    const blocks = decls('.tr-row[data-expandable] .tr-io').map(props);
    assert.ok(
      blocks.some((p) => p['padding-right']),
      'caret 常显时正文必须给右端的 caret 留出内边距，否则截断的「…」与 ▸ 叠在同一像素上',
    );
  });
});
