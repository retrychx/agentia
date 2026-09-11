import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Provider } from '../container/container.js';
import { isProvider } from '../container/container.js';

/**
 * Agentia —— 单元目录发现（units/<name>/ 目录约定，spec §7 静态校验仍由装配层统一做）。
 *
 * 约定：
 * - 每个子目录 = 一个单元文件夹，入口为 index.ts / index.mts / index.js / index.mjs（按序取先存在者）；
 * - 入口 default export 支持三种形态：
 *   1. 类                → { provide: <文件夹名>, useClass: 该类 }
 *   2. Provider 对象      → 原样使用（可用 useFactory/useValue 自定义 token）
 *   3. Provider 数组      → 展开（一个文件夹暴露多个 provider）
 * - DI token 缺省 = 文件夹名（kebab-case 文件夹即 kebab-case token，单元引用照写）。
 *
 * 与手动 providers 可混用：createApp({ providers, discover }) 合并注册，
 * 重名/引用校验在装配期统一进行（AgentApp 构造函数）。
 *
 * 动态 import 决定本函数是异步的 —— createApp 带 discover 时同样返回 Promise。
 */
const ENTRY_CANDIDATES = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];

export async function discoverProviders(dir: string): Promise<Provider[]> {
  const root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (!existsSync(root)) {
    throw new Error(`单元目录不存在: ${root}（先创建或用 CLI: agentia g <type> <name>）`);
  }

  const providers: Provider[] = [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => isDirLike(join(root, e.name), e))
    .map((e) => e.name)
    .sort(); // 排序保证装配顺序稳定（菜单顺序 = 目录名序，可复现）

  for (const name of entries) {
    const entry = ENTRY_CANDIDATES.map((f) => join(root, name, f)).find(existsSync);
    if (!entry) {
      // 静默跳过过一次（无入口的目录视为非单元目录，如 assets/）：
      // 但「菜单莫名少一个单元」需要留痕，否则只能靠猜
      console.warn(`[agentia:discover] 跳过 ${name}/：无 ${ENTRY_CANDIDATES.join(' / ')} 入口`);
      continue;
    }
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (e) {
      throw new Error(
        `单元 ${name} 入口加载失败（${entry}）: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    const exported = (mod as { default?: unknown }).default;
    providers.push(...normalizeExport(name, exported, entry));
  }
  return providers;
}

/**
 * 目录判定：**软链目录**（pnpm store / monorepo 里 `units/foo` 常是软链）的
 * `isDirectory()` 为 false，直接用会把真单元目录静默漏掉、菜单空着却不报错 ——
 * 软链要 stat 解引用后再判。悬空软链按非目录处理。
 */
function isDirLike(full: string, e: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function normalizeExport(name: string, exported: unknown, entry: string): Provider[] {
  if (typeof exported === 'function') {
    return [{ provide: name, useClass: exported as new () => object }];
  }
  if (isProvider(exported)) {
    return [exported];
  }
  if (Array.isArray(exported) && exported.every(isProvider)) {
    return exported;
  }
  throw new Error(
    `单元入口 ${entry} 的 default export 形态非法：应为「类 / Provider / Provider[]」，实际 ${describe(exported)}`,
  );
}

function describe(x: unknown): string {
  if (x === undefined) return 'undefined（缺少 default export？）';
  if (x === null) return 'null';
  return typeof x;
}
