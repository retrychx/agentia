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
 * 但**带 scheme** 的（`file:` / `https:` …）与**绝对路径**（`/etc/passwd`）都会让
 * `new URL(rel, base)` 把 base 的路径部分整个丢掉 —— 「以为读了能力目录里的文件，
 * 实际读了别处」，这种静默错位显式拒绝。（`../` 不在此列：它**是**相对 base 解析的。）
 */
export function asset(base: string | URL, rel: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel)) {
    throw new Error(
      `asset() 的 rel 必须是相对路径（如 './system.md'），收到带 scheme 的 "${rel}" —— 它会让 base 被整个忽略`,
    );
  }
  // 绝对路径与带 scheme 的**同一类**：`new URL('/etc/passwd', 'file:///a/b/c.js')`
  // 解析成 `file:///etc/passwd`，base 被整个忽略。此前只拦了 scheme，注释声称的
  // 那个不变量（「不让 base 被静默忽略」）实际上没守住。
  // `\\` 一并拦：`file:` 是 special scheme，反斜杠会被规范化成 `/`，同样丢掉 base。
  // Windows 的 `C:\x` 已被上面的 scheme 正则拦下。
  if (rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error(
      `asset() 的 rel 必须是相对路径（如 './system.md'），收到绝对路径 "${rel}" —— 它会让 base 被整个忽略`,
    );
  }
  return readFileSync(new URL(rel, base), 'utf8');
}
