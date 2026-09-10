/* Agentia Playground —— 真实模型模式（BYOK）。
 * 浏览器内迷你 agent 循环：fetch 直连 Anthropic Messages API（dangerous-direct-browser-access），
 * key 只存 localStorage。面板 / trace 树 / usage 计数全部复用 playground.js 暴露的
 * window.AgentiaPlayground 共用面，模拟模式代码路径不受影响。
 */
(() => {
  'use strict';

  const pg = window.AgentiaPlayground;
  if (!pg) return; // playground.js 未加载时不启用

  /* ========== DOM ========== */
  const $ = (sel) => document.querySelector(sel);
  const modeBar = $('#pg-mode');
  const badgeText = $('#pg-badge-text');
  const headSub = $('#pg-head-sub');
  const byokEl = $('#pg-byok');
  const keyInput = $('#byok-key');
  const modelInput = $('#byok-model');
  const btnClear = $('#byok-clear');
  const uNote = $('#u-note');
  if (!modeBar || !byokEl || !keyInput) return;

  const LS_KEY = 'agentia.byok.key';
  const LS_MODEL = 'agentia.byok.model';
  const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
  const MAX_ITERATIONS = 6;
  const API_URL = 'https://api.anthropic.com/v1/messages';

  /* 单价（$/M tokens）：模拟模式沿用 opus，真实模式按 haiku 4.5 */
  const PRICE_SIM = { input: 3, output: 15 };
  const PRICE_REAL = { input: 0.8, output: 4 };

  const COPY = {
    sim: {
      badge: '模拟演示：本地预置脚本，非真实模型调用',
      sub: '选一个任务，看主 agent 如何思考、从菜单选中单元、发起 llm.turn、调用单元并汇总产出。右侧 trace 调用树与 token 用量随回放同步生长。',
      note: '按 claude-opus 单价估算（input $3 / output $15 每百万 token），仅演示用途。',
    },
    real: {
      badge: '真实模型：浏览器直连 Anthropic API，产生真实 token 消耗',
      sub: '同一个任务，换真实模型跑一遍：浏览器内迷你 agent 循环直连 Anthropic Messages API，三个工具（天气 / 计算器 / 文本资产）为本地 JS 实现，trace 与 token 用量均为真实值。',
      note: 'token 为 API 返回真实值；成本按 claude-haiku-4.5 估算（input $0.8 / output $4 每百万 token），改模型后单价可能不准。',
    },
  };

  /* ========== 内置工具（与场景联动） ========== */
  const WEATHER = {
    上海: '上海：今天晴 24~31°C，明天多云 23~29°C，东南风 3 级。',
    杭州: '杭州：今天阵雨转晴 23~30°C，明天晴 22~28°C，湿度 78%。',
    北京: '北京：今天晴 18~27°C，明天晴 17~26°C，北风 2 级，空气良。',
    深圳: '深圳：今天多云有雷阵雨 26~32°C，明天阵雨 25~31°C，湿度 85%。',
    成都: '成都：今天阴 20~26°C，明天小雨 19~24°C，微风。',
  };

  const ASSETS = {
    'doc-weekly-report':
      '《运营周报 · 草稿》\n摘要：本周 DAU 均值 11.8 万，营收环比持平。\n核心指标：DAU 均值 12.4 万（环比 +3.1%），7 日留存 41.2%。\n渠道分析：自然量占比 62%，付费渠道占比 38%（未标注数据来源）。\n附录：取数 SQL 与统计窗口待补。',
    'review-checklist':
      '文档审查清单：① 摘要与正文指标口径一致；② 引用数据可溯源；③ 环比/同比定义统一；④ 章节结构完整（摘要 / 指标 / 分析 / 附录）。',
    'metrics-weekly':
      '上周核心指标：DAU 均值 118,420（环比 +3.1%）；WAU 402,311；7 日留存 41.2%；营收 ¥2.31M（环比 -1.4%）。',
    'report-style':
      '周报文体：三段式（核心指标速览 / 异动分析 / 下周跟进项）；每段不超过 4 条；指标保留一位小数；结论先行。',
    'packing-playbook':
      '短途出行清单：雨具（折叠伞）、防晒 SPF30+、证件、充电宝、速干外套、常用药；高铁出行留意返程末班时间。',
  };

  const TOOL_SCHEMAS = [
    {
      name: 'get_weather',
      description: '查询城市天气（演示数据，仅覆盖：上海 / 杭州 / 北京 / 深圳 / 成都）',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，如「上海」' } },
        required: ['city'],
      },
    },
    {
      name: 'calculator',
      description: '计算四则运算表达式，如 (118420-114858)/114858*100',
      input_schema: {
        type: 'object',
        properties: { expression: { type: 'string', description: '只含数字与 +-*/(). 的表达式' } },
        required: ['expression'],
      },
    },
    {
      name: 'read_asset',
      description: '读取预置文本资产（文档 / 清单 / 指标 / 文体 / 出行 playbook）',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: Object.keys(ASSETS), description: '资产名' },
        },
        required: ['name'],
      },
    },
  ];

  function execTool(name, input) {
    const t0 = performance.now();
    let text;
    let isError = false;
    try {
      if (name === 'get_weather') {
        const city = String((input && input.city) || '');
        text = WEATHER[city] || '未收录城市「' + city + '」（演示数据仅覆盖：' + Object.keys(WEATHER).join(' / ') + '）。';
      } else if (name === 'calculator') {
        const expr = String((input && input.expression) || '');
        if (!expr || !/^[0-9+\-*/().\s]+$/.test(expr)) {
          throw new Error('表达式只允许数字与 +-*/(). 字符');
        }
        const value = Function('"use strict"; return (' + expr + ');')();
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('表达式结果不是有限数值');
        }
        text = expr + ' = ' + value;
      } else if (name === 'read_asset') {
        const key = String((input && input.name) || '');
        text = ASSETS[key] || '资产「' + key + '」不存在（可选：' + Object.keys(ASSETS).join(' / ') + '）。';
      } else {
        throw new Error('未知工具：' + name);
      }
    } catch (e) {
      text = '工具执行失败：' + (e && e.message ? e.message : String(e));
      isError = true;
    }
    return { text, isError, ms: Math.max(1, Math.round(performance.now() - t0)) };
  }

  /* ========== 场景 → system 提示 ========== */
  const SYSTEMS = {
    'doc-review':
      '你是文档审查 agent。先用 read_asset 拉取「doc-weekly-report」文档与「review-checklist」清单，逐条核对结构、事实与数据口径（数字可用 calculator 验证），最后输出分条审查结论。用中文回答。',
    'weekly-report':
      '你是运营周报 agent。先用 read_asset 拉取「metrics-weekly」指标与「report-style」文体资产，需要算环比用 calculator，然后按文体要求产出一份简短周报。用中文回答。',
    'weather-trip':
      '你是出行建议 agent。用 get_weather 查相关城市天气（仅覆盖上海/杭州/北京/深圳/成都），需要时用 read_asset 拉取「packing-playbook」清单，最后给出分条出行建议。用中文回答。',
  };

  const REAL_MENU = [
    { name: 'tool:get_weather', desc: '查询城市天气（内置假数据）' },
    { name: 'tool:calculator', desc: '四则运算求值' },
    { name: 'tool:read_asset', desc: '读取预置文本资产' },
  ];

  /* ========== Anthropic API 直连 ========== */
  async function callApi(key, model, system, messages) {
    let resp;
    try {
      resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system,
          tools: TOOL_SCHEMAS,
          messages,
        }),
      });
    } catch (e) {
      throw { kind: 'network', cause: e };
    }
    if (!resp.ok) {
      let msg = '';
      try {
        const body = await resp.json();
        msg = (body && body.error && body.error.message) || '';
      } catch (_) { /* 忽略非 JSON 错误体 */ }
      throw { kind: 'http', status: resp.status, message: msg };
    }
    return resp.json();
  }

  /* ========== 错误块（含重试） ========== */
  function panelError(text) {
    const block = pg.el('div', 'tp-block tp-error');
    block.appendChild(pg.el('div', 'tp-head', '✕ 调用失败'));
    block.appendChild(pg.el('div', 'tp-body', text));
    const retry = pg.el('button', 'tp-retry', '重试');
    retry.addEventListener('click', () => realRun());
    block.appendChild(retry);
    pg.addBlock(block);
  }

  function describeError(err) {
    if (err && err.kind === 'http') {
      if (err.status === 401) return '鉴权失败（401）：API key 无效或已撤销，请检查上面的 key 后重试。';
      if (err.status === 429) return '触发限流（429）：请求太密或额度不足，请稍后重试。';
      return 'API 返回错误（HTTP ' + err.status + '）' + (err.message ? '：' + err.message : '。');
    }
    return '网络 / CORS 错误：浏览器未能连通 api.anthropic.com。本页通过 anthropic-dangerous-direct-browser-access 直连 Anthropic（不经过任何服务器）；若请求被拦截，请检查网络连通性、代理或屏蔽跨域的浏览器扩展。';
  }

  /* ========== 真实模式主循环 ========== */
  async function realRun() {
    if (pg.state.running) return;
    const key = keyInput.value.trim();
    if (!key) {
      pg.resetPanels();
      pg.panelNote('请先在页面顶部填入 Anthropic API Key —— key 只存浏览器 localStorage，直连 Anthropic API，不经过任何服务器。');
      keyInput.focus();
      byokEl.classList.add('pg-byok-pulse');
      setTimeout(() => byokEl.classList.remove('pg-byok-pulse'), 1600);
      return;
    }

    const sc = pg.state.scenario;
    const model = modelInput.value.trim() || DEFAULT_MODEL;
    const system = SYSTEMS[sc.id] || SYSTEMS['weather-trip'];
    const gen = ++pg.state.gen;
    pg.setRunning(true);
    pg.resetPanels();
    pg.traceReset(sc);
    pg.renderUsage({ input: 0, output: 0 });
    pg.panelNote('— 真实模型调用：' + model + ' · 工具为浏览器内 JS 实现 · 最多 ' + MAX_ITERATIONS + ' 轮 —');

    const usageAcc = { input: 0, output: 0 };
    const startedAt = performance.now();
    const messages = [{ role: 'user', content: sc.task }];
    const stale = () => pg.state.gen !== gen;

    try {
      for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        const spanId = 'turn-' + iter;
        pg.traceStart({ id: spanId, parent: 'root', kind: 'llm.turn', name: model });
        pg.panelLlmOpen('llm.turn · 主 agent（' + model + '）');
        const t0 = performance.now();
        const resp = await callApi(key, model, system, messages);
        if (stale()) return;
        const ms = Math.round(performance.now() - t0);

        const blocks = Array.isArray(resp.content) ? resp.content : [];
        for (const b of blocks) {
          if (b && b.type === 'text' && b.text) {
            await pg.panelStream(b.text, gen);
            if (stale()) return;
          }
        }
        const usage = {
          input: (resp.usage && resp.usage.input_tokens) || 0,
          output: (resp.usage && resp.usage.output_tokens) || 0,
        };
        pg.traceEnd({ id: spanId, ms, usage }, usageAcc);

        const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
        if (resp.stop_reason === 'tool_use' && toolUses.length > 0) {
          if (iter === MAX_ITERATIONS) {
            pg.panelNote('已达 ' + MAX_ITERATIONS + ' 轮工具循环上限，提前收尾。');
            break;
          }
          messages.push({ role: 'assistant', content: blocks });
          const results = [];
          for (let i = 0; i < toolUses.length; i++) {
            const tu = toolUses[i];
            const unitId = spanId + '-tool-' + i;
            pg.highlightMenu('tool:' + tu.name);
            pg.traceStart({ id: unitId, parent: 'root', kind: 'unit', name: 'tool:' + tu.name });
            pg.panelTool(tu.name, tu.input);
            const out = execTool(tu.name, tu.input);
            pg.panelResult(out.text);
            pg.traceEnd({ id: unitId, ms: out.ms }, usageAcc);
            const r = { type: 'tool_result', tool_use_id: tu.id, content: out.text };
            if (out.isError) r.is_error = true;
            results.push(r);
          }
          messages.push({ role: 'user', content: results });
          continue;
        }

        if (resp.stop_reason === 'max_tokens') {
          pg.panelNote('（模型输出达到 max_tokens 上限，可能被截断）');
        }
        break;
      }
    } catch (err) {
      if (stale()) return;
      panelError(describeError(err));
    } finally {
      if (!stale()) {
        pg.traceFinish(Math.round(performance.now() - startedAt), usageAcc);
        pg.addBlock(pg.el('div', 'tp-note', '— run 结束：usage 为 Anthropic API 返回的真实 token 计数 —'));
        pg.setRunning(false);
      }
    }
  }

  /* ========== 模式切换 ========== */
  function setMode(mode) {
    if (pg.state.running || pg.state.mode === mode) return;
    pg.state.gen++; // 作废任何残留循环
    pg.state.mode = mode;
    modeBar.querySelectorAll('.pg-mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode),
    );
    badgeText.textContent = COPY[mode].badge;
    headSub.textContent = COPY[mode].sub;
    uNote.textContent = COPY[mode].note;
    byokEl.hidden = mode !== 'real';
    pg.setPrice(mode === 'real' ? PRICE_REAL : PRICE_SIM);
    if (mode === 'real') {
      pg.renderMenu({ menu: REAL_MENU });
      pg.state.realRun = realRun;
      if (!keyInput.value.trim()) keyInput.focus();
    } else {
      pg.renderMenu(pg.state.scenario);
      pg.state.realRun = null;
    }
    pg.resetPanels();
  }

  modeBar.querySelectorAll('.pg-mode-btn').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode)),
  );

  /* 场景切换后：真实模式换成真实工具菜单（playground.js 会先画回模拟菜单） */
  pg.state.onScenarioChange = () => {
    if (pg.state.mode === 'real') pg.renderMenu({ menu: REAL_MENU });
  };

  /* ========== key / model 持久化 ========== */
  try {
    keyInput.value = localStorage.getItem(LS_KEY) || '';
    modelInput.value = localStorage.getItem(LS_MODEL) || DEFAULT_MODEL;
  } catch (_) { /* localStorage 不可用（隐私模式等）时仅本次会话有效 */ }

  keyInput.addEventListener('input', () => {
    try { localStorage.setItem(LS_KEY, keyInput.value.trim()); } catch (_) {}
  });
  modelInput.addEventListener('change', () => {
    try { localStorage.setItem(LS_MODEL, modelInput.value.trim()); } catch (_) {}
  });
  btnClear.addEventListener('click', () => {
    keyInput.value = '';
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_MODEL);
    } catch (_) {}
    modelInput.value = DEFAULT_MODEL;
    keyInput.focus();
  });
})();
