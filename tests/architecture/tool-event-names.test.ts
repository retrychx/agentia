/*
 * 架构守卫 —— 工具 I/O 事件名（`tool.input` / `tool.output`）的**跨层单源**（外部深评 E8）。
 *
 * ## 不守会怎样
 *
 * 这两个名字跨 **engine → eval → integrations** 三层被手写（原状 12 处取值）。改名的代价不是
 * 「改三遍」那么轻：漏一处不是少记一条事件，而是**静默归零** —— 事件在引擎里叫 A、报表按 B
 * 过滤 ⇒ `integrations/report.ts` / `metrics-state.ts` 那两处过滤恒空，**报表说「没有工具调用」
 * 而 trace 里明明有**。同一类的先例本仓记过好几次（`limits.ts` 头注的「计数会过期」、
 * `AGENTS.md` 的分层约定），共同点是：**没有任何东西会在退化时变红**。
 *
 * ## 单源为什么落在 `core/trace.ts`
 *
 * 外部报告建议放 `engine/tool-events.ts`（与载荷构造器同处）—— **不可行**：`integrations`
 * 只许依赖 `core`（`tests/architecture/layering.test.ts`），拿不到 engine 的导出，那样
 * integrations 侧只能再手写一份，等于把「单源」补成「两处」。所以名字（core）与载荷构造器
 * （engine）**分开**：名字是最底层词汇表，谁都能引。本守卫把这个结论也钉住 ——
 * 常量必须能从 `core/trace.ts` 取到、且值就是那两个字符串（它是**对外契约**：
 * 看板 / OTLP 消费方 / 报表都按这个名字过滤，改值等于改协议）。
 *
 * ## 为什么**不**复用 `lib/source-scan.ts`
 *
 * 那个扫描器的职责是**读模块说明符**，为此它把字符串**逐字遮蔽**掉。本守卫要找的恰恰是
 * 「处在代码位置的字符串字面量」—— 复用它会把要猎的东西一起遮掉（**假阴性**，最危险的方向）。
 * 所以这里自带一个最小遮蔽器，并配三组自证样本把「它真的能区分」钉住：
 * 代码里的字面量**必须**看见；行注释 / 块注释 / 模板字符串里的**必须**看不见。
 *
 * ## 白名单（一条，且不许静默变大）
 *
 * `src/eval/harvest.ts` 的那一处是**生成出去的代码文本**（写进 harvested 用例的源码），
 * 不是本仓的取值 —— 生成的脚本不 import 本仓常量，改成 `TOOL_INPUT_EVENT` 会得到一个引用了
 * 不存在标识符的脚本（跑起来才炸）。所以它按**文件 + 恰好条数**放行：多了或少了都红。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_INPUT_EVENT, TOOL_OUTPUT_EVENT } from '../../src/core/trace.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** 单源所在文件：常量**定义**在这里，别处一律不许再写字面量 */
const SINGLE_SOURCE = 'src/core/trace.ts';

/** 放行清单：文件 → **恰好**允许的条数（多了少了都红，白名单不能静默变大） */
const ALLOWLIST: ReadonlyArray<{ file: string; count: number; why: string }> = [
  {
    file: 'src/eval/harvest.ts',
    count: 1,
    why: '生成出去的用例源码文本（不 import 本仓常量）',
  },
];

const NEEDLES = ["'tool.input'", "'tool.output'"];

/**
 * 最小遮蔽器：把**注释**与**模板字符串的字面量段**替换成等长空格（保留换行），
 * 但**保留代码位置的字符串字面量** —— 与 `lib/source-scan.ts` 恰好相反，理由见文件头注。
 *
 * ⚠️ 模板里的 `${ … }` **是代码**（不是字面量段）：必须按代码递归处理，否则那里面的字面量
 * 会被整段遮掉 ⇒ **假阴性**（本文件第一版就是这么写的，被下面那条自证样本当场抓出）。
 */
function maskNonCode(src: string): string {
  const out = src.split('');
  const blank = (a: number, b: number): void => {
    for (let k = Math.max(0, a); k < Math.min(b, src.length); k++)
      if (out[k] !== '\n') out[k] = ' ';
  };

  /** 扫一段**代码**：注释就地遮蔽、模板递归、普通字符串只跳过（内容保留） */
  function scanCode(start: number, stop: number): void {
    let i = start;
    while (i < stop) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && n === '/') {
        let j = i;
        while (j < stop && src[j] !== '\n') j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '/' && n === '*') {
        let j = i + 2;
        while (j < stop && !(src[j] === '*' && src[j + 1] === '/')) j++;
        blank(i, j + 2);
        i = Math.min(j + 2, stop);
        continue;
      }
      if (c === '`') {
        i = scanTemplate(i, stop);
        continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < stop && src[j] !== c) {
          if (src[j] === '\\') j++;
          j++;
        }
        i = j + 1;
        continue;
      }
      i++;
    }
  }

  /** 模板：字面量段遮蔽，`${ … }` 的**表达式段按代码递归**；返回结束位置（` 之后） */
  function scanTemplate(start: number, stop: number): number {
    let i = start + 1;
    let chunk = i;
    while (i < stop) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '`') {
        blank(chunk, i);
        return i + 1;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        blank(chunk, i + 2); // 字面量段 + `${` 本身
        // 找配对的 `}`：字符串 / 注释 / 内层模板里的花括号都不参与计数
        let depth = 1;
        let j = i + 2;
        while (j < stop && depth > 0) {
          const c = src[j];
          if (c === "'" || c === '"') {
            let k = j + 1;
            while (k < stop && src[k] !== c) {
              if (src[k] === '\\') k++;
              k++;
            }
            j = k + 1;
            continue;
          }
          if (c === '/' && src[j + 1] === '/') {
            while (j < stop && src[j] !== '\n') j++;
            continue;
          }
          if (c === '/' && src[j + 1] === '*') {
            let k = j + 2;
            while (k < stop && !(src[k] === '*' && src[k + 1] === '/')) k++;
            j = Math.min(k + 2, stop);
            continue;
          }
          if (c === '`') {
            j = scanTemplate(j, stop);
            continue;
          }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          j++;
        }
        scanCode(i + 2, j - 1); // ← 表达式段是**代码**：里面的字面量必须看得见
        blank(j - 1, j); // 收尾的 `}`（模板语法的一部分）
        i = j;
        chunk = i;
        continue;
      }
      i++;
    }
    blank(chunk, stop);
    return stop;
  }

  scanCode(0, src.length);
  return out.join('');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 数一个文件里「代码位置的」目标字面量有几条 */
