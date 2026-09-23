/**
 * 面板的 **Markdown 最小渲染器** —— 纯逻辑、零 DOM、零依赖。
 *
 * 为什么自己写而不引 `marked` / `markdown-it`：
 * - **零运行时依赖是本 CLI 的硬承诺**（`package.json` 里没有 `dependencies`）。为了面板把一份
 *   解析器 + 一份消毒器（DOMPurify 之类）塞进 dist，等于在 dev 链路里引入两个第三方供应链面，
 *   而它们的产物**没法被本仓的单测验证**（我们只能验「我写的那部分」）。
 * - 面板只需要**模型正文**这一种输入可读：标题 / 粗体 / 斜体 / 行内码 / 围栏码 / 列表 /
 *   引用 / 分隔线 / 链接。这套子集手写不到 200 行，且**每条规则都能配一条单测**。
 * - 最要紧的是**它按构造不产生 HTML**：返回值是一棵 token 树（`MdBlock` / `MdInline`），
 *   没有任何「原样透传的 HTML」这一类。页面的渲染器只准用 `createElement` + `textContent`
 *   把它变成 DOM ⇒ **模型输出里的 `<script>` 只会是字面文本**，不存在「忘了转义」这条路径。
 *
 * ⚠️ 本文件**不许碰 DOM**（不出现 `document` / `window`）—— 它要在 Node 里被直接 import 做单测。
 *
 * 支持的子集（刻意不做的都在「不做」里）：
 * - 块：`#` 标题（1–6 级）、围栏码块（``` / ~~~，带语言标注）、无序/有序列表（**一层**）、
 *   引用（合并成一段正文）、`---` 分隔线、段落
 * - 行内：行内码、`**粗**`、`*斜*`、`[文字](链接)`、`<https://…>` 自动链接
 *
 * 不做（都是刻意的，不是漏）：
 * - **不做 HTML 透传**（安全前提，见上）
 * - 不做表格 / 任务列表 / 嵌套列表 / 脚注 / 数学 —— 面板是调试视图，不是文档站
 * - 不做 setext 标题（`===` 下划线式）—— 与分隔线歧义大、收益小
 * - 不做图片（`![]()`）—— 面板**不去外网取图**：一次 run 的正文不该触发网络请求
 * - 不做**词内** `_` 强调（`read_file_tool` 原样显示）—— 与 CommonMark 同口径，见 `parseInline`
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'link'; href: string; text: string };

export type MdBlock =
  | { type: 'p'; inline: MdInline[] }
  | { type: 'h'; level: number; inline: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'quote'; inline: MdInline[] }
  | { type: 'hr' };

/**
 * 链接协议白名单。**这是安全边界，不是风格选择**：
 * 模型输出里的 `[点我](javascript:alert(1))` 若被渲染成可点链接，面板就成了 XSS 的跳板
 * （`href` 是唯一一处「我们主动写进属性」的值 —— 文本全走 `textContent` 是安全的，
 * 属性不是）。不合法 ⇒ 这一条**整个降级成字面文本**（连 `[]()` 都照原样显示），
 * 使用者一眼看得出「这里有个链接我没渲染」，而不是看到一个空链接或点不动的链接。
 */
