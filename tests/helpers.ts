/** 测试共用：mock Anthropic client（脚本化往返）与 fake AppCallable。 */

import type { Message, ModelClient } from '../src/index.js';

export interface MockExchange {
  /** 收到完整请求参数时可断言/记录 */
  onParams?: (params: unknown) => void;
  message: Record<string, unknown>;
}

/**
 * 按脚本依次返回 message 的 mock client（stream().on 忽略，finalMessage 出脚本）。
 *
 * client 显式标注 `ModelClient`（不是 `as never`）：契约加必需成员时这里编译报错，
 * 而不是所有调用方静默拿一个 any。⚠️ 「忽略 on('text')」是**设计**（要真吐字的增量
 * 用 src/eval 的 scriptedClient）；脚本 message 是测试夹具形状，类型上按 unknown 过渡。
 */
export function mockClient(script: Array<Record<string, unknown> | MockExchange>): {
  seen: unknown[];
  client: ModelClient;
} {
  const seen: unknown[] = [];
  let i = 0;
  const client: ModelClient = {
    messages: {
      stream: (params) => {
        seen.push(params);
        return {
          on() {},
          finalMessage: async () => {
            const step = script[i++];
            if (!step) throw new Error(`mock 脚本耗尽（第 ${i} 次调用）`);
            if ('message' in step) {
              // `in` 对 `Record<string, unknown>` 联合不会收窄 → 显式按 MockExchange 用
              const ex = step as MockExchange;
              ex.onParams?.(params);
              return ex.message as unknown as Message;
            }
            return step as unknown as Message;
          },
        };
      },
    },
  };
  return { seen, client };
}

/** 常用 usage 块 */
export const U = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export function toolUseMsg(name: string, input: unknown, id = 'tu1') {
  return {
    id: 'm1',
    model: 'claude-opus-5',
    stop_reason: 'tool_use' as const,
    usage: U,
    content: [{ type: 'tool_use', id, name, input }],
  };
}

export function endTurnMsg(text: string) {
  return {
    id: 'm2',
    model: 'claude-opus-5',
    stop_reason: 'end_turn' as const,
    usage: U,
    content: [{ type: 'text', text }],
  };
}

/**
 * 等到条件成立 —— 跨进程/带宿主的测试要等「异步侧真的推进了」时用它，别手搓循环。
 *
 * 三条约定，都是踩过的坑：
 * - **断言的是「最终会」，不是「多快会」**：这类等待验的是顺序/一致性，没有一处验延迟指标。
 *   所以预算给足（默认 10s）是**刻意的** —— 1 秒级的墙钟预算等于顺手断言了一个不存在的性能
 *   SLA，在满载 runner 上会把「慢」误判成「坏」，是 CI 上最难查的那类红。
 * - **超时要能自陈**：抛出带 `what`（条件描述）+ 实测耗时的错误。否则满载下只剩一行 assert
 *   失败，没人知道等的是什么、等了多久（`verify-all.sh` 抽标记行也救不了这种情况）。
 * - **返回 Promise<void> 而不是 boolean**：调用方不该「拿到 false 再自己 assert」—— 那样错误
 *   信息就退化成 `expected false to be true` 了。
 */
export async function waitFor(cond: () => boolean, what: string, budgetMs = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    const elapsed = Date.now() - t0;
    if (elapsed >= budgetMs) {
      throw new Error(`waitFor 超时：等了 ${elapsed}ms（预算 ${budgetMs}ms）仍未满足 —— ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
