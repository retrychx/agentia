import type { SpanError } from './trace.js';

/**
 * Agentia —— run 生命周期数据模型（spec §6.1）。
 *
 * 放在 core 的理由：`RunStatus` / `RunMeta` 是纯数据，只依赖 `core/trace`。
 * store / transport / runtime 都要读它，下沉 core 后三者都不必再向上引 runtime
 * （此前 `store → runtime` 是未声明的兄弟层依赖，见 AGENTS.md 分层约定）。
 *
 * `suspended`：run **挂起了** —— **非终态**（awaitTask 继续轮询）、不占并发槽（执行段落已
 * 收尾释放）、`resumePending` 不捡走（它不是孤儿，崩溃续跑语义不适用于「在等」）；
 * 消息历史（含未决 tool_use）与待决清单随 TaskRecord 落库。
 *
 * 「挂起」是**一个状态 + 一个原因**（2026-09-28 ①：从前 `awaiting_approval` 一个状态兼职
 * 两件事）：状态只说「它在等」，等什么由 `SuspendedReason` 说 —— 判据（审批超时 / 能否
 * 审批）落在**原因**上，于是「时间挂起被审批超时提前叫醒」这类误伤在类型上就写不出来。
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  /**
   * 被**取消**（宿主调 `runner.cancel`）—— 终态，但与 `failed` **分开**：
   * 取消不是失败（引擎侧 `abortedResult` 的注释早就这么写），运维读数不该把
   * 「人按的」与「跑挂的」混成一类（`GROUP BY status` 是第一读者）。
   * 机制上是 `abort signal`（与 `runTimeoutMs` 同一条），差别在**意图** ——
   * 状态按意图落：超时仍是 `failed`。
   */
  | 'cancelled';

/**
 * 挂起原因 —— 「等人工审批」与「等一个时刻」是两种挂起，判据必须分开：
 *   approval —— 等人工决定（HITL）：`approve()` 能叫醒它，`approvalTimeoutMs` 管它；
 *   timer    —— 等一个时刻（durable timer）：只有到点能叫醒它。
 * ⚠️ 拿 timer 挂起去撞 `approvalTimeoutMs` = **提前叫醒一条在睡的 run** ——
 * 那两条闸（`approvalExpired` / `approve` 的 409）因此都 gate 在原因上，不 gate 在状态上。
 */
export type SuspendedReason = 'approval' | 'timer';

/**
 * run 的运行记录（供持久化 / 读取）。字段**必填但可为 undefined**：它们是框架在 run
 * 生命周期各阶段**总是写进对象**的状态（`toMeta()` 一次构造全量），「缺省」在这里不是
 * 一个有意义的语义 —— 与「可选入参」不同。这条区分由 tsconfig 的
 * `exactOptionalPropertyTypes` 强制：可选入参保持 `?: T`（调用点不许显式传 undefined），
 * 而状态/结果记录写成必填 `T | undefined`（字段在场、值可能没有）。
 */
export interface RunMeta {
  runId: string;
  status: RunStatus;
  idempotencyKey: string | undefined;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  error: SpanError | undefined;
  /**
   * 挂起原因（仅 `status === 'suspended'` 时非空）—— 「字段在场」约定同 `error`：
   * 它是 run 生命周期里**总会写进对象**的状态位，缺省在这里没有语义。
   */
  suspendedReason: SuspendedReason | undefined;
  /**
   * 时间挂起的目标时刻（epoch ms，仅 `suspendedReason === 'timer'` 时非空；字段在场约定同上）
   * —— 「这条 run 什么时候该醒」是运行记录的一部分，与「在等什么」并列。
   */
  wakeAt: number | undefined;
}
