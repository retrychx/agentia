/* 窄屏导航折叠：零依赖，四页共用（styles.css 在 ≤520px 才显示开关）。
   宽屏下 .nav-links 是普通 flex 行，开关隐藏、本脚本不产生任何可见影响。 */
(() => {
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
