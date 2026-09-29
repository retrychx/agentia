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
 * ⚠️ **射程跨四个文件**（2026-09-29 抽出三个监督件）：`approve` / 审批超时兜底 / `signalTask` /
 * 到期唤醒 / `resumePending` 的认领循环各自搬到了 `approval-supervisor.ts` /
 * `signal-supervisor.ts` / `resume-scanner.ts`，它们经**注入的** `dispatch` 回调落到同一个
 * `#dispatch`（停机闸仍留在 `async.ts`）⇒ 「路径数」得四个文件一起数。
 *
 * ⚠️ 每次搬件这个计数都会先掉一格、把这条用例判红 —— **那是它该有的表现**：修法是**扩射程**
 * （把新文件登记进来），不是放宽下限（「路径总数」这一事实没变）。
 *
 * 自带**真空护栏**：先断言解析出来的规模合理 —— 否则正则一旦失效，这个用例会永远绿
 * （那种守卫比没有更糟）。
 */
const SRC = fileURLToPath(new URL('../../src/transport/async.ts', import.meta.url));
/**
 * 三个监督件 —— 各自的派发点形如 `this.#deps.dispatch(`，路径同样落唯一的 `#dispatch`。
 * 第二项是该文件里**应有**的派发点数：少一处 = 有路径不再派发，多一处 = 新恢复路径该登记。
 */
const SUPERVISORS: readonly [string, number][] = [
  ['approval-supervisor.ts', 2],
  ['signal-supervisor.ts', 1],
  ['resume-scanner.ts', 3],
];

/** 监督件源码的绝对路径 */
function supervisorPath(file: string): string {
  return fileURLToPath(new URL(`../../src/transport/${file}`, import.meta.url));
}

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
    // 窗口要够宽：闸与派发之间还夹着「拒绝要出声」那段 warn（见 PR #164 复核 §1）
    const window = code.slice(Math.max(0, at - 1800), at);
    assert.match(window, /#dispatch\(rec: TaskRecord\): void \{/, '唯一调用点必须在 #dispatch 里');
    // 只断言**位置**（闸出现在派发之前），不钉花括号写法 —— 钉格式的守卫会在无害的改版式上红
    assert.match(window, /if \(this\.#drain\.isDraining\)/, '#dispatch 的停机闸必须排在派发之前');
  });

  it('各恢复路径都走唯一入口（次数下限 + 每个监督件的精确数）', () => {
    // 四个文件一起数（见文件头注的射程说明）：恢复路径搬进监督件后，它们的派发点
    // 变成 `this.#deps.dispatch(`。
    const here = (code.match(/this\.#dispatch\(/g) ?? []).length;
    const parts = SUPERVISORS.map(([file, expect]) => {
      const src = codeOf(supervisorPath(file));
      assert.ok(src.length > 200, `${file} 解析出的源码太短（${src.length}）—— 守卫已失效`);
      const n = (src.match(/this\.#deps\.dispatch\(/g) ?? []).length;
      // 少一处 = 有路径不再派发，多一处 = 新恢复路径，该把它一并登记进 SUPERVISORS
      assert.equal(n, expect, `${file} 里的派发点应为 ${expect} 处，实为 ${n}`);
      return n;
    });
    const there = parts.reduce((a, b) => a + b, 0);
    assert.ok(
      here + there >= 7,
      `派发调用点共 ${here + there} 处（async.ts ${here} + 三个监督件 ${there}）` +
        ' —— submit + 六条恢复路径都该走唯一入口',
    );
  });

  it('旁路守卫：`this.#executeInner(` 也只许出现在 `#execute` 里', () => {
    // 2026-09-28 PR #164 复核 §2：#execute 是**唯一**做「同步认领 + 开流 + active++」的地方，
    // 之后才把手交给 #executeInner。新加一条恢复路径时若直接调 `this.#executeInner(rec)`，
    // 会**同时**绕过两样东西 —— 上面那道停机闸（本 PR 修的就是这一类），以及 `active++`
    // 与 `#streams.open`（后果：`drain()` 会在一条 run 真在跑的时候返回 true；
    // `GET /tasks/:id/stream` 对着一条正在跑的任务说 `not-in-this-process`）。
    // 只钉 `this.#execute(` 拦不住它 —— 那是同一个旁路的另一半，所以也钉住。
    const sites = code.match(/this\.#executeInner\(/g) ?? [];
    assert.equal(
      sites.length,
      1,
      `this.#executeInner( 出现 ${sites.length} 处 —— 它只能由 #execute 调（认领/开流/计数都在那里）`,
    );
    const at = code.indexOf('this.#executeInner(');
    const window = code.slice(Math.max(0, at - 700), at);
    assert.match(
      window,
      /async #execute\(rec: TaskRecord\): Promise<void> \{/,
      '唯一调用点必须在 #execute 里',
    );
    assert.match(
      window,
      /this\.active\+\+;/,
      '在飞计数必须先于 #executeInner（否则 drain 漏掉在跑的 run）',
    );
  });
});
