import type { AgentTool, ToolRunContext } from '../core/tool.js';

/**
 * Agentia —— 单元调用中间件（拦截器链，roadmap R1）。
 *
 * 挂在每一次单元（tool/skill/subagent/prompt）调用的前后：鉴权、限流、结果缓存、
 * 审计日志、超时包装等横切关注点都走这里，不进业务单元。
 *
 * 语义：
 * - 链序 = 注册顺序（洋葱模型：先注册的最外层）；
 * - `next()` 放行（可用 `next(newInput)` 改写入参）；不调 next 即短路（结果缓存等）；
 * - 抛错按单元失败处理（engine 包成 is_error 回给模型，不中断 run）。
 *
 * 装配期包裹（AgentApp 构造函数），对 engine 零侵入。
 */
export interface UnitCall {
  /** 被调用的单元（name/description/inputSchema 可读） */
  readonly unit: AgentTool;
  /** 模型给出的结构化入参（schema 校验已过） */
  readonly input: unknown;
  /** engine 注入的执行上下文（recorder/parentSpanId/client），同步宿主下可用 */
  readonly ctx?: ToolRunContext;
}

/** 放行到下一层；`next(newInput)` 可改写入参，缺省沿用当前 input */
export type UnitNext = (input?: unknown) => unknown;

export type UnitMiddleware = (call: UnitCall, next: UnitNext) => unknown;

/** 用中间件链包裹工具菜单（链为空时原样返回，零开销）。 */
export function applyMiddleware(tools: AgentTool[], middleware: UnitMiddleware[]): AgentTool[] {
  if (middleware.length === 0) return tools;
  return tools.map((tool) => ({
    ...tool,
    run: (input: unknown, ctx?: ToolRunContext) => {
      const invoke = (i: number, inp: unknown): unknown =>
        i >= middleware.length
          ? tool.run(inp, ctx)
          : middleware[i](
              { unit: tool, input: inp, ctx },
              (nextInput: unknown = inp) => invoke(i + 1, nextInput),
            );
      return invoke(0, input);
    },
  }));
}
