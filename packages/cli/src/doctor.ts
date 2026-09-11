/** doctor 命令：静态体检装配健康度（只读文件系统 + units.ts 文本，不 import 用户代码） */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidName } from './templates.js';

/** 单元入口候选（须与框架 src/toolkit/discover.ts 的 ENTRY_CANDIDATES 一致） */
const ENTRY_CANDIDATES = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];

interface RegistryEntry {
  token: string;
  ident: string;
}

/** 解析 units.ts：imports（标识符 → 来源）+ entries（provide token → useClass 标识符） */
function parseRegistry(content: string): { imports: Map<string, string>; entries: RegistryEntry[] } {
  const imports = new Map<string, string>();
  for (const m of content.matchAll(/^import\s+(\w+)\s+from\s+'([^']+)'/gm)) {
    imports.set(m[1], m[2]);
  }
  const entries: RegistryEntry[] = [];
  for (const m of content.matchAll(/\{\s*provide:\s*'([^']+)'\s*,\s*useClass:\s*(\w+)/g)) {
    entries.push({ token: m[1], ident: m[2] });
  }
  return { imports, entries };
}

export function doctor(): number {
  const cwd = process.cwd();
  const unitsDir = join(cwd, 'units');
  const registryFile = join(cwd, 'units.ts');

  const folders = existsSync(unitsDir)
    ? readdirSync(unitsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const content = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : '';
  const { imports, entries } = parseRegistry(content);

  const warnings: string[] = [];
  const errors: string[] = [];
  const oks: string[] = [];

  // 重复 provide 条目 → 错误
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.token, (seen.get(e.token) ?? 0) + 1);
  for (const [token, n] of seen) {
    if (n > 1) errors.push(`units.ts 存在 ${n} 条重复 provide: '${token}'，请保留一条`);
  }

  const folderSet = new Set(folders);
  const registeredTokens = new Set(entries.map((e) => e.token));

  // 文件夹视角：命名规范 / 入口文件 / 是否登记
  for (const name of folders) {
    let broken = false;
    if (!isValidName(name)) {
      errors.push(`单元名「${name}」不符合 kebab-case 规范（units/${name}/）`);
      broken = true;
    }
    if (!ENTRY_CANDIDATES.some((f) => existsSync(join(unitsDir, name, f)))) {
      errors.push(`单元 units/${name}/ 缺少入口文件（${ENTRY_CANDIDATES.join(' / ')}）`);
      broken = true;
    }
    if (!registeredTokens.has(name)) {
      warnings.push(`units/${name}/ 存在但 units.ts 未登记（运行 agentia g <type> ${name} 或手工登记）`);
    } else if (!broken) {
      oks.push(`units/${name}：已登记且入口齐全`);
    }
  }

  // 注册表视角：悬空单板（import 指向 ./units/ 但文件夹已不存在；add 引入的包无本地文件夹属正常）
  for (const e of entries) {
    if (!isValidName(e.token)) {
      errors.push(`provide token「${e.token}」不符合 kebab-case 规范`);
    }
    const source = imports.get(e.ident);
    if (source === undefined) continue; // 无法定位 import（可能手工编写），跳过
    if (source.startsWith('./units/')) {
      const folder = source.split('/')[2];
      if (folder !== undefined && !folderSet.has(folder)) {
        warnings.push(
          `units.ts 条目 { provide: '${e.token}' } 指向 ${source}，但 units/${folder}/ 不存在（悬空单板，请删除条目或恢复目录）`,
        );
      }
    }
  }

  console.log('agentia doctor —— 装配体检\n');
  for (const msg of oks) console.log(`  ✓ ${msg}`);
  for (const msg of warnings) console.log(`  警告：${msg}`);
  for (const msg of errors) console.log(`  错误：${msg}`);
  console.log(`\n体检结果：${errors.length} 错误，${warnings.length} 警告`);

  if (errors.length > 0) {
    process.exitCode = 1;
    return 1;
  }
  return 0;
}
