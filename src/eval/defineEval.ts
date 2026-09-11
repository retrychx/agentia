import type Anthropic from '@anthropic-ai/sdk';
import type { AgentRunResult } from '../engine/types.js';
import type { Trace } from '../core/trace.js';
import type { ModelClient } from '../core/tool.js';
import type { AgentApp, RunAppOptions } from '../toolkit/module.js';

/**
 * Agentia —— evals（D2）：把「agent 有没有回归」变成断言。
 *
 * 不引测试框架：`defineEval(...).run()` 跑完给一份 `EvalReport`（通过/失败 + 失败
 * case 的 trace），接 CI 只要看 `report.ok`。断言源是既有的 `Trace` —— 「先调 search
 * 才调 summarize」这类顺序断言全从 trace 里读，框架不为此新增埋点
 * （`traceToMessages` 也能把 trace 还原成 messages，做更细的重放断言）。
 */

export interface EvalCase {
  /** 用例名（报告里用）；缺省 `case#<序号>` */
  name?: string;
  /** 本用例的用户输入（框架会包成单条 user message） */
  input: string;
  /** 本用例的模型脚本：`scriptedClient([...])` */
  client: ModelClient;
  /**
   * 单次 run 选项（同 `app.run(messages, opts)`），用于给单个用例注入
   * `resultSchema`（断言 `result.typed`）、`maxIterations`、`blackboard` 等。
   * `client` 由 eval 自己填（本字段里的 client 会被忽略）。
   */
  opts?: RunAppOptions;
}

/** 断言上下文：`trace` 与 `result.trace` 是同一份（此处并列给出，读起来更顺） */
export interface EvalContext {
  trace: Trace;
}

export interface EvalCaseReport {
  name: string;
  ok: boolean;
  /** 跑完才有（断言失败时也有 —— 断言抛错不吞掉结果） */
  stopReason?: string;
  /** 失败原因（断言抛出的 message，或 app.run 抛出的错） */
  error?: string;
  /** 失败 case 的完整 trace（能拿到就给）—— 排查回归就看它 */
  trace?: Trace;
}

export interface EvalReport {
  name: string;
  total: number;
  passed: number;
  failed: number;
  /** 全通过才 true（`total === 0` 视为通过：没有用例就没有回归） */
  ok: boolean;
  cases: EvalCaseReport[];
}

export interface EvalDefinition<T = unknown> {
  name: string;
  /**
   * 建应用。**一次 `run()` 只调一次**（工具菜单/DI 实例在用例间复用 ——
   * 每个用例都重建应用会掩盖「装配期状态泄漏」这类问题，而且慢）。
   * 需要每用例新建就自己 `app: () => createApp(...)` 返回新实例。
   */
  app: () => Promise<AgentApp> | AgentApp;
  cases: EvalCase[];
  /**
   * 断言。抛错 = 该用例失败（`assert` 原生就够用，不引断言库）。
   * 返回 Promise 也行（要读外部系统时）。
   */
  expect: (r: AgentRunResult<T>, ctx: EvalContext) => void | Promise<void>;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 定义一个 eval。`run()` **不会因用例失败而抛出** —— 失败进报告（这样一次跑完
 * 能看到所有回归，而不是修一个跑一次）。只有「应用建不起来」才冒泡（那是环境错误，
 * 不是回归）。
 */
export function defineEval<T = unknown>(
  def: EvalDefinition<T>,
): { name: string; run(): Promise<EvalReport> } {
  return {
    name: def.name,
    async run(): Promise<EvalReport> {
      const app = await def.app();
      const cases: EvalCaseReport[] = [];

      for (let i = 0; i < def.cases.length; i++) {
        const c = def.cases[i];
        const label = c.name ?? `case#${i + 1}`;
        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: c.input }];
        let report: EvalCaseReport = { name: label, ok: false };
        try {
          const { result } = await app.run(messages, { ...c.opts, client: c.client });
          const typed = result as AgentRunResult<T>;
          // 先落 stopReason/trace 再断言：断言失败时报告里仍带着「跑出来长什么样」
          report = { name: label, ok: true, stopReason: result.stopReason, trace: result.trace };
          await def.expect(typed, { trace: result.trace });
        } catch (e) {
          report = { ...report, ok: false, error: messageOf(e) };
        }
        cases.push(report);
      }

      const passed = cases.filter((c) => c.ok).length;
      return {
        name: def.name,
        total: cases.length,
        passed,
        failed: cases.length - passed,
        ok: passed === cases.length,
        cases,
      };
    },
  };
}
