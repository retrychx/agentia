/**
 * 巡检工作区 —— 把「模型给的路径字符串」翻译成「进程能碰的绝对路径」。
 *
 * 这是宿主自己的安全边界，不是框架的：框架只负责把工具调进来，**路径能不能碰**
 * 是宿主的判断（spec 的「只给缝不给策略」）。所以这里只做两件事：
 *
 *   1. **读面**：一切读操作必须落在 `root` 之下 —— 越界（`..` / 绝对路径 / 软链逃逸）
 *      一律抛错，而不是「纠正成 root 下的某个路径」（静默纠正 = 把攻击变成笔误）。
 *   2. **写面**：只有 `reportsDir` 之下可写，且文件名被规整过（不带目录分隔符）。
 *
 * 越界判定分两道，缺一不可：
 *
 *   - **词法道**：`resolve` 之后比 `relative`（不用 `startsWith`）——`/a/bc` 以 `/a/b`
 *     开头但不在它里面，字符串前缀判定会放过它。这道只挡住 `..` 与绝对路径，
 *     **挡不住软链**：`root/link -> /etc` 词法上在界内，`readFileSync`/`renameSync`
 *     却都跟随链接。
 *   - **真身道**：root 在构造期先 `realpathSync` 一次作基准，每个待读路径解析后再
 *     `realpathSync` 求真身，真身仍须落在 realpath 后的 root 内。macOS 大小写不敏感
 *     文件系统上 realpath 返回磁盘真实大小写，两边都过 realpath 后比较口径一致。
 *     realpath 要求路径**存在**：不存在的路径（含悬空软链）抛 ENOENT、软链成环抛
 *     ELOOP，两者都落成同一个「不可读」错误通道（界内不存在 ≠ 越界，但对模型来说
 *     结论一样：这个路径碰不了）。
 *
 * 已知边界：校验与使用之间存在 TOCTOU 竞态（realpath 验过之后路径被换成别的东西）。
 * 示例不防这一层 —— 生产上靠挂载层兜底（容器里巡检根本来就是 `:ro` 挂进来的）。
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface WorkspaceOptions {
  /** 巡检根（只读面） */
  root: string;
  /** 产出目录（唯一可写面） */
  reportsDir: string;
}

export class Workspace {
  /** 巡检根（**realpath 之后的真身**，display/relative 的基准都是它） */
  readonly root: string;
  readonly reportsDir: string;
  readonly quarantineDir: string;

  constructor(opts: WorkspaceOptions) {
    this.root = realpathExisting(resolve(opts.root), '巡检根');
    // 先建目录再 realpath：reportsDir 可能尚不存在，而 realpath 要求存在
    const reportsAbs = resolve(opts.reportsDir);
    mkdirSync(join(reportsAbs, 'quarantine'), { recursive: true });
    this.reportsDir = realpathSync(reportsAbs);
    this.quarantineDir = join(this.reportsDir, 'quarantine');
  }

  /**
   * 只读面解析：把 `p`（相对 root）解析成绝对路径，并**证明**它的真身没跑出 root。
   * 返回值是 **realpath 之后的真身路径**（调用方拿去 read/stat/rename 都跟着真身走，
   * 不会在「校验一个词法路径、操作另一个真身」之间裂开）。
   *
   * `p` 允许空串（= root 本身，给「列根目录」用）。绝对路径一律拒 —— 不是因为它一定
   * 越界，而是因为接受它就得再判一次「这个绝对路径在不在 root 下」，而模型给的绝对路径
   * 没有任何理由被信任（工具 schema 已经声明了「相对 root」）。
   */
  resolveReadable(p: string): string {
    if (isAbsolute(p)) {
      throw new Error(`只接受相对巡检根（${this.root}）的路径，收到绝对路径：${p}`);
    }
    const abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`路径越出巡检根：${p}（解析为 ${abs}，root=${this.root}）`);
    }
    if (rel === '') return abs; // 就是 root 本身，构造期已 realpath
    const real = realpathExisting(abs, p);
    const relReal = relative(this.root, real);
    if (relReal !== '' && (relReal.startsWith('..') || isAbsolute(relReal))) {
      throw new Error(`路径经软链越出巡检根：${p}（真身为 ${real}，root=${this.root}）`);
    }
    return real;
  }

  /**
   * 写面解析：只允许**单段文件名**（无目录分隔符、不是 `..`/`.`）。
   * 产出目录固定，模型改不了 —— 它只能决定文件叫什么。
   */
  resolveWritable(name: string): string {
    const base = name.trim();
    if (base === '' || base === '.' || base === '..' || base.includes('/') || base.includes(sep)) {
      throw new Error(
        `报告文件名必须是单段文件名（不含路径分隔符），收到：${JSON.stringify(name)}`,
      );
    }
    return join(this.reportsDir, base);
  }

  /** 展示用的相对路径（读数里别泄漏宿主机绝对前缀） */
  display(abs: string): string {
    const rel = relative(this.root, abs);
    return rel === '' ? '.' : rel;
  }
}

/**
 * realpath 一个**必须存在**的路径；不存在 / 悬空软链 / 成环软链统一翻成可读错误。
 * ELOOP 单独点名 —— 「软链成环」与「路径不存在」是两种事故，报错里该分得开。
 */
function realpathExisting(abs: string, what: string): string {
  try {
    return realpathSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new Error(`软链成环，不可读：${what}（解析为 ${abs}）`);
    }
    throw new Error(`路径不存在或不可读：${what}（解析为 ${abs}）`);
  }
}
