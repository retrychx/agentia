import { writeFileSync } from 'node:fs';
import { Tool } from '@migor/agentia';
import type { Workspace } from '../../workspace.js';

/** 产出报告（可写，但**只**能写进产出目录，文件名是单段）—— 这是本服务唯一的交付物 */
export default class WriteReport {
  constructor(private readonly ws: Workspace) {}

  @Tool({
    description:
      '把巡检报告的 Markdown 正文写入产出目录。filename 必须是单段文件名（如 patrol.md），不能带路径。',
    schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '单段文件名，建议以 .md 结尾' },
        markdown: { type: 'string', description: '报告的 Markdown 全文' },
      },
      required: ['filename', 'markdown'],
      additionalProperties: false,
    },
    strict: true,
  })
  writeReport(input: { filename: string; markdown: string }): string {
    const abs = this.ws.resolveWritable(input.filename);
    writeFileSync(abs, input.markdown, 'utf8');
    return JSON.stringify({
      ok: true,
      path: input.filename,
      bytes: Buffer.byteLength(input.markdown, 'utf8'),
    });
  }
}
