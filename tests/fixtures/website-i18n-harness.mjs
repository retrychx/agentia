/*
 * `tests/docs/website-i18n.test.ts` 的**子进程夹具**。
 *
 * 为什么必须是子进程：官网客户端脚本的语言在 **import 期**就定了 —— `src/scripts/lang.js`
 * 顶层读 `<html lang>` 算出 `PG_EN`，而 ESM 按 URL 缓存模块。同一个 Node 进程里改
 * `globalThis.document` 再 `import` 第二次（换语言），拿到的还是第一次那份缓存副本 ⇒
 * 「同进程跑两遍语言」在 ESM 下**做不到**。子进程是唯一能真跑两遍的办法。
 *
 * 用法：`node website-i18n-harness.mjs <lang> <modulePath> <mode>`，结果以 JSON 打到 stdout。
 *   mode=scenarios       → 打印模块导出的 `SCENARIOS`（演示剧本）
 *   mode=playground-real → 装一套极简 DOM 桩 + 假 fetch，真跑 IIFE 与 agent 循环，
 *                          打印所有写进 DOM 的字符串、菜单参数、以及发出去的请求体
 *
 * ⚠️ DOM 桩是**记录型**的，不是断言型的：凡 `textContent` / `innerHTML` / `pg.el(_,_,text)` /
 * `appendChild` 收到的字符串都被收进 `written`。这样「英文页是否漏出中文」不必解析源码文本
 * （那需要 JS 解析器，见守卫头注的射程说明），而是**真跑出来的**。
 */

const [lang, modulePath, mode] = process.argv.slice(2);
const CJK_INPUT = /^zh/i.test(lang) ? '上海' : 'Shanghai';

/* 极简 DOM 桩 --------------------------------------------------------------- */

/** 收集所有被写进 DOM 的字符串（用户可见文案都要经过这里） */
const written = [];
const record = (v) => {
  if (typeof v === 'string' && v.length) written.push(v);
};

class El {
  constructor(tag = 'div') {
    this.tagName = tag;
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.placeholder = '';
    this.dataset = {};
    this.handlers = {};
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = v == null ? '' : String(v);
    record(this._text);
  }
  get innerHTML() {
    return this._html ?? '';
  }
  set innerHTML(v) {
    this._html = v == null ? '' : String(v);
    record(this._html);
  }
  get classList() {
    if (!this._cls) this._cls = { add() {}, remove() {}, toggle() {} };
    return this._cls;
  }
  addEventListener(type, cb) {
    this.handlers[type] = cb;
  }
  appendChild(child) {
    record(child?.textContent);
    return child;
  }
  focus() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

/** 模式按钮：`.pg-mode-btn` 的查询要拿得到它们（playground-real 靠它接线 setMode） */
const modeButtons = ['sim', 'real'].map((m) => {
  const b = new El('button');
  b.dataset.mode = m;
  return b;
});

const bySelector = new Map();
const el = (sel) => {
  if (!bySelector.has(sel)) bySelector.set(sel, new El('div'));
  return bySelector.get(sel);
};
el('#pg-mode').querySelectorAll = (sel) => (sel === '.pg-mode-btn' ? modeButtons : []);

const fakeDocument = {
  documentElement: { getAttribute: (name) => (name === 'lang' ? lang : null) },
  querySelector: (sel) => el(sel),
  querySelectorAll: () => [],
  createElement: (tag) => new El(tag),
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* 假 fetch：把 agent 循环驱动完（一次工具往返 + 一次 401），全部确定性 ------------ */

const requests = [];
let fetchStep = 0;
const scripted = [
  // 第 1 次调用：一次工具往返，把 execTool 的全部文案分支都走一遍
  {
    ok: true,
    body: {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: CJK_INPUT } },
        { type: 'tool_use', id: 'tu2', name: 'get_weather', input: { city: 'Atlantis' } },
        { type: 'tool_use', id: 'tu3', name: 'read_asset', input: { name: 'review-checklist' } },
        { type: 'tool_use', id: 'tu4', name: 'read_asset', input: { name: 'nope' } },
        { type: 'tool_use', id: 'tu5', name: 'calculator', input: { expression: 'BAD' } },
        { type: 'tool_use', id: 'tu6', name: 'no_such_tool', input: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  // 第 2 次调用：正常收尾
  {
    ok: true,
    body: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 3 },
    },
  },
  // 第 3 次调用：HTTP 401（走 describeError + panelError 那条）
  { ok: false, status: 401, body: { error: { message: 'bad key' } } },
];
globalThis.fetch = async (url, opts) => {
  requests.push({ url: String(url), body: JSON.parse(opts.body) });
  const step = scripted[Math.min(fetchStep++, scripted.length - 1)];
  return {
    ok: step.ok,
    status: step.status ?? 200,
    json: async () => step.body,
  };
};

/** playground.js 在页面里暴露的共用面（真跑时由它提供；这里只记调用） */
const menuArgs = [];
const pg = {
  // ⚠️ `gen` 必须是数字：realRun 用 `++gen` 当世代号，NaN 会让 `stale()` 恒真、循环立刻退出
  state: { gen: 0, scenario: { id: 'weather-trip', task: 'weekend trip' } },
  renderMenu: (arg) => menuArgs.push(JSON.stringify(arg)),
  resetPanels: () => {},
  setPrice: () => {},
  setRunning: () => {},
  panelNote: (v) => record(v),
  panelLlmOpen: (v) => record(v),
  panelTool: () => {},
  panelResult: (v) => record(v),
  panelStream: async () => {},
  highlightMenu: () => {},
  addBlock: () => {},
  renderUsage: () => {},
  traceReset: () => {},
  traceStart: () => {},
  traceEnd: () => {},
  traceEvent: () => {},
  traceFinish: () => {},
  fmtArg: (v) => JSON.stringify(v),
  rawArg: (v) => JSON.stringify(v, null, 2),
  el: (tag, _cls, text) => {
    record(text);
    return new El(tag);
  },
};

globalThis.document = fakeDocument;
globalThis.window = { AgentiaPlayground: pg };

/* 跑目标模块 --------------------------------------------------------------- */

const mod = await import(modulePath);

if (mode === 'scenarios') {
  process.stdout.write(JSON.stringify({ scenarios: mod.SCENARIOS }));
} else {
  const click = (name) => modeButtons.find((b) => b.dataset.mode === name)?.handlers.click?.();
  const keyInput = el('#byok-key');
  const providerSel = el('#byok-provider');

  click('real'); // 触发 copyReal + REAL_MENU
  await pg.state.realRun(); // key 为空 ⇒ 「请先填入 API Key」早退分支
  keyInput.value = 'sk-test';
  await pg.state.realRun(); // 工具往返（fetch 第 1、2 次）
  await pg.state.realRun(); // 401 错误路径（fetch 第 3 次）
  keyInput.value = '';
  providerSel.value = 'deepseek';
  providerSel.handlers.change?.(); // 真实模式下调 loadProvider ⇒ 另一份 copyReal / priceNote
  click('sim'); // COPY_SIM

  process.stdout.write(
    JSON.stringify({
      written,
      menus: menuArgs.filter(Boolean),
      systems: requests.map((r) => r.body.system),
      tools: requests[0]?.body.tools ?? [],
    }),
  );
}
