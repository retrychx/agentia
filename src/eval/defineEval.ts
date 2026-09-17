import type { MessageParam } from '../core/message.js';
import type { AgentRunResult } from '../engine/types.js';
import { attachScore, type Trace } from '../core/trace.js';
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
   *
   * 注：断言跑在**本次 run 的 `RunContext` 之内**（必须在 sinks 冲刷前出结论，见下），
   * 因此断言里 `RunContext.current()` 读得到这次 run。
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
        const messages: MessageParam[] = [{ role: 'user', content: c.input }];
        let report: EvalCaseReport = { name: label, ok: false };
        // R7 质量闭环：用例结论挂成 trace 根 span 的 score 事件 —— eval 的 trace 自带
        // 质量结论，下游 TraceSink / metrics 可直接聚合「这个 eval 的通过率」。
        // 拿得到 trace 才挂：app.run 抛错（环境错误）时无 trace 可挂，跳过。
        const attach = (trace: Trace): void => {
          attachScore(trace, {
            name: 'eval',
            value: report.ok ? 1 : 0,
            source: def.name,
            ...(report.error !== undefined ? { comment: report.error } : {}),
          });
        };
        // 本用例是否走了「冲刷前钩子」（见下）—— 决定结论在哪里落定
        let hooked = false;
        try {
          const { result } = await app.run(messages, {
            ...c.opts,
            client: c.client,
            // ⚠️ 断言与挂分**必须在 sinks 冲刷之前**做完：`flushSinks` 发生在
            // `executeRun` 内部，等 `app.run` 返回再 `attachScore`，`metricsSink`
            // 早已在 `export()` 那一刻聚完账 —— 分数永远进不了指标，而
            // usage-guide / roadmap 都承诺了「eval 的 trace 可直接聚合通过率」。
            // 而「这轮对不对」只有拿到 result 才判得出，所以断言也只能在这里做。
            beforeFlush: async (trace, r) => {
              hooked = true;
              // 先落 stopReason/trace 再断言：断言失败时报告里仍带着「跑出来长什么样」
              report = { name: label, ok: true, stopReason: r.stopReason, trace };
              try {
                await def.expect(r as AgentRunResult<T>, { trace });
              } catch (e) {
                // 断言失败 = 用例失败，不是 run 失败 —— 必须在这里收住，不能让它
                // 从钩子里飞出去（那会把一次正常的 run 打成 failed）
                report = { ...report, ok: false, error: messageOf(e) };
              }
              attach(trace);
            },
          });
          if (!hooked) {
            // 兜底：应用不认 `beforeFlush`（自定义实现漏透传 opts 字段）时退回
            // 「跑完再断言」——断言与报告行为不变，只是这条 trace 的 score 挂在冲刷
            // 之后（指标聚合看不到它）。比重写成「所有用例都失败」诚实得多。
            const typed = result as AgentRunResult<T>;
            report = { name: label, ok: true, stopReason: result.stopReason, trace: result.trace };
            await def.expect(typed, { trace: result.trace });
          }
        } catch (e) {
          report = { ...report, ok: false, error: messageOf(e) };
        }
        if (!hooked && report.trace) attach(report.trace); // 正常路径已在钩子里挂过，不重复挂
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
