/*
 * 架构守卫 —— AGENTS.md 的**仓库导览图不漏点名**（外部深评 F2，2026-09-29）。
 *
 * ## 不守会怎样
 *
 * `AGENTS.md` 的目录树里点名的文件，是「有独立职责、值得单独说明」的那些。但**没有任何守卫**
 * 要求它穷尽 —— 全仓提到 `AGENTS.md` 的 10 处都在讲别的事（observability / usage-guide /
 * tsconfig / layering…），所以「新加一个文件要不要登记进地图」全靠记得。后果实测过一次：
 * #170 往 `src/toolkit/` 加了 `capability-cycles.ts`（能力引用图的成环检测），`AGENTS.md`
 * 里**一次都没提过**；而同一目录、同一批的 `capability-slice.ts` 却在 #186 被补上了 ——
 * 同一件事，一个记得、一个忘了，且没人发现。
 *
 * ## 为什么**不**做「全部点名」的全量穷尽
 *
 * 结构体检时实证过：`src/toolkit/` 13 个文件里，只有 `capability-slice.ts` / `module.ts`
 * 以**完整文件名**在 `AGENTS.md` 出现（`tool.ts` 的那次命中是 `core/tool.ts` 的假阳性）。
 * 其余 9 个是**故意**以概念词覆盖的 ——「装饰器×4」涵盖 `tool/prompt/skill/subagent`、
 * 「中间件」涵盖 `middleware.ts`、「collect 内核」「目录发现(discover)」「zod 桥」……
 * `AGENTS.md` 是**精选导览**不是清单，要求它点名每个文件既做不到也没必要。
 * ⇒ 判据改成「**露名，或显式豁免**」：新增文件必须在 `AGENTS.md` 出现文件名，或进下面的
 * `CONCEPT_ONLY`（说明它被哪个概念短语覆盖）—— 一句话：**加文件时要表态**。
 *
 * ## 射程如实
 *
 * 只守 `src/toolkit/`（F2 的实际发生地）。别的目录（`engine` / `transport` / `integrations` …）
 * 同理会漂，本期不扩面 —— 需要时按同一模板加。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const TOOLKIT = join(ROOT, 'src', 'toolkit');

/**
 * 「概念词覆盖」豁免清单：这些文件**故意不在** `AGENTS.md` 露英文文件名，而是被目录树说明里
 * 的某个概念短语整体涵盖。新增文件若既不露名、也不在此列 ⇒ 守卫红。
 *
 * ⚠️ `tool.ts` **不在此列**：`AGENTS.md` 里出现的 `tool.ts` 其实是 `core/tool.ts`（假阳性），
 * 它靠这个假阳性通过判定 —— 已知瑕疵，列在这里只为如实（改 `core/tool.ts` 的说明前先想一下）。
 */
const CONCEPT_ONLY: Readonly<Record<string, string>> = {
  'asset.ts': '「文本资产(asset)」以概念词覆盖',
  'collect.ts': '「collect 内核」以概念词覆盖',
  'discover.ts': '「目录发现(discover)」以概念词覆盖',
  'env.ts': '「env 引导(loadEnvFile)」以概念词覆盖',
  'middleware.ts': '「中间件」以中文名覆盖',
  'prompt.ts': '「装饰器×4」整体覆盖',
  'skill.ts': '「装饰器×4」整体覆盖',
  'subagent.ts': '「装饰器×4」整体覆盖',
  'zod.ts': '「zod 桥」以概念词覆盖',
};

describe('AGENTS.md 导览图不漏点名（F2）', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const files = readdirSync(TOOLKIT).filter((f) => f.endsWith('.ts'));

  it('src/toolkit 的每个文件要么被 AGENTS.md 点名，要么在概念覆盖清单里（带理由）', () => {
    assert.ok(
      files.length >= 13,
      `走查范围异常：src/toolkit 只扫到 ${files.length} 个 .ts（应 ≥ 13）—— 输入没吃到会假绿`,
    );
    const unregistered = files.filter((f) => !agents.includes(f) && !(f in CONCEPT_ONLY));
    assert.deepEqual(
      unregistered,
      [],
      '这些 src/toolkit 文件既没在 AGENTS.md 露名、也不在概念覆盖清单里 —— 新加文件要在导览图里表态' +
        `（露名，或加进 CONCEPT_ONLY 并写清被哪个概念短语覆盖）：\n${unregistered.join('\n')}`,
    );
  });

  it('F2 的当事人 capability-cycles.ts 确实被点名（不是靠豁免蒙混过关）', () => {
    assert.ok(
      agents.includes('capability-cycles.ts'),
      'AGENTS.md 应点名 capability-cycles.ts（能力引用图的成环检测）—— F2 的核心修复',
    );
    assert.ok(
      !('capability-cycles.ts' in CONCEPT_ONLY),
      'capability-cycles.ts 不该走豁免 —— 它有独立职责，必须真正出现在地图里',
    );
  });
});
