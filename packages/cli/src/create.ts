/** create 命令：生成 Agentia 项目脚手架 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

export function createProject(name: string, parent: string | undefined): number {
  const dir = resolve(parent ?? process.cwd(), name);

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

  registerUnit(dir, 'hello');

  console.log(`已创建项目 ${dir}

后续步骤：
  cd ${dir}
  npm install
  export ANTHROPIC_API_KEY=sk-ant-...
  npm run dev`);
  return 0;
}
