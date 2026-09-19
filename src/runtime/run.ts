import type { MessageParam } from '../core/message.js';
import type { AgentRunResult, RunAgentOptions } from '../engine/types.js';
import type { JsonSchema, SchemaType } from '../core/tool.js';
import type { Trace, TraceSink } from '../core/trace.js';
import { isSuccessStopReason } from '../engine/types.js';
import { runAgent } from '../engine/loop.js';
import { TraceRecorder } from '../engine/tracer.js';
import { classifyError } from '../engine/errors.js';
import type { RunMeta, RunStatus } from '../core/run.js';
import { RunContext, withRunContext } from './context.js';
import type { MemoryStore } from './memory.js';
import type { SessionStore } from './session.js';

/**
 * Run —— 一次运行的生命周期容器（spec §2/§6.1）。
 * runId == recorder.traceId == traceId（1:1）。
 * recorder 由 engine 的 runAgent 写入（run 根 span 归 engine 开）。
 */
export class Run {
  readonly recorder: TraceRecorder;
  readonly runId: string;
  readonly idempotencyKey: string | undefined;
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

  /**
   * 挂起（HITL）：从 running 进 awaiting_approval。**不是终态** —— finishedAt 不置、
   * 不算成功也不算失败；扩展后的消息历史在 `result.suspendedMessages` 里，
   * 由异步宿主落库等待审批，决定到齐后带着它重进引擎循环。
   */
  suspend(result: AgentRunResult): void {
    if (this._status !== 'running') {
      throw new Error(`cannot suspend a run in status ${this._status}`);
    }
    this._result = result;
    this._status = 'awaiting_approval';
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
        error: classifyError(error),
        typed: undefined,
        suspendedMessages: undefined,
        pendingApprovals: undefined,
      };
      return;
    }
    this._result.error = classifyError(error);
  }
}

export interface ExecuteRunOptions<S extends JsonSchema = JsonSchema> extends RunAgentOptions<S> {
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
   * 会话持久化（C4）：run 开始把 `store.load(id)` 拼在**传入 messages 之前**，
   * 收尾把「本轮消息 + 回复」`append` 回去。与 `memory`（键值黑板）正交 —— 见 SessionStore。
   *
   * 只记**对话轮次**：本轮传入的 messages + 最终回复（`finalText`）。
   * run 内部的 tool_use / tool_result 往返**不进会话历史**（它们属于这次 run 的内部过程；
   * 要重建完整过程用 trace 重放 `traceToMessages`）—— 这样历史保持干净、可长期累积。
   */
  session?: { store: SessionStore; id: string };
  /**
   * 到达本层 catch 的异常是否抛出。缺省 true；异步宿主（AsyncRunner）置 false：
   * 失败也以 {run(status=failed), result.error} 返回，便于把失败 run 落库而非冒泡。
   *
   * 注意口径：模型 API / 请求层的失败**不走这里** —— runAgent 已把它们收成
   * `stopReason:'error'` 的 result 正常返回（所以缺省下模型调用失败也不会抛）。
   * 能进本层 catch 的只有 runAgent 之外的环节（contextInit 抛错、runAgent 自身
   * 意外抛出等）；rethrow:false 时这些同样收成 result 返回。
   */
  rethrow?: boolean;
  /** trace 出口（观测）：run 收尾后逐个投递；sink 抛错被吞，不影响 run */
  sinks?: TraceSink[];
  /**
   * trace 交给 sinks **之前**的最后一笔账（`run.finish` 之后、`flushSinks` 之前调一次，
   * 可 await；抛错被吞 —— 同 sink / 记忆回写：收尾动作失败不得击穿 run）。
   *
   * 为什么必须留这个缝：有些结论**只有拿到 run 的结果才算得出来**（断言这一轮到底对不对、
   * 跑一次判官比一比），而 `flushSinks` 发生在 run 内部 —— 等 `app.run()` 返回后再
   * `attachScore`，sink 早已把这条 trace 消化完（`metricsSink` 的聚合发生在 `export()`
   * 那一刻），分数永远进不了指标，与 `usage-guide.md`「eval 的 trace 自带质量结论、
   * 可直接聚合通过率」的承诺不符。
   *
   * 与「把判官写进 sink 里」（usage-guide §6 的采样配方）的分工：那个适合**读 trace
   * 就够**的判断（sink 里 await 判官即可，顺序上仍在 metricsSink 之前）；本钩子适合
   * **拿不到 `result` 就无从判断**的。`defineEval`（`src/eval/defineEval.ts`）的 score
   * 是后者，也是框架内唯一的使用者。
   *
   * ⚠️ 只在**正常结束**的路径调用（`run.finish` 之后）。`runAgent` 之外的环节抛错
   * （contextInit、意外异常）走 catch 分支 —— 那里没有 typed result，也没人需要在这条
   * 路径挂分（eval 在该路径连 trace 都不保留）。
   */
  beforeFlush?: (trace: Trace, result: AgentRunResult<SchemaType<S>>) => void | Promise<void>;
}

/**
 * 高层入口：建 Run → start → 注入 recorder 跑 engine → finish。
 * run 层持有 recorder，返回后 run.recorder 里的 trace 即本次完整调用树。
 * RunContext 在整个执行期间经 AsyncLocalStorage 可被 `RunContext.current()` 读到，
 * 工具/能力执行体无需把 ctx 作为参数层层下传。
 */
