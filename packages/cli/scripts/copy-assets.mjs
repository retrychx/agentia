import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 把 @migor/trace-view 的产物与面板页面拷进 packages/cli/dist/，
 * 让 inspector 能纯静态提供、CLI 保持零运行时依赖（不 import trace-view）。 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = join(here, '..');
const tvDist = join(cliRoot, '..', 'trace-view', 'dist');
const out = join(cliRoot, 'dist', 'inspector');

if (!existsSync(tvDist)) {
  console.error('[cli] @migor/trace-view 未构建：先跑 npm run build -w @migor/trace-view');
  process.exit(1);
}

mkdirSync(out, { recursive: true });
cpSync(tvDist, out, { recursive: true });
cpSync(join(cliRoot, 'src', 'inspector-page.html'), join(cliRoot, 'dist', 'inspector-page.html'));

/* 使用者向的 AI 说明（单源：仓库根 docs/usage-guide.md）随 CLI 一起发布 ——
 * `agentia create` 会把它写进新项目的 AGENTS.md，让任何 AI 工具一进项目就拿到
 * 权威 API 说明。注意：monorepo 构建才读得到仓库根，发布物里只有 dist/AGENTS.md。 */
const guide = join(cliRoot, '..', '..', 'docs', 'usage-guide.md');
if (!existsSync(guide)) {
  console.error('[cli] 未找到 docs/usage-guide.md（AI 说明单源）：在仓库根执行构建');
  process.exit(1);
}
cpSync(guide, join(cliRoot, 'dist', 'AGENTS.md'));

console.log('[cli] inspector 资源就位：dist/inspector/ + dist/inspector-page.html；AI 说明：dist/AGENTS.md');
