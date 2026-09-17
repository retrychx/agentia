/* 首屏：真 trace 自播 —— 把「run 长成调用树 + token/成本逐 span 记账」放到最贵的位置上。
 *
 * 为什么在这里：这页的文案把 trace 标成「核心」，而首屏此前只有一块通用节点网络 canvas
 * （不说这个框架的任何独特之处）。渲染器（@migor/trace-view）、场景脚本（./scenarios.js）、
 * 回放节奏（./trace-player.js）三样都是既有资产 —— 本文件只是把它们接到首屏，
 * 不新写渲染、不新写节奏，因此不会与 /playground 漂移。
 *
 * 三条硬约定（与站内既有动效一致）：
 *   · prefers-reduced-motion ⇒ 不播动画，直接落**完整静态终态**（脚本一次性跑完、等待归零）
 *   · 自播一次就停，不无限循环（有限时长的动画不会长期占 CPU；旧 canvas 是全屏每帧重绘）
 *   · 离屏 / 切到后台不空转：滚动离开首屏或页面隐藏时取消当前回放
 */
import { createTraceView } from '@migor/trace-view';
import { SCENARIOS } from './scenarios.js';
import { playScript } from './trace-player.js';

(() => {
  const treeEl = document.getElementById('hero-trace');
  if (!treeEl) return;

  const inEl = document.getElementById('hero-in');
  const outEl = document.getElementById('hero-out');
  const costEl = document.getElementById('hero-cost');
  const replayBtn = document.getElementById('hero-replay');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 单价（$/M tokens），与 playground 同源同值：框架内置价格表 DEFAULT_PRICING 的
     claude-opus-5 行（场景脚本里的 span 名就是它）。 */
  const PRICE = { input: 5, output: 25 };

  const view = createTraceView(treeEl, {
    price: PRICE,
    usage: { in: inEl, out: outEl, cost: costEl },
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sc = SCENARIOS[0];
  let gen = 0;

  async function play() {
    const my = ++gen;
    treeEl.innerHTML = '';
    view.reset(`run · ${sc.title}`);
    /* 不等 wait：reduced-motion 下要的是同一棵树的静态终态，不是「慢动作」。
       把每个 wait 归零即可，脚本本身一个字都不用改。 */
    const script = reduced ? sc.script.map((ev) => ({ ...ev, wait: 0 })) : sc.script;
    await playScript({
      view,
      script,
      sleep,
      isCancelled: () => gen !== my,
      // 首屏没有菜单 chip 与终端面板。菜单高亮这一步在首屏无对应物；其余步骤由游标处理 trace。
      // 顺带把视口跟到最新一行（树在固定高度里生长，不跟就会看不到新 span）。
      onStep: () => {
        treeEl.scrollTop = treeEl.scrollHeight;
      },
    });
  }

  /* 首屏入场时间线是等字体就绪才播的（见 site.js）—— 自播同样等字体，避免两段动效叠在一起；
     上限 1.5s，字体取不到也要照常开始。 */
  const fontsReady =
    document.fonts && document.fonts.ready
      ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))])
      : Promise.resolve();
  fontsReady.then(play);

  replayBtn?.addEventListener('click', () => {
    replayBtn.classList.add('busy');
    play().then(() => replayBtn.classList.remove('busy'));
  });

  /* 离开首屏（或切后台）就取消，别让它在看不见的地方继续跑 */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) gen += 1;
      },
      { threshold: 0 },
    ).observe(treeEl);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) gen += 1;
  });
})();
