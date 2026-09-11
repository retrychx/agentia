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
 * 读取时机：本函数在**调用处**读文件。把 `asset(...)` 直接当装饰器 spec 值（下面的例子）
 * 是**模块加载期读一次**并固化；要「每次调用重算」（@Prompt 的 volatile 语义），应把
 * `asset(...)` 写在方法体内返回。文本文件读取开销可忽略。
 *
 * @param base 调用方模块的 import.meta.url（相对它解析 rel）
 * @param rel  相对资产路径（'./system.md'）
 */
export function asset(base: string | URL, rel: string): string {
  return readFileSync(new URL(rel, base), 'utf8');
}
