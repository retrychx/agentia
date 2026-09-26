import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 官网 API 页校验（`packages/website/src/fragments/api.html`）。
 *
 * 为什么单独有这一份：`api.html` 是**手写**的导出速查（不像 `llms.txt` 那样从
 * `docs/usage-guide.md` 派生），是仓库里最容易悄悄漂移的文档 —— 加了个导出忘了写、
 * 改了签名忘了改。它之前真的漂了：`SpanKind` 写成含不存在的 `'internal'`、
 * `trimToolPairs` 还挂着改名前的 `keepRecent`、A/B/C 三期的导出大量缺失。
 *
 * 这里把它钉两头：
 * ① **正向**：表格首列的名字必须真实存在 —— 「X 选项」表对 `X` 的成员（含继承），
 *    其余表对 `src/index.ts` 的导出名；
 * ② **反向全覆盖**：`src/index.ts` 的**每一个导出**都必须在页面上出现
 *    （防「代码有了、文档没写」——漂移的另一种方向）。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const PAGE = join(repoRoot, 'packages', 'website', 'src', 'fragments', 'api.html');

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SRC = srcFiles(join(repoRoot, 'src'));

/** 找到 `export interface X` / `export class X` 的主体块（花括号配平） */
function bodyOf(typeName: string): string | undefined {
  for (const file of SRC) {
    const text = readFileSync(file, 'utf8');
    const m = new RegExp(`export\\s+(?:interface|class)\\s+${typeName}\\b`).exec(text);
    if (!m) continue;
    const open = text.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
  }
  return undefined;
}

