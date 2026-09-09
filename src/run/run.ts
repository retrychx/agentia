import type { AgentRunResult, RunAgentOptions } from '../engine/types.js';
import { runAgent } from '../engine/loop.js';
import { TraceRecorder } from '../engine/tracer.js';
import { classifyError } from '../engine/errors.js';
import type { RunMeta, RunStatus } from './types.js';
import { RunContext, withRunContext } from './context.js';

/**
 * Run —— 一次运行的生命周期容器（spec §2/§6.1）。
 * runId == recorder.traceId == traceId（1:1）。
 * recorder 由 engine 的 runAgent 写入（run 根 span 归 engine 开）。
 */
export class Run {
  readonly recorder: TraceRecorder;
  readonly runId: string;
  readonly idempotencyKey?: string;
  readonly createdAt: number = Date.now();
  private _status: RunStatus = 'queued';
  startedAt?: number;
  finishedAt?: number;
  private _result?: AgentRunResult;

  constructor(opts: { idempotencyKey?: string } = {}) {
    this.recorder = new TraceRecorder();
    this.runId = this.recorder.traceId;
    this.idempotencyKey = opts.idempotencyKey;
  }

  get status(): RunStatus {
    return this._status;
  }
  get result(): AgentRunResult | undefined {
    return this._result;
  }

  /** meta（供运行记录/持久化使用） */
  toMeta(): RunMeta {
    return {
      runId: this.runId,
      status: this._status,
      idempotencyKey: this.idempotencyKey,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this._result?.error,
    };
  }

  start(): void {
    if (this._status !== 'queued') throw new Error(`cannot start a run in status ${this._status}`);
    this._status = 'running';
    this.startedAt = Date.now();
  }

  finish(result: AgentRunResult): void {
    this._result = result;
    this.finishedAt = Date.now();
    this._status = result.stopReason === 'end_turn' ? 'succeeded' : 'failed';
  }

  fail(error: unknown): void {
    this._status = 'failed';
    this.finishedAt = Date.now();
    if (!this._result) {
      this._result = {
        trace: this.recorder.snapshot('error'),
        stopReason: 'error',
        finalText: '',
        iterations: 0,
      };
    }
    this._result.error = classifyError(error);
  }
}

export interface ExecuteRunOptions extends RunAgentOptions {
  idempotencyKey?: string;
  /** 在 runAgent 前对本次 RunContext 做预置（blackboard 种子等） */
  contextInit?: (ctx: RunContext) => void;
}

/**
 * 高层入口：建 Run → start → 注入 recorder 跑 engine → finish。
 * run 层持有 recorder，返回后 run.recorder 里的 trace 即本次完整调用树。
 * RunContext 在整个执行期间经 AsyncLocalStorage 可被 `RunContext.current()` 读到，
 * 工具/单元执行体无需把 ctx 作为参数层层下传。
 */
export async function executeRun(
  options: ExecuteRunOptions,
): Promise<{ run: Run; result: AgentRunResult }> {
  const run = new Run({ idempotencyKey: options.idempotencyKey });
  run.start();
  const ctx = new RunContext(run);
  return withRunContext(ctx, async () => {
    try {
      options.contextInit?.(ctx);
      const result = await runAgent({ ...options, recorder: run.recorder });
      run.finish(result);
      return { run, result };
    } catch (e) {
      run.fail(e);
      throw e;
    }
  });
}