function countLiterals(file: string): number {
  const masked = maskNonCode(readFileSync(file, 'utf8'));
  let n = 0;
  for (const needle of NEEDLES) {
    let idx = masked.indexOf(needle);
    while (idx !== -1) {
      n++;
      idx = masked.indexOf(needle, idx + needle.length);
    }
  }
  return n;
}

describe('工具 I/O 事件名的跨层单源（E8）', () => {
  it('常量值就是那两个字符串（对外契约：看板 / OTLP / 报表都按名字过滤）', () => {
    assert.equal(TOOL_INPUT_EVENT, 'tool.input');
    assert.equal(TOOL_OUTPUT_EVENT, 'tool.output');
  });

  it('遮蔽器自证：代码里的看见、注释与模板里的看不见（含阳性对照）', () => {
    // 没有这组，「0 处违规」不可证伪 —— 遮蔽器一旦错位吞掉后面的代码，本守卫会假绿
    const sample = [
      "const a = 'tool.input';", // 代码位置 → 必须看见
      "// 注释里写 'tool.output' 不算", // 行注释 → 必须看不见
      "/* 块注释里写 'tool.input' 也不算 */", // 块注释 → 必须看不见
      "const b = `模板里写 'tool.output' 也不算`;", // 模板字面量 → 必须看不见
      "const c = `${'tool.input'}`;", // 模板的 ${} **里面是代码** → 必须看见（嵌套判据）
    ].join('\n');
    const masked = maskNonCode(sample);
    assert.equal(
      (masked.match(/'tool\.input'/g) ?? []).length,
      2,
      '代码位置的两处必须都看得见（含 ${} 嵌套里那处）',
    );
    assert.equal((masked.match(/'tool\.output'/g) ?? []).length, 0, '注释与模板里的两处必须看不见');
  });

  it('全 src 只有单源文件允许出现这两个字面量（白名单按文件+条数，不许静默变大）', () => {
    const files = walk(SRC);
    // 防真空：走查范围塌成空会假绿
    assert.ok(files.length > 60, `走查范围异常：只扫到 ${files.length} 个 .ts（应 ≥ 60）`);
    // 射程钉：**曾经**带这两个字面量的文件必须在走查范围里（否则「扫了但没扫到该扫的」）
    for (const must of [
      'src/engine/turn.ts',
      'src/engine/mcp-server.ts',
      'src/engine/replay.ts',
      'src/eval/export.ts',
      'src/eval/harvest.ts',
      'src/integrations/metrics-state.ts',
      'src/integrations/report.ts',
      'src/core/trace.ts',
    ]) {
      assert.ok(files.includes(join(SRC, ...must.split('/').slice(1))), `射程里缺 ${must}`);
    }

    const violations: string[] = [];
    for (const file of files) {
      const rel = `src/${file.slice(SRC.length + 1)}`;
      const n = countLiterals(file);
      if (n === 0) continue;
      if (rel === SINGLE_SOURCE) continue; // 单源：常量定义在这里
      const allowed = ALLOWLIST.find((a) => a.file === rel);
      if (!allowed) {
        violations.push(`${rel}：${n} 处字面量（应改引 core/trace.ts 的常量）`);
      } else if (allowed.count !== n) {
        violations.push(
          `${rel}：白名单写 ${allowed.count} 条、实测 ${n} 条（${allowed.why}）—— 白名单不许静默变大`,
        );
      }
    }
    assert.deepEqual(
      violations,
      [],
      `工具 I/O 事件名必须在 core/trace.ts 单源；下面的文件又手写了字面量：\n${violations.join('\n')}`,
    );
  });

  it('单源确实是**常量**（不是又一处字面量集中在别的地方）：core/trace.ts 导出两条且各恰好一处', () => {
    const n = countLiterals(join(SRC, 'core', 'trace.ts'));
    assert.equal(n, 2, `core/trace.ts 应恰好两处（两个常量的定义各一处），实测 ${n} 处`);
  });
});
