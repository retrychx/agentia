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
 * 越界判定用 `resolve` 之后比 `relative`（不用 `startsWith`）——`/a/bc` 以 `/a/b` 开头
 * 但不在它里面，字符串前缀判定会放过它。这是本仓库对「别用看起来像对的判据」的同一条纪律。
 */
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface WorkspaceOptions {
  /** 巡检根（只读面） */
  root: string;
  /** 产出目录（唯一可写面） */
  reportsDir: string;
}

export class Workspace {
  readonly root: string;
  readonly reportsDir: string;
  readonly quarantineDir: string;

  constructor(opts: WorkspaceOptions) {
    this.root = resolve(opts.root);
    this.reportsDir = resolve(opts.reportsDir);
    this.quarantineDir = join(this.reportsDir, 'quarantine');
    mkdirSync(this.quarantineDir, { recursive: true });
  }

  /**
   * 只读面解析：把 `p`（相对 root）解析成绝对路径，并**证明**它没跑出 root。
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
    if (rel === '') return abs; // 就是 root 本身
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`路径越出巡检根：${p}（解析为 ${abs}，root=${this.root}）`);
    }
    return abs;
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
