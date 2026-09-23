/*
 * 「零运行时依赖」守卫的**扫描器**（被 no-runtime-deps.test.ts 使用）。
 *
 * 为什么单独一个文件而不是写在测试里：这个扫描器本身需要被**单独验证** ——
 * 它的失效方向是**假阴性**（错位后把后面的真 import 一起遮蔽，于是「没有第三方 import」
 * 变成假绿），必须能用一个小脚本直接打印某个文件扫到了什么。写在 .test.ts 里就做不到
 * （import 测试文件会直接跑测试）。
 *
 * 它做的事只有一件：**一遍扫完源文件，把非代码遮蔽掉，同时把说明符位置的字符串读出来**。
 * 两件事必须同时做，缺一即废：
 *   - 只遮蔽不读取 ⇒ 说明符本身就是字符串，会被自己遮蔽掉；
 *   - 只读取不遮蔽 ⇒ 注释 / 模板字符串 / 文档字符串里的 `from 'x'` 全变成假依赖边。
 * 细节与真实语料里的危险形态见函数头注与测试文件头注。
 */

/** 说明符及其在源文件中的偏移 */
export interface Spec {
  spec: string;
  /** 说明符**内容**起始的字符偏移（用于换算行号） */
  index: number;
}

export interface ScanResult {
  /** 遮蔽后的文本（长度与换行与源文件一一对应，可安全跑正则 / 定位行号） */
  masked: string;
  /** 说明符位置读到的模块说明符 */
  specs: Spec[];
}

/** 出现在 `/` 前、使其成为**正则**起点的关键字（否则 `/` 是除号） */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;
const SPACE = /\s/;

/**
 * 一遍扫完源文件：
 *   - 注释 / 字符串 / 模板字符串 / 正则字面量 → 逐字遮蔽为空格（换行保留）；
 *   - **说明符位置**的字符串 → 读出来记进 `specs`（这是唯一不遮蔽内容的字符串）。
 *
 * 「说明符位置」的判定（四条，逐条对应一种真实语法形态）：
 *   ① `from 'x'` —— 且 `from` 前面不是 `.`（排除 `Array.from('abc')`）；
 *   ② `import 'x'` —— 副作用导入（`import` 后直接跟字符串）；
 *   ③ `import('x')` / `require('x')` —— `(` 前的词是 import / require；
 *   ④ `export … from 'x'` / `export * from 'x'` / `import type … from 'x'` 由 ① 覆盖。
 *
 * 模板字符串用显式栈处理 `${ … }` 嵌套：栈顶是 code 时按代码扫，
 * 遇到 `}` 且本层花括号已配平就弹回 template。
 */
export function scan(src: string): ScanResult {
  const out = src.split('');
  const specs: Spec[] = [];
  const stack: Array<{ kind: 'code' | 'template'; braces: number }> = [{ kind: 'code', braces: 0 }];
  let i = 0;
  /** 最近扫过的标识符 */
  let lastWord = '';
  /** 最近扫过的标识符是否紧跟 `.` 之后（`Array.from` 里的 `from` 不算说明符引导词） */
  let lastWordAfterDot = false;
  /** 最近一个 `(` 之前的标识符（判 `import(` / `require(`） */
  let parenOwner = '';

  /** 遮蔽 [from, to) —— 换行原样保留（行号不失真） */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  /** 往回找最近的非空白字符（**在已遮蔽的 out 上找** —— 注释已变成空格，天然被跳过） */
  const prevSignificant = (from: number): string => {
    for (let k = from; k >= 0; k--) {
      const c = out[k];
      if (c !== undefined && !SPACE.test(c)) return c;
    }
    return '';
  };

  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const n = src[i + 1];

    // ── 模板字符串态：只认 ` \ 与 ${，其余一律遮蔽 ──
    if (top.kind === 'template') {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        blank(i, i + 1);
        stack.pop();
        i += 1;
        continue;
      }
      if (c === '$' && n === '{') {
        blank(i, i + 2);
        stack.push({ kind: 'code', braces: 0 });
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }

    // ── 代码态 ──
    if (c === '/' && n === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    // 字符串：先判是不是说明符位置，再决定「读出来」还是「纯遮蔽」
    if (c === '"' || c === "'") {
      const isSpecifier =
        (lastWord === 'from' && !lastWordAfterDot) ||
        lastWord === 'import' ||
        (prevSignificant(i - 1) === '(' && (parenOwner === 'import' || parenOwner === 'require'));

      let j = i + 1;
      let content = '';
      while (j < src.length) {
        if (src[j] === '\\') {
          content += src[j] + (src[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        if (src[j] === '\n') break; // 未闭合：不越行吞（避免一次错位吞掉整个文件）
        content += src[j];
        j += 1;
      }
      if (isSpecifier) specs.push({ spec: content, index: i + 1 });
      const end = j < src.length && src[j] === c ? j + 1 : j;
      blank(i, end);
      i = end;
      lastWord = '';
      lastWordAfterDot = false;
      parenOwner = '';
      continue;
    }

    if (c === '`') {
      blank(i, i + 1);
      stack.push({ kind: 'template', braces: 0 });
      i += 1;
      continue;
    }

    if (
      c === '/' &&
      (REGEX_PRECEDING_KEYWORDS.has(lastWord) || isRegexStart(prevSignificant(i - 1)))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break; // 未闭合：不越行吞
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      lastWord = '';
      lastWordAfterDot = false;
      parenOwner = '';
      continue;
    }

    if (c === '{') {
      top.braces += 1;
      lastWord = '';
      lastWordAfterDot = false;
      parenOwner = '';
      i += 1;
      continue;
    }
    if (c === '}') {
      if (top.braces === 0 && stack.length > 1) {
        blank(i, i + 1); // 这个 } 闭合的是 ${ —— 遮蔽后弹回模板态
        stack.pop();
      } else {
        top.braces = Math.max(0, top.braces - 1);
      }
      lastWord = '';
      lastWordAfterDot = false;
      parenOwner = '';
      i += 1;
      continue;
    }
    if (c === '(') {
      parenOwner = lastWord;
      lastWord = '';
      lastWordAfterDot = false;
      i += 1;
      continue;
    }

    if (WORD_CHAR.test(c)) {
      const start = i;
      let j = i;
      while (j < src.length && WORD_CHAR.test(src[j])) j += 1;
      lastWord = src.slice(start, j);
      lastWordAfterDot = prevSignificant(start - 1) === '.';
      parenOwner = '';
      i = j;
      continue;
    }

    if (!SPACE.test(c)) {
      lastWord = '';
      lastWordAfterDot = false;
      parenOwner = '';
    }
    i += 1;
  }

  return { masked: out.join(''), specs };
}

/** `/` 是否正则起点：看上一个有意义字符。标识符/数字/`)`/`]`/`}` 之后是**除号**。 */
function isRegexStart(prev: string): boolean {
  if (prev === '') return true;
  if (WORD_CHAR.test(prev)) return false;
  if (prev === ')' || prev === ']' || prev === '}') return false;
  return true;
}

export type SpecKind = 'relative' | 'builtin' | 'workspace' | 'external';

/** 说明符分类。`@migor/*` 单列 —— 它是自家兄弟包，违规理由与第三方不同。 */
export function classify(spec: string, isBuiltin: (s: string) => boolean): SpecKind {
  if (spec.startsWith('.')) return 'relative';
  if (spec.startsWith('node:')) return 'builtin';
  if (spec.startsWith('@migor/')) return 'workspace';
  if (isBuiltin(spec)) return 'builtin'; // 裸内置（'fs'）—— 不是第三方，放行
  return 'external';
}
