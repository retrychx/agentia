import type Anthropic from '@anthropic-ai/sdk';

/**
 * SessionStore —— 会话持久化 / 对话历史（C4）。
 *
 * ⚠️ **与 `MemoryStore` 的区别（别混，文档里必须并列讲）**：
 * - `MemoryStore`（runtime/memory.ts）= 键值**黑板**：跨 run 存「状态与事实」
 *   （用户是谁、上次查到哪），run 开始水合进 `RunContext.blackboard`；
 * - `SessionStore`（本文件）= **对话历史**：存 messages 序列，run 开始拼在传入 messages
 *   **之前**，收尾时把本轮消息追加回去。
 *
 * 两者正交，可以同时用。
 */

export interface SessionStore {
  /** 读整段历史（没有则空数组） */
  load(sessionId: string): Anthropic.MessageParam[] | Promise<Anthropic.MessageParam[]>;
  /**
   * 追加消息（**append-only**）—— 不做 upsert：并发写不会互相覆盖，
   * 也便于事后审计「这段历史是怎么长出来的」。
   */
  append(sessionId: string, messages: Anthropic.MessageParam[]): void | Promise<void>;
}

/** Map 实现：测试与缺省场景（进程内，无持久化） */
export class InMemorySessionStore implements SessionStore {
  private readonly data = new Map<string, Anthropic.MessageParam[]>();

  load(sessionId: string): Anthropic.MessageParam[] {
    // 返回浅拷贝：run 会把结果拼进自己的 messages 数组并继续 push，
    // 直接把内部数组交出去会让那些 push 反向污染 store 里的历史。
    const cur = this.data.get(sessionId);
    return cur ? [...cur] : [];
  }

  append(sessionId: string, messages: Anthropic.MessageParam[]): void {
    const cur = this.data.get(sessionId) ?? [];
    cur.push(...messages);
    this.data.set(sessionId, cur);
  }
}
