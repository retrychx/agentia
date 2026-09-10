import { readFileSync } from 'node:fs';

/**
 * Agentia —— 文本资产加载（units/<name>/ 目录约定的配套 helper）。
 *
 * 一单元一文件夹时，长文本（prompt 模板、子 agent 的 system）放在单元目录里的
 * .md 文件，单元代码里 `asset(import.meta.url, './system.md')` 直读：
 *
 * ```ts
 * // units/reviewer/index.ts
 * import { SubAgent, asset } from 'agentia';
 * export default class Reviewer {
 *   @SubAgent({ description: '…', schema: {...}, system: asset(import.meta.url, './system.md') })
 *   reviewer(_input: { doc: string }): void {}
 * }
 * ```
 *
 * 每次调用现读、不缓存：@Prompt 的 volatile 语义（每次调用重算）要求资产新鲜；
 * 文本文件读取开销可忽略。要在模块加载期固化，就在模块顶层调用一次存常量。
 *
 * @param base 调用方模块的 import.meta.url（相对它解析 rel）
 * @param rel  相对资产路径（'./system.md'）
 */
export function asset(base: string | URL, rel: string): string {
  return readFileSync(new URL(rel, base), 'utf8');
}
