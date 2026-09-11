/* Agentia Playground —— 模拟演示回放引擎。
 * 全部数据为本地预置脚本（字段参照真实 trace：span 树 + usage），不发起任何真实模型调用。
 * 节奏用 setTimeout/Promise 编排；回放区为终端式面板，trace 树随 span start/end 同步生长。
 */
(() => {
  'use strict';

  /* ========== 预置场景脚本 ==========
   * 事件类型：
   *  { wait }                          停顿 ms
   *  { think }                         主 agent 思考行
   *  { menu }                          高亮菜单里的单元 chip
   *  { spanStart:{id,parent,kind,name} }  trace 开 span（kind: run/unit/llm.turn）
   *  { spanEnd:{id,ms,usage} }         trace 收尾（usage 累计到计数器）
   *  { llmOpen:{label,nested} }        终端面板开一个 llm.turn 输出块
   *  { stream }                        打字机流入最近的输出块
   *  { tool:{name,input,nested} }      tool_use 卡片（入参 JSON）
   *  { result:{text,nested} }          tool_result 卡片
   *  { note }                          分区说明（如「SubAgent 内部」）
   *  { finalOpen } / { done }          最终报告块 / run 收尾
   */
  const SCENARIOS = [
    {
      id: 'doc-review',
      title: '审查一份文档',
      kind: 'SubAgent · 隔离上下文',
      desc: '主 agent 派出子代理独立审查长文档，中间批注不外泄，只有结论回流。',
      task: '审查 docs/weekly-report.md，指出结构与事实性问题',
      menu: [
        { name: 'subagent:doc_reviewer', desc: '隔离审查文档' },
        { name: 'tool:read_file', desc: '读取文件片段' },
        { name: 'prompt:review_checklist', desc: '审查清单资产' },
      ],
      script: [
        { wait: 500, think: '任务是独立审查一份长文档——逐段批注会很长，不该污染主上下文。' },
        { wait: 700, spanStart: { id: 's1', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'llm.turn · 主 agent' } },
        { stream: '审查类任务会在中间产生大量逐段批注，适合放进隔离的子代理：doc_reviewer 有独立循环和裁剪上下文，只把审查结论回流给我。' },
        { wait: 300, spanEnd: { id: 's1', ms: 1320, usage: { input: 1450, output: 88 } } },
        { wait: 400, menu: 'subagent:doc_reviewer' },
        { wait: 500, spanStart: { id: 's2', parent: 'root', kind: 'unit', name: 'subagent:doc_reviewer' } },
        { tool: { name: 'subagent:doc_reviewer', input: { task: '审查 docs/weekly-report.md，指出结构与事实性问题', focus: ['结构', '事实', '数据口径'] } } },
        { wait: 600, note: '— SubAgent 内部（独立上下文，过程不外泄） —' },
        { wait: 300, spanStart: { id: 's3', parent: 's2', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'llm.turn · doc_reviewer', nested: true } },
        { stream: '先读文档开头两百行，摸清结构，再逐节核对数据引用。' },
        { wait: 200, spanEnd: { id: 's3', ms: 1580, usage: { input: 1180, output: 120 } } },
        { wait: 350, spanStart: { id: 's4', parent: 's2', kind: 'unit', name: 'tool:read_file' } },
        { tool: { name: 'tool:read_file', input: { path: 'docs/weekly-report.md', offset: 0, limit: 200 }, nested: true } },
        { wait: 700, result: { text: '已读取 200 行（全文共 342 行）。章节：摘要 / 核心指标 / 渠道分析 / 附录。', nested: true } },
        { spanEnd: { id: 's4', ms: 210 } },
        { wait: 400, spanStart: { id: 's5', parent: 's2', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'llm.turn · doc_reviewer', nested: true } },
        { stream: '发现三处问题：①「核心指标」环比口径与附录不一致；②第 3 节引用的 DAU 与摘要对不上；③渠道分析缺少数据来源标注。继续读完剩余部分后汇总结论。' },
        { wait: 200, spanEnd: { id: 's5', ms: 2360, usage: { input: 1940, output: 220 } } },
        { wait: 500, result: { text: '审查完成：3 处结构问题、2 处事实存疑、1 处数据口径不一致。已按章节给出逐条清单与修改建议。' } },
        { spanEnd: { id: 's2', ms: 6840, usage: { input: 3120, output: 340 } } },
        { wait: 600, note: '— 回到主 agent（只有结论回流） —' },
        { wait: 300, spanStart: { id: 's6', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' } },
        { finalOpen: {} },
        { stream: '文档审查结论\n\n① 结构：摘要与正文的指标口径不一致（第 2 节）；渠道分析缺数据来源标注。\n② 事实：第 3 节 DAU「12.4 万」与摘要「11.8 万」冲突，建议以数仓口径为准。\n③ 建议：统一环比定义，附录补充取数 SQL 与统计窗口。\n\n详细逐条清单已由 doc_reviewer 归档，可按需调取。' },
        { wait: 300, spanEnd: { id: 's6', ms: 1740, usage: { input: 2680, output: 310, cacheRead: 2340 } } },
        { done: {} },
      ],
    },
    {
      id: 'weekly-report',
      title: '生成上周运营周报',
      kind: 'Skill · 代码控制流程',
      desc: '先取数，再交给 Skill：调几次模型、怎么加工，全由代码决定。',
      task: '拉取上周核心指标，生成一份运营周报',
      menu: [
        { name: 'tool:query_metrics', desc: '查询运营指标' },
        { name: 'skill:weekly_report', desc: '代码控制的成稿流程' },
        { name: 'prompt:report_style', desc: '周报文体资产' },
      ],
      script: [
        { wait: 500, think: '需要真实的上周数据，再按固定流程成稿——取数用 Tool，成稿用 Skill。' },
        { wait: 700, spanStart: { id: 's1', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'llm.turn · 主 agent' } },
        { stream: '分两步：先用 query_metrics 拉上周核心指标，再交给 weekly_report 这个 Skill——它的成稿流程（调几次模型、怎么加工）是代码写死的，产出稳定可复现。' },
        { wait: 300, spanEnd: { id: 's1', ms: 1180, usage: { input: 1320, output: 74 } } },
        { wait: 400, menu: 'tool:query_metrics' },
        { wait: 500, spanStart: { id: 's2', parent: 'root', kind: 'unit', name: 'tool:query_metrics' } },
        { tool: { name: 'tool:query_metrics', input: { metrics: ['dau', 'wau', 'retention_d7', 'revenue'], week: '2026-W36' } } },
        { wait: 800, result: { text: 'DAU 均值 118,420（环比 +3.1%）；WAU 402,311；7 日留存 41.2%；营收 ¥2.31M（环比 -1.4%）。' } },
        { spanEnd: { id: 's2', ms: 340 } },
        { wait: 500, menu: 'skill:weekly_report' },
        { wait: 400, spanStart: { id: 's3', parent: 'root', kind: 'unit', name: 'skill:weekly_report' } },
        { tool: { name: 'skill:weekly_report', input: { week: '2026-W36', data: '见上一条指标结果' } } },
        { wait: 600, note: '— Skill 内部（ctx.llm() 由代码显式调用） —' },
        { wait: 300, spanStart: { id: 's4', parent: 's3', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'ctx.llm() · 数据解读', nested: true } },
        { stream: '解读指标：活跃度上行但营收微降，增长质量需关注；留存 41.2% 高于行业基准。' },
        { wait: 200, spanEnd: { id: 's4', ms: 1990, usage: { input: 1480, output: 210 } } },
        { wait: 400, spanStart: { id: 's5', parent: 's3', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'ctx.llm() · 按模板成稿', nested: true } },
        { stream: '按周报模板组织成三段：核心指标速览 / 异动分析 / 下周跟进项。' },
        { wait: 200, spanEnd: { id: 's5', ms: 2470, usage: { input: 1380, output: 250 } } },
        { wait: 500, result: { text: '周报已成稿：三段式结构，含 4 项指标、2 条异动解读、3 项跟进建议。' } },
        { spanEnd: { id: 's3', ms: 5210, usage: { input: 2860, output: 460 } } },
        { wait: 600, spanStart: { id: 's6', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' } },
        { finalOpen: {} },
        { stream: '运营周报 · 2026-W36\n\n核心指标：DAU 118,420（+3.1%）、WAU 402,311、7 日留存 41.2%、营收 ¥2.31M（-1.4%）。\n异动：活跃度与营收背离，建议排查付费转化漏斗。\n跟进：① 转化漏斗分渠道拆解；② 留存人群画像复核；③ 下周三前出营收归因简报。' },
        { wait: 300, spanEnd: { id: 's6', ms: 1490, usage: { input: 2410, output: 290, cacheRead: 2180, cacheCreation: 190 } } },
        { done: {} },
      ],
    },
    {
      id: 'weather-trip',
      title: '查天气并给出出行建议',
      kind: 'Tool + Prompt · 轻量编排',
      desc: '两次工具调用 + 一次文本资产拉取，主 agent 汇总成出行建议。',
      task: '周末从上海去杭州，查天气并给出出行建议',
      menu: [
        { name: 'tool:get_weather', desc: '查询城市天气' },
        { name: 'prompt:packing_playbook', desc: '出行清单资产' },
      ],
      script: [
        { wait: 500, think: '需要两地天气，再看有没有出行类的提示词资产可用。' },
        { wait: 700, spanStart: { id: 's1', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' } },
        { llmOpen: { label: 'llm.turn · 主 agent' } },
        { stream: '先查上海和杭州周末的天气；菜单里还有一份 packing_playbook 文本资产，适合拉进上下文辅助给建议。' },
        { wait: 300, spanEnd: { id: 's1', ms: 980, usage: { input: 1150, output: 62 } } },
        { wait: 400, menu: 'tool:get_weather' },
        { wait: 500, spanStart: { id: 's2', parent: 'root', kind: 'unit', name: 'tool:get_weather' } },
        { tool: { name: 'tool:get_weather', input: { city: '上海' } } },
        { wait: 600, result: { text: '上海：周六晴 24~31°C，周日多云 23~29°C，东南风 3 级。' } },
        { spanEnd: { id: 's2', ms: 180 } },
        { wait: 450, spanStart: { id: 's3', parent: 'root', kind: 'unit', name: 'tool:get_weather' } },
        { tool: { name: 'tool:get_weather', input: { city: '杭州' } } },
        { wait: 600, result: { text: '杭州：周六阵雨转晴 23~30°C，周日晴 22~28°C，湿度 78%。' } },
        { spanEnd: { id: 's3', ms: 190 } },
        { wait: 500, menu: 'prompt:packing_playbook' },
        { wait: 400, spanStart: { id: 's4', parent: 'root', kind: 'unit', name: 'prompt:packing_playbook' } },
        { tool: { name: 'prompt:packing_playbook', input: {} } },
        { wait: 500, result: { text: '已拉取文本资产：短途出行清单（雨具 / 防晒 / 证件 / 充电宝……），共 640 字注入上下文。' } },
        { spanEnd: { id: 's4', ms: 40 } },
        { wait: 600, spanStart: { id: 's5', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' } },
        { finalOpen: {} },
        { stream: '出行建议 · 上海 → 杭州（周末）\n\n天气：杭州周六上午有阵雨，午后转晴；周日全晴。建议周六午后再进景区。\n衣物：白天 28~30°C 短袖即可，湿度大，备一件速干外套。\n装备：折叠伞必带；防晒 SPF30+；高铁往返注意返程末班。\n行程：周六午后西湖东线，周日早起灵隐寺避开人流。' },
        { wait: 300, spanEnd: { id: 's5', ms: 1620, usage: { input: 2260, output: 340, cacheRead: 2010 } } },
        { done: {} },
      ],
    },
  ];

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

  /* 单价（$/M tokens），仅演示 */
  const PRICE = { input: 3, output: 15 };

  const state = {
    scenario: SCENARIOS[0],
    running: false,
    gen: 0, // 取消令牌：重播/切换场景时作废旧循环
    mode: 'sim', // 'sim' 模拟演示 | 'real' 真实模型（BYOK，由 playground-real.js 接管）
    realRun: null, // playground-real.js 注册的真实模式入口
    onScenarioChange: null, // 场景切换钩子（真实模式用来换菜单/system）
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtNum = (n) => n.toLocaleString('en-US');
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms');
  /* span 入参摘要：写进 trace 行，否则同名 unit（如两次 tool:get_weather）无法区分 */
  const fmtArg = (v) => {
    if (v == null) return '';
    let s;
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return ''; // 无入参就不显示，避免行里多一个 "{}"
      s = '{ ' + keys.slice(0, 4).map((k) => {
        let sv = typeof v[k] === 'object' ? JSON.stringify(v[k]) : String(v[k]);
        if (sv.length > 22) sv = sv.slice(0, 21) + '…';
        return k + ': ' + sv;
      }).join(', ') + (keys.length > 4 ? ', …' : '') + ' }';
    } else s = String(v);
    return s.length > 62 ? s.slice(0, 61) + '…' : s;
  };

  /* ========== 场景选择与按钮 ========== */
  function renderScenarios() {
    scenariosEl.innerHTML = '';
    SCENARIOS.forEach((sc) => {
      const btn = document.createElement('button');
      btn.className = 'pg-scenario' + (sc === state.scenario ? ' active' : '');
      btn.innerHTML =
        `<span class="pg-sc-kind">${sc.kind}</span><h3>${sc.title}</h3><p>${sc.desc}</p>`;
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
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mdInline(s) {
    return escHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
        /^(https?:|mailto:)/i.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>' : m);
  }

  /* 结构用原文解析（`>`/`*`/`#` 这类标记不能被提前转义），行内文本进入 mdInline 时才转义 */
  function mdToHtml(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    let out = '';
    let inCode = false;
    let codeBuf = [];
    let listType = null;
    let para = [];
    const flushPara = () => {
      if (para.length) { out += '<p>' + para.map(mdInline).join('<br />') + '</p>'; para = []; }
    };
    const closeList = () => { if (listType) { out += '</' + listType + '>'; listType = null; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (!inCode) { flushPara(); closeList(); inCode = true; codeBuf = []; }
        else { inCode = false; out += '<pre class="md-pre"><code>' + escHtml(codeBuf.join('\n')) + '</code></pre>'; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); closeList(); out += '<h' + h[1].length + '>' + mdInline(h[2].trim()) + '</h' + h[1].length + '>'; continue; }

      if (/^\s*[-*•]\s+/.test(line)) {
        flushPara();
        if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul'; }
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
      if (line.trim() === '') { flushPara(); continue; }
      closeList();
      if (/^\s*>\s?/.test(line)) { flushPara(); out += '<blockquote>' + mdInline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out += '<hr />'; continue; }
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

  /* ========== trace 树 ========== */
  let traceRoot = null;
  const spanMap = new Map();

  function traceReset(sc) {
    traceRoot = {
      id: 'root',
      kind: 'run',
      name: 'run · ' + sc.title,
      children: [],
      done: false,
      ms: 0,
      usage: { input: 0, output: 0 },
    };
    spanMap.clear();
    spanMap.set('root', traceRoot);
    renderTrace();
  }

  function traceStart(s) {
    const node = {
      id: s.id,
      kind: s.kind,
      name: s.name,
      arg: s.arg || '',
      children: [],
      done: false,
      ms: 0,
      status: 'ok',
      error: null,
      usage: null,
    };
    spanMap.set(s.id, node);
    const parent = spanMap.get(s.parent) || traceRoot;
    parent.children.push(node);
    renderTrace();
  }

  function traceEnd(s, usageAcc) {
    const node = spanMap.get(s.id);
    if (!node) return;
    node.done = true;
    node.ms = s.ms || 0;
    node.status = s.status || 'ok';
    node.error = s.error || null;
    if (s.arg) node.arg = s.arg;
    node.usage = s.usage
      ? {
          input: s.usage.input || 0,
          output: s.usage.output || 0,
          cacheRead: s.usage.cacheRead || 0,
          cacheCreation: s.usage.cacheCreation || 0,
        }
      : null;
    // 计数器只累加 llm.turn（unit span 的 usage 是子 span 聚合，重复计入会双算）
    if (s.usage && node.kind === 'llm.turn') {
      usageAcc.input += node.usage.input;
      usageAcc.output += node.usage.output;
      usageAcc.cacheRead = (usageAcc.cacheRead || 0) + node.usage.cacheRead;
      usageAcc.cacheCreation = (usageAcc.cacheCreation || 0) + node.usage.cacheCreation;
      renderUsage(usageAcc);
    }
    renderTrace();
  }

  function traceFinish(ms, usageAcc) {
    traceRoot.done = true;
    traceRoot.ms = ms;
    traceRoot.usage = { input: usageAcc.input, output: usageAcc.output };
    renderTrace();
  }

  function renderTrace() {
    traceBody.innerHTML = '';
    const rows = [];
    (function walk(node, prefix, isLast, isRoot) {
      rows.push({ node, prefix, isRoot });
      const kids = node.children;
      kids.forEach((kid, i) => {
        const last = i === kids.length - 1;
        const next = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
        walk(kid, next, last, false);
      });
    })(traceRoot, '', true, true);

    rows.forEach(({ node, prefix, isRoot }, idx) => {
      const bad = node.done && node.status === 'error';
      const row = el('div', 'tr-row' + (node.done ? '' : ' running') + (bad ? ' error' : ''));
      row.dataset.kind = node.kind;
      const branch = isRoot ? '' : prefix + (idx === rows.length - 1 || isLastChild(node) ? '└─ ' : '├─ ');
      row.appendChild(el('span', 'tr-pre', branch));
      row.appendChild(el('span', 'tr-dot', node.done ? (bad ? '✕' : '●') : '◌'));
      row.appendChild(el('span', 'tr-name', node.name));
      if (node.arg) {
        const arg = el('span', 'tr-arg', node.arg);
        arg.title = node.arg;
        row.appendChild(arg);
      }
      let meta;
      if (node.done) {
        const parts = [fmtMs(node.ms)];
        if (node.usage) {
          parts.push(fmtNum(node.usage.input + node.usage.output) + ' tok');
          const cr = node.usage.cacheRead || 0;
          const cc = node.usage.cacheCreation || 0;
          if (cr || cc) parts.push('cache ↑' + fmtNum(cr) + ' ↓' + fmtNum(cc));
        }
        if (bad) parts.push((node.error && node.error.type) || 'error');
        meta = parts.join(' · ');
      } else meta = '…';
      const metaEl = el('span', 'tr-meta', meta);
      if (bad && node.error && node.error.message) metaEl.title = node.error.message;
      row.appendChild(metaEl);
      traceBody.appendChild(row);
    });
  }

  /* 脚本里 tool 事件紧跟其 unit span 的 spanStart：把入参挂到同名、尚未带入参的最后一个 span 上 */
  function attachSpanArg(name, input) {
    let target = null;
    for (const n of spanMap.values()) if (n.kind === 'unit' && n.name === name && !n.arg) target = n;
    if (target) {
      target.arg = fmtArg(input);
      renderTrace();
    }
  }

  function isLastChild(node) {
    const parent = [...spanMap.values()].find((n) => n.children.includes(node));
    return parent ? parent.children[parent.children.length - 1] === node : true;
  }

  /* ========== usage 计数器 ========== */
  function renderUsage(acc) {
    uIn.textContent = fmtNum(acc.input);
    uOut.textContent = fmtNum(acc.output);
    if (PRICE.input == null || PRICE.output == null) {
      uCost.textContent = '—'; // 无公开单价的端点不做估算（如 DeepSeek）
      return;
    }
    const cost = (acc.input * PRICE.input + acc.output * PRICE.output) / 1e6;
    uCost.textContent = '$' + cost.toFixed(4);
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
    const usageAcc = { input: 0, output: 0 };
    const startedAt = performance.now();

    for (const ev of sc.script) {
      if (state.gen !== gen) return; // 已被取消
      if (ev.wait) {
        await sleep(ev.wait);
        if (state.gen !== gen) return;
      }
      if (ev.think) panelThink(ev.think);
      if (ev.menu) {
        menuEl.querySelectorAll('.pg-chip').forEach((c) =>
          c.classList.toggle('on', c.dataset.name === ev.menu),
        );
      }
      if (ev.spanStart) traceStart(ev.spanStart);
      if (ev.spanEnd) traceEnd(ev.spanEnd, usageAcc);
      if (ev.llmOpen) panelLlmOpen(ev.llmOpen.label, ev.llmOpen.nested);
      if (ev.stream) await panelStream(ev.stream, gen);
      if (ev.tool) {
        panelTool(ev.tool.name, ev.tool.input, ev.tool.nested);
        attachSpanArg(ev.tool.name, ev.tool.input);
      }
      if (ev.result) panelResult(ev.result.text, ev.result.nested);
      if (ev.note) panelNote(ev.note);
      if (ev.finalOpen) panelFinalOpen();
      if (ev.done) {
        traceFinish(Math.round(performance.now() - startedAt), usageAcc);
        addBlock(el('div', 'tp-note', '— run 完成：trace 已归档，runId == traceId —'));
      }
    }
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
      menuEl.querySelectorAll('.pg-chip').forEach((c) =>
        c.classList.toggle('on', c.dataset.name === name),
      );
    },
    traceReset,
    traceStart,
    traceEnd,
    traceFinish,
    renderUsage,
    resetPanels,
    setRunning,
    setPrice(p) {
      PRICE.input = p && p.input != null ? p.input : null;
      PRICE.output = p && p.output != null ? p.output : null;
    },
  };

  /* nav 滚动态（与 main.js 一致） */
  const nav = $('.nav');
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 24), { passive: true });

  /* 初始化 */
  renderScenarios();
  renderMenu(state.scenario);
  resetPanels();
  btnReplay.disabled = false;
})();
