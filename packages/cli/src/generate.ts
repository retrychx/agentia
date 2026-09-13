/** g / generate 命令：在 cwd 生成 src/<分类>/<name>/ 能力并登记注册表 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_DIRS,
  promptAssetMd,
  promptIndexTs,
  skillIndexTs,
  subagentIndexTs,
  subagentSystemMd,
  toolIndexTs,
  type CapabilityType,
} from './templates.js';
import { ensureRegistry, registerCapability } from './registry.js';
import { legacyLayout, legacyMigrationHint } from './layout.js';

export function generateCapability(type: CapabilityType, name: string): number {
  const cwd = process.cwd();

  // 老布局：绝不悄悄在旁边新建一棵新目录（会让项目里长出两套能力目录）
  const legacy = legacyLayout(cwd);
  if (legacy) {
    console.error(`错误：${legacyMigrationHint(legacy)}`);
    process.exitCode = 1;
    return 1;
  }

  const relDir = CAPABILITY_DIRS[type];
  const capabilityDir = join(cwd, relDir, name);

  // 四个分类目录共用一套 DI token（缺省 = 文件夹名），跨目录同名会让装配期静默覆盖掉一个。
  // 生成期直接拦住（doctor 另做兜底体检），而不是等运行时菜单少一项才发现。
  const clash = (Object.entries(CAPABILITY_DIRS) as [CapabilityType, string][]).find(([, d]) =>
    existsSync(join(cwd, d, name)),
  );
  if (clash) {
    console.error(
      `错误：能力名「${name}」已存在于 ${clash[1]}/${name}/ —— 四个分类目录共用同一套 DI token（缺省取文件夹名），不能重名`,
    );
    process.exitCode = 1;
    return 1;
  }
  mkdirSync(capabilityDir, { recursive: true });

  const files: string[] = [];
  const put = (rel: string, content: string): void => {
    writeFileSync(join(capabilityDir, rel), content, 'utf8');
    files.push(`${relDir}/${name}/${rel}`);
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
  const result = registerCapability(cwd, name, type);

  console.log(`已生成 ${type} 能力：`);
  for (const f of files) console.log(`  ${f}`);
  if (result === 'registered') {
    console.log(`已登记到 src/registry.ts：{ provide: '${name}' }`);
  } else {
    console.log(`src/registry.ts 中「${name}」已注册，跳过登记`);
  }
  console.log(
    '提示：discover 目录扫描路线下无需登记即可生效；显式装配路线从 src/registry.ts 引入 providers',
  );
  return 0;
}
