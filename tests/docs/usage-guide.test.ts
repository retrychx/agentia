import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 说明文档校验 —— 防「文档承诺了、代码里没有」。
 *
 * `docs/usage-guide.md` 是面向使用者的单源说明（CLI 脚手架生成的项目 AGENTS.md 与
 * 官网 /llms.txt 都由它派生）。它最容易变成谎言：改了 API 却忘了改文档。
 * 这里把文档里**表格列出的每个名字**都对着源码验一遍：
 * - 表格标题里点名了某个类型（如 `AppOptions`）→ 首列名字必须是该类型的成员（含继承）；
 * - 表格标题没点名类型（如「宿主」清单）→ 首列名字必须是 `src/index.ts` 的导出名；
 * - 正文里出现的 `@Tool/@Skill/@SubAgent/@Prompt` 必须是真实导出。
 * 改名/删字段会立刻让本测试失败。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const GUIDE = join(repoRoot, 'docs', 'usage-guide.md');

/** 表格标题里可能点名的「成员容器」类型 —— 校验时按成员比对 */
const MEMBERSHIP_TYPES = [
  'AppOptions',
  'RunAppOptions',
  'ToolSpec',
  'SkillSpec',
  'SubAgentSpec',
  'PromptSpec',
  'RunContext',
  'SkillContext',
];

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
    const re = new RegExp(`export\\s+(?:interface|class)\\s+${typeName}\\b`);
    const m = re.exec(text);
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

/** 成员（含 extends 继承链） */
function membersOf(typeName: string): Set<string> {
  const out = ownMembers(typeName);
  // `extends A, B` → 递归并入
  for (const file of SRC) {
    const text = readFileSync(file, 'utf8');
    const re = new RegExp(
      `export\\s+(?:interface|class)\\s+${typeName}(?:<[^>]*>)?\\s+extends\\s+([^{]+)\\{`,
    );
    const m = re.exec(text);
    if (!m) continue;
    const bases = m[1]
      .split(',')
      .map((s) => s.trim().split('<')[0].trim())
      .filter(Boolean);
    for (const b of bases) {
      if (MEMBERSHIP_TYPES.includes(b) || bodyOf(b)) for (const x of membersOf(b)) out.add(x);
    }
    break;
  }
  return out;
}

/** `src/index.ts` 的导出名（值 + 类型） */
function exportedNames(): Set<string> {
  const text = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8');
  const out = new Set<string>();
  const addList = (list: string) => {
    for (const part of list.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  };
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}\s*from/g)) addList(m[1]);
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}\s*;?/g)) addList(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    out.add(m[1]);
  }
  return out;
}

interface Table {
  heading: string;
  /** 首列反引号里的名字（合法标识符才收集） */
  names: string[];
}

/** 抽出文档里所有表格：记录每张表之前的最近标题与首列名字 */
function parseTables(md: string): Table[] {
  const tables: Table[] = [];
  let heading = '';
  let current: Table | undefined;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('#')) {
      heading = line.replace(/^#+\s*/, '');
      current = undefined;
      continue;
    }
    if (!line.startsWith('|')) {
      current = undefined;
      continue;
    }
    if (/^\|[\s:\-|]+\|$/.test(line)) continue; // 分隔行
    const first = line.slice(1).split('|')[0].trim();
    const m = /^`([^`]+)`$/.exec(first);
    if (!m) {
      current = undefined;
      continue;
    }
    const name = m[1].trim();
    if (!/^[A-Za-z_$@][\w$]*$/.test(name)) {
      current = undefined;
      continue;
    }
    if (!current || current.heading !== heading) {
      current = { heading, names: [] };
      tables.push(current);
    }
    current.names.push(name.replace(/^@/, ''));
  }
  return tables;
}

const guide = readFileSync(GUIDE, 'utf8');
const tables = parseTables(guide);
const exported = exportedNames();

/** 标题里点名的成员容器类型：取**最长**匹配（否则 RunAppOptions 会被 AppOptions 抢先命中） */
function membershipTypeOf(heading: string): string | undefined {
  return MEMBERSHIP_TYPES.filter((n) => heading.includes(n)).sort((a, b) => b.length - a.length)[0];
}

describe('usage-guide.md 与源码一致', () => {
  it('文档里有足量表格被解析（防止解析器静默失效）', () => {
    assert.ok(tables.length >= 8, `只解析出 ${tables.length} 张表，解析器可能坏了`);
    const total = tables.reduce((n, t) => n + t.names.length, 0);
    assert.ok(total >= 60, `只解析出 ${total} 个条目，预期 ≥60`);
  });

  it('表格标题点名了类型的：首列名字必须是该类型的成员（含继承）', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const t of tables) {
      const type = membershipTypeOf(t.heading);
      if (!type) continue;
      const members = membersOf(type);
      for (const name of t.names) {
        checked++;
        if (!members.has(name)) problems.push(`${type}.${name}（在「${t.heading}」表里）`);
      }
    }
    assert.ok(checked >= 25, `只校验了 ${checked} 个成员，预期 ≥25`);
    assert.deepEqual(problems, [], `文档写了源码里不存在的成员：\n${problems.join('\n')}`);
  });

  it('表格标题未点名类型的：首列名字必须是 src/index.ts 的导出名', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const t of tables) {
      if (membershipTypeOf(t.heading)) continue;
      // 第 0 节「四类单元」表的表头是「单元」，首列非标识符已在解析时过滤
      for (const name of t.names) {
        checked++;
        if (!exported.has(name)) problems.push(`${name}（在「${t.heading}」表里）`);
      }
    }
    assert.ok(checked >= 15, `只校验了 ${checked} 个导出名，预期 ≥15`);
    assert.deepEqual(problems, [], `文档写了不是导出的名字：\n${problems.join('\n')}`);
  });

  it('正文提到的装饰器都是真实导出', () => {
    for (const dec of ['Tool', 'Skill', 'SubAgent', 'Prompt']) {
      assert.ok(guide.includes(`@${dec}`), `文档应提到 @${dec}`);
      assert.ok(exported.has(dec), `@${dec} 必须是 src/index.ts 的导出`);
    }
  });

  it('文档点名的类型确实存在于源码（防「文档引用了已删除的类型」）', () => {
    for (const type of MEMBERSHIP_TYPES) {
      assert.ok(bodyOf(type) !== undefined, `源码里找不到类型 ${type}`);
    }
  });
});
