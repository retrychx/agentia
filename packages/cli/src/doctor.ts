/** doctor 命令：静态体检装配健康度（只读文件系统 + src/registry.ts 文本，不 import 用户代码） */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_DIRS, CAPABILITY_DIR_LIST, REGISTRY_PATH, isValidName } from './templates.js';
import { legacyLayout, legacyMigrationHint } from './layout.js';

/** 能力入口候选（须与框架 src/toolkit/discover.ts 的 ENTRY_CANDIDATES 一致） */
const ENTRY_CANDIDATES = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];

interface RegistryEntry {
  token: string;
  ident: string;
}

/** 解析 src/registry.ts：imports（标识符 → 来源）+ entries（provide token → useClass 标识符） */
function parseRegistry(content: string): {
  imports: Map<string, string>;
  entries: RegistryEntry[];
} {
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

/** 分类目录相对注册表的 import 前缀：./tools 等（悬空条目判定用） */
const LOCAL_PREFIXES = CAPABILITY_DIR_LIST.map((p) => './' + p.replace(/^src\//, '') + '/');

export function doctor(): number {
  const cwd = process.cwd();

  // 老布局：先给迁移提示再收工 —— 去扫一个还不存在的新布局只会刷一屏无关警告
  const legacy = legacyLayout(cwd);
  if (legacy) {
    console.log('agentia doctor —— 装配体检\n');
    console.log(`  警告：${legacyMigrationHint(legacy)}`);
    console.log('\n体检结果：0 错误，1 警告');
    return 0;
  }

  const registryFile = join(cwd, REGISTRY_PATH);

  const content = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : '';
  const { imports, entries } = parseRegistry(content);

  const warnings: string[] = [];
  const errors: string[] = [];
  const oks: string[] = [];

  // 重复 provide 条目 → 错误
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.token, (seen.get(e.token) ?? 0) + 1);
  for (const [token, n] of seen) {
    if (n > 1) errors.push(`${REGISTRY_PATH} 存在 ${n} 条重复 provide: '${token}'，请保留一条`);
  }

  const registeredTokens = new Set(entries.map((e) => e.token));
  /** 文件夹名 → 出现的分类目录列表（跨类型同名会让装配期静默覆盖一个） */
  const whereByName = new Map<string, string[]>();
  const allFolders = new Set<string>();

  // 逐个分类目录体检：命名规范 / 入口文件 / 是否登记
  for (const [type, relDir] of Object.entries(CAPABILITY_DIRS) as [string, string][]) {
    const dir = join(cwd, relDir);
    if (!existsSync(dir)) {
      warnings.push(
        `${relDir}/ 不存在（该类型暂时没有能力；discover 里若仍列着这个路径会启动即报错）`,
      );
      continue;
    }
    const folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const name of folders) {
      allFolders.add(name);
      whereByName.set(name, [...(whereByName.get(name) ?? []), relDir]);
      let broken = false;
      if (!isValidName(name)) {
        errors.push(`能力名「${name}」不符合 kebab-case 规范（${relDir}/${name}/）`);
        broken = true;
      }
      if (!ENTRY_CANDIDATES.some((f) => existsSync(join(dir, name, f)))) {
        errors.push(`能力 ${relDir}/${name}/ 缺少入口文件（${ENTRY_CANDIDATES.join(' / ')}）`);
        broken = true;
      }
      if (!registeredTokens.has(name)) {
        warnings.push(
          `${relDir}/${name}/ 存在但未登记（运行 agentia g ${type} ${name} 或手工登记）`,
        );
      } else if (!broken) {
        oks.push(`${relDir}/${name}：已登记且入口齐全`);
      }
    }
  }

  // 跨分类目录同名 → 错误（四个目录共用一套 token，装配期后者覆盖，菜单只会剩一个）
  for (const [name, dirs] of whereByName) {
    if (dirs.length > 1) {
      errors.push(
        `能力名「${name}」在多个分类目录重复（${dirs.join('、')}）—— DI token 共用，装配期只会保留一个；请改名`,
      );
    }
  }

  // 注册表视角：悬空条目（import 指向本地分类目录但文件夹已不存在；add 引入的包无本地文件夹属正常）
  for (const e of entries) {
    if (!isValidName(e.token)) {
      errors.push(`provide token「${e.token}」不符合 kebab-case 规范`);
    }
    const source = imports.get(e.ident);
    if (source === undefined) continue; // 无法定位 import（可能手工编写），跳过
    const prefix = LOCAL_PREFIXES.find((p) => source.startsWith(p));
    if (prefix === undefined) continue;
    const folder = source.slice(prefix.length).split('/')[0];
    if (folder !== undefined && !allFolders.has(folder)) {
      warnings.push(
        `${REGISTRY_PATH} 条目 { provide: '${e.token}' } 指向 ${source}，但该目录已不存在（悬空条目，请删除条目或恢复目录）`,
      );
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
