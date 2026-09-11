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

console.log('[cli] inspector 资源就位：dist/inspector/ + dist/inspector-page.html');
