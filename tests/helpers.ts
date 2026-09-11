/** 测试共用：mock Anthropic client（脚本化往返）与 fake AppCallable。 */

export interface MockExchange {
  /** 收到完整请求参数时可断言/记录 */
  onParams?: (params: unknown) => void;
  message: Record<string, unknown>;
}

/** 按脚本依次返回 message 的 mock client（stream().on 忽略，finalMessage 出脚本） */
export function mockClient(script: Array<Record<string, unknown> | MockExchange>) {
  const seen: unknown[] = [];
  let i = 0;
  return {
    seen,
    client: {
      messages: {
        stream: (params: unknown) => {
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
                return ex.message;
              }
              return step;
            },
          };
        },
      },
    } as never,
  };
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
