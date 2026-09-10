/** units.ts 注册表 codemod：基于 @agentia 标记行插入/跳过条目，幂等 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMPORTS_END_MARKER,
  ENTRIES_END_MARKER,
  emptyRegistryTemplate,
  kebabToPascal,
} from './templates.js';

export class RegistryError extends Error {}

/** 注册表文件不存在时按空模板创建 */
export function ensureRegistry(dir: string): string {
  const file = join(dir, 'units.ts');
  if (!existsSync(file)) {
    writeFileSync(file, emptyRegistryTemplate(), 'utf8');
  }
  return file;
}

export type RegisterResult = 'registered' | 'already';

/** 把单元登记进 dir/units.ts；已存在同名条目则跳过。标记行缺失时报错。 */
export function registerUnit(dir: string, name: string): RegisterResult {
  const file = ensureRegistry(dir);
  const content = readFileSync(file, 'utf8');

  const importLine = `import ${kebabToPascal(name)} from './units/${name}/index.js';`;
  const entryLine = `  { provide: '${name}', useClass: ${kebabToPascal(name)} },`;

  if (content.includes(`'./units/${name}/index.js'`) || content.includes(`provide: '${name}'`)) {
    return 'already';
  }

  const lines = content.split('\n');
  const importsEnd = lines.findIndex((l) => l.trim() === IMPORTS_END_MARKER);
  const entriesEnd = lines.findIndex((l) => l.trim() === ENTRIES_END_MARKER);
  if (importsEnd === -1 || entriesEnd === -1) {
    throw new RegistryError(
      `units.ts 缺少 ${IMPORTS_END_MARKER} / ${ENTRIES_END_MARKER} 标记行，无法自动登记；请手工维护该文件`,
    );
  }

  lines.splice(entriesEnd, 0, entryLine);
  lines.splice(importsEnd, 0, importLine);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return 'registered';
}
