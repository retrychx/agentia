/* Agentia Playground —— 模拟演示回放引擎。
 * 全部数据为本地预置脚本（字段参照真实 trace：span 树 + usage），不发起任何真实模型调用。
 * 节奏用 setTimeout/Promise 编排；回放区为终端式面板，trace 树随 span start/end 同步生长。
 */
import { createTraceView, fmtArg, rawArg, fmtNum, fmtMs } from '@migor/trace-view';
import { SCENARIOS } from './scenarios.js';
import { playScript } from './trace-player.js';

(() => {
  /* 预置场景脚本与回放游标都抽到了同级模块（首屏自播共用同一份数据与节奏）。 */

  /* ========== DOM ========== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const layoutEl = $('#pg-layout');
  const scenariosEl = $('#pg-scenarios');
  const menuEl = $('#pg-menu');
  const termBody = $('#term-body');
  const traceBody = $('#trace-body');
  const btnRun = $('#btn-run');
  const btnReplay = $('#btn-replay');
  const uIn = $('#u-in');
  const uOut = $('#u-out');
  const uCost = $('#u-cost');

  /* 单价（$/M tokens），仅演示 —— 与框架内置价格表（src/engine/usage.ts 的
     DEFAULT_PRICING）的 claude-opus-5 行保持一致；场景脚本里的 span 名也是它 */
  const PRICE = { input: 5, output: 25 };

  const state = {
    scenario: SCENARIOS[0],
    running: false,
    gen: 0, // 取消令牌：重播/切换场景时作废旧循环
    mode: 'sim', // 'sim' 模拟演示 | 'real' 真实模型（BYOK，由 playground-real.js 接管）
    realRun: null, // playground-real.js 注册的真实模式入口
    onScenarioChange: null, // 场景切换钩子（真实模式用来换菜单/system）
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ========== 场景选择与按钮 ========== */
  function renderScenarios() {
    scenariosEl.innerHTML = '';
    SCENARIOS.forEach((sc) => {
      const btn = document.createElement('button');
      btn.className = 'pg-scenario' + (sc === state.scenario ? ' active' : '');
      btn.innerHTML = `<span class="pg-sc-kind">${sc.kind}</span><h3>${sc.title}</h3><p>${sc.desc}</p>`;
      btn.addEventListener('click', () => {
        if (state.running || sc === state.scenario) return;
        state.gen++; // 作废任何残留循环
        state.scenario = sc;
        renderScenarios();
        renderMenu(sc);
        resetPanels();
        if (state.onScenarioChange) state.onScenarioChange(sc);
      });
      scenariosEl.appendChild(btn);
    });
  }

  function renderMenu(sc) {
    menuEl.innerHTML = '';
    sc.menu.forEach((m) => {
      const chip = document.createElement('span');
      chip.className = 'pg-chip';
      chip.dataset.name = m.name;
      chip.title = m.desc;
      chip.textContent = m.name;
      menuEl.appendChild(chip);
    });
  }

  function setRunning(on) {
    state.running = on;
    layoutEl.classList.toggle('locked', on);
    btnRun.disabled = on;
    btnReplay.disabled = on;
  }

  /* ========== 终端面板 ========== */
  function scrollTerm() {
    termBody.scrollTop = termBody.scrollHeight;
  }

  let streamEl = null; // 当前打字机目标

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addBlock(node) {
    termBody.appendChild(node);
    scrollTerm();
    return node;
  }

  function panelThink(text) {
    addBlock(el('div', 'tp-block tp-think', '主 agent 思考中… ' + text));
  }

  function panelNote(text) {
    addBlock(el('div', 'tp-note', text));
  }

  function panelLlmOpen(label, nested) {
    const block = el('div', 'tp-block tp-llm' + (nested ? ' tp-nested' : ''));
    block.appendChild(el('div', 'tp-head', label));
    streamEl = el('div', 'tp-stream tp-caret');
    block.appendChild(streamEl);
    addBlock(block);
  }

  function panelFinalOpen() {
    const block = el('div', 'tp-block tp-final');
    block.appendChild(el('div', 'tp-head', '✓ 最终报告'));
    streamEl = el('div', 'tp-stream tp-caret');
    block.appendChild(streamEl);
    addBlock(block);
  }

  /* ========== 轻量 Markdown 渲染（零依赖、先转义后转换，杜绝 HTML 注入） ==========
     模型返回的是 Markdown（粗体 / 标题 / 有序列表 / 行内代码 / 代码块），早期实现按纯文本
     直出，`**上海**`、`#`、`1.` 都原样显示。这里做一个够用的子集渲染器；不用 CDN 脚本。 */
  const escHtml = (s) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  function mdInline(s) {
    return escHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
        /^(https?:|mailto:)/i.test(u)
          ? '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'
          : m,
      );
  }

  /* 结构用原文解析（`>`/`*`/`#` 这类标记不能被提前转义），行内文本进入 mdInline 时才转义 */
  function mdToHtml(src) {
    const lines = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .split('\n');
    let out = '';
    let inCode = false;
    let codeBuf = [];
    let listType = null;
    let para = [];
    const flushPara = () => {
      if (para.length) {
        out += '<p>' + para.map(mdInline).join('<br />') + '</p>';
        para = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out += '</' + listType + '>';
        listType = null;
      }
    };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (!inCode) {
          flushPara();
          closeList();
          inCode = true;
          codeBuf = [];
        } else {
          inCode = false;
          out += '<pre class="md-pre"><code>' + escHtml(codeBuf.join('\n')) + '</code></pre>';
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        closeList();
        out += '<h' + h[1].length + '>' + mdInline(h[2].trim()) + '</h' + h[1].length + '>';
        continue;
      }

      if (/^\s*[-*•]\s+/.test(line)) {
        flushPara();
        if (listType !== 'ul') {
          closeList();
          out += '<ul>';
          listType = 'ul';
        }
        out += '<li>' + mdInline(line.replace(/^\s*[-*•]\s+/, '')) + '</li>';
        continue;
      }
      const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== 'ol') {
          closeList();
          const start = parseInt(ol[1], 10);
          out += '<ol' + (start > 1 ? ' start="' + start + '"' : '') + '>';
          listType = 'ol';
        }
        out += '<li>' + mdInline(ol[2]) + '</li>';
        continue;
      }

      /* 空行只断段落、不断列表：模型常在有序列表项之间插空行（松散列表），
         若在这里就 closeList()，每个列表项都会各自成为一个 <ol>，
         标记全部从 1 重新计数 —— 表现为「每一条都是 1.」。 */
      if (line.trim() === '') {
        flushPara();
        continue;
      }
      closeList();
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        out += '<blockquote>' + mdInline(line.replace(/^\s*>\s?/, '')) + '</blockquote>';
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        out += '<hr />';
        continue;
      }
      para.push(line);
    }
    flushPara();
    if (inCode) out += '<pre class="md-pre"><code>' + escHtml(codeBuf.join('\n')) + '</code></pre>'; // 未闭合的代码块
    closeList();
    return out;
  }

  async function panelStream(text, gen) {
    if (!streamEl) panelLlmOpen('llm.turn');
    const target = streamEl;
    target.classList.add('md'); // 交给 Markdown 样式（white-space 由 normal 接管）
    for (let i = 0; i < text.length; i += 2) {
      if (state.gen !== gen) return;
      target.__raw = (target.__raw || '') + text.slice(i, i + 2);
      target.innerHTML = mdToHtml(target.__raw);
      scrollTerm();
      await sleep(14);
    }
    target.innerHTML = mdToHtml(target.__raw || '');
    target.classList.remove('tp-caret');
  }

  function panelTool(name, input, nested) {
    const block = el('div', 'tp-block tp-tool' + (nested ? ' tp-nested' : ''));
    block.appendChild(el('div', 'tp-head', 'tool_use · ' + name));
    block.appendChild(el('pre', null, JSON.stringify(input, null, 2)));
    addBlock(block);
  }

  function panelResult(text, nested) {
    const block = el('div', 'tp-block tp-result' + (nested ? ' tp-nested' : ''));
    block.appendChild(el('div', 'tp-head', 'tool_result'));
    block.appendChild(el('div', 'tp-body', text));
    addBlock(block);
  }

  /* ========== trace 树 ==========
     渲染器已抽到 @migor/trace-view —— 同一份也被 CLI `agentia dev` 的 inspector 复用
     （那边用 playTrace 吃真实 Trace），官网与本地面板不再各写一套、避免渲染漂移。
     下面的包装函数保持原有签名，调用方（含 playground-real.js 的共用面）无需改动。 */
  const view = createTraceView(traceBody, {
    price: PRICE,
    usage: { in: uIn, out: uOut, cost: uCost },
  });

  function traceReset(sc) {
    view.reset('run · ' + sc.title);
  }

  function traceStart(s) {
    view.start(s);
  }

  /* text = 折叠态摘要，full = 展开态全文。入参两个都要传：只传摘要时点开还是那 62 个字符
     （「假展开」）—— 渲染器无法从摘要反推原文，这个信息只有调用方有。 */
  function traceEvent(id, type, tool, text, ok, full) {
    view.event(id, type, tool, text, ok, full);
  }

  /* 第二参 usageAcc 由 view 内部维护（旧签名保留，兼容 playground-real.js） */
  function traceEnd(s) {
    view.end(s);
  }

  function traceFinish(ms, _usageAcc, status, error) {
    view.finish(ms, status, error);
  }

  function renderUsage(acc) {
    view.setUsage(acc);
  }

  /* ========== 回放引擎 ========== */
  function resetPanels() {
    termBody.innerHTML = '';
    termBody.appendChild(el('div', 'pg-term-empty', '任务：' + state.scenario.task));
    traceBody.innerHTML = '';
    traceBody.appendChild(el('div', 'tr-empty', '// 等待 run 开始…'));
    renderUsage({ input: 0, output: 0 });
    streamEl = null;
  }

  async function runScenario() {
    if (state.running) return;
    const sc = state.scenario;
    const gen = ++state.gen;
    setRunning(true);
    termBody.innerHTML = '';
    traceReset(sc);
    renderUsage({ input: 0, output: 0 });
    streamEl = null;

    /* trace 侧（span 生长、工具事件出入参的 LIFO 配对）交给共享游标 —— 官网首屏的真 trace
       自播走的是同一个游标，所以节奏与配对只有一份定义（见 trace-player.js）。
       本函数只负责终端面板与外层状态。 */
    await playScript({
      view,
      script: sc.script,
      sleep,
      isCancelled: () => state.gen !== gen,
      onStep: async (ev) => {
        if (ev.think) panelThink(ev.think);
        if (ev.menu) {
          menuEl.querySelectorAll('.pg-chip').forEach((c) => {
            c.classList.toggle('on', c.dataset.name === ev.menu);
          });
        }
        if (ev.llmOpen) panelLlmOpen(ev.llmOpen.label, ev.llmOpen.nested);
        if (ev.stream) await panelStream(ev.stream, gen);
        if (ev.tool) panelTool(ev.tool.name, ev.tool.input, ev.tool.nested);
        if (ev.result) panelResult(ev.result.text, ev.result.nested);
        if (ev.note) panelNote(ev.note);
        if (ev.finalOpen) panelFinalOpen();
        if (ev.done) {
          addBlock(el('div', 'tp-note', '— run 完成：trace 已归档，runId == traceId —'));
        }
      },
    });

    if (state.gen !== gen) return; // 已被取消（重播 / 切场景）
    setRunning(false);
  }

  /* ========== 运行入口分发 ==========
   * 模拟模式走 runScenario；真实模型模式（BYOK）由 playground-real.js
   * 注册 state.realRun 接管，复用下方同一套面板/trace 渲染函数。
   */
  function handleRun() {
    if (state.mode === 'real') {
      if (state.realRun) state.realRun();
      return;
    }
    runScenario();
  }

  btnRun.addEventListener('click', handleRun);
  btnReplay.addEventListener('click', handleRun);

  /* 暴露给 playground-real.js 的最小共用面（不改动模拟模式任何行为） */
  window.AgentiaPlayground = {
    SCENARIOS,
    state,
    sleep,
    fmtNum,
    fmtMs,
    fmtArg,
    rawArg,
    el,
    addBlock,
    panelThink,
    panelNote,
    panelLlmOpen,
    panelFinalOpen,
    panelStream,
    panelTool,
    panelResult,
    renderMenu,
    highlightMenu(name) {
      menuEl.querySelectorAll('.pg-chip').forEach((c) => {
        c.classList.toggle('on', c.dataset.name === name);
      });
    },
    traceReset,
    traceStart,
    traceEnd,
    traceEvent,
    traceFinish,
    renderUsage,
    resetPanels,
    setRunning,
    setPrice(p) {
      view.setPrice(p);
    },
  };

  /* nav 滚动态（与 main.js 一致） */
  const nav = $('.nav');
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 24), {
    passive: true,
  });

  /* 初始化 */
  renderScenarios();
  renderMenu(state.scenario);
  resetPanels();
  btnReplay.disabled = false;
})();
