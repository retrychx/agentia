/** create 命令：生成 Agentia 项目脚手架 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_DIR_LIST,
  copyAssetsMjs,
  emptyRegistryTemplate,
  mainTs,
  projectDotEnv,
  projectDotEnvExample,
  projectGitignore,
  projectPackageJson,
  projectReadme,
  projectTsconfig,
  REGISTRY_PATH,
  toolIndexTs,
} from './templates.js';
import { registerCapability } from './registry.js';

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
  throw new Error(
    `找不到 AI 使用说明（docs/usage-guide.md）。查找过：\n  ${candidates.join('\n  ')}`,
  );
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
  write(dir, 'src/tools/hello/index.ts', toolIndexTs('hello'));
  write(dir, 'scripts/copy-assets.mjs', copyAssetsMjs());
  write(dir, REGISTRY_PATH, emptyRegistryTemplate());
  write(dir, 'README.md', projectReadme(name));
  write(dir, '.gitignore', projectGitignore());
  // 四个分类目录都建出来：目录名自解释，用户一看就知道新能力往哪放
  // （.gitkeep 让空目录能进版本库；discover 只认目录，会忽略它）
  for (const relDir of CAPABILITY_DIR_LIST) {
    write(dir, `${relDir}/.gitkeep`, '');
  }
  // .env 是「填上就能跑」的入口（main.ts 首行 loadEnvFile() 读它）；
  // .env.example 进版本库当变量清单。**两者必须与 gitignore 的 .env 同时存在** ——
  // 生成 .env 却不忽略它，等于把 key 直接送进用户的第一个 commit。
  write(dir, '.env', projectDotEnv());
  write(dir, '.env.example', projectDotEnvExample());
  // AI 使用说明：让 Claude Code / Cursor / Copilot 等一进项目就拿到权威 API 速查
  write(dir, 'AGENTS.md', guide);

  registerCapability(dir, 'hello', 'tool');

  console.log(`已创建项目 ${dir}

后续步骤：
  cd ${dir}
  npm install
  把 API key 填进 .env（已生成，且已被 .gitignore 忽略）
  npm run dev

生产构建：npm run build && npm start（tsc → dist/，.md 资产由 scripts/copy-assets.mjs 跟随拷贝）

目录约定：src/tools/ · src/skills/ · src/prompts/ · src/subagents/（一能力一文件夹）

提示：项目内 AGENTS.md 是本框架的使用说明（API 速查 + 已知边界），
      交给 AI 辅助编码时会自动被读，能显著减少猜 API 的错。`);
  return 0;
}