/** 声明里的直接成员名（属性 / 方法 / 访问器） */
function ownMembers(typeName: string): Set<string> {
  const body = bodyOf(typeName);
  assert.ok(body !== undefined, `源码里找不到 ${typeName} 的声明`);
  const out = new Set<string>();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//')) continue;
    const m = /^(?:readonly\s+)?(?:static\s+)?(?:get\s+)?([A-Za-z_$][\w$]*)\s*[?:(<]/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** 成员（含 extends 继承链，如 RunAppOptions extends RunInvocationOptions） */
function membersOf(typeName: string): Set<string> {
  const out = ownMembers(typeName);
  for (const file of SRC) {
    const text = readFileSync(file, 'utf8');
    const m = new RegExp(
      `export\\s+(?:interface|class)\\s+${typeName}(?:<[^>]*>)?\\s+extends\\s+([^{]+)\\{`,
    ).exec(text);
    if (!m) continue;
    for (const b of m[1]
      .split(',')
      .map((s) => s.trim().split('<')[0].trim())
      .filter(Boolean)) {
      if (bodyOf(b)) for (const x of membersOf(b)) out.add(x);
    }
    break;
  }
  return out;
}

/** `src/index.ts` 的导出名（值 + 类型） */
function exportedNames(): Set<string> {
  const text = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8');
  const out = new Set<string>();
  const addList = (list: string): void => {
    for (const part of list.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  };
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}\s*(?:from|;)/g)) addList(m[1]);
  for (const m of text.matchAll(
    /export\s+(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    out.add(m[1]);
  }
  return out;
}

const html = readFileSync(PAGE, 'utf8');

/** 行内 HTML 实体还原（`&lt;T&gt;` 等） */
function decode(s: string): string {
  return s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

interface Table {
  /** 最近的 h2 / h3 标题 */
  heading: string;
  /** 每行首列的标识符（`A / B` 拆开；泛型与「（必填）」去掉） */
  names: string[];
}

/** 按 `<h2>/<h3>` 标题 + `<tr><td>` 行抽取表格 */
function parseTables(md: string): Table[] {
  const tables: Table[] = [];
  let heading = '';
  let current: Table | undefined;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const h = /^<h([23])>(.*?)<\/h\1>/.exec(line);
    if (h) {
      heading = h[2].replace(/<[^>]*>/g, '').trim();
      current = undefined;
      continue;
    }
    // ⚠️ `<tr>` 上允许带属性：此前只认 `<tr><td>`，写成 `<tr class="…"><td>` 会整行跳过
    //（导出表有反向全覆盖兜着，但「X 选项」表的成员校验没有行级兜底 —— 静默漏检）。
    const row = /^<tr\b(?:(?!<tr\b).)*?<td>(.*?)<\/td>/.exec(line);
    if (!row) {
      if (!/^<tr\b/.test(line)) current = undefined;
      continue;
    }
    const names = decode(row[1])
      .split(' / ')
      .map((s) =>
        s
          .replace(/<[^>]*>/g, '')
          .replace(/（[^）]*）/g, '')
          .trim(),
      )
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    if (names.length === 0) continue;
    if (!current || current.heading !== heading) {
      current = { heading, names: [] };
      tables.push(current);
    }
    current.names.push(...names);
  }
  return tables;
}

const tables = parseTables(html);

// ── 第二列的 `{ … }` 类型形状 ────────────────────────────────────────────────
// 上面三条只守「**名字**在不在」，不守「**形状**对不对」。2026-09-26 实测：
// `ModelPricing` 那行写的是 `{ in: number; out: number }`，而源码已加 `cacheRead?` /
// `cacheWrite?` —— 三条守卫全绿。给 interface 加一个可选字段时 TS 不会报「文档少写了一个
// 字段」，所以这类漂移此前**没有任何东西拦得住**（同一轮靠这套检查另查出 6 处同类漏写）。

/**
 * 抽出第二列里每个 `<code>{ … }</code>` 的形状文本（已解码实体）。
 *
 * 用**花括号配平**而不是 `[^}]*`：`{ messages.stream(params) → { on('text', cb) } }` 这类
 * 嵌套形状会被后者截断成半个（实测过）。
 */
function shapesIn(cell: string): string[] {
  const out: string[] = [];
  const re = /<code>\s*\{/g;
  for (const m of cell.matchAll(re)) {
    const start = m.index + m[0].length - 1; // 指向 '{'
    let depth = 0;
    let i = start;
    for (; i < cell.length; i++) {
      if (cell[i] === '{') depth++;
      else if (cell[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    // ⚠️ **先解码再交给调用方**：`&lt;` 自带分号，形状按 `;` 切段时会被它切错
    //（实测：不解码时 `Promise&lt;void&gt;` 会被切成 `Promise&lt` + `void&gt;`，
    // `TraceSink` 于是被误判成「页面发明了 void」）。
    out.push(decode(cell.slice(start + 1, i)));
  }
  return out;
}

/** 每个 `<tr>` 的「首列名字 + 第二列形状」，按位配对用 */
function rowsWithShapes(): Array<{ names: string[]; shapes: string[] }> {
  const out: Array<{ names: string[]; shapes: string[] }> = [];
  for (const raw of html.split('\n')) {
    const m = /^<tr\b[^>]*><td>(.*?)<\/td><td>(.*?)<\/td>/.exec(raw.trim());
    if (!m) continue;
    const names = decode(m[1]!)
      .replace(/<[^>]*>/g, '')
      .split(' / ')
      .map((s) => s.replace(/（[^）]*）/g, '').trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    const shapes = shapesIn(m[2]!);
    if (names.length === 0 || shapes.length === 0) continue;
    out.push({ names, shapes });
  }
  return out;
}

/** 形状里写的字段名（按 `;` 切段、取每段前导标识符 —— 方法名也算成员名） */
function shapeFields(shape: string): Set<string> {
  const out = new Set<string>();
  for (const seg of shape.split(';')) {
    const m = /^\s*([A-Za-z_$][\w$]*)/.exec(seg);
    if (m) out.add(m[1]!);
  }
  return out;
}

/**
 * 该名字是不是**平坦的对象类型**（`export interface X {` / `export class X {`）。
 *
 * 联合（`A | B`）、交叉（`A & { … }`）、函数别名、`type X = {…}` 别名一律排除：
 * `bodyOf` 只按第一个 `{` 配平，拿到的是其中一支，用它当「真源」会把另一支的字段
 * 误判成「页面发明的」（`TraceRecordEvent = …Payload & { seq }` 实测踩过）。
 */
function isObjectType(typeName: string): boolean {
  if (bodyOf(typeName) === undefined) return false; // 只认 interface / class
  for (const file of SRC) {
    const text = readFileSync(file, 'utf8');
    const m = new RegExp(`export\\s+(?:interface|class)\\s+${typeName}\\b`).exec(text);
    if (!m) continue;
    const after = text.slice(m.index + m[0].length);
    const open = after.indexOf('{');
    if (open < 0) return false;
    const head = after.slice(0, open);
    return !/[|&;]/.test(head) && !head.includes('=>');
  }
  return false;
}

// ── 第三列**散文**里的「非法单价怎么处置」 ───────────────────────────────────
// 上面两条只守「名字」与「类型形状」，守不到**散文**。2026-09-26 起手动作②当场发现：
// 同一页**三处**写「非法单价在（构造期 / run 开始）抛错」，而实测是 `buildPricing` 只在
// `engine/turn.ts` 的循环入口被调用、`runAgent` 把它的错**收成** `{status:'error'}` 的
// result —— **不抛给调用方**。同一口径在 `docs/usage-guide.md` 里已经订正过（Q3），
// 唯独漏了 api.html，而上面三条守卫**全绿**。
//
// ⚠️ 自由文本没有机器可读的形状，所以这里**只在踩过的那两处钉**（不铺全页）：
// 凡第三列同时出现「价格表 / 单价 / priceOverrides」与「非法」的行，必须说清
// 「这个错不抛给调用方」，且不得把失败归因到「构造期」。
// 关键词钉**天生脆**（换个说法就静默失效）—— 这是它的射程边界，写在这里备查。

const PRICING_WORDS = /价格表|单价|priceOverrides/;
/** 「这个错没抛给调用方」的限定语（`buildPricing` 的错被 `runAgent` 收成 result） */
const NOT_TO_CALLER = /不抛给调用方|不是抛异常给调用方/;

/** 每个 `<tr>` 的「首列名字 + 第三列说明」（说明列去标签后解码，供散文匹配） */
function rowsWithProse(): Array<{ names: string[]; prose: string }> {
  const out: Array<{ names: string[]; prose: string }> = [];
  for (const raw of html.split('\n')) {
    const m = /^<tr\b[^>]*><td>(.*?)<\/td><td>.*?<\/td><td>(.*?)<\/td>/.exec(raw.trim());
    if (!m) continue;
    const names = decode(m[1]!)
      .replace(/<[^>]*>/g, '')
      .split(' / ')
      .map((s) => s.replace(/（[^）]*）/g, '').trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    if (names.length === 0) continue;
    out.push({ names, prose: decode(m[2]!.replace(/<[^>]*>/g, '')) });
  }
  return out;
}

/**
 * 价格表口径的问题清单。
 *
 * 拆成**纯函数**是为了让钉子**可证伪**：历史那两句能直接喂进来做阳性对照 ——
 * 若它只会返回 `[]`，那它对页面说的任何话都无感（§3 纪律：先造一个违规证明它会红）。
 */
function pricingProseProblems(rows: Array<{ names: string[]; prose: string }>): string[] {
  const out: string[] = [];
  for (const { names, prose } of rows) {
    // 触发面：讲价格表**且**讲「非法值」的行 —— 这才是「非法单价怎么处置」这个口径
    if (!PRICING_WORDS.test(prose) || !/非法/.test(prose)) continue;
    const who = names.join(' / ');
    if (!NOT_TO_CALLER.test(prose)) {
      out.push(
        `${who}：这行在讲「非法单价 / 乘数」的处置，却没说清这个错**不抛给调用方**` +
          '（buildPricing 的错被 runAgent 收成 status: error 的 result，' +
          '别让读者写 try/catch 等它抛）',
      );
    }
    if (/构造期/.test(prose)) {
      out.push(
        `${who}：价格表的失败发生在**第一次 llm 调用之前**（engine/turn.ts 的循环入口），` +
          '不是 createApp 构造期 —— 这正是 2026-09-26 订正过的那句',
      );
    }
  }
  return out;
}

const exported = exportedNames();

/** 标题形如「RunAgentOptions 选项」→ 该表是成员表 */
function optionsTypeOf(heading: string): string | undefined {
  const m = /^([A-Za-z_$][\w$]*) 选项$/.exec(heading);
  return m?.[1];
}

describe('官网 api.html 与源码一致', () => {
  it('页面有足量表格被解析（防止解析器静默失效）', () => {
    assert.ok(tables.length >= 8, `只解析出 ${tables.length} 张表，解析器可能坏了`);
    const total = tables.reduce((n, t) => n + t.names.length, 0);
    assert.ok(total >= 120, `只解析出 ${total} 个名字，预期 ≥120`);
  });

  it('「X 选项」表的首列必须是 X 的成员（含继承链）', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const t of tables) {
      const type = optionsTypeOf(t.heading);
      if (!type) continue;
      const members = membersOf(type);
      for (const name of t.names) {
        checked++;
        if (!members.has(name)) problems.push(`${type}.${name}（在「${t.heading}」表里）`);
      }
    }
    assert.ok(checked >= 10, `只校验了 ${checked} 个成员，预期 ≥10`);
    assert.deepEqual(problems, [], `页面写了源码里不存在的成员：\n${problems.join('\n')}`);
  });

  it('导出表的首列必须是 src/index.ts 的导出名', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const t of tables) {
      if (optionsTypeOf(t.heading)) continue;
      for (const name of t.names) {
        checked++;
        if (!exported.has(name)) problems.push(`${name}（在「${t.heading}」表里）`);
      }
    }
    assert.ok(checked >= 110, `只校验了 ${checked} 个导出名，预期 ≥110`);
    assert.deepEqual(problems, [], `页面写了不是导出的名字：\n${problems.join('\n')}`);
  });

  it('反向全覆盖：src/index.ts 的每个导出都出现在页面上（防「代码有了、文档没写」）', () => {
    const onPage = new Set(tables.flatMap((t) => t.names));
    const missing = [...exported].filter((n) => !onPage.has(n)).sort();
    assert.deepEqual(
      missing,
      [],
      `这些导出已存在于 src/index.ts，但官网 API 页没写：\n${missing.join('\n')}`,
    );
  });

  it('第二列的类型形状：自陈穷尽的行必须与源码成员集相等', () => {
    const problems: string[] = [];
    let equalChecked = 0;
    let subsetChecked = 0;
    for (const row of rowsWithShapes()) {
      // `A / B` 与两个形状**按位**配对；数目不符就不猜（配对关系会变成猜的）
      if (row.names.length !== row.shapes.length) continue;
      for (const [i, shape] of row.shapes.entries()) {
        const type = row.names[i]!;
        if (!isObjectType(type)) continue;
        const real = membersOf(type);
        const page = shapeFields(shape);
        // 带方法签名 / 箭头 / 嵌套对象的形状没法逐字对名 —— 只做「页面 ⇒ 源码」这一向
        const flat = !/[(→{]/.test(shape);
        if (flat) {
          const invented = [...page].filter((f) => !real.has(f)).sort();
          if (invented.length > 0) {
            problems.push(`${type}：页面写了源码里没有的字段 ${invented.join(' / ')}`);
            continue;
          }
        }
        // 含 `…` 的形状**自陈是子集**；不带的才声称穷尽 ⇒ 要求两边相等
        if (shape.includes('…') || !flat) {
          subsetChecked++;
          continue;
        }
        equalChecked++;
        const missing = [...real].filter((f) => !page.has(f)).sort();
        if (missing.length > 0) {
          problems.push(
            `${type}：形状没有「…」（= 自陈穷尽）却漏了源码里的 ${missing.join(' / ')}` +
              ' —— 要么补上，要么加「…」自陈子集',
          );
        }
      }
    }
    assert.ok(
      equalChecked >= 40,
      `只做了 ${equalChecked} 次「相等」比对，预期 ≥40（解析器可能坏了）`,
    );
    assert.ok(subsetChecked >= 5, `只做了 ${subsetChecked} 次「子集」比对，预期 ≥5`);
    assert.deepEqual(problems, [], `api.html 的类型形状与源码不一致：\n${problems.join('\n')}`);
  });

  it('形状解析器可证伪：合成样本 + 阳性对照', () => {
    // 纯函数直测 —— 解析器退化成「永远返回空集」时，上面那条会**假绿**
    assert.deepEqual([...shapeFields('in; out; cacheRead?')].sort(), ['cacheRead', 'in', 'out']);
    assert.deepEqual([...shapeFields('a?=60000; b?: string')].sort(), ['a', 'b']);
    assert.equal(shapeFields('').size, 0);
    // 阳性对照：凭空发明的字段必须被看见（否则「没问题」不可证伪）
    assert.deepEqual([...shapeFields('in; out; bogus')].sort(), ['bogus', 'in', 'out']);
    // ⚠️ 实体必须**先解码再切分**：`&lt;` 自带分号，不解码会把 `Promise&lt;void&gt;`
    // 切成 `Promise&lt` + `void&gt;`（实测时 `TraceSink` 因此被误判成「发明了 void」）
    assert.deepEqual(
      shapesIn('<td><code>{ export(trace) → void | Promise&lt;void&gt; }</code></td>'),
      [' export(trace) → void | Promise<void> '],
    );
    // 嵌套形状必须整段拿到（`[^}]*` 会截断成半个）
    assert.deepEqual(shapesIn('<td><code>{ a: { b } }</code></td>'), [' a: { b } ']);
  });

  it('第三列的「非法单价」口径：必须说清这个错不抛给调用方、且不得归因到构造期', () => {
    const rows = rowsWithProse();
    // 防真空：钉子的触发面必须真的存在 —— 触发面为 0 时这条断言**永远为真**
    const hits = rows.filter((r) => PRICING_WORDS.test(r.prose) && /非法/.test(r.prose));
    assert.ok(
      hits.length >= 2,
      `只在 ${hits.length} 行命中「价格表 + 非法值」，钉子可能已静默失效（预期 ≥2）`,
    );
    const problems = pricingProseProblems(rows);
    assert.deepEqual(problems, [], `api.html 的价格表口径与实测语义不符：\n${problems.join('\n')}`);
  });

  it('「非法单价」口径钉可证伪：把历史那两句喂回去必须报警（含「构造期」归因）', () => {
    const drifted = [
      {
        names: ['DEFAULT_PRICING / buildPricing'],
        prose: '内置价格表与合并函数。非法单价构造期抛错 —— 不让它悄悄算出 NaN 成本。',
      },
      { names: ['priceOverrides'], prose: '价格表覆盖/追加。非法单价在 run 开始即抛错。' },
    ];
    const problems = pricingProseProblems(drifted);
    // 样本 1 同时踩两条（没说清不抛给调用方 + 归因到构造期）；样本 2 只踩前者
    assert.equal(problems.length, 3, `预期 3 条，实际：\n${problems.join('\n')}`);
    assert.match(problems[0]!, /不抛给调用方/);
    assert.match(problems[1]!, /构造期/);
    assert.match(problems[2]!, /不抛给调用方/);
    // 阳性对照的另一半：写全口径的样本必须**干净**，否则钉子会误伤正确写法
    assert.deepEqual(
      pricingProseProblems([
        {
          names: ['priceOverrides'],
          prose:
            '非法单价在第一次 llm 调用之前就失败：run 以 status: error 收口 —— 不是抛异常给调用方。',
        },
      ]),
      [],
    );
    // 射程边界：不含价格表词的行一律不碰（`onUnpricedModel` 的「抛错被吞」说的是回调，不是单价校验）
    assert.deepEqual(
      pricingProseProblems([
        {
          names: ['onUnpricedModel'],
          prose: '遇到价格表外的模型时回调；抛错被吞，不改变 run 结局。',
        },
        { names: ['signal'], prose: 'run 以 aborted 收尾（不抛异常）。' },
      ]),
      [],
    );
  });

  it('页头统计与层次索引卡不自说自话（数字对源码、锚点对节）', () => {
    const chips = [
      ...html.matchAll(/<span class="api-chip">\s*<b>(\d+)<\/b>\s*([^<]+)<\/span>/g),
    ].map((m) => ({ n: Number(m[1]), label: m[2].trim() }));
    const sections = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);

    const exportsChip = chips.find((c) => c.label.includes('导出'));
    assert.ok(exportsChip, '页头缺「导出」计数 chip');
    assert.equal(
      exportsChip.n,
      exported.size,
      `页头写「${exportsChip.n} 个导出」，但 src/index.ts 实际导出 ${exported.size} 个 —— 手写数字必须跟着改`,
    );

    const layersChip = chips.find((c) => c.label.includes('层次'));
    assert.ok(layersChip, '页头缺「层次」计数 chip');
    assert.equal(
      layersChip.n,
      sections.length,
      `页头写「${layersChip.n} 个层次」，但页面实际有 ${sections.length} 个 section`,
    );

    const cards = [...html.matchAll(/<a class="layer-card" href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(cards.length > 0, '页头缺层次索引卡');
    assert.deepEqual(
      [...cards].sort(),
      [...sections].sort(),
      '层次索引卡必须与 section 一一对应（防漏项与死链）',
    );
  });
});

/**
 * 页面上**其余**手写数字。（`210 个导出` / `9 个层次` 已由上面的 describe 守着：
 * 前者对 `src/index.ts` 的导出数，后者对页面自己的 section 数。）
 *
 * 为什么补这一份：`0 个运行时依赖` / `4 类能力` / `3 类触发` 此前**没有任何断言** ——
 * 加一个运行时依赖、加/删一类能力或触发宿主，页面会继续写旧数字而没人拦
 * （本仓库已有这类漂移的先例：`1 个运行时依赖 → 0 个` 就是靠人眼改的）。
 *
 * ⚠️ 两个**计数推不出来**的，如实标出，别把它们当已守（它们各自有别的守卫，但**不在本文件**）：
 * - `1:1 run ↔ trace`：是不变量不是计数，真正的守卫在 `tests/engine/traceLink.test.ts`
 *   （断言 `traceId == runId` 不被破坏）；这里只钉「首屏别把它删了」。
 * - `0 反射`：策略声明（显式 DI，不用装饰器元数据反射）—— 源码里本来就有 `Reflect.ownKeys`
 *   这类**正当**用法，**计数推不出来**（`Reflect.*` 出现几次说明不了任何事）。
 *   声明本身的可执行版本是 `tests/architecture/no-legacy-decorator-metadata.test.ts`
 *   （2026-09-23 建成，已从 `docs/guards.md` §2「待守」移入 §1）；这里仍只钉「首屏别删」。
 */
describe('官网手写数字与源码一致（chips 之外的）', () => {
  const INDEX = join(repoRoot, 'packages', 'website', 'src', 'fragments', 'index.html');
  const indexHtml = readFileSync(INDEX, 'utf8');

  /** 四个能力装饰器（`src/toolkit/<name>.ts` 各一个） */
  const ABILITIES = ['Tool', 'Skill', 'SubAgent', 'Prompt'];
  /** 三种触发宿主（`src/transport/<name>.ts`） */
  const TRIGGERS = ['http', 'async', 'scheduler'];

  /** `api.html` 的 chip（`<b>N</b> 标签`） */
  const chip = (label: string): number => {
    const m = new RegExp(`<b>(\\d+)</b>\\s*${label}`).exec(html);
    assert.ok(m, `api.html 上找不到「<b>N</b> ${label}」`);
    return Number(m[1]);
  };

  /** `index.html` 首屏 hero-stats 行的取值（`<b>值</b> 标签`） */
  const hero = /<div class="hero-stats"[^>]*>([\s\S]*?)<\/div>/.exec(indexHtml)?.[1] ?? '';
  const heroStats = [...hero.matchAll(/<b>([^<]+)<\/b>\s*([^<]+)/g)].map((m) => ({
    value: m[1].trim(),
    label: m[2].trim(),
  }));
  const heroValue = (label: string): string | undefined =>
    heroStats.find((s) => s.label === label)?.value;

  const runtimeDeps = (): number => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(pkg.dependencies ?? {}).length;
  };

  it('解析器没退化（hero-stats 行抽到足够条目）', () => {
    assert.ok(heroStats.length >= 5, `只抽到 ${heroStats.length} 条 hero 统计，解析器可能坏了`);
  });

  it('「个运行时依赖」= package.json 的 dependencies 数（两个页面都要对）', () => {
    const deps = runtimeDeps();
    assert.equal(chip('个运行时依赖'), deps, 'api.html 的 chip');
    assert.equal(heroValue('个运行时依赖'), String(deps), 'index.html 首屏统计行');
  });

  it('「类能力」= 四个能力装饰器（都得是真导出，且两个页面都要对）', () => {
    for (const name of ABILITIES) {
      assert.ok(exported.has(name), `@${name} 必须是 src/index.ts 的导出`);
      assert.ok(
        existsSync(join(repoRoot, 'src', 'toolkit', `${name.toLowerCase()}.ts`)),
        `src/toolkit/${name.toLowerCase()}.ts 应当存在（能力实现按名成文件）`,
      );
    }
    assert.equal(chip('类能力'), ABILITIES.length, 'api.html 的 chip');
    assert.equal(heroValue('类能力'), String(ABILITIES.length), 'index.html 首屏统计行');
  });

  it('「类触发」= 三种触发宿主（传输层文件必须在）', () => {
    for (const f of TRIGGERS) {
      assert.ok(
        existsSync(join(repoRoot, 'src', 'transport', `${f}.ts`)),
        `src/transport/${f}.ts 应当存在`,
      );
    }
    assert.equal(heroValue('类触发'), String(TRIGGERS.length));
  });

  it('首屏那两条计数推不出来的声明**别被悄悄删掉**（各自的守卫在别处，见本 describe 的注释）', () => {
    assert.equal(
      heroValue('run ↔ trace'),
      '1:1',
      '真正的不变量守卫在 tests/engine/traceLink.test.ts',
    );
    assert.equal(
      heroValue('反射'),
      '0',
      '计数推不出来（Reflect.ownKeys 是正当用法）—— 声明的守卫在 ' +
        'tests/architecture/no-legacy-decorator-metadata.test.ts，本文件只钉首屏别删',
    );
  });
});
