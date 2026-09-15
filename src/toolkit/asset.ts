import { readFileSync } from 'node:fs';

/**
 * Agentia —— 文本资产加载（capabilities/<name>/ 目录约定的配套 helper）。
 *
 * 一能力一文件夹时，长文本（prompt 模板、子 agent 的 system）放在能力目录里的
 * .md 文件，能力代码里 `asset(import.meta.url, './system.md')` 直读：
 *
 * ```ts
 * // capabilities/reviewer/index.ts
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
 *
 * 边界口径：rel 是**开发者字面量**而非外部输入，`../` 越出能力目录**有意放行**
 *（共享资产如 `../../shared/common.md` 是合法用法，框架不替作者设防）；
 * 但带 scheme 的「相对路径」（`file:` / `https:` …）会让 `new URL(rel, base)` 整个
 * 忽略 base —— 「以为读了能力目录里的文件，实际读了别处」，这种静默错位显式拒绝。
 */
export function asset(base: string | URL, rel: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel)) {
    throw new Error(
      `asset() 的 rel 必须是相对路径（如 './system.md'），收到带 scheme 的 "${rel}" —— 它会让 base 被整个忽略`,
    );
  }
  return readFileSync(new URL(rel, base), 'utf8');
}
