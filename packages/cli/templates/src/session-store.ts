import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MessageParam, SessionStore } from '@migor/agentia';

/**
 * 文件后端 `SessionStore`：整段对话历史存在一个 JSON 文件里。
 *
 * 为什么需要文件后端：框架自带的 `InMemorySessionStore` 是**进程内**的，重启即丢。
 * 而 dev 环（以及任何重启式宿主）每次 run 都可能换进程 —— 对话历史要接得上，
 * 就必须落盘。这个类只有 ~30 行，放在模板里（而不是框架里）：它是**可选件**，
 * 只有对话型能力用得上，而放模板里用户能直接改（换 sqlite / Redis 只改这一个文件）。
 *
 * ⚠️ 与 `MemoryStore` 不是一回事：那是键值**黑板**（存「状态与事实」），
 * 这是**对话历史**（存 messages 序列）。两者正交，可以同时用。
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly file: string) {}

  load(sessionId: string): MessageParam[] {
    const cur = this.readAll()[sessionId];
    // 返回浅拷贝：run 会把结果拼进自己的 messages 数组并继续 push，
    // 直接把内部数组交出去会让那些 push 反向污染 store 里的历史。
    return Array.isArray(cur) ? [...cur] : [];
  }

  append(sessionId: string, messages: MessageParam[]): void {
    const all = this.readAll();
    const cur = all[sessionId] ?? [];
    for (const m of messages) cur.push(m);
    all[sessionId] = cur;
    mkdirSync(dirname(this.file), { recursive: true });
    // 原子写：先写同目录的临时文件再 rename。直接覆写的话，进程在写一半时被杀
    // 会留下半截 JSON，下一次 load 直接抛 —— 整段历史因为一次崩溃而不可读。
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: all }, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /**
   * 读整份文件。文件不存在 = 还没有历史（空）。
   * 解析失败**响亮报错**而不是当作空历史 —— 静默当成空会把「历史读不出来」
   * 伪装成「这是第一轮」，然后下一轮 append 再把它覆盖掉：整段对话无声消失。
   */
  private readAll(): Record<string, MessageParam[]> {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`读会话文件失败（${this.file}）：${(e as Error).message}`);
    }
    if (raw.trim().length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `会话文件不是合法 JSON（${this.file}）：${(e as Error).message}\n` +
          '它是本地调试产物（已进 .gitignore），删掉它就能重新开始一段干净的对话。',
      );
    }
    const sessions = (parsed as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      throw new Error(`会话文件结构不对（${this.file}）：应为 { "sessions": { "<id>": [...] } }`);
    }
    return sessions as Record<string, MessageParam[]>;
  }
}
