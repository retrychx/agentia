/* Agentia 官网动效：canvas 编排网络 + GSAP 滚动动画 + Lenis 平滑滚动。
 * Astro 迁移：GSAP / ScrollTrigger / Lenis 从 CDN 全局改为本地打包 import（不再依赖 window 全局）。 */
import gsap from 'gsap';
import ScrollTrigger from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = true; // gsap 由上方 import 保证存在（原先判断 gsap）

  /* 首屏不再有 backdrop canvas —— 那块位置改由「真 trace 自播」承担（见 hero-trace.js：
     复用 @migor/trace-view 渲染器 + 与 playground 同一份场景脚本）。通用节点网络的
     那 145 行随之下线：它不说这个框架的任何独特之处。 */

  if (reduced || !hasGsap) return;

  /* ---------- Lenis 平滑滚动 ---------- */
  let lenis = null;
  if (typeof Lenis !== 'undefined') {
    lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 0.95 });
    lenis.on('scroll', () => ScrollTrigger && ScrollTrigger.update());
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    // 锚点链接走 lenis
    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href');
        if (id.length > 1 && document.querySelector(id)) {
          e.preventDefault();
          lenis.scrollTo(id, { offset: -60 });
        }
      });
    });
  }

  gsap.registerPlugin(ScrollTrigger);
  document.documentElement.classList.add('gsap-on');

  /* ---------- 字体就绪后再落布局 ----------
   * 自定义字体是 latin 子集、页面以中文为主，`font-display: swap` 落地时会把**拉丁字符**
   * 换一次字（中文回退 PingFang，不动）。而 Lenis 的滚动上限与 ScrollTrigger 的元素位置
   * 都是**测量时缓存**的 —— 不在字体落定后 refresh，缓存就是过期的，滚动会抖/跳。
   * （当前换字引起的位移很小，但这是必须堵上的缝。）
   * 上限 1.5s：字体万一取不到（离线/被拦截）也要让入场照常开始，不能把首屏吊死。 */
  const fontsReady =
    document.fonts && document.fonts.ready
      ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))])
      : Promise.resolve();
  const syncScrollMetrics = () => {
    if (lenis) lenis.resize();
    ScrollTrigger.refresh();
  };
  fontsReady.then(syncScrollMetrics);
  window.addEventListener('load', syncScrollMetrics, { once: true });

  /* ---------- Hero 入场 ----------
   * `paused` 起手、等字体就绪再播：否则入场动画会和「换字」叠在同一段时间里，
   * 观感就是那一下卡顿。 */
  gsap.set('[data-intro]', { opacity: 0, y: 26 });
  // 关键词高亮：CSS 的默认态是「已点亮」，这里只把起点拉回 0，动画负责扫出来。
  // （反过来做的话，JS 一旦没跑起来高亮就整个丢了。）
  gsap.set('.hero-sub .hl', { backgroundSize: '0% 100%' });
  const introTl = gsap
    .timeline({ defaults: { ease: 'power3.out' }, paused: true })
    .to('.hero-kicker', { opacity: 1, y: 0, duration: 0.7 }, 0.15)
    .to('.hero h1 .line', { opacity: 1, y: 0, duration: 0.9, stagger: 0.12 }, 0.3)
    .to('.hero-sub', { opacity: 1, y: 0, duration: 0.8 }, 0.65)
    // 副标落位后，两处关键词像记号笔一样自左扫过；错开一点，读起来有先后
    .to(
      '.hero-sub .hl',
      { backgroundSize: '100% 100%', duration: 0.7, stagger: 0.16, ease: 'power2.inOut' },
      1.0,
    )
    .to('.hero-actions', { opacity: 1, y: 0, duration: 0.7 }, 0.85)
    .to('.hero-install', { opacity: 1, y: 0, duration: 0.7 }, 1.0)
    // hero 统计行此前漏在 timeline 之外：[data-intro] 被统设为 opacity:0 后没人点亮它，
    // 线上一直是不可见的（视觉上「少了」一行）。补进 timeline，并让各项错开弹入。
    .to('.hero-stats', { opacity: 1, y: 0, duration: 0.6 }, 1.1)
    .from(
      '.hero-stats > span, .hero-stats > i',
      { opacity: 0, scale: 0.85, duration: 0.4, stagger: 0.07, ease: 'back.out(2)' },
      1.22,
    );
  fontsReady.then(() => introTl.play());

  /* ---------- 区块标题 reveal ---------- */
  document.querySelectorAll('[data-reveal]').forEach((el) => {
    gsap.fromTo(
      el,
      { opacity: 0, y: 28 },
      {
        opacity: 1,
        y: 0,
        duration: 0.8,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 86%' },
      },
    );
  });

  /* ---------- 卡片批量 stagger ---------- */
  ScrollTrigger.batch('[data-card]', {
    start: 'top 88%',
    onEnter: (batch) =>
      gsap.fromTo(
        batch,
        { opacity: 0, y: 34 },
        { opacity: 1, y: 0, duration: 0.7, stagger: 0.09, ease: 'power3.out', overwrite: true },
      ),
  });

  /* ---------- nav 滚动态 ---------- */
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
