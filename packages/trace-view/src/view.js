/* Agentia trace 调用树渲染器 —— 数据无关、零依赖。
 *
 * 只认五个动作：reset 开树 / start 开 span / event 记事件 / end 收 span / finish 收 run。
 * 谁喂它都行：官网 playground 的模拟回放脚本，或 fromTrace.js 的 playTrace（真实 Trace）。
 *
 * 视觉语言与语义（逐字取自 packages/website/src/scripts/playground.js，行为不变）：
 *   - 事件行（tool.input / tool.output）没有状态圈、没有耗时，比 span 行更轻；
 *   - 事件与子 span 按发生顺序混排（input 先于它触发的 unit span、output 后于它）——
 *     这个先后本身就是语义，不能拍平成一类；
 *   - 四类单元标识符（⚙ tool / ◆ skill / ¶ prompt / ⊕ subagent）只靠字形区分、不上类型色。
 *
 * 宿主需提供的 CSS 变量：--ice --faint --text（见 trace-view.css）。
 */

export const UNIT_ICO = { tool: '⚙', skill: '◆', prompt: '¶', subagent: '⊕' };

/** 单元类型取自名字前缀（tool: / skill: / prompt: / subagent:） */
export function unitTypeOf(name) {
  const t = String(name || '').split(':')[0];
  return UNIT_ICO[t] ? t : '';
}

export const fmtNum = (n) => n.toLocaleString('en-US');
export const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms');

/* span 入参摘要：写进 trace 行，否则同名 unit（如两次 tool:get_weather）无法区分 */
export function fmtArg(v) {
  if (v == null) return '';
  let s;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return ''; // 无入参就不显示，避免行里多一个 "{}"
    s =
      '{ ' +
      keys
        .slice(0, 4)
        .map((k) => {
          let sv = typeof v[k] === 'object' ? JSON.stringify(v[k]) : String(v[k]);
          if (sv.length > 22) sv = sv.slice(0, 21) + '…';
          return k + ': ' + sv;
        })
        .join(', ') +
      (keys.length > 4 ? ', …' : '') +
      ' }';
  } else s = String(v);
  return s.length > 62 ? s.slice(0, 61) + '…' : s;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 建一个绑定到 rootEl 的 trace 视图。
 * opts.price   = { input, output }（$/M tokens）或 null（无公开单价则不估算成本）
 * opts.usage   = { in, out, cost } 三个 DOM 节点（可选；给了才更新计数器）
 * opts.onUsage = (acc) => void（可选；每次累计后回调，便于宿主自定义展示）
 */
