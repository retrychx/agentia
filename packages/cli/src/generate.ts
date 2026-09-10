/** g / generate 命令：在 cwd 生成 units/<name>/ 单元并登记注册表 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  promptAssetMd,
  promptIndexTs,
  skillIndexTs,
  subagentIndexTs,
  subagentSystemMd,
  toolIndexTs,
  type UnitType,
} from './templates.js';
import { ensureRegistry, registerUnit } from './registry.js';

export function generateUnit(type: UnitType, name: string): number {
  const cwd = process.cwd();
  const unitDir = join(cwd, 'units', name);

  if (existsSync(unitDir)) {
    console.error(`错误：units/${name}/ 已存在`);
    process.exitCode = 1;
    return 1;
  }
  mkdirSync(unitDir, { recursive: true });

  const files: string[] = [];
  const put = (rel: string, content: string): void => {
    writeFileSync(join(unitDir, rel), content, 'utf8');
    files.push(`units/${name}/${rel}`);
  };

  switch (type) {
    case 'tool':
      put('index.ts', toolIndexTs(name));
      break;
    case 'prompt':
      put('index.ts', promptIndexTs(name));
      put('asset.md', promptAssetMd(name));
      break;
    case 'subagent':
      put('index.ts', subagentIndexTs(name));
      put('system.md', subagentSystemMd(name));
      break;
    case 'skill':
      put('index.ts', skillIndexTs(name));
      break;
  }

  ensureRegistry(cwd);
  const result = registerUnit(cwd, name);

  console.log(`已生成 ${type} 单元：`);
  for (const f of files) console.log(`  ${f}`);
  if (result === 'registered') {
    console.log(`已登记到 units.ts：{ provide: '${name}' }`);
  } else {
    console.log(`units.ts 中「${name}」已注册，跳过登记`);
  }
  console.log('提示：discover 目录扫描路线下无需登记即可生效；显式装配路线从 units.ts 引入 providers');
  return 0;
}
