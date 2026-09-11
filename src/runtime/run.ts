import type { AgentRunResult, RunAgentOptions } from '../engine/types.js';
import { isSuccessStopReason } from '../engine/types.js';
import { runAgent } from '../engine/loop.js';
import { TraceRecorder } from '../engine/tracer.js';
import { classifyError } from '../engine/errors.js';
import type { RunMeta, RunStatus } from './types.js';
import { RunContext, withRunContext } from './context.js';
import type { MemoryStore } from './memory.js';

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
    this._status = isSuccessStopReason(result.stopReason) ? 'succeeded' : 'failed';
  }

  fail(error: unknown): void {
    this._status = 'failed';
    this.finishedAt = Date.now();
    if (!this._result) {
      // run 根可能尚未开（如 contextInit 抛错）：补一个 error 根再 snapshot，
      // 避免 snapshot 的 "run root not started" 掩盖原始错误。
      if (!this.recorder.rootStarted) {
        const rootId = this.recorder.begin('run', 'agent.run', null);
        this.recorder.end(rootId, { status: 'error', error: classifyError(error) });
      }
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
  /**
   * 跨 run 记忆（R4）：run 开始把 store.load(keys) 水合进 blackboard
   * （在 contextInit 之后执行，且用户种子优先 —— 不覆盖已有同名 key）；
   * run 结束（finish/fail 两条路径）把这些 key 的当前值 save 回 store。
   */
  memory?: { store: MemoryStore; keys: string[] };
  /**
   * 硬失败（请求/API 层异常）是否抛出。缺省 true；
   * 异步宿主（AsyncRunner）置 false：失败也以 {run(status=failed), result.error} 返回，
   * 便于把失败 run 落库而非冒泡。
   */
  rethrow?: boolean;
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
  const memory = options.memory;
  return withRunContext(ctx, async () => {
    try {
      options.contextInit?.(ctx);
      if (memory) await hydrateMemory(memory, ctx);
      const result = await runAgent({ ...options, recorder: run.recorder });
      run.finish(result);
      if (memory) {
        // 回写是辅助动作：失败不得把已成功的 run 翻成 failed（会丢结果与 trace），
        // 与下面失败路径的 flushMemory 同款防护。
        try {
          await flushMemory(memory, ctx);
        } catch {
          /* ignore */
        }
      }
      return { run, result };
    } catch (e) {
      run.fail(e);
      if (memory) {
        // 失败路径也回写；save 自身出错不掩盖原始错误
        try {
          await flushMemory(memory, ctx);
        } catch {
          /* ignore */
        }
      }
      if (options.rethrow === false) return { run, result: run.result! };
      throw e;
    }
  });
}

/** 水合：store 值注入 blackboard；contextInit 已写的同名 key 不覆盖（用户种子优先） */
async function hydrateMemory(
  memory: { store: MemoryStore; keys: string[] },
  ctx: RunContext,
): Promise<void> {
  const loaded = await memory.store.load(memory.keys);
  for (const key of memory.keys) {
    // Object.hasOwn 而非 `in`：`in` 会命中 Object.prototype 的继承属性 ——
    // key='toString'/'constructor' 之类会把原型上的函数当成记忆值水合进黑板
    if (Object.hasOwn(loaded, key) && !ctx.has(key)) ctx.set(key, loaded[key]);
  }
}

/** 回写：blackboard 里这些 key 的当前值存回 store */
async function flushMemory(
  memory: { store: MemoryStore; keys: string[] },
  ctx: RunContext,
): Promise<void> {
  // 无原型对象：`entries['__proto__'] = v` 在 {} 上会走 Object.prototype 的 setter
  // （改掉原型而非建属性），该 key 的回写值会静默丢失
  const entries: Record<string, unknown> = Object.create(null);
  for (const key of memory.keys) {
    if (ctx.has(key)) entries[key] = ctx.get(key);
  }
  await memory.store.save(entries);
}
