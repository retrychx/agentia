/**
 * 老布局识别与迁移提示。
 *
 * 目录约定改名（2026-09-13）前是项目根的 `units/` + `units.ts`；新约定是四分类目录
 * `src/tools` · `src/skills` · `src/prompts` · `src/subagents` + 注册表 `src/registry.ts`。
 *
 * **运行时零破坏**：`discover` 收的是路径，老项目 `discover: 'units'` 照跑。变的只是
 * `create` / `g` / `doctor` 的**约定** —— 所以这三个命令必须在老项目里**明确提示迁移**，
 * 而不是悄悄在旁边新建一棵 `src/tools/`，让项目里长出两套能力目录。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY_PATH } from './templates.js';

const LEGACY_REGISTRY = 'units.ts';
const LEGACY_DIR = 'units';

/** 老布局特征列表（用于提示措辞） */
export interface LegacyLayout {
  registry: boolean;
  dir: boolean;
}

/**
 * 检测老布局：项目根还有 `units.ts` 或 `units/`，且新布局的 `src/registry.ts` 不在。
 * 两者都没有、或已经迁移过（新注册表在）→ 返回 null。
 */
export function legacyLayout(dir: string): LegacyLayout | null {
  const registry = existsSync(join(dir, LEGACY_REGISTRY));
  const hasLegacyDir = existsSync(join(dir, LEGACY_DIR));
  if (!registry && !hasLegacyDir) return null;
  if (existsSync(join(dir, REGISTRY_PATH))) return null; // 已迁移（可能还留着老目录，不算阻塞）
  return { registry, dir: hasLegacyDir };
}

/** 迁移提示（多行，直接打印） */
export function legacyMigrationHint(found: LegacyLayout): string {
  const what = [found.dir ? 'units/' : null, found.registry ? 'units.ts' : null]
    .filter(Boolean)
    .join(' + ');
  return `检测到老布局（${what}）—— 目录约定已改为四分类目录，新能力不会再写进 units/：

  1) 把 units/<name>/ 按类型挪进 src/tools/ · src/skills/ · src/prompts/ · src/subagents/
     （目录名就是类型：@Tool→tools、@Skill→skills、@Prompt→prompts、@SubAgent→subagents）
  2) 把 units.ts 挪成 ${REGISTRY_PATH}，import 改成按分类的相对路径，
     如 import Echo from './tools/echo/index.js';
  3) src/main.ts 的 discover 从 'units' 改成四分类目录数组（或仍指向你自定义的目录）

  运行时本身不受影响：discover 收的是路径，discover: 'units' 照跑 —— 但 CLI 不会再往老目录追加。
  迁移完这行提示自然消失。`;
}
