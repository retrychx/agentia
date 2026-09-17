/* docs / api 共用：锚点 scrollspy + nav 滚动态（零依赖）。
 * 由两页各自逐字重复的内联 <script> 合并而来。 */
/* 锚点 scrollspy + nav 滚动态（零依赖） */
(() => {
  const nav = document.querySelector('.nav');
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 24), {
    passive: true,
  });

  const links = [...document.querySelectorAll('.docs-nav a')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const spy = () => {
    let current = sections[0];
    for (const sec of sections) {
      if (sec.getBoundingClientRect().top <= 120) current = sec;
    }
    // 末节比视口短时它**永远**轮不到：页面已滚到底，而它的顶边还在阈值 120px 之下
    // （实测 docs 页 #env 到底时仍在 263px 处）—— 于是最后一条链接永不点亮。
    // 到底就认末节。（只在页面真能滚时判定，否则首屏就会被判成「已在底部」。）
    const doc = document.documentElement;
    const atBottom =
      doc.scrollHeight > window.innerHeight + 2 &&
      window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
    if (atBottom) current = sections[sections.length - 1];
    links.forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current.id);
    });
  };
  window.addEventListener('scroll', spy, { passive: true });
  spy();
})();
