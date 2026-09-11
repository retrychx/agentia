import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* trace-view 产物 = src 下的 .js 与 .css 原样拷到 dist。
 * 纯 ESM、零依赖、无编译步骤 —— 官网（Astro 打包）与 CLI inspector（静态提供）都直接消费。 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(src)) {
  cpSync(join(src, f), join(dist, f));
}
console.log('[trace-view] dist 已生成：' + readdirSync(dist).sort().join(', '));
