import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
    for (const b of m[1].split(',').map((s) => s.trim().split('<')[0].trim()).filter(Boolean)) {
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
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  };
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}\s*(?:from|;)/g)) addList(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
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
    const row = /^<tr><td>(.*?)<\/td>/.exec(line);
    if (!row) {
      if (!line.startsWith('<tr>')) current = undefined;
      continue;
    }
    const names = decode(row[1])
      .split(' / ')
      .map((s) => s.replace(/<[^>]*>/g, '').replace(/（[^）]*）/g, '').trim())
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
});
