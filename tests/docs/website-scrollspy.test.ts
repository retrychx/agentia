import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 官网 docs / api 页共用的 scrollspy：**滚到底必须点亮末条链接**。
 *
 * 为什么值得钉：末节常常比视口短，于是页面已经滚到底、它的顶边却仍在阈值（120px）之下 ——
 * 原实现只认「顶边 ≤ 120」，末节**永远**轮不到，最后一条导航永远不高亮。
 * 实测 docs 页末节 `#env` 到底时顶边在 263px：`needToHighlight 17148 > maxScroll 17005`。
 *
 * 这个缺陷在页面里不报错、不溢出、不影响任何现有断言（浏览器里要滚到底逐条看才看得出来），
 * 但脚本是纯 IIFE —— 喂一个假 document/window 就能在 Node 里**真跑**它，把几何当输入。
 * 于是这里不钉源码文本，钉行为：同一份真代码，四种几何。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const SCRIPT = join(repoRoot, 'packages', 'website', 'src', 'scripts', 'scrollspy.js');
const THRESHOLD = 120; // 与脚本内的判定阈值一致

interface Geometry {
  /** 各锚点节的视口相对顶边（getBoundingClientRect().top） */
  tops: Record<string, number>;
  scrollY: number;
  innerHeight: number;
  scrollHeight: number;
}

/** 跑**真实**的 scrollspy 源码，返回「当前被点亮的是哪个锚点」 */
function runSpy(ids: string[], geo: Geometry) {
  const src = readFileSync(SCRIPT, 'utf8');

  interface FakeLink {
    active: boolean;
    getAttribute(name: string): string | null;
    classList: { toggle(cls: string, on?: boolean): void };
  }
  const links: FakeLink[] = ids.map((id) => {
    const link = {
      active: false,
      getAttribute: (name: string) => (name === 'href' ? `#${id}` : null),
      classList: { toggle: () => {} },
    } as FakeLink;
    link.classList = {
      toggle: (cls: string, on?: boolean) => {
        if (cls === 'active') link.active = on === true;
      },
    };
    return link;
  });

  const sections = ids.map((id) => ({
    id,
    getBoundingClientRect: () => ({ top: geo.tops[id] ?? 99_999 }),
  }));

  const doc = {
    querySelector: (sel: string) => {
      const hit = sections.find((s) => `#${s.id}` === sel);
      return hit ?? null;
    },
    querySelectorAll: (sel: string) => (sel === '.docs-nav a' ? links : []),
    documentElement: { scrollHeight: geo.scrollHeight },
  };
  const nav = { classList: { toggle: () => {} } };
  const docWithNav = {
    ...doc,
    querySelector: (sel: string) => (sel === '.nav' ? nav : doc.querySelector(sel)),
  };

  const handlers: Array<() => void> = [];
  const win = {
    scrollY: geo.scrollY,
    innerHeight: geo.innerHeight,
    addEventListener: (type: string, cb: () => void) => {
      if (type === 'scroll') handlers.push(cb);
    },
  };

  // 真跑源码（IIFE，读 document/window 两个全局）
  new Function('document', 'window', src)(docWithNav, win);

  return {
    /** 重跑一次（模拟又滚动了一屏） */
    fire(scrollY: number) {
      win.scrollY = scrollY;
      for (const h of handlers) h();
    },
    active(): string | null {
      if (handlers.length === 0) return null;
      for (const h of handlers) h();
      const hit = links.find((l) => l.active);
      return hit ? hit.getAttribute('href') : null;
    },
  };
}

describe('官网 scrollspy（docs / api 共用）', () => {
  const IDS = ['start', 'middleware', 'budget', 'crosscut', 'env'];

  it('首屏（还没滚）：点亮第一条，不因「没在底部」而空着', () => {
    const spy = runSpy(IDS, {
      tops: { start: 300, middleware: 2500, budget: 6000, crosscut: 12000, env: 17000 },
      scrollY: 0,
      innerHeight: 900,
      scrollHeight: 17_905,
    });
    assert.equal(spy.active(), '#start');
  });

  it('中段：点亮「最后一个顶边已越过阈值」的那节', () => {
    const spy = runSpy(IDS, {
      tops: { start: -3000, middleware: -1000, budget: 300, crosscut: 5000, env: 12000 },
      scrollY: 9000,
      innerHeight: 900,
      scrollHeight: 30_000,
    });
    assert.equal(spy.active(), '#middleware');
  });

  it('滚到底且末节顶边仍在阈值之下（真实几何）：必须点亮末条 —— 回归守卫', () => {
    // docs 页实测：maxScroll 17005、innerHeight 900、#env 顶边 263（> 120）
    const spy = runSpy(IDS, {
      tops: { start: -16_000, middleware: -15_000, budget: -12_000, crosscut: -5000, env: 263 },
      scrollY: 17_005,
      innerHeight: 900,
      scrollHeight: 17_905,
    });
    assert.equal(
      spy.active(),
      '#env',
      '滚到底时末条链接必须高亮（末节比视口短 ⇒ 它永远到不了 ' + THRESHOLD + 'px 阈值）',
    );
  });

  it('页面不可滚（内容比视口短）：不得被误判成「已在底部」', () => {
    const spy = runSpy(IDS, {
      tops: { start: 200, middleware: 400, budget: 600, crosscut: 700, env: 800 },
      scrollY: 0,
      innerHeight: 900,
      scrollHeight: 800,
    });
    assert.equal(spy.active(), '#start');
  });

  it('从底部往回滚：应回到中段那节（底部判定不得粘住）', () => {
    const geo = {
      tops: { start: -16_000, middleware: -15_000, budget: -12_000, crosscut: -5000, env: 263 },
      scrollY: 17_005,
      innerHeight: 900,
      scrollHeight: 17_905,
    };
    const spy = runSpy(IDS, geo);
    assert.equal(spy.active(), '#env');
    geo.tops = { start: -3000, middleware: -1000, budget: 300, crosscut: 5000, env: 12_000 };
    spy.fire(9000);
    assert.equal(spy.active(), '#middleware');
  });
});
