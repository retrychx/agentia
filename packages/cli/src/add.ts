/** add 命令：npm install 第三方单元包并登记进 units.ts 注册表 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerPackage } from './registry.js';

/** 从 add 参数解析真实包名：支持 name[@version]、@scope/name[@version]、本地路径（. / 前缀，或 file: 协议） */
export function resolvePackageName(arg: string): string {
  // file: 协议（npm install file:./pkg 的写法）先剥前缀，再按本地路径处理
  const local = arg.startsWith('file:') ? arg.slice('file:'.length) : arg;
  if (local.startsWith('.') || local.startsWith('/')) {
    const pkgFile = join(resolve(local), 'package.json');
    if (!existsSync(pkgFile)) {
      throw new Error(`本地包 ${local} 缺少 package.json`);
    }
    const name = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string }).name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`本地包 ${local} 的 package.json 缺少 name 字段`);
    }
    return name;
  }
  // 去掉版本后缀：@scope/name@1.0.0 → @scope/name；name@1.0.0 → name
  const at = arg.startsWith('@') ? arg.indexOf('@', 1) : arg.indexOf('@');
  return at > 0 ? arg.slice(0, at) : arg;
}

/** 包名 → DI token：去 scope，转 kebab-case（fooBar → foo-bar，foo_bar → foo-bar） */
export function packageNameToToken(pkgName: string): string {
  const bare = pkgName.startsWith('@') ? pkgName.slice(pkgName.indexOf('/') + 1) : pkgName;
  return bare
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

export function addPackage(arg: string): number {
  const cwd = process.cwd();

  const r = spawnSync('npm', ['install', arg], { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`错误：npm install ${arg} 失败，units.ts 未改动`);
    process.exitCode = 1;
    return 1;
  }

  let pkgName: string;
  try {
    pkgName = resolvePackageName(arg);
  } catch (err) {
    console.error(`错误：${(err as Error).message}`);
    process.exitCode = 1;
    return 1;
  }
  const token = packageNameToToken(pkgName);
  const result = registerPackage(cwd, token, pkgName);

  if (result === 'registered') {
    console.log(`已登记到 units.ts：import ${pkgName} → { provide: '${token}' }`);
  } else {
    console.log(`units.ts 中「${token}」已注册，跳过登记`);
  }
  console.log(
    '约定提示：第三方单元包应 default export 一个 provider 类（或 Provider 对象）；' +
      '若该包不符合约定，请手工调整 units.ts 中的 import 与条目',
  );
  return 0;
}
