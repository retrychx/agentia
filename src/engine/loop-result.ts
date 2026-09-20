import type { MessageParam } from '../core/message.js';
import type { SpanError } from '../core/trace.js';
import { classifyError } from './errors.js';
import { abortedError } from './turn.js';
import type { AgentStopReason } from './types.js';

/**
 * Agentia —— 循环出口的**结果形状单源**（engine/loop.ts 的拆分第二步）。
 *
 * `AgentLoopResult` 属「结果/状态记录」型（`docs/guards.md` 的类型角色表）：7 个字段
 * **必须全在场**，值可以为 undefined —— 消费方按 `result.suspendedMessages === undefined`
 * 判「没挂起」，而「字段缺席」与「字段为 undefined」在 JSON / OTLP 上是两回事。
 *
 * 此前这 7 个字段由 loop.ts 的五处对象字面量各写一遍（= 35 次「记得写」）：加一个字段
 * 要改五处，漏一处就是无声的形状漂移。现在出口只剩四个具名构造器，各自的语义写在名字上：
 *
 *   suspendedResult  挂起（等人审批）—— 不是失败；交出的历史是**拷贝**
 *   abortedResult    已取消 —— 带结构化 error（取消不是失败，但原因要可查）
 *   failedResult     抛出被兜住 —— 由 `classifyError` 翻成结构化 error
 *   finishedResult   循环这次**结束**了 —— 成败由 stopReason 表达，error 由调用方给
 *
 * 文件分工：本文件只管「出口长什么样」；什么时候走哪个出口由 engine/loop.ts 决定。
 */

export interface AgentLoopResult<T = unknown> {
  stopReason: AgentStopReason;
  finalText: string;
  /** 非正常收尾时的结构化原因；正常收尾为 undefined（**字段在场**，见 core/run.ts 的说明） */
  error: SpanError | undefined;
  /** 本轮循环自己发起的模型往返次数 */
  iterations: number;
  /** submit_result 校验通过的结构化结果；未提交则为 undefined（类型由 resultSchema 推导） */
  typed: T | undefined;
  /**
   * HITL 挂起（stopReason === 'awaiting_approval'）时的完整消息历史
   * （末尾是含未决 tool_use 的 assistant 消息）；未挂起为 undefined（字段在场）。
   */
  suspendedMessages: MessageParam[] | undefined;
  /** HITL 挂起时待决的 tool_use_id 列表；未挂起为 undefined（字段在场） */
  pendingApprovals: string[] | undefined;
}

/**
 * 出口的公共底座：把五个「每次都得给」的字段写全，并把两个「只有挂起才非空」的字段
 * 显式写成**在场**。唯一不经过它的是 `suspendedResult` —— 那正是它要覆盖这两个字段的原因。
 */
function loopResult<T>(f: {
  stopReason: AgentStopReason;
  finalText: string;
  error: SpanError | undefined;
  iterations: number;
  typed: T | undefined;
}): AgentLoopResult<T> {
  return {
    stopReason: f.stopReason,
    finalText: f.finalText,
    error: f.error,
    iterations: f.iterations,
    typed: f.typed,
    suspendedMessages: undefined,
    pendingApprovals: undefined,
  };
}

/** 挂起收尾（两处出口共用：循环中途挂起 / 恢复模式进来发现决定仍不齐） */
export function suspendedResult<T>(
  ctx: { messages: MessageParam[]; progress: { iterations: number }; typed: T | undefined },
  pending: string[],
  /** 挂起前那一回合的文本（循环中途挂起时给；恢复模式再次挂起时没有新回合，留空） */
  finalText = '',
): AgentLoopResult<T> {
  return {
    ...loopResult<T>({
      stopReason: 'awaiting_approval',
      finalText,
      // 挂起不是失败：等人不该被看板算成失败（区分由 stopReason 承担）
      error: undefined,
      iterations: ctx.progress.iterations,
      typed: ctx.typed,
    }),
    // 历史是**拷贝**：宿主落库后仍可能继续用同一条数组，挂起段的消息不能再被改
    suspendedMessages: [...ctx.messages],
    // 待决 id 列表原样交出（同一引用）—— 调用方此后不再改动它，保留原行为，不顺手加拷贝
    pendingApprovals: pending,
  };
}

/**
 * 已取消收尾。取消**不是失败**，但必须带结构化 error —— 否则 trace 上只看到「停了」，
 * 看不出是「人取消的」还是「上游出错的」。
 *
 * `iterations` 由调用方给实际进度：取消可能发生在第 N 回合之后，硬写 0 会谎报成「一次模型都没调」。
 */
export function abortedResult<T = never>(iterations = 0): AgentLoopResult<T> {
  return loopResult<T>({
    stopReason: 'aborted',
    finalText: '',
    error: abortedError(),
    iterations,
    typed: undefined,
  });
}

/**
 * 抛出被兜住的收尾：`cause` 是**任何**抛出来的东西（SDK 异常、类型错误、abort 信号……），
 * 出口处一律经 `classifyError` 翻成结构化 SpanError —— 「非正常收尾必带结构化 error」
 * 这条不变量落在这一处，而不是散在各 catch 里。
 */
export function failedResult<T = never>(cause: unknown, iterations: number): AgentLoopResult<T> {
  return loopResult<T>({
    stopReason: 'error',
    finalText: '',
    error: classifyError(cause),
    iterations,
    typed: undefined,
  });
}

/**
 * 循环这次结束了。名字刻意不含成败：`stopReason` 才是成败的表达
 * （`end_turn` / `stop_sequence` 成功，`budget_exceeded` / `max_iterations` / `refusal` 一类
 * 非正常收尾则由调用方把结构化 `error` 一并给出）。
 */
export function finishedResult<T>(f: {
  stopReason: AgentStopReason;
  finalText: string;
  iterations: number;
  typed: T | undefined;
  error?: SpanError | undefined;
}): AgentLoopResult<T> {
  return loopResult<T>({
    stopReason: f.stopReason,
    finalText: f.finalText,
    error: f.error,
    iterations: f.iterations,
    typed: f.typed,
  });
}
