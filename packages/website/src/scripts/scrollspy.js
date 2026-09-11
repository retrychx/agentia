/* docs / api 共用：锚点 scrollspy + nav 滚动态（零依赖）。
 * 由两页各自逐字重复的内联 <script> 合并而来。 */
/* 锚点 scrollspy + nav 滚动态（零依赖） */
    (() => {
      const nav = document.querySelector('.nav');
      window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 24), { passive: true });

      const links = [...document.querySelectorAll('.docs-nav a')];
      const sections = links
        .map((a) => document.querySelector(a.getAttribute('href')))
        .filter(Boolean);
      const spy = () => {
        let current = sections[0];
        for (const sec of sections) {
          if (sec.getBoundingClientRect().top <= 120) current = sec;
        }
        links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + current.id));
      };
      window.addEventListener('scroll', spy, { passive: true });
      spy();
    })();
