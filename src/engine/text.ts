/**
 * 引擎侧的文本读取口径（**单源**）：多文本块用 `\n` 连接。
 *
 * 从 turn.ts 外移（2026-09-20，turn 拆分第一步）：`stop-reason.ts` 也要用这个口径，而它若
 * 继续从 turn.ts 取、turn.ts 又要 import stop-reason.ts ⇒ **成环**（分层守卫禁环）。这一层很薄，
 * 但「引擎用 `\n`、适配器用 `''`」这个选择必须只有一处 —— 见 core/text.ts 头注。
 */
import type { Message } from '../core/message.js';
import { textOf as coreTextOf } from '../core/text.js';

/** 取消息里的全部文本块（引擎口径：多块按 `\n` 连接，保住模型的分段输出） */
export function textOf(message: Message): string {
  return coreTextOf(message, '\n');
}
