/**
 * Agentia —— 消息文本读取（**单源**）。
 *
 * 合并三处同形实现：`integrations/anthropic.ts` 与 `integrations/openai.ts` 的
 * 「非流式回落路径」各有一份 `join('')`，`engine/turn.ts` 有一份 `join('\n')`。
 * 三份长得一样、只差一个连接符 —— 这不是巧合，是同一个语义在三处各自推导了一遍，
 * 任何后续修正（例如「空文本块不该产生分隔符」）都只会落到其中一处。
 *
 * 为什么不放进 `core/message.ts`：那个文件**刻意**是「零依赖纯类型文件」
 * （见其头注：编译后全部擦除、import 它零运行时成本）。为一个 8 行函数破掉这条性质
 * 不划算 —— 类型在 `message.ts`、取值函数在这儿，两边各守一个职责。
 *
 * `separator` 是**调用方语义**，不是格式细节：
 * - `''`（适配器）：回落的原文本来就是一整段，拼回去要与流式累积的文本逐字一致；
 * - `'\n'`（引擎）：多文本块是模型分段的输出，拼成 `finalText` 要保住分段。
 */
import type { Message, TextBlock } from './message.js';

/** 取消息里的全部文本块，按 `separator` 连接（无文本块 → 空串） */
export function textOf(message: Pick<Message, 'content'>, separator: string): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(separator);
}
