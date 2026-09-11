/** create 命令：生成 Agentia 项目脚手架 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mainTs,
  projectGitignore,
  projectPackageJson,
  projectReadme,
  projectTsconfig,
  toolIndexTs,
  emptyRegistryTemplate,
} from './templates.js';
import { registerUnit } from './registry.js';

function write(dir: string, rel: string, content: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

/**
 * 使用者向 AI 说明（项目里的 AGENTS.md）的单源 = 仓库根 `docs/usage-guide.md`。
 * - 发布物：构建时由 `scripts/copy-assets.mjs` 拷成 `dist/AGENTS.md`（here = dist）；
 * - 源码直跑（tsx）：here = src，回退三级到仓库根。
 * 找不到就**明确失败**（不生成缺说明的项目）—— 说明是 AI 写对代码的前提。
 */
function readUsageGuide(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'AGENTS.md'), // 发布物：dist/AGENTS.md
    join(here, '..', '..', '..', 'docs', 'usage-guide.md'), // 源码直跑：packages/cli/src → 仓库根
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`找不到 AI 使用说明（docs/usage-guide.md）。查找过：\n  ${candidates.join('\n  ')}`);
}

export function createProject(name: string, parent: string | undefined): number {
  const dir = resolve(parent ?? process.cwd(), name);

  let guide: string;
  try {
    guide = readUsageGuide();
  } catch (e) {
    console.error(`错误：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return 1;
  }

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    console.error(`错误：目录 ${dir} 已存在且非空`);
    process.exitCode = 1;
    return 1;
  }
  mkdirSync(dir, { recursive: true });

  write(dir, 'package.json', projectPackageJson(name));
  write(dir, 'tsconfig.json', projectTsconfig());
  write(dir, 'src/main.ts', mainTs(name));
  write(dir, 'units/hello/index.ts', toolIndexTs('hello'));
  write(dir, 'units.ts', emptyRegistryTemplate());
  write(dir, 'README.md', projectReadme(name));
  write(dir, '.gitignore', projectGitignore());
  // AI 使用说明：让 Claude Code / Cursor / Copilot 等一进项目就拿到权威 API 速查
  write(dir, 'AGENTS.md', guide);

  registerUnit(dir, 'hello');

  console.log(`已创建项目 ${dir}

后续步骤：
  cd ${dir}
  npm install
  export ANTHROPIC_API_KEY=sk-ant-...
  npm run dev

提示：项目内 AGENTS.md 是本框架的使用说明（API 速查 + 已知边界），
      交给 AI 辅助编码时会自动被读，能显著减少猜 API 的错。`);
  return 0;
}
