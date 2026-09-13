/* 窄屏导航折叠：零依赖，四页共用（styles.css 在 ≤520px 才显示开关）。
   宽屏下 .nav-links 是普通 flex 行，开关隐藏、本脚本不产生任何可见影响。 */
(() => {
  /* 顶部滚动进度条（纯装饰、零依赖）。放在 nav 折叠逻辑之前：即使本页没有 nav-toggle，
     进度条也照常工作。Lenis 用的是真实滚动位置，所以 window scroll 事件同样触发。 */
  const bar = document.getElementById('scroll-progress');
  if (bar) {
    let queued = false;
    const update = () => {
      queued = false;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
  }

  const toggle = document.querySelector('.nav-toggle');
  const links = document.getElementById('nav-links');
  const nav = document.querySelector('.nav');
  if (!toggle || !links) return;

  const setOpen = (open) => {
    links.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    // 展开时给透明导航一条实底：否则菜单浮在 hero 上读不清
    nav?.classList.toggle('menu-open', open);
  };

  toggle.addEventListener('click', () => setOpen(!links.classList.contains('open')));
  // 选中即收起（同页锚点跳转后菜单不该继续挡着内容）
  links.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a')) setOpen(false);
  });
  // 视口变宽回到桌面布局时清掉展开态
  window.addEventListener('resize', () => {
    if (window.innerWidth > 520) setOpen(false);
  });
})();
