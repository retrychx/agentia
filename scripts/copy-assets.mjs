import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 把「使用者向的 AI 说明」随框架包一起发布。
 *
 * 单源是仓库根 docs/usage-guide.md —— 它同时被三处消费：
 *   ① packages/cli      → dist/AGENTS.md（`agentia create` 写进新项目的 AGENTS.md）
 *   ② packages/website  → /llms-full.txt 与 /llms.txt
 *   ③ 这里             → 框架包自己的 dist/AGENTS.md
 *
 * 此前只有 CLI 包带它：装了 @migor/agentia 的人（或 AI）在 node_modules 里只翻得到
 * README，而装 CLI 的却能拿到权威说明 —— 两边不对称，这里补齐。
 *
 * **只拷贝、不另写第二份**：产物落在 dist/（已 gitignore），每次构建重新生成，
 * 因此不会出现「提交的派生文件与单源漂移」那类问题。 */

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const repoRoot = join(here, '..');

const guide = join(repoRoot, 'docs', 'usage-guide.md');
const dist = join(repoRoot, 'dist');

if (!existsSync(guide)) {
  console.error('[agentia] 未找到 docs/usage-guide.md（AI 说明单源）');
  process.exit(1);
}
/* dist/ 由 tsc 产出；本脚本挂在 `npm run build` 的 tsc 之后，正常不会缺。
   单跑本脚本时才可能缺 —— 明确报错，别静默产出空包。 */
if (!existsSync(dist)) {
  console.error('[agentia] dist/ 不存在：先跑 `npm run build`（tsc）再拷资源');
  process.exit(1);
}

cpSync(guide, join(dist, 'AGENTS.md'));
console.log('[agentia] AI 说明就位：dist/AGENTS.md（单源 docs/usage-guide.md）');
