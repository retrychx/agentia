import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 把 @migor/trace-view 的产物与面板页面拷进 packages/cli/dist/，
 * 让 inspector 能纯静态提供、CLI 保持零运行时依赖（不 import trace-view）。
 *
 * 本脚本是 CLI 包 `npm run build` 的一部分（prepublishOnly 只跑 build），
 * 必须自给自足：fresh clone 直接 npm publish 时 trace-view 还没构建，
 * 它的构建是纯文件拷贝（零依赖），就地补跑，不因此发出缺资源的包。 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = join(here, '..');
const tvDist = join(cliRoot, '..', 'trace-view', 'dist');
const out = join(cliRoot, 'dist', 'inspector');

if (!existsSync(tvDist)) {
  console.log('[cli] @migor/trace-view 未构建，就地补跑其构建（纯拷贝，零依赖）');
  execFileSync(process.execPath, [join(cliRoot, '..', 'trace-view', 'scripts', 'build.mjs')], {
    stdio: 'inherit',
  });
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

/* 脚手架模板（templates/ 真文件）整树拷进 dist/templates/ —— create/g 在运行时
 * 从 dist 读模板（见 src/templates.ts 的 templatePath）。点文件以无点文件名
 * 存放（gitignore/env/env.example），写出时才补点，原因见 templates.ts 文件头。 */
cpSync(join(cliRoot, 'templates'), join(cliRoot, 'dist', 'templates'), { recursive: true });

console.log(
  '[cli] inspector 资源就位：dist/inspector/ + dist/inspector-page.html；AI 说明：dist/AGENTS.md；脚手架模板：dist/templates/',
);

/* 根 CHANGELOG.md 随 CLI 包发布（npm 的「总是包含」只覆盖 README/LICENSE，
 * CHANGELOG 不在其列 —— 实测 npm pack 不含它）。拷到包根（不是 dist/），
 * 已进 .gitignore（构建产物，单源是仓库根那份）。 */
cpSync(join(cliRoot, '..', '..', 'CHANGELOG.md'), join(cliRoot, 'CHANGELOG.md'));
