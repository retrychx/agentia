/* Agentia 官网动效：canvas 编排网络 + GSAP 滚动动画 + Lenis 平滑滚动。
 * Astro 迁移：GSAP / ScrollTrigger / Lenis 从 CDN 全局改为本地打包 import（不再依赖 window 全局）。 */
import gsap from 'gsap';
import ScrollTrigger from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = true; // gsap 由上方 import 保证存在（原先判断 gsap）

  /* ---------- Hero canvas：主 agent 调度单元的节点脉冲网络 ---------- */
  const canvas = document.getElementById('orchestra');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const ACCENT = '52, 203, 224';
    let W = 0;
    let H = 0;
    let dpr = 1;
    let nodes = [];
    let edges = [];
    let pulses = [];
    let mouseX = 0;
    let mouseY = 0;
    let running = true;

    function layout() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cx = W / 2;
      const cy = H * 0.52;
      const R = Math.min(W, H) * 0.34;
      const satellites = 7;
      nodes = [{ x: cx, y: cy, r: 4.5, hub: true, depth: 0.35, phase: 0 }];
      edges = [];
      for (let i = 0; i < satellites; i++) {
        const a = (i / satellites) * Math.PI * 2 - Math.PI / 2;
        const wobble = 0.82 + 0.3 * Math.sin(i * 2.7);
        nodes.push({
          x: cx + Math.cos(a) * R * wobble * 1.35,
          y: cy + Math.sin(a) * R * wobble * 0.85,
          r: 2.2,
          hub: false,
          depth: 0.5 + 0.5 * Math.random(),
          phase: Math.random() * Math.PI * 2,
          orbit: a,
        });
        edges.push([0, i + 1]);
      }
      // 卫星之间的少量弱连接（单元间协作）
      edges.push([1, 3], [2, 5], [4, 6], [3, 7]);
      pulses = [];
    }

    function spawnPulse() {
      if (pulses.length > 14) return;
      const e = edges[Math.floor(Math.random() * edges.length)];
      pulses.push({
        e,
        t: 0,
        speed: 0.004 + Math.random() * 0.006,
        dir: Math.random() > 0.35 ? 1 : -1, // 多数从 hub 出发
      });
    }

    let time = 0;
    function frame() {
      if (!running) return;
      time += 0.016;
      ctx.clearRect(0, 0, W, H);

      const px = (mouseX - 0.5) * 18;
      const py = (mouseY - 0.5) * 14;
      const pos = nodes.map((n) => ({
        x: n.x + px * n.depth + Math.sin(time * 0.7 + n.phase) * (n.hub ? 0 : 5),
        y: n.y + py * n.depth + Math.cos(time * 0.6 + n.phase) * (n.hub ? 0 : 5),
      }));

      // 边
      ctx.lineWidth = 1;
      for (const [a, b] of edges) {
        ctx.strokeStyle = `rgba(255,255,255,${a === 0 ? 0.1 : 0.05})`;
        ctx.beginPath();
        ctx.moveTo(pos[a].x, pos[a].y);
        ctx.lineTo(pos[b].x, pos[b].y);
        ctx.stroke();
      }

      // 脉冲
      if (Math.random() < 0.06) spawnPulse();
      pulses = pulses.filter((p) => p.t <= 1 && p.t >= 0);
      for (const p of pulses) {
        p.t += p.speed * p.dir;
        const [a, b] = p.e;
        const x = pos[a].x + (pos[b].x - pos[a].x) * p.t;
        const y = pos[a].y + (pos[b].y - pos[a].y) * p.t;
        const fade = Math.sin(Math.min(Math.max(p.t, 0), 1) * Math.PI);
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, `rgba(${ACCENT},${0.85 * fade})`);
        g.addColorStop(1, `rgba(${ACCENT},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // 节点
      nodes.forEach((n, i) => {
        if (n.hub) {
          const pulse = 1 + 0.12 * Math.sin(time * 1.6);
          const halo = ctx.createRadialGradient(pos[i].x, pos[i].y, 0, pos[i].x, pos[i].y, 26 * pulse);
          halo.addColorStop(0, `rgba(${ACCENT},0.30)`);
          halo.addColorStop(1, `rgba(${ACCENT},0)`);
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(pos[i].x, pos[i].y, 26 * pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(240, 246, 255, 0.95)'; // hub 白热核心 + 冰蓝光晕
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
        }
        ctx.beginPath();
        ctx.arc(pos[i].x, pos[i].y, n.r, 0, Math.PI * 2);
        ctx.fill();
      });

      if (!reduced) requestAnimationFrame(frame);
    }

    layout();
    window.addEventListener('resize', layout);
    window.addEventListener('pointermove', (e) => {
      mouseX = e.clientX / window.innerWidth;
      mouseY = e.clientY / window.innerHeight;
    });
    if (!reduced) {
      document.addEventListener('visibilitychange', () => {
        running = !document.hidden;
        if (running) requestAnimationFrame(frame);
      });
      requestAnimationFrame(frame);
    } else {
      frame(); // reduced-motion：只画一帧静态网络，不循环
    }
  }

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

  /* ---------- Hero 入场 ---------- */
  gsap.set('[data-intro]', { opacity: 0, y: 26 });
  gsap
    .timeline({ defaults: { ease: 'power3.out' } })
    .to('.hero-kicker', { opacity: 1, y: 0, duration: 0.7 }, 0.15)
    .to('.hero h1 .line', { opacity: 1, y: 0, duration: 0.9, stagger: 0.12 }, 0.3)
    .to('.hero-sub', { opacity: 1, y: 0, duration: 0.8 }, 0.65)
    .to('.hero-actions', { opacity: 1, y: 0, duration: 0.7 }, 0.85)
    .to('.hero-install', { opacity: 1, y: 0, duration: 0.7 }, 1.0);

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
