/** src/registry.ts 注册表 codemod：基于 @agentia 标记行插入/跳过条目，幂等 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CAPABILITY_DIRS,
  IMPORTS_END_MARKER,
  ENTRIES_END_MARKER,
  REGISTRY_PATH,
  emptyRegistryTemplate,
  kebabToPascal,
  type CapabilityType,
} from './templates.js';

export class RegistryError extends Error {}

/** 注册表文件不存在时按空模板创建（含所需的父目录） */
export function ensureRegistry(dir: string): string {
  const file = join(dir, REGISTRY_PATH);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, emptyRegistryTemplate(), 'utf8');
  }
  return file;
}

export type RegisterResult = 'registered' | 'already';

/** 在标记区插入 import 行与条目行；标记行缺失时报错 */
function insertAtMarkers(content: string, importLine: string, entryLine: string): string {
  const lines = content.split('\n');
  const importsEnd = lines.findIndex((l) => l.trim() === IMPORTS_END_MARKER);
  const entriesEnd = lines.findIndex((l) => l.trim() === ENTRIES_END_MARKER);
  if (importsEnd === -1 || entriesEnd === -1) {
    throw new RegistryError(
      `${REGISTRY_PATH} 缺少 ${IMPORTS_END_MARKER} / ${ENTRIES_END_MARKER} 标记行，无法自动登记；请手工维护该文件`,
    );
  }
  lines.splice(entriesEnd, 0, entryLine);
  lines.splice(importsEnd, 0, importLine);
  return lines.join('\n');
}

/** 分类目录 → 相对注册表（src/registry.ts）的 import 前缀，如 src/tools → ./tools */
function importPrefix(type: CapabilityType): string {
  return './' + CAPABILITY_DIRS[type].replace(/^src\//, '');
}

/** 把能力登记进 src/registry.ts；已存在同名条目则跳过。标记行缺失时报错。 */
export function registerCapability(dir: string, name: string, type: CapabilityType): RegisterResult {
  const file = ensureRegistry(dir);
  const content = readFileSync(file, 'utf8');

  const prefix = importPrefix(type);
  const source = `${prefix}/${name}/index.js`;
  const importLine = `import ${kebabToPascal(name)} from '${source}';`;
  const entryLine = `  { provide: '${name}', useClass: ${kebabToPascal(name)} },`;

  if (content.includes(`'${source}'`) || content.includes(`provide: '${name}'`)) {
    return 'already';
  }

  writeFileSync(file, insertAtMarkers(content, importLine, entryLine), 'utf8');
  return 'registered';
}

/** 把第三方包（agentia add）登记进 src/registry.ts；token/import 来源已存在则跳过。 */
export function registerPackage(dir: string, token: string, importSource: string): RegisterResult {
  const file = ensureRegistry(dir);
  const content = readFileSync(file, 'utf8');

  const pascal = kebabToPascal(token);
  const importLine = `import ${pascal} from '${importSource}';`;
  const entryLine = `  { provide: '${token}', useClass: ${pascal} },`;

  if (content.includes(`provide: '${token}'`) || content.includes(`from '${importSource}'`)) {
    return 'already';
  }

  writeFileSync(file, insertAtMarkers(content, importLine, entryLine), 'utf8');
  return 'registered';
}