export function createTraceView(rootEl, opts = {}) {
  let price = opts.price ?? null;
  const onUsage = opts.onUsage ?? null;
  const usageEls = opts.usage ?? null;

  let traceRoot = null;
  const spanMap = new Map();
  const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  function renderTrace() {
    rootEl.innerHTML = '';
    const rows = [];
    /* 每个节点下【事件】与【子 span】按发生顺序混排：tool.input 先于它触发的 unit span、
       tool.output 后于它，这个先后本身就是语义，不能拍平成一类。 */
    (function walk(node, prefix, isLast, isRoot) {
      rows.push({ node, prefix, isRoot, last: isLast, ev: null });
      const items = node.order || [];
      items.forEach((it, i) => {
        const last = i === items.length - 1;
        const next = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
        if (it.t === 'span') walk(it.n, next, last, false);
        else rows.push({ node, prefix: next, isRoot: false, last, ev: it.e });
      });
    })(traceRoot, '', true, true);

    rows.forEach(({ node, prefix, isRoot, last, ev }) => {
      const branch = isRoot ? '' : prefix + (last ? '└─ ' : '├─ ');

      /* 事件行：没有 status 圈、没有耗时、不参与 usage 计数，只带入参/出参摘要 */
      if (ev) {
        const row = el('div', 'tr-row tr-ev' + (ev.ok === false ? ' error' : ''));
        row.dataset.ev = ev.type;
        row.dataset.unit = unitTypeOf(ev.tool);
        row.appendChild(el('span', 'tr-pre', branch));
        row.appendChild(el('span', 'tr-evv', ev.type === 'tool.output' ? '◂' : '▸'));
        row.appendChild(el('span', 'tr-evtype', ev.type));
        row.appendChild(el('span', 'tr-name', ev.tool));
        const io = el('span', 'tr-io', ev.text || '');
        io.title = ev.text || '';
        row.appendChild(io);
        rootEl.appendChild(row);
        return;
      }

      const bad = node.done && node.status === 'error';
      const row = el('div', 'tr-row' + (node.done ? '' : ' running') + (bad ? ' error' : ''));
      row.dataset.kind = node.kind;
      const ut = node.kind === 'unit' ? unitTypeOf(node.name) : '';
      if (ut) row.dataset.unit = ut;
      row.appendChild(el('span', 'tr-pre', branch));
      row.appendChild(el('span', 'tr-dot', node.done ? (bad ? '✕' : '●') : '◌'));
      if (ut) row.appendChild(el('span', 'tr-ico', UNIT_ICO[ut]));
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
      rootEl.appendChild(row);
    });
  }

  function renderUsage(acc) {
    if (onUsage) onUsage(acc);
    if (!usageEls) return;
    if (usageEls.in) usageEls.in.textContent = fmtNum(acc.input);
    if (usageEls.out) usageEls.out.textContent = fmtNum(acc.output);
    if (!usageEls.cost) return;
    if (price == null || price.input == null || price.output == null) {
      usageEls.cost.textContent = '—'; // 无公开单价的端点不做估算（如 DeepSeek）
      return;
    }
    const cost = (acc.input * price.input + acc.output * price.output) / 1e6;
    usageEls.cost.textContent = '$' + cost.toFixed(4);
  }

  /** 开树。rootName 为 run 根显示名（如 'run · 审查一份文档'） */
  function reset(rootName) {
    traceRoot = {
      id: 'root',
      kind: 'run',
      name: rootName || 'run',
      children: [],
      events: [],
      order: [],
      done: false,
      ms: 0,
      usage: { input: 0, output: 0 },
    };
    spanMap.clear();
    spanMap.set('root', traceRoot);
    usageAcc.input = 0;
    usageAcc.output = 0;
    usageAcc.cacheRead = 0;
    usageAcc.cacheCreation = 0;
    renderTrace();
  }

  function start(s) {
    const node = {
      id: s.id,
      kind: s.kind,
      name: s.name,
      arg: s.arg || '',
      children: [],
      events: [],
      order: [],
      done: false,
      ms: 0,
      status: 'ok',
      error: null,
      usage: null,
    };
    spanMap.set(s.id, node);
    const parent = spanMap.get(s.parent) || traceRoot;
    parent.children.push(node);
    parent.order.push({ t: 'span', n: node });
    renderTrace();
  }

  /* span 事件：框架把普通工具 / @Prompt 调用记成【turn 上的事件】，不给它们建 unit span
     （只有 skill / subagent 会 recorder.begin('unit', …)，见 engine/loop.ts）。
     events 与 order 并存：events 是数据、order 负责与子 span 的先后顺序。 */
  function event(id, type, tool, text, ok) {
    const node = spanMap.get(id);
    if (!node) return;
    const e = { type, tool, text, ok: ok !== false };
    node.events.push(e);
    node.order.push({ t: 'ev', e });
    renderTrace();
  }

  function end(s) {
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
      usageAcc.cacheRead += node.usage.cacheRead;
      usageAcc.cacheCreation += node.usage.cacheCreation;
      renderUsage(usageAcc);
    }
    renderTrace();
  }

  function finish(ms, status, error) {
    if (!traceRoot) return;
    traceRoot.done = true;
    traceRoot.ms = ms;
    // run 失败时根 span 也要标红：原先 status 恒为 ok，错误只体现在子 span 上
    traceRoot.status = status || 'ok';
    traceRoot.error = error || null;
    traceRoot.usage = { input: usageAcc.input, output: usageAcc.output };
    renderTrace();
  }

  return {
    reset,
    start,
    event,
    end,
    finish,
    render: renderTrace,
    setUsage: renderUsage,
    /** 换单价（如真实模式切服务商）：null 表示无公开单价 → 成本显示为 — */
    setPrice(p) {
      price = p ?? null;
      renderUsage(usageAcc);
    },
    get usage() {
      return usageAcc;
    },
  };
}