export async function executeRun<S extends JsonSchema = JsonSchema>(
  options: ExecuteRunOptions<S>,
): Promise<{ run: Run; result: AgentRunResult<SchemaType<S>> }> {
  const run = new Run(
    options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {},
  );
  run.start();
  const ctx = new RunContext(run);
  const memory = options.memory;
  const session = options.session;
  return withRunContext(ctx, async () => {
    try {
      options.contextInit?.(ctx);
      if (memory) {
        // 水合是辅助动作：store 故障（Redis 挂掉等）不得杀死本次 run ——
        // 与下面 flushMemory 对称（那里已有同款防护）。失败即当「无记忆」继续跑。
        try {
          await hydrateMemory(memory, ctx);
        } catch {
          /* ignore：辅助动作失败不影响 run */
        }
      }
      const result = await runAgent<S>({
        ...options,
        // 会话历史拼在传入 messages **之前**；读不出来就当无历史（同上：辅助动作不击穿 run）
        messages: await loadSession(session, options.messages),
        recorder: run.recorder,
        // 会话标识落 run 根 attribute（`session.id`）—— 多轮 run 按会话聚合的锚点
        ...(session ? { sessionId: session.id } : {}),
      });
      if (result.stopReason === 'awaiting_approval') {
        // HITL 挂起：不是终态 —— 记忆回写/会话追加维持「只成功才写」（挂起不写），
        // beforeFlush 也只在正常收尾路径调（见该选项注释）。
        // 但**照常 flushSinks**：挂起段的 trace 段落必须可观测（每段执行一棵树，
        // 恢复段是经 traceContext link 挂过来的新树 —— sink 两边都收得到）。
        run.suspend(result);
        await flushSinks(options.sinks, result.trace);
        return { run, result };
      }
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
      // 只在**跑成功**的轮次回写会话（见 appendSession 的不变量 1）。
      // 注意判据是 run 的终态而非「有没有抛异常」—— stopReason 为 error / max_tokens /
      // budget_exceeded / aborted 的 run 同样是「没跑完」，不该进对话历史。
      if (session && run.status === 'succeeded') {
        await appendSession(session, options.messages, result.finalText);
      }
      // 冲刷前把「run 之后才算得出的结论」挂上 trace（见 beforeFlush 的注释）。
      // 位置很关键：必须在 flushSinks **之前**，否则 sink 看不到它。
      await runBeforeFlush(options.beforeFlush, result.trace, result);
      await flushSinks(options.sinks, result.trace);
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
      await flushSinks(options.sinks, run.result!.trace);
      // 失败路径：run.fail() 造的结果没有 typed（恒为 undefined），断言只为对齐返回类型
      if (options.rethrow === false)
        return { run, result: run.result! as AgentRunResult<SchemaType<S>> };
      throw e;
    }
  });
}

/** 没有文本输出时写进会话的占位（保住「历史以 assistant 结尾」这个不变量，见 appendSession） */
const EMPTY_REPLY_MARK = '（本次无文本输出）';

/**
 * 读会话历史，拼在传入 messages 之前。失败当「无历史」继续 ——
 * 与 memory 水合同款防护：辅助动作失败不得击穿 run。
 */
async function loadSession(
  session: { store: SessionStore; id: string } | undefined,
  incoming: MessageParam[],
): Promise<MessageParam[]> {
  if (!session) return incoming;
  try {
    const history = await session.store.load(session.id);
    return history.length > 0 ? [...history, ...incoming] : incoming;
  } catch {
    return incoming;
  }
}

/**
 * 把本轮消息 + 回复追加回会话（**只在成功路径调用**）。失败吞掉（同 memory 回写防护）。
 *
 * 三条不变量（都是为了下一轮还能把这个历史发出去）：
 * 1. **只有成功路径回写** —— 失败时若只存下用户的提问，历史就会以 user 结尾，
 *    下一轮再传入 user 消息即变成「连续两条 user」，撞 API 的角色交替校验；
 * 2. 历史**以 assistant 结尾**：没有文本输出时补一条占位（`end_turn` 下极罕见）；
 * 3. 只存**对话轮次**（用户输入 + 最终回复），run 内部的 tool 往返不进历史
 *    —— 要完整过程请用 trace 重放 `traceToMessages`。
 *
 * 以上三条只保**单 run** 视角。并发 run 共用同一 session 时各自的 append 可能交错
 * （连续两条 user，下轮 load 撞角色交替校验）—— 框架不串行化同 session 的 flush，
 * 该边界见 `SessionStore.append` 的注释；需要者请在调用方按 session 串行化。
 */
async function appendSession(
  session: { store: SessionStore; id: string } | undefined,
  incoming: MessageParam[],
  finalText: string,
): Promise<void> {
  if (!session) return;
  try {
    await session.store.append(session.id, [
      ...incoming,
      { role: 'assistant', content: finalText || EMPTY_REPLY_MARK },
    ]);
  } catch {
    /* ignore */
  }
}

/**
 * 冲刷前钩子：让调用方在 sinks 看到 trace 之前补最后一笔（见 `beforeFlush`）。
 * 抛错被吞 —— 与 `flushSinks` 同款防护：收尾动作失败不得击穿 run。
 */
async function runBeforeFlush<S extends JsonSchema>(
  hook: ((trace: Trace, result: AgentRunResult<SchemaType<S>>) => void | Promise<void>) | undefined,
  trace: Trace,
  result: AgentRunResult<SchemaType<S>>,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(trace, result);
  } catch {
    /* ignore：收尾动作失败不影响 run */
  }
}

/** 投递 trace 给所有 sink：观测失败（sink 抛错）不得影响 run 结果（同 memory 回写防护） */
async function flushSinks(sinks: TraceSink[] | undefined, trace: Trace): Promise<void> {
  if (!sinks || sinks.length === 0) return;
  for (const sink of sinks) {
    try {
      await sink.export(trace);
    } catch {
      /* 观测失败不得影响 run */
    }
  }
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
