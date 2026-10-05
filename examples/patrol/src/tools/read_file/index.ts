import { readFileSync, statSync } from 'node:fs';
import { Tool } from '@migor/agentia';
import type { Workspace } from '../../workspace.js';

/** 单次读取的缺省 / 上限（字节）—— 宿主侧的输出尺寸闸，见 usage-guide §7 */
const DEFAULT_MAX_BYTES = 16_000;
const HARD_MAX_BYTES = 256_000;

/** 读文件（只读）：按字节上限截断，并**如实标注截断**（不让模型以为这就是全文） */
export default class ReadFile {
  constructor(private readonly ws: Workspace) {}

  @Tool({
    description:
      '读取巡检根下某个文本文件的内容。超过 maxBytes 会截断，返回值里会标注 truncated=true。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对巡检根的文件路径' },
        maxBytes: {
          type: 'integer',
          description: `最多读多少字节（缺省 ${DEFAULT_MAX_BYTES}，上限 ${HARD_MAX_BYTES}）`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  })
  readFile(input: { path: string; maxBytes?: number }): string {
    const abs = this.ws.resolveReadable(input.path);
    const st = statSync(abs);
    if (st.isDirectory()) throw new Error(`${input.path} 是目录，不是文件（用 list_files）`);
    const limit = Math.min(Math.max(1, input.maxBytes ?? DEFAULT_MAX_BYTES), HARD_MAX_BYTES);
    const raw = readFileSync(abs);
    const truncated = raw.byteLength > limit;
    const text = raw.subarray(0, limit).toString('utf8');
    return JSON.stringify(
      {
        path: this.ws.display(abs),
        bytes: st.size,
        truncated,
        content: text,
      },
      null,
      1,
    );
  }
}
