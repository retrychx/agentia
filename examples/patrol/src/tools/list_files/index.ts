import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Tool } from '@migor/agentia';
import type { Workspace } from '../../workspace.js';

/** 单次列目录的条目上限 —— 工具输出无大小闸是框架已知边界（usage-guide §7），宿主自己收口 */
const MAX_ENTRIES = 200;

/** 列目录（只读）：返回该目录下的直接子项，按名字排序 */
export default class ListFiles {
  constructor(private readonly ws: Workspace) {}

  @Tool({
    description:
      '列出巡检根下某个目录的直接子项（名、类型、字节数）。dir 省略或传 "." 表示巡检根。只读，不递归。',
    schema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '相对巡检根的目录路径，省略表示根' },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  })
  listFiles(input: { dir?: string }): string {
    const abs = this.ws.resolveReadable(input.dir ?? '.');
    const names = readdirSync(abs).sort();
    const rows = names.slice(0, MAX_ENTRIES).map((name) => {
      // lstat 不跟随软链：条目类型如实标 'link'（让模型知道它是链接），
      // 链接指不指向界内由 read_file / quarantine_path 的 realpath 校验把关。
      const st = lstatSync(join(abs, name), { throwIfNoEntry: false });
      if (!st) return { name, type: 'unknown' };
      const type = st.isDirectory()
        ? 'dir'
        : st.isFile()
          ? 'file'
          : st.isSymbolicLink()
            ? 'link'
            : 'other';
      return { name, type, bytes: type === 'file' ? st.size : undefined };
    });
    const truncated = names.length > MAX_ENTRIES;
    return JSON.stringify(
      {
        dir: this.ws.display(abs),
        total: names.length,
        shown: rows.length,
        truncated,
        entries: rows,
      },
      null,
      1,
    );
  }
}
