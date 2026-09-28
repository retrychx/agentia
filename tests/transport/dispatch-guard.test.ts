import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **派发口的穷尽守卫**（2026-09-28 外部深评 P1-1 的根因修法）。
 *
 * 背景：所有「先落库再派发」的路径形状相同（`submit` / `approve` / `signalTask` / 到期唤醒 /
 * 审批超时兜底 / `resumePending` 的认领循环），而**停机闸原先散在各支里** —— 于是
 * 「这道闸覆盖几条路径」是一份**靠人记**的清单：第一批修了三支，第四支（审批超时兜底，
 * 由 `poll()` 驱动）与第五支（认领循环）漏了，两处都在 `drain()` 说了「排空干净」之后
 * 又起了新 run（实证见 `drain-race.test.ts`）。
 *
 * 本用例是那份清单的**可执行版本**：`src/transport/async.ts` 里 `this.#execute(` 只许出现在
 * 唯一派发口 `#dispatch` 里（与 `store/*.ts` 禁裸 `JSON.parse` 那道源码守卫同款）。
 * ⇒ 第五次新增恢复路径而忘了走 `#dispatch` 时，**构建红**，不靠记性。
 *
 * 自带**真空护栏**：先断言解析出来的规模合理 —— 否则正则一旦失效，这个用例会永远绿
 * （那种守卫比没有更糟）。
 */
const SRC = fileURLToPath(new URL('../../src/transport/async.ts', import.meta.url));

/** 去掉注释后的源码（注释里提到 `this.#execute(` 不算调用点） */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('派发口守卫（源码级）：`this.#execute(` 只许出现在 #dispatch 里', () => {
  const code = codeOf(SRC);

  it('真空护栏：源码真解析出来了（否则下面的断言全是假绿）', () => {
    assert.ok(code.length > 10_000, `解析出的源码太短（${code.length} 字符）—— 守卫已失效`);
    assert.ok(code.includes('export class AsyncRunner'), '解析到了 AsyncRunner 本体');
  });

  it('调用点恰好一处，落在 #dispatch 里、且在停机闸之后', () => {
    const sites = code.match(/this\.#execute\(/g) ?? [];
    assert.equal(
      sites.length,
      1,
      `this.#execute( 出现 ${sites.length} 处 —— 派发必须一律走 #dispatch（闸只在那里判一次）`,
    );
    const at = code.indexOf('this.#execute(');
    const window = code.slice(Math.max(0, at - 400), at);
    assert.match(window, /#dispatch\(rec: TaskRecord\): void \{/, '唯一调用点必须在 #dispatch 里');
    assert.match(
      window,
      /if \(this\.#drain\.isDraining\) return;/,
      '#dispatch 的停机闸必须排在派发之前',
    );
  });

  it('各恢复路径都走唯一入口（次数下限，防有人把某一支改回裸派发）', () => {
    const calls = code.match(/this\.#dispatch\(/g) ?? [];
    assert.ok(
      calls.length >= 7,
      `this.#dispatch( 只出现 ${calls.length} 次 —— submit + 六条恢复路径都该走它`,
    );
  });
});
