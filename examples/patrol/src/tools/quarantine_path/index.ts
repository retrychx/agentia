import { mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Tool } from '@migor/agentia';
import type { Workspace } from '../../workspace.js';

/**
 * 隔离文件 —— **本示例唯一会改动文件系统的工具**，因此标了 `approval: 'required'`。
 *
 * 这条「人工审批闸」正是 deployment.md §2 / usage-guide §7 描述的那条路径：
 * 模型调用它 ⇒ run 在回合间挂起为 `suspended`（不是失败、不占并发槽、不触发完成回调）
 * ⇒ 宿主 `POST /tasks/<taskId>/approve` 给决定 ⇒ 恢复执行。
 * （路径段写 `<taskId>` 而不是 `<id>`：提交响应里的字段名就是 `taskId`，
 *  `id` 是**读不到的** —— 照 `id` 写会拿到 undefined。）
 *
 * 动作本身是**可逆**的（移动到产出目录下的 quarantine/，不是删除）——刻意的：
 * 演示审批闸不该顺手真的毁数据，而且「可逆」才配得上「隔离」这个词。
 */
export default class QuarantinePath {
  constructor(private readonly ws: Workspace) {}

  @Tool({
    description:
      '把一个文件移入隔离区（可逆：从巡检根移到产出目录的 quarantine/ 下）。这是改动文件系统的动作，需要人工审批。',
    approval: 'required',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对巡检根的文件路径' },
        reason: { type: 'string', description: '为什么要隔离它（会进隔离回执，供人审批时判断）' },
      },
      required: ['path', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  })
  quarantinePath(input: { path: string; reason: string }): string {
    // resolveReadable 返回的是 realpath 后的真身：指向界外的软链在解析期就已被拒
    // （否则 renameSync 跟随链接，会把 root 外的真文件移进隔离区，而审批人看到的
    // 仍是 benign 相对路径）；指向界内的软链则移动的是真身文件，软链本身留在原地。
    const src = this.ws.resolveReadable(input.path);
    const st = statSync(src, { throwIfNoEntry: false });
    if (!st) throw new Error(`文件不存在：${input.path}`);
    if (!st.isFile()) throw new Error(`只能隔离文件（收到 ${input.path} 不是普通文件）`);
    mkdirSync(this.ws.quarantineDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = join(this.ws.quarantineDir, `${stamp}__${basename(src)}`);
    renameSync(src, dst);
    return JSON.stringify({
      ok: true,
      quarantined: input.path,
      to: this.ws.display(dst),
      bytes: st.size,
      reason: input.reason,
    });
  }
}