export function isSafeHref(href: string): boolean {
  // 允许 http/https/mailto；**不允许** javascript: / data: / vbscript: / file: 等
  return /^(https?:|mailto:)/i.test(href.trim());
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const BLANK = /^\s*$/;
/** 「单词字符」：`_` 的词内排除用它判边界（与 CommonMark 的 intraword 规则同口径） */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** 下标可能越界（`text[-1]` / `text[len]` 都是 `undefined`）⇒ 越界一律当「不是单词字符」 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * 把一段 Markdown 文本解析成块序列。
 *
 * 三条与「真 Markdown」不同但**刻意**的口径：
 * - 缩进 ≥2 空格的续行归上一条列表项（列表只解析**一层**：更深一层当正文，不递归建树）；
 * - 未闭合的围栏码块吃掉到文末（**不静默丢内容** —— 模型被截断时最常见的就是这个形态）；
 * - 引用（`>`）合并成**一段正文**（面板里引用几乎总是模型在引日志，逐行建块只会更碎）。
 */
export function parseMarkdown(text: string): MdBlock[] {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    const joined = para.join('\n').trim();
    para = [];
    if (joined) blocks.push({ type: 'p', inline: parseInline(joined, 0) });
  };

  while (i < lines.length) {
    const line = lines[i] as string;

    // —— 围栏码块 ——
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = (fence[1] as string)[0] as string;
      const min = (fence[1] as string).length;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i] as string;
        const close = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${min},}\\s*$`);
        if (close.test(cur)) {
          i++;
          break;
        }
        body.push(cur);
        i++;
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // —— 空行：段落到此为止 ——
    if (BLANK.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // —— 分隔线（必须在列表之前判：`---` 也是无序列表的标记） ——
    if (HR.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // —— 标题 ——
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      blocks.push({
        type: 'h',
        level: (h[1] as string).length,
        inline: parseInline((h[2] as string).trim(), 0),
      });
      i++;
      continue;
    }

    // —— 引用：连续 `>` 行合成一段 ——
    if (QUOTE.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        quoted.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] as string);
        i++;
      }
      const joined = quoted.join('\n').trim();
      blocks.push({ type: 'quote', inline: parseInline(joined, 0) });
      continue;
    }

    // —— 列表（无序 / 有序，各收一段连续的） ——
    const ul = UL.exec(line);
    const ol = olAt(line);
    if (ul || ol) {
      flushPara();
      const ordered = ol !== null;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const cur = lines[i] as string;
        const m = ordered ? olAt(cur) : UL.exec(cur);
        if (m) {
          items.push(parseInline(m[3].trim(), 0));
          i++;
          continue;
        }
        // 续行：缩进 ≥2 且不是新的一条 ⇒ 并进上一项
        if (items.length > 0 && /^\s{2,}\S/.test(cur) && !BLANK.test(cur)) {
          const last = items[items.length - 1] as MdInline[];
          last.push(...parseInline(cur.trim(), 0));
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // —— 其余：段落（连续非空行合并，行内换行保留） ——
    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

/** 有序列表标记（`1.` / `1)`），返回与 UL 同形的三组：缩进 / 标记 / 正文 */
function olAt(line: string): RegExpExecArray | null {
  const m = OL.exec(line);
  return m ? (m as unknown as RegExpExecArray) : null;
}

/**
 * 行内解析。`depth` 是**递归上限**：`**a *b* c**` 这类嵌套只展开到第 3 层，
 * 再深就按字面留着 —— 递归无上限时，一条构造出来的正文就能把面板卡死。
 */
export function parseInline(text: string, depth: number): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  let i = 0;
  const pushText = (): void => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };

  while (i < text.length) {
    const c = text[i] as string;

    // 行内码：`...`（不跨行；两端各去掉一个空格 —— 与 CommonMark 同款）
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        pushText();
        let inner = text.slice(i + 1, end);
        if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim())
          inner = inner.slice(1, -1);
        out.push({ type: 'code', text: inner });
        i = end + 1;
        continue;
      }
    }

    // 链接：[文字](地址) —— 地址不过白名单就整条降级成字面文本（见 isSafeHref）
    if (c === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i));
      if (m) {
        const raw = text.slice(i, i + (m[0] as string).length);
        const href = (m[2] as string).trim();
        if (isSafeHref(href)) {
          pushText();
          out.push({ type: 'link', href, text: (m[1] as string).trim() });
        } else {
          buf += raw; // 字面保留（连 []() 一起）—— 让使用者看见「这里有个链接我没渲染」
        }
        i += (m[0] as string).length;
        continue;
      }
    }

    // 自动链接：<https://…>（裸的 `<` 一律当文本 —— 这正是「不做 HTML 透传」的落点）
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s>]+)>/.exec(text.slice(i));
      if (m) {
        pushText();
        out.push({ type: 'link', href: m[1] as string, text: m[1] as string });
        i += (m[0] as string).length;
        continue;
      }
    }

    // 强调：**粗** / *斜*（`__` / `_` 同义）
    if (c === '*' || c === '_') {
      const strong = text.startsWith(c + c, i);
      const mark = strong ? c + c : c;
      const end = text.indexOf(mark, i + mark.length);
      if (end > i + mark.length) {
        const inner = text.slice(i + mark.length, end);
        /**
         * `_` 的**词内排除**（CommonMark 的 intraword 规则）：两侧只要有一边紧贴单词字符，
         * 就不构成强调。
         *
         * 没有这条，`read_file_tool` 会被切成 `read` + <em>file</em> + `tool`、
         * `src/my_dir/my_file.ts` 同理 —— 而面板渲染的正是**模型正文**，标识符是那里最常见的东西。
         * 单下划线（`read_file`）本来就不配对、不受影响；真正被切开的是有两个及以上 `_` 的标识符。
         *
         * ⚠️ `*` **不做**这条限制：CommonMark 里 `a*b*c` **就是** `a<em>b</em>c`。
         * 只修 `_`、不修 `*`，是照口径修，不是照直觉修。
         */
        const intraword =
          c === '_' && (isWordChar(text[i - 1]) || isWordChar(text[end + mark.length]));
        if (!intraword && inner.trim() && !inner.startsWith(' ') && !inner.endsWith(' ')) {
          pushText();
          const children =
            depth < 3 ? parseInline(inner, depth + 1) : [{ type: 'text' as const, text: inner }];
          out.push(strong ? { type: 'strong', children } : { type: 'em', children });
          i = end + mark.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  pushText();
  return out;
}
