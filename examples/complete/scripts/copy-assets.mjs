// 把单元文件夹里的 .md 文本资产拷进 dist/（与编译产物同相对路径）。
// asset(import.meta.url, './x.md') 按**文件位置**解析，所以 .md 必须跟着 .js 走。
import { cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', 'src');
const outDir = join(here, '..', 'dist');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

let n = 0;
for (const f of walk(srcDir)) {
  cpSync(f, join(outDir, f.slice(srcDir.length + 1)));
  n++;
}
console.log(`[copy-assets] ${n} 个 .md 资产 → dist/`);
