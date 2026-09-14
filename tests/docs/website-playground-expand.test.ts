import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 官网 playground 的 trace 回放**必须同时给摘要与原文**。
 *
 * 为什么值得单独钉：渲染器的展开态读 `full`，而 `full` 只有调用方有 —— 62 字符的摘要反推不出
 * 原文。少传一个实参**不会报错、不会让任何断言变红**，只是「点开什么都没多出来」。
 * 这个宿主就这么漏过一次：`playTrace`（CLI inspector）那条路在 #28 里改好了，官网这条
 * 自己组 trace 的路径没跟上，于是**同一份渲染器在两个宿主里一个真展开、一个假展开** ——
 * 而两处共用一份渲染器的全部意义就是不让这种漂移发生。
 *
 * 这类缺陷浏览器里也要靠「展开后的正文 ≠ 折叠态摘要」才量得出来（页面不报错、无溢出、
 * 构建全绿）。但它在**源码层**是静态可见的，所以在这里便宜地钉住。
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const scriptsDir = join(repoRoot, 'packages', 'website', 'src', 'scripts');

/** 取 `(` 起括号配平的那段实参文本（跨行调用也能取全） */
function argListOf(src: string, openParenIdx: number): string | null {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return null;
}

/** 某个函数名的**调用点**实参列表（排除 `function name(` 这个定义本身） */
function callArgLists(src: string, fnName: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`(?<!function\\s)${fnName}\\s*\\(`, 'g'))) {
    const args = argListOf(src, m.index + m[0].length - 1);
    if (args != null) out.push(args);
  }
  return out;
}

/** 顶层逗号切分（不切进嵌套的括号/方括号/花括号里） */
function topLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of args) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

describe('官网 playground 的 trace 事件入参', () => {
  it('记 tool.input 时必须一并给原文（rawArg）—— 否则该宿主是「假展开」', () => {
    const checked = [];
    for (const file of ['playground.js', 'playground-real.js']) {
      const src = readFileSync(join(scriptsDir, file), 'utf8');
      for (const args of callArgLists(src, 'traceEvent')) {
        const parts = topLevelArgs(args);
        if (!parts.some((p) => /^'tool\.input'$/.test(p))) continue;
        checked.push(`${file}: ${parts.length} 个实参`);
        assert.ok(
          parts.some((p) => /rawArg\s*\(/.test(p)),
          `${file} 记 tool.input 事件时没有传原文（找不到 rawArg(...)）：折叠态摘要与展开态全文是\n` +
            '两个字段，只传摘要 ⇒ 点开看到的还是那 62 个字符。实参：' +
            args.replace(/\s+/g, ' '),
        );
      }
    }
    assert.ok(
      checked.length >= 2,
      `两个宿主各应有一处 tool.input 记录点，实际找到 ${checked.length} 处`,
    );
  });

  it('traceEvent 包装器把收到的实参全部转发给 view.event（含第 6 个 full）', () => {
    const src = readFileSync(join(scriptsDir, 'playground.js'), 'utf8');
    const def = src.match(/function traceEvent\(([^)]*)\)\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(def, '找不到 traceEvent 的定义');
    const params = topLevelArgs(def[1]);
    const inner = callArgLists(def[2], 'view\\.event')[0] ?? callArgLists(def[2], 'event')[0];
    assert.ok(inner, 'traceEvent 里找不到 view.event(...) 调用');
    const forwarded = topLevelArgs(inner);

    assert.equal(
      forwarded.length,
      params.length,
      `traceEvent(${params.length} 参) 只往 view.event 转了 ${forwarded.length} 个实参 —— 少一个就有一个字段永远传不进去`,
    );
    assert.ok(
      params.length >= 6,
      `view.event 的契约是 6 参（…, ok, full），包装器只声明了 ${params.length} 个`,
    );
  });
});
