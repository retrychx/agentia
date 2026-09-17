import type { AgentTool, ToolRunContext } from '../core/tool.js';

/**
 * Agentia —— 能力调用中间件（拦截器链，roadmap R1）。
 *
 * 挂在每一次能力（tool/skill/subagent/prompt）调用的前后：鉴权、限流、结果缓存、
 * 审计日志、超时包装等横切关注点都走这里，不进业务能力。
 *
 * 语义：
 * - 链序 = 注册顺序（洋葱模型：先注册的最外层）；
 * - `next()` 放行（可用 `next(newInput)` 改写入参）；不调 next 即短路（结果缓存等）；
 * - 抛错按能力失败处理（engine 包成 is_error 回给模型，不中断 run）。
 *
 * 装配期包裹（AgentApp 构造函数），对 engine 零侵入。
 */
export interface CapabilityCall {
  /** 被调用的能力（name/description/inputSchema 可读） */
  readonly capability: AgentTool;
  /** 模型给出的结构化入参（schema 校验已过） */
  readonly input: unknown;
  /** engine 注入的执行上下文（recorder/parentSpanId/client），同步宿主下可用 */
  readonly ctx: ToolRunContext | undefined;
}

/** 放行到下一层；`next(newInput)` 可改写入参，缺省沿用当前 input */
export type CapabilityNext = (input?: unknown) => unknown;

export type CapabilityMiddleware = (call: CapabilityCall, next: CapabilityNext) => unknown;

/** 用中间件链包裹工具菜单（链为空时原样返回，零开销）。 */
export function applyMiddleware(
  tools: AgentTool[],
  middleware: CapabilityMiddleware[],
): AgentTool[] {
  if (middleware.length === 0) return tools;
  return tools.map((tool) => ({
    ...tool,
    run: (input: unknown, ctx?: ToolRunContext) => {
      const step = (i: number, inp: unknown): unknown => {
        if (i >= middleware.length) return tool.run(inp, ctx);
        let passed = false;
        return middleware[i](
          { capability: tool, input: inp, ctx },
          // rest 形参而非默认值：`next(undefined)` 是「把入参改写成 undefined」，
          // 与 `next()`（沿用当前入参）语义不同，默认值写法分不开这两者。
          // 连调两次会让能力体跑两遍（有副作用的能力尤其危险）——直接报错。
          (...a: unknown[]) => {
            if (passed) {
              throw new Error(
                `中间件链上 next() 被重复调用（能力 ${tool.name}）：一次调用只能放行一次`,
              );
            }
            passed = true;
            return step(i + 1, a.length > 0 ? a[0] : inp);
          },
        );
      };
      return step(0, input);
    },
  }));
}
