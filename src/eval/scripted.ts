import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../core/tool.js';

/**
 * Agentia —— 脚本化模型客户端（D2，evals）。
 *
 * 把测试里那个手写的 `mockClient` 提升为一等能力：按脚本依次返回**模型响应**，
 * 于是「改 prompt / 换模型 / 加工具之后有没有回归」可以写成断言，而不是靠人眼看。
 * 这是 agent 服务最缺的一环 —— 单测覆盖的是框架语义，evals 覆盖的是**你的 agent 语义**。
 *
 * 与 `tests/helpers.ts` 的 mockClient 的差别（为什么不是同一个东西）：
 * - 这里是**公共 API**，走 `ModelClient` 类型，能在用户项目里用（mockClient 是测试夹具）；
 * - 这里会**真的把文本块逐块通过 `on('text')` 吐出去** —— 于是 `onText` / SSE 链路
 *   在 eval 里也真实走一遍（mockClient 直接忽略 `on`）；副作用是「已吐字不重试」这类
 *   与流式相关的分支在 eval 里也按真实路径走；
 * - 步骤耗尽会抛错（而不是静默返回 undefined），脚本与 agent 行为不匹配时立刻可见。
 */

/** 一步脚本：直接给响应对象，或按本次请求参数现算（`(params) => message`） */
export type ScriptedStep =
  | Record<string, unknown>
  | ((params: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>);

/**
 * 按脚本依次返回模型响应。
 *
 * 消费时机：**在 `finalMessage()` 成功返回之后**才前进到下一步 —— 于是
 * ① 抛错的步骤（用函数步骤 `throw` 模拟 429 / 网络失败）会在重试时**重放同一步**，
 * 想验重试就写 `(params) => { if (++n === 1) throw ...; return msg; }`；
 * ② 脚本耗尽时报错指向「第几次调用」，一眼看出 agent 多调了一轮模型。
 */
export function scriptedClient(steps: ScriptedStep[]): ModelClient {
  let cursor = 0;
  return {
    messages: {
      stream(params: unknown) {
        const handlers: Array<(delta: string) => void> = [];
        return {
          on(event: 'text', cb: (delta: string) => void): void {
            if (event === 'text') handlers.push(cb);
          },
          async finalMessage(): Promise<Anthropic.Message> {
            const step = steps[cursor];
            if (step === undefined) {
              throw new Error(
                `scriptedClient 脚本耗尽：第 ${cursor + 1} 次调用模型，但只给了 ${steps.length} 步`,
              );
            }
            const message = (await (typeof step === 'function' ? step(params) : step)) as unknown as Anthropic.Message;
            // 真的逐块吐文本 —— onText / SSE 链路在 eval 里按真实路径走一遍
            for (const block of (message.content ?? []) as Array<{ type?: string; text?: string }>) {
              if (block.type === 'text' && block.text) {
                for (const h of handlers) h(block.text);
              }
            }
            cursor++;
            return message;
          },
        };
      },
    },
  } as ModelClient;
}
