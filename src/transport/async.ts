import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { MessageParam } from '../core/message.js';
import type { ModelClient } from '../core/tool.js';
import type { AgentRunResult } from '../engine/types.js';
import { classifyError } from '../engine/errors.js';
import type { RunStatus, TaskEvent } from '../core/run.js';
import { isTerminalStatus } from '../core/run.js';
import { normalizeMessages, TaskInputError } from '../engine/spec.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import { InMemoryTaskStore, isThenable, nextTaskId } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';
import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import { abortedError } from '../engine/turn.js';
import { assertTimerDelay, TimeoutError } from '../core/timeout.js';
import { zeroClauseOf } from '../core/limits.js';
import { composeTraceEvents } from '../core/trace.js';
import type { TraceRecordEvent } from '../core/trace.js';
import { SlotPool } from './slot-pool.js';
import { approvalExpired, approvalsComplete, fillTimeoutDenials } from './approval-policy.js';
import { summarizeSuspended, timerDue } from './wake-policy.js';
import type { SuspendedEntry, SuspendedSummary } from './wake-policy.js';
import { DrainGate } from './drain-gate.js';
import { resumeSkipReason } from './resume-policy.js';
import { formatOwnerId } from './owner-id.js';
import { ownerAlive } from './owner-liveness.js';
import { TaskWaiters } from './task-waiters.js';
import { TaskEventStreams } from './task-events.js';
import type { TaskStreamEvent } from './task-events.js';

/**
 * Agentia —— 异步任务宿主（spec §6.3 异步 / §6.5 确定性 / §6.6 换宿主不换语义）。
 *
 * - submit 即回（queued），后台驱动状态机 queued → running → succeeded/failed；
 *   工具标了 `approval: 'required'` 时 run 可在回合间挂起为 **suspended**
 *   （HITL：非终态、不占并发槽、不触发 TaskSink.onFinished），`approve()` 给齐决定后恢复；
 *   工具调 `ctx.deferUntil(t)` 时同样挂起（durable timer：`suspendedReason: 'timer'`），
 *   到点由 `resumePending` / `poll` 的**惰性**扫描唤醒（不起定时器，见 wake-policy.ts）；
 *   两条挂起路径的**闸按原因分开**（等谁的决定 vs 等到点了没）；
 * - **at-least-once 去重**：同一 idempotencyKey 重复 submit，若上一任务仍在
 *   queued/running/succeeded 则直接返回既有记录，不重复执行（失败可重试新任务）；
 * - run 记录落 TaskStore（v1 InMemoryTaskStore），trace 随 result 一同保留；
 *   DB/队列宿主只需实现 TaskStore。
 *
 * 异步 TaskStore（R6，TaskStore 方法返回 MaybePromise）：
 * - 内部执行路径（#execute / awaitTask / resumePending）全部 await 化，两种 store 通吃；
 * - submit/poll/byIdempotency/list 是**同步门面**，为同步 store 保持原有用法与返回类型
 *   （http/scheduler/既有调用方零改动）。接异步 store 时：submit 的即时去重无法进行
 *   （推迟到 #execute：同键已有 succeeded 记录则采纳其结果、不重复执行），poll 等
 *   返回 Promise 需调用方自行 await。
 */

/**
 * 任务完成回调（C5）。任务达终态、记录已落库后调用。
 * **抛错被吞**，绝不影响任务状态（与 trace sink / memory 回写同款防护）。
 *
 * webhook 故意**不做进框架**：用本接口 + 你自己的 `fetch` 就能搭（含签名与重试策略），
 * 而那会引入「出站请求 + 重试 + 签名」一整套复杂度。
 */
export interface TaskSink {
  onFinished(rec: TaskRecord): void | Promise<void>;
}

/**
 * 落库失败的形状（`AsyncRunnerOptions.onPersistError` 的入参）。
 *
 * ⚠️ 回调只在「**这次写出本身**失败」时 firing —— `error` 永远是**这次**写出的错。
 * `phase` 区分两次**都曾静默**的写出：
 * - `'initial'` —— 提交时那次 `save` 迟到 reject 之后的**补偿性重存**（把任务改判为
 *   `failed` 再写）也失败了。注意：原始那次 reject 本身**不触发**本回调（它只触发
 *   补偿路径），这里拿到的 `error` 是**重存**的错，不是原始 save 的。
 *   同步 store 当场抛走的也不是这条路（那条按 `TaskInputError` 处理，本来就响亮）。
 * - `'outcome'` —— 终态（或挂起态）那次写出失败。**这条最贵**：库里停在 `running`，
 *   而它其实已经跑完了（副作用已发生）—— 重启后 `resumePending` 会把它当孤儿**再跑一遍**。
 */
export interface PersistFailureInfo {
  record: TaskRecord;
  error: unknown;
  phase: 'initial' | 'outcome';
}

/** `approve` 的入参：一批 tool_use_id → 批准/拒绝（理由可选） */
export type ApprovalDecisions = Record<string, { approved: boolean; reason?: string }>;

/**
 * 任务事件流的一帧（`GET /tasks/:id/stream` 的帧形状，与 SSE 帧名一一对应）。
 *
 * 为什么帧里带 `index`：SSE 的 `Last-Event-ID` / `?from=` 指的是**流自己的序号**
 * （不是 recorder 的 `seq` —— 一个任务可能跨多个 run 段，每段 `seq` 从 1 重来，
 * 见 `task-events.ts` 的设计约束 1）。
 */
export type TaskStreamFrame =
  /** 一条记账事件（帧名 `trace.event`，SSE `id:` = index） */
  | { type: 'trace'; index: number; event: TraceRecordEvent }
  /** 缓冲超限、最前面的一段没了（帧名 `stream.truncated`，只发一次、在重放之前） */
  | { type: 'truncated'; droppedBefore: number }
  /** 任务到终态，流到此为止（帧名 `task.end`，随后服务端关闭连接） */
  | { type: 'end'; record: TaskRecord }
  /**
   * 本进程没有这条任务的实时流（帧名 `stream.unavailable`）——跨进程宿主（队列消费者在
   * 别的进程里跑）或任务早于本进程启动。**不假装实时**：发完它就收口
   * （终态补一帧 `end`，非终态补一帧 `closed` —— 见下）。
   */
  | { type: 'unavailable'; reason: 'not-in-this-process' }
  /**
   * **流级**收尾（帧名 `stream.closed`，随后服务端关闭连接）：流到此处为止，但任务
   * **不是**终态（还在别的进程里跑）。与 `end` 严格区分 —— `end` 的语义是「任务终态」，
   * 非终态发 `end` 是伪造终态；没有这一帧，跨进程 + 非终态的 SSE 只剩心跳永远挂着，
   * 按「读到流结束」写法的客户端永远等不到。客户端收到它应转去轮询 `GET /tasks/:id`。
   */
  | { type: 'closed'; reason: 'not-in-this-process' };

/**
 * `streamTask` 的失败：带 HTTP 语义的状态码（404 = 任务不存在），HTTP 宿主据此回对应响应。
 * 形状与 `TaskApproveError` 同款（module 级 export，不进公共导出面）。
 */
export class TaskStreamError extends Error {
  readonly status: 404;
  constructor(message: string) {
    super(message);
    this.name = 'TaskStreamError';
    this.status = 404;
  }
}

/**
 * 任务是否**已到终态**（流可以收口了）。
 *
 * ⚠️ 与 `resume-policy.ts` 那个「可续跑」的判定**刻意不同**：那里 `suspended`
 * 算「不可续跑」（重启扫描不该去动它），这里是**非终态** —— 挂起在等人，人批了它会接着跑，
 * 流必须**继续开着**（关掉的话「等审批结果的前端」正好在最需要的时候断线）。
 */
function isTerminalTask(rec: TaskRecord): boolean {
  // 判定外移到 core/run.ts 的 `isTerminalStatus`（单一真源，2026-09-28 外部深评 S1）：
  // 这里原本是负向枚举（`status !== 'queued' && …`），而 Redis store 那边压根没判 ——
  // 同一事实两份读数，写法还不一样。那两处现在都调同一个函数。
  return isTerminalStatus(rec.status);
}

/**
 * `approve` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 任务当前不在
 * `suspended` 状态），HTTP 宿主据此回对应响应。
 * module 级 export —— 不进公共导出面（纯宿主内部实现细节）。
 */
export class TaskApproveError extends Error {
  /** 400 = 入参语义不合法（decisions 里有本任务待决之外的 id，2026-09-28 深评 P1-2） */
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'TaskApproveError';
    this.status = status;
  }
}

/**
 * `cancel` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 已终态 / 在飞 run 不在本进程）。
 * 形状与 `TaskApproveError` 同款（module 级 export，不进公共导出面）。
 */
export class TaskCancelError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'TaskCancelError';
    this.status = status;
  }
}

/**
 * `signalTask` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 任务当前不在
 * `suspended` 状态 / 同 eventId 已投递）。形状与 `TaskCancelError` 同款
 * （module 级 export，不进公共导出面）。
 */
export class TaskEventError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'TaskEventError';
    this.status = status;
  }
}

/**
 * `submit` 在**排队段已满**时的失败（`AsyncRunnerOptions.maxQueued`，2026-09-28 外部深评 T5）。
 *
 * 为什么单独一个类型、而不是复用 `TaskInputError`：两者在 HTTP 上的**含义不同** ——
 * 入参不合法是 **400**（调用方改请求就能过），排队满**不是调用方的错**，是 **503
 * + `Retry-After`**（同一次请求稍后重发就该过）。宿主若把它们混成一支，运维看到的就是
 * 「你的请求有问题」，而实际是「服务该扩容 / 该退避」—— 与 `maxConcurrentRuns` 的 503
 * 那支刻意分开的理由同款。
 *
 * `status` 是自陈字段（本仓 `TaskApproveError` 起的惯例）：宿主按它选状态码，不靠
 * `instanceof` 猜；本类目前只有 503 一种。
 *
 * module 级 export —— 不进公共导出面（与 TaskApproveError / TaskCancelError / TaskEventError 同档）。
 */
export class TaskQueueFullError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'TaskQueueFullError';
  }
}

/**
 * `deliveredEventIds` 簿记的条数上限（FIFO 裁最旧）。它是**去重簿记**不是审计日志：
 * 256 条对「webhook 重试窗口」绰绰有余，而无界增长会让每条 TaskRecord 随事件量膨胀
 * （记录随 trace 一起落库，每次 save 全文重写）。「数量有界」不是用户旋钮，不进
 * `core/limits.ts` 的 0 语义表。
 */
const MAX_DELIVERED_EVENT_IDS = 256;

/**
 * `pendingEvents`（待注入事件缓冲）的**条数上限**（2026-09-28 复审第三轮，定案 **B**）。
 *
 * 为什么要有：`deliveredEventIds` 那侧是有界的（256），缓冲这侧原先没有 —— 而它不需要攻击者
 * 就能长：投方每次投一条、这条 run 每次都在恢复段**再次挂起**（再挂起出口刻意不注入事件，
 * 见 spec §10 ⑥ 第 4 条）⇒ 每条都留在记录上，而记录随 trace 一起落库、每次 save 全文重写。
 *
 * 为什么是「满了拒绝」而不是「丢最旧」（A 的反面）：缓冲**在下次跑通时就注入并清空**，所以
 * 上限只管「一个挂起窗口里能攒多少」。丢最旧必须**同时**把该 id 从 `deliveredEventIds` 摘掉，
 * 否则发件方重投会拿到「已投递」的 409 而事件其实已经没了 —— 那是最坏的一种谎。宁可不收下
 * 并说出来（调用方拿到 409 就能改主意：先让这条 run 真走起来）。
 *
 * 为什么是 64：一个挂起窗口里等到的输入，量级与 `deliveredEventIds` 的重试窗口（256）同类，
 * 取它的 1/4 —— 容得下真实的 webhook 突发（一次重试窗口里几十条），又不足以把挂起任务当队列灌。
 * **数量有界不是用户旋钮**（与 MAX_DELIVERED_EVENT_IDS 同档），不进 `core/limits.ts` 的 0 语义表。
 */
const MAX_PENDING_EVENTS = 64;

/**
 * 取消的**宽限**：取消请求发出后，留给那次 run 自己收尾的时间。
 *
 * 尊重 signal 的 client 是毫秒级收尾（SDK 一收到 abort 就 reject，run 随即以 `stopReason:
 * 'aborted'` 收尾 —— 那条路连 `result` 与 trace 都保得住，本常量对它只是余量：一次网络往返 +
 * trace 落盘）。不认 signal 的宿主**永远**不会自己收尾 —— 等多久都是白等，所以到点就撤回意图、
 * 如实抛 409（见 `#awaitCancelled`），不假装取消成功。
 */
const CANCEL_GRACE_MS = 2_000;

export interface AsyncRunnerOptions {
  client?: ModelClient;
  store?: TaskStore;
  /**
   * 会话历史 store（C4）：配上之后，任务 `options.sessionId`（可序列化的会话引用）
   * 在执行前被换成 `RunAppOptions.session`（store 实例 + id）注入 run ——
   * 这是异步宿主上会话的**正式通道**（store 实例不可序列化，所以任务里只带 id、
   * 实例由 runner 持有；同步宿主没有这一步，会话走程序内 `RunAppOptions.session`）。
   *
   * 不配它而任务带了 `sessionId` ⇒ submit 当场抛 `TaskInputError`（响亮失败，
   * 不静默降级成「没有会话」）。
   */
  sessionStore?: {
    load(sessionId: string): MessageParam[] | Promise<MessageParam[]>;
    append(sessionId: string, messages: MessageParam[]): void | Promise<void>;
  };
  /** 同时执行的任务上限；缺省不限。超出部分排队等槽位（状态保持 queued） */
  concurrency?: number;
  /**
   * **在等槽位的任务数**上限（`concurrency` 之外的那一段）；缺省 0 = 不限。
   *
   * 为什么需要它（2026-09-28 外部深评 T5）：`concurrency` 只约束**同时在跑**几个，
   * 而「跑不上、排在后面」的那一段**没有任何上限** —— `submit` 永远收单（POST /tasks
   * 永远 202），排队段因此随调用方灌入无界增长：每条排队任务都是一条 `TaskRecord` +
   * 一棵 `#execute` 的悬挂 promise + 一个 `#slots` 等待者，**全部在内存里**。
   * `concurrency: 1` 挡不住它 —— 那只是让排队段更长。
   *
   * 语义：**「在等槽位」= 已受理（落库 + `#execute` 同步前段已计数）、尚未拿到槽位**。
   * 拿到槽位即离开本计数（此后归 `concurrency` 管），所以两个旋钮管的是两段、可加：
   * 进程内最多 `concurrency + maxQueued` 条任务同时在推进。
   *
   * ⚠️ 两个刻意的口径：
   * - **只在 `submit`（新活入口）判**：恢复路径（approve / 到期唤醒 / 崩溃重投）**不受闸**
   *   —— 它们推进的是**已受理**的任务，拦下来等于把任务永久搁死在 store 里。
   * - **超限是 503 不是 400**：这不是调用方把参数写错了，是「现在排不下、稍后再来」。
   *   HTTP 宿主回 503 + `Retry-After`（与 `maxConcurrentRuns` 同款），错误类型
   *   `TaskQueueFullError` 让宿主能把它与「入参不合法」分开。
   */
  maxQueued?: number;
  /** 任务完成回调（进程内）；见 TaskSink */
  taskSinks?: TaskSink[];
  /**
   * **落库失败回调**（观测 / 对账用）。缺省不给 = 静默，与加本选项之前**逐字一致**。
   *
   * 为什么需要它：`docs/usage-guide.md` §7 那条边界（「终态落库失败无告警」）写着
   * 「store 抖动时任务可能永远停在 `running`，重启后 `resumePending` 会重跑一个**实际已成功**
   * （副作用已发生）的任务 —— **耐久 store 的故障告警是宿主的事**」。但在本选项出现之前，
   * 框架把这个失败**吞掉且不留任何出口**（`#safeSave`）—— 宿主**做不到**它被要求做的事：
   * 它拿不到失败、也不该靠轮询 store 去猜。
   *
   * 本仓同因、同形、只差一个名字的先例：`createOtlpExporter({ onExportError })`
   * （「`TraceSink` 的失败缺省是静默的，这类消息得有人能收到」）。
   *
   * ⚠️ 它**不能补救**落库失败（写不进去就是写不进去）。它的职责是两件：
   * ① 让你能对账（哪条记录、哪一次写出、什么错）；② 让「记录无声丢失」不再是默认行为。
   * 回调抛错被吞（观测是辅助动作，不影响 run；与 `onUnpricedModel` / `onExportError` 同口径）。
   */
  onPersistError?: (info: PersistFailureInfo) => void;
  /**
   * 单任务执行超时（毫秒）；缺省 0 = 不限。必须为非负**有限**数（NaN/Infinity 会被
   * setTimeout 钳到 1ms，等同每个任务立即超时 —— 构造期直接报配置错误）。
   *
   * **超时即中止**：到点会 abort 本次 run 的 signal —— 对尊重 signal 的模型客户端
   * （框架自带的 Anthropic / OpenAI 适配器都转发 signal）是**真中止**，token 不再继续烧；
   * 不尊重 signal 的自定义 client 则仍等价于「放弃等待」（run 在后台跑完、产物丢弃）。
   * 槽位无论如何立即回收；被放弃且仍在跑的任务会让实际并发短暂高于 concurrency。
   */
  runTimeoutMs?: number;
  /**
   * 审批等待超时（毫秒，HITL）；缺省 0 = 不限（一直等人）。
   *
   * **惰性判定，不起定时器**：`approve` / `poll` / `resumePending` 读到一个
   * `suspended` 任务时，若它挂起已超过该值，框架自动把**全部待决项**写成
   * 「denied，reason: '审批超时'」并恢复执行（模型收到拒绝理由，可自行换路）。
   * 也就是说超时只在「有人读它」时生效 —— 没人读的任务不会自己动（进程里不养定时器，
   * 崩溃/重启也不依赖任何在飞回调）。
   */
  approvalTimeoutMs?: number;
  /**
   * 每任务**记账事件缓冲**的条数上限（`GET /tasks/:id/stream` 用）；缺省 500。
   *
   * 必须是**正**安全整数：NaN / Infinity / 负数 / 小数 / 0 一律在构造期抛 TypeError ——
   * NaN 会让「超出条数上限」的判定恒假（内存闸静默失效）；0 没有「缓冲几条」的读法
   * （既不是「关掉流」也不是「不限」），0 语义归类见 `core/limits.ts`。
   *
   * 内存量级：单条事件正文受 `maxEventChars` 约束（入参/成功出参缺省 2000 字符），
   * 故 500 条 ≈ 1 MB/任务；终态流的保留条数是代码里的常量（最近 16 条）。
   * 超出条数上限时丢**最旧**的，并向订阅方发一帧 `stream.truncated`（**不静默**）。
   */
  streamBufferEvents?: number;
}

/** resumePending 的启动扫描选项 */
export interface ResumePendingOptions {
  /**
   * 他进程任务的判定开关；缺省 0 = 不判断，一律重派（重启即续跑，单进程旧语义）。
   *
   * `> 0` 时按**两档**判他进程的记录（判据在 `resume-policy.ts`，这里只说取舍）：
   * ① 记录里的主机名是本机 ⇒ **问 pid 还在不在**（`owner-liveness.ts`）——
   *    「主人在」的直接证据：**在的绝不抢**（不管它起跑多久），**不在的立刻可抢**
   *    （不等保鲜期，崩溃孤儿不会饿死）；
   * ② 判不了（异主机 / 升级前写下的旧格式 ownerId / 自定义串）⇒ 退回本参数名义上的
   *    那件事：`startedAt`（退化到 `createdAt`）距今不足该值就当他还在跑、先别抢。
   *
   * ⚠️ ②只是**启发式**（「记录看起来还新」），不是租约：单进程部署建议 0；多进程共库
   * 时它只是「问不到 pid」时的兜底，别再指望它单独把「重复执行」挡住。
   * 阈值取值要大于「一个进程从启动到跑满一条记录」的合理时间，否则长跑会被抢。
   */
  staleAfterMs?: number;
}

/** 应用最小调用面（agent 装配无关，避免 run 层向上依赖 toolkit） */
export interface AppCallable {
  readonly name: string;
  run(
    messages: MessageParam[],
    opts?: RunInvocationOptions,
  ): Promise<{ run: { runId: string; status: RunStatus }; result: AgentRunResult }>;
}

export class AsyncRunner {
  readonly store: TaskStore;
  /**
   * 本进程标识：写进认领的 `TaskRecord.ownerId`，供 resumePending 区分他我。
   *
   * 形状 `p<pid>@<host>-<8位十六进制>`（真源见 `owner-id.ts`）。为什么带主机名与 pid：
   * 光有时间判不出「主人还在不在」（`staleAfterMs` 是**新鲜度**不是**租约**），
   * 而「同主机 + pid 还在」是能直接问操作系统的**直接证据**（见 `owner-liveness.ts`）。
   */
  readonly ownerId: string;
  /**
   * 本机主机名（构造期取一次）。**同一个值**既写进 `ownerId`、也用于「同主机吗」的判定 ——
   * 两处各自取一次就可能不一致（hostname 在进程存活期间是可能被改的），判定会因此静默失效。
   */
  readonly #host = hostname();
  private readonly client: ModelClient | undefined;
  private readonly sessionStore: AsyncRunnerOptions['sessionStore'];
  private readonly concurrency: number;
  private readonly maxQueued: number;
  /**
   * 当前**在等槽位**的任务 id 集合（已受理、尚未拿到槽位）—— `maxQueued` 的判据，
   * 也是 `queued` 读数。
   *
   * 为什么是**集合**而不是计数器：入口只有一处（`#execute` 的**同步前段**、第一个 await
   * 之前 `add`），出口有两处（`#executeInner` 里**拿到槽位**那一刻 `delete`，`#execute`
   * 的外层 finally 再 `delete` 一次兜底 —— 覆盖「幂等去重早退 / 中途抛错」）。`add` /
   * `delete` 的语义**天然幂等**，所以多重释放无害、漏放不可能（兜底那道闸在 finally 里）。
   * 用整数计数器要做到同一件事，得自己再造一个「只减一次」的闸 —— 那正是最容易写漏的东西
   * （第一版就是这么写的，而释放点根本不在同一个函数作用域里，闭包跨不过去）。
   *
   * ⚠️ 同一 taskId 的两次 `#execute` 并发不在设计内（在飞闸挡着）；万一发生，先退出那一趟
   * 的 finally 会把仍在等槽位的那趟从集合里删掉 ⇒ 读数**偏小**（闸更宽松）。偏小是安全的
   * 方向：它不会把服务永久锁在 503 上，而「多收一条」只是回到加本旋钮之前的行为。
   *
   * ⚠️ **它本身不是排队深度**：队列长度要减掉「马上就能拿到空槽位的那些」，见 `#queueDepth`
   * —— 一个 `submit` 循环里同步灌进来的每一条都会先落进本集合，而此时池子还空着，
   * 直接拿 `size` 当深度会把「立刻就能跑的」也算成排队的（`concurrency: 1` + `maxQueued: 1`
   * 下连灌两条就会把第 2 条误拒 —— 第一版就是这么写的，被用例当场抓出来）。
   */
  readonly #waiting = new Set<string>();

  /**
   * **真正在排队的深度**（`maxQueued` 的判据，也是 `queued` 读数）。
   *
   * 公式：`max(0, 已受理未持槽的任务数 + adding − 当前空槽位数)`。
   *
   * 为什么不能只用等待队列长度、也不能只用 `#waiting.size`：
   * - `#waiting` 里混了「刚 submit、还没走到 acquire」的任务 —— 池子空着时它们**不会排队**，
   *   只是还没轮到执行那一刻。`adding` 就是给「正在提交的这一条」留的位置。
   * - 空槽位数 = `concurrency − #slots.inUse`。于是「同步灌 N 条」时：先到的 N 条一边进
   *   `#waiting`、一边还算着同样的空槽位，两个量相抵 ⇒ 判据正好落在
   *   「最多 `concurrency + maxQueued` 条在推进」这条对外口径上（见 `AsyncRunnerOptions.maxQueued`）。
   * - `concurrency` 为 `Infinity`（缺省）时空槽位数是 `Infinity` ⇒ 深度恒为 0 ⇒ 闸天然不起作用，
   *   与「缺省行为与加本旋钮之前逐字一致」对齐。
   */
  #queueDepth(adding = 0): number {
    const freeSlots = Math.max(0, this.concurrency - this.#slots.inUse);
    return Math.max(0, this.#waiting.size + adding - freeSlots);
  }
  private readonly runTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  /** 并发槽位池（见 slot-pool.ts）：本类不再自管 running/waitQueue */
  readonly #slots: SlotPool;
  /** 已受理但未达终态的任务数（queued + running）—— /healthz 与 drain 共用 */
  private active = 0;
  /** 停机等待闸（见 drain-gate.ts）：停机态标志与等待者一并外移 */
  readonly #drain = new DrainGate();
  /** 任务终态等待表（见 task-waiters.ts）：仅覆盖本进程写终态，他进程写靠兜底轮询 */
  readonly #taskWaiters = new TaskWaiters();
  /**
   * 本进程**已受理并正在推进**的任务（= `#execute` 的存活区间）。
   *
   * 只为 `cancel` 的文案存在：命中「`status === 'running'` 但在飞句柄表里没有」时，
   * 区分「**本进程排队未起跑**」与「**真不在本进程**」——
   * - 四条恢复路径（approve / 到期唤醒 / 事件投递 / 崩溃重投）都**先**把状态置 `running`
   *   再 `#dispatch`，而 `#runAborts` 要到 `#slots.acquire()` 之后才登记 ⇒ 中间整个窗口
   *   里 `status` 已是 running、句柄却还没有。原文案一律说「不在本进程」，
   *   对同进程排队的那条是**说反话**（2026-09-28 外部复核抓到）。
   * - 本集合与 `#runAborts` 的**差集**恰好就是「已受理、未起跑」（见 `#cancel`）。
   *
   * ⚠️ **纯诊断**：不参与任何正确性判定，也不影响 409 闸本身（那道闸不放开 ——
   * 放开会让等槽位那趟 `#execute` 的 finally 双发 `onFinished`，正是 spec §10 的变异 M23）。
   */
  readonly #executions = new Set<string>();
  /**
   * 每任务的记账事件流（见 task-events.ts）：`GET /tasks/:id/stream` 的重放 + 实时推送。
   * 纯记账件，独立于 store / 槽位 —— 所以在 855 行的类里单独抽一个文件。
   */
  readonly #streams: TaskEventStreams;
  /**
   * **同进程内的幂等键认领表**（idempotencyKey → 在飞记录）。
   *
   * 为什么必须有它（2026-09-21 外部复核实测）：`submit` 是同步门面，**无法 await** 异步 store 的
   * `byIdempotency`；而 `#executeInner` 只采纳已 `succeeded` 的既有记录。于是「同时提交两个
   * 相同 idempotencyKey」在异步 store 下**两次都执行**（实测 appRunCalls=2）——
   * 文档承诺的「同键未失败直接返回既有记录」实际只对同步 store 成立。
   *
   * 这里把那条承诺补回到「**同进程内**并发提交」这一档：认领在 `#execute` 的同步前段完成，
   * 所以两次连续的 `submit` 之间没有窗口。跨进程仍是 at-least-once（诚实边界，见 usage-guide §7）。
   */
  readonly #claims = new Map<string, TaskRecord>();
  private readonly taskSinks: TaskSink[];
  private readonly onPersistError: AsyncRunnerOptions['onPersistError'];
  /**
   * HITL 挂起时快照的「本轮用户输入」（taskId → messages）—— 恢复段成功后做会话回写用
   * （恢复段不把 session 交给 run 层，见 #executeInner 的 callOpts 注释）。
   * 只在首个挂起段快照；任务达终态时清掉（#execute 的出口）。
   *
   * **刻意只放内存**：进程崩在「挂起 → 重启 → approve」之间会丢这一次会话回写 ——
   * 会话少一轮，但绝写不进坏历史（孤立 tool_use / 历史翻倍），审批决定本身已落库、
   * 不受影响。快照若落库就要动 TaskRecord 的序列化 schema（sqlite / redis），
   * 而它相对审批决定只是锦上添花 —— 这个取舍是有意的。
   */
  private readonly sessionInputs = new Map<string, MessageParam[]>();

  constructor(
    private readonly app: AppCallable,
    opts: AsyncRunnerOptions = {},
  ) {
    this.store = opts.store ?? new InMemoryTaskStore();
    this.client = opts.client;
    this.sessionStore = opts.sessionStore;
    this.taskSinks = opts.taskSinks ?? [];
    this.onPersistError = opts.onPersistError;
    this.#streams = new TaskEventStreams(
      opts.streamBufferEvents === undefined ? {} : { maxEvents: opts.streamBufferEvents },
    );
    this.concurrency = opts.concurrency ?? Number.POSITIVE_INFINITY;
    if (!(this.concurrency > 0)) {
      throw new Error(
        `concurrency 必须为正数（${zeroClauseOf('AsyncRunner.concurrency')}），收到 ${opts.concurrency}`,
      );
    }
    // 放在校验之后：字段初始化式在构造函数体之前求值，那时 concurrency 还是 undefined
    this.#slots = new SlotPool(this.concurrency);
    this.maxQueued = opts.maxQueued ?? 0;
    if (!Number.isInteger(this.maxQueued) || this.maxQueued < 0) {
      // 与 concurrency 同族：`0` 本身**合法**（= 不限），坏的是「负数 / 小数 / NaN / Infinity」。
      // 负数的读法无解（「最多排 -1 个」是什么），小数会让比较变成「有时收有时不收」——
      // 都不是「配置宽一点」而是「配置说了另一件事」，所以构造期响亮失败。
      throw new Error(
        `maxQueued 必须为 ≥ 0 的整数（${zeroClauseOf('AsyncRunner.maxQueued')}），收到 ${opts.maxQueued}`,
      );
    }
    this.runTimeoutMs = opts.runTimeoutMs ?? 0;
    if (!Number.isFinite(this.runTimeoutMs) || this.runTimeoutMs < 0) {
      // NaN/Infinity 都不能放给 setTimeout：两者都会被钳到 1ms，每个任务立即「超时」失败
      // （且 NaN 会绕过 `< 0` 检查静默通过）。要「不限」请传 0（缺省）。
      // 文案里的「0 = 不限」取自 core/limits.ts 的表 —— 口径与实现同一处，不可能各说各话。
      throw new Error(
        `runTimeoutMs 必须为 ≥ 0 的有限数（${zeroClauseOf('AsyncRunner.runTimeoutMs')}），收到 ${opts.runTimeoutMs}`,
      );
    }
    // 上界（2026-09-28）：「≥0 且有限」还不够 —— 超过 2^31-1ms（约 24.86 天）的延迟
    // Node **不会遵守**（stderr 一行 TimeoutOverflowWarning + 钳到 1ms），于是「配 30 天
    // 超时」变成「每个任务立即超时失败」，静默且与配置相反。上限单源与五处站点共用：
    // 这一句就是 scheduler.ts 注释里承诺过的「async.ts 同款防线」（此前那句话与实现不符）。
    assertTimerDelay(this.runTimeoutMs, 'AsyncRunner 的 runTimeoutMs');
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0;
    if (!Number.isFinite(this.approvalTimeoutMs) || this.approvalTimeoutMs < 0) {
      // 同 runTimeoutMs：非有限数会让「已挂起多久」的比较静默失效或立即超时
      throw new Error(
        `approvalTimeoutMs 必须为 ≥ 0 的有限数（${zeroClauseOf('AsyncRunner.approvalTimeoutMs')}），收到 ${opts.approvalTimeoutMs}`,
      );
    }
    this.ownerId = formatOwnerId(process.pid, this.#host, randomUUID().slice(0, 8));
  }

  /**
   * 提交一次异步任务。入参可为 string / messages / {prompt|text|messages}。
   * 幂等键存在且上一任务未失败 → 直接返回既有记录（去重）；失败的同键可产生新任务。
   * 同步门面：同步 store 下立即去重并返回快照；异步 store 下 save 在后台完成、
   * 去重推迟到执行前（见 #execute），返回新建任务的提交时刻快照。
   */
  submit(
    input: unknown,
    opts: { idempotencyKey?: string; source?: string; options?: RunInvocationOptions } = {},
  ): TaskRecord {
    // 停机中不接单（drain 之后）；宿主据此回 503。放在最前：连入参规整都省了。
    if (this.#drain.isDraining) {
      throw new Error('runner 正在优雅停机，不再接受新任务');
    }
    const messages = normalizeMessages(input);
    if (opts.options?.sessionId !== undefined && this.sessionStore === undefined) {
      // 响亮失败：调用方明着要会话语义，静默降级成「没有会话」是最难查的那种错。
      // 注意 import 的是 spec.js 的 TaskInputError —— HTTP 宿主据此回 400（调用方的错）。
      throw new TaskInputError(
        '任务带了 options.sessionId，但本 runner 未配 sessionStore —— 会话历史接不上；' +
          '给 AsyncRunner 传 sessionStore，或去掉 sessionId',
      );
    }
    if (opts.idempotencyKey) {
      // 同步快路径：**同进程内已有同键在飞** → 直接返回它。异步 store 下 byIdempotency 是
      // Promise，同步门面等不了；而 #executeInner 只采纳已 succeeded 的记录 ⇒ 不认领这条，
      // 「同时提交两个同键任务」会两次都执行（见 #claims 的注释）。
      const inFlight = this.#claims.get(opts.idempotencyKey);
      if (inFlight) return { ...inFlight };
      const existing = this.store.byIdempotency(opts.idempotencyKey);
      if (isThenable(existing)) {
        // 异步 store 返回 Promise —— 同步门面无法 await，去重交给 #execute。
        // 但**必须订阅它**：byIdempotency 的 reject（Redis 抖动等）若无人处理就是
        // unhandledRejection（Node ≥15 默认终止宿主进程）。这里只做「查不到既有记录」
        // 处理，拒绝即视为无记录，交 #execute 的去重兜底。
        existing.catch(() => undefined);
      } else if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
        // at-least-once 去重：不重复执行。`failed` 被刻意排除（失败后同键重提要真跑）；
        // `cancelled` 同理 —— 排队被取消的任务**一次都没跑过**，同键再提交若直接认回
        // 那条 cancelled 记录，这次提交就被静默吞掉（且与 #executeInner 只采纳
        // `succeeded` 的异步路径不一致：同一件事两种 store 两种结局）。
        return { ...existing };
      }
    }
    // 排队段闸（2026-09-28 外部深评 T5）：放在**去重之后** —— 幂等键命中既有记录时
    // 本次提交既不产生新活也不排队，不该吃 503（否则「重试同一个键」会变成看运气）。
    // 读 `#waiting` 是**同步准确**的：别的 submit 在它自己的 `#execute` 同步前段就入过集合
    // （`#dispatch` 是 submit 的最后一行，`void this.#execute(rec)` 的 body 到第一个 await
    // 之前全同步）⇒ 「一个循环里同步灌 N 条」不可能绕过这道闸，不靠人记得 await。
    // 判据是**真正在排队的深度**（`#queueDepth`），不是「已受理未持槽」的集合大小：
    // 后者把「池子还空着、马上就能跑」的那些也算成排队的，会把第 2 条合法提交误拒。
    // `(1)` = 把正在提交的这一条算进去 —— 闸要拦的是「这条交了以后会溢出」。
    const queueDepth = this.#queueDepth(1);
    if (this.maxQueued > 0 && queueDepth > this.maxQueued) {
      throw new TaskQueueFullError(
        `排队已满：这条提交会让 ${queueDepth} 条任务排在槽位后` +
          `（上限 maxQueued=${this.maxQueued}，concurrency=${this.concurrency}）` +
          '—— 请退避重试，或调大 concurrency / maxQueued',
      );
    }
    const rec: TaskRecord = {
      taskId: nextTaskId(),
      status: 'queued',
      idempotencyKey: opts.idempotencyKey,
      spec: { messages, options: opts.options, source: opts.source ?? 'async' },
      createdAt: Date.now(),
      ownerId: this.ownerId,
    };
    const saved = this.store.save(rec);
    if (isThenable(saved)) {
      // 异步落库失败：尽力把任务标记为 failed 重存，避免静默吞错 / unhandled rejection。
      // 但只在任务**尚未被 #execute 推进**时改判：初始 save 的 reject 可能迟到，
      // 那时 run 已跑完并写了成功终态，无条件覆写会把成功翻成失败（落库终态与真实结果相反）。
      saved.catch((e) => {
        if (rec.status !== 'queued' || rec.finishedAt !== undefined) return;
        rec.status = 'failed';
        rec.error = classifyError(e);
        rec.finishedAt = Date.now();
        void this.#safeSave(rec, 'initial');
      });
    }
    // 派发走唯一入口（闸在 #dispatch 里）—— ⚠️ 这里是**结构一致性**，不是行为依赖：
    // 本方法开头那道 `isDraining` 检查（拒绝语义：对调用方的承诺是抛错 / 503，不是静默排期）
    // 与这一行之间**没有 await** —— `submit` 是**全同步**的（异步 store 的 `save` 也只是挂个
    // `.catch`，不 await）⇒ JS 不可能在中间插入 drain 的置位 ⇒ `#dispatch` 那道闸在**本方法内
    // 永远不触发**。（2026-09-28 PR #164 复核 §3：此前的注释与提交信息把它说成「挡进闸与派发
    // 之间刚开始停机的窄窗口」，那是个不存在的窗口。）
    // 仍然走它：**「派发一律走唯一入口」这条纪律不该有例外** —— 少一个例外，就少一处将来
    // 新增恢复路径时会漏的枚举。
    this.#dispatch(rec);
    // 返回浅拷贝：记录会被后台状态机原地推进，调用方拿到的是提交时刻的快照
    return { ...rec };
  }

  /** 查任务当前记录（异步 store 下返回 Promise，调用方 await） */
  poll(taskId: string): MaybePromise<TaskRecord | undefined> {
    const rec = this.store.get(taskId);
    // 惰性挂起闸（HITL 超时 + 到期唤醒）：读到挂起记录时顺手判定，到点就恢复并重派
    if (isThenable(rec)) return rec.then((r) => this.#lazyGates(r));
    return this.#lazyGates(rec);
  }

  /**
   * 订阅某任务的**记账事件流**（`GET /tasks/:id/stream` 的引擎侧）。
   *
   * 三条语义（与 docs/plans/2026-09-21-incremental-trace-export-and-sampling.md §3 Phase A3 对齐）：
   * 1. **先重放、后实时**：`opts.from`（= SSE 的 `Last-Event-ID` / `?from=`）之后的事件先补发，
   *    再挂实时订阅 —— 「连上时已经跑了一半」的客户端因此也能拿到完整前缀。
   * 2. **终态收口**：任务已终态 ⇒ 补发完缓冲 + 一帧 `end`，**不留**一条永远不会再产出事件的流。
   *    挂起（`suspended`）**不是**终态：批了（或睡到点了）会接着跑，流必须开着（见 isTerminalTask）。
   * 3. **跨进程不假装**：本进程没有这条流时（别的进程在跑 / 任务早于本进程），发一帧
   *    `unavailable` 后**立即收口**：终态补 `end`，非终态补 `closed`（流级收尾，不是
   *    伪造终态）—— 非终态只发 `unavailable` 就返回的话，这条 SSE 只剩心跳永远挂着。
   *    事件**不落 store** 是有意的：实测事件数
   *    = 2 × 工具调用、正文 KB 级 ⇒ 每条工具调用要把 KB 级正文写库两次（写放大），
   *    而宿主本来就有自己的总线（`onTraceEvent` 就是给它的缝）。
   *
   * 返回退订函数（连接关掉时必须调，否则订阅者挂在表里）。任务不存在 ⇒ `TaskStreamError`（404）。
   */
  async streamTask(
    taskId: string,
    listener: (frame: TaskStreamFrame) => void,
    opts: { from?: number } = {},
  ): Promise<() => void> {
    const noop = (): void => {};
    if (this.#streams.has(taskId)) {
      const replayed = this.#streams.replay(taskId, opts.from);
      // 截断明示放在重放之前：下游先知道「前面缺了一段」，再读数据
      if (replayed.droppedBefore !== undefined) {
        listener({ type: 'truncated', droppedBefore: replayed.droppedBefore });
      }
      for (const item of replayed.events) {
        listener({ type: 'trace', index: item.index, event: item.event });
      }
      if (replayed.done) {
        const rec = await this.poll(taskId);
        if (rec) listener({ type: 'end', record: rec });
        return noop;
      }
      // 实时订阅：`onDone` 里补发 `end` 帧 —— 终态是流的一部分
      //（没有它，这条 SSE 会在任务跑完之后一直挂着，客户端以为它还在跑）
      return this.#streams.subscribe(
        taskId,
        (item: TaskStreamEvent) =>
          listener({ type: 'trace', index: item.index, event: item.event }),
        () => {
          // poll 可能是异步 store ⇒ 用 then 补发（此刻任务已终态、记录已落库）
          void Promise.resolve(this.poll(taskId)).then((rec) => {
            if (rec) listener({ type: 'end', record: rec });
          });
        },
      );
    }
    const rec = await this.poll(taskId);
    if (!rec) throw new TaskStreamError(`task 不存在: ${taskId}`);
    listener({ type: 'unavailable', reason: 'not-in-this-process' });
    // unavailable 之后**必须立即收口**：返回的 noop 意味着没有退订通道，不收口这条
    // 流就只剩心跳永远挂着（客户端按「读到流结束」写法永远等不到）。
    // 终态补 `end`；非终态不能伪造终态帧 —— 发流级收尾帧 `closed`（客户端转轮询）。
    if (isTerminalTask(rec)) {
      listener({ type: 'end', record: rec });
    } else {
      listener({ type: 'closed', reason: 'not-in-this-process' });
    }
    return noop;
  }

  byIdempotency(key: string): MaybePromise<TaskRecord | undefined> {
    return this.store.byIdempotency(key);
  }

  list(): MaybePromise<TaskRecord[]> {
    return this.store.list();
  }

  /**
   * 取消一个任务（durable 配套 5 的另一半；设计稿 `docs/plans/2026-09-28-cancel-api.md`）。
   *
   * 三种「在服」状态各自的语义 —— 都落在这一处，不分散：
   * - **running**：中止在飞 signal ⇒ 引擎以 `stopReason: 'aborted'` 收尾（尊重 signal 的
   *   client 是**真中断**，token 不再烧；不尊重者等价「放弃等待」—— 与 `runTimeoutMs`
   *   同一份契约）。等它真落库再返回：不等的话调用方拿到的是 `status` 仍为 running 的快照，
   *   「取消了但状态还在跑」比不返回更误导。
   * - **queued**（还没起跑）：落终态；`#executeInner` 拿到槽位后会**重读**再判，
   *   所以被取消的排队任务**绝不起跑**（这条是本次实现顺带补上的洞）。记账由本方法
   *   自己做；那一趟还活着的 `#execute`（在等槽位）靠 `#cancelSettled` 在 finally 里
   *   跳过它那一份（否则 onFinished 两次）。
   * - **suspended**（两种原因都算）：落终态 —— 两条唤醒闸都 gate 在 `status === 'suspended'`
   *   上，「不唤醒」因此是翻转状态的**推论**，不需要第二处标志。它没有活着的 `#execute`
   *   （挂起时那趟就走完了），所以记账（sinks / 事件流 / 认领释放 / 等待者 / 会话清理）
   *   由本方法自己做 —— 也因此它**不进** `#cancelSettled`（没有消费者，加了就是泄漏）。
   *
   * 状态按**意图**落，不按机制落：超时的收尾语义**不变**（仍是 `failed` + `error.type` 为
   * `'timeout'`），取消带 `error = abortedError()`（取消不是失败，但原因要可查）。
   *
   * 不做静默 no-op：已终态 ⇒ `TaskCancelError(409)`（状态不对要说出来），不存在 ⇒ 404。
   * 边界（如实写在这里）：`running` 的 run **不在本进程**（多进程部署 / 上一世留下的 running）
   * 时抛 409 —— 本进程没有句柄可中断，改状态假装取消只会在那条 run 跑完时被覆盖回去。
   *
   * ⚠️ 同一个 409 判据下还有**第二种**情形（2026-09-28 外部复核）：任务已在本进程受理、
   * 但还没走到 `#runAborts` 登记（在等并发槽位，或恢复路径刚写完 `running` 尚未派发完）。
   * 它**不是**「不在本进程」—— 原文案一律那么说，对这一类是说反话。两种情形分开措辞
   * （见 `#cancel` 的判据），但**闸不放开**：放开会让等槽位那趟 `#execute` 的 finally
   * 双发 `onFinished`（spec §10 的变异 M23）。
   */
  cancel(taskId: string): MaybePromise<TaskRecord> {
    const found = this.store.get(taskId);
    if (isThenable(found)) return found.then((rec) => this.#cancel(rec, taskId));
    return this.#cancel(found, taskId);
  }

  #cancel(rec: TaskRecord | undefined, taskId: string): MaybePromise<TaskRecord> {
    if (!rec) throw new TaskCancelError(404, `task 不存在: ${taskId}`);
    if (isTerminalTask(rec)) {
      throw new TaskCancelError(409, `task ${taskId} 已终态（${rec.status}），不能取消`);
    }
    const inflight = this.#runAborts.get(taskId);
    if (rec.status === 'running' && !inflight) {
      // 「假装取消」是这里最坏的选项：那条 run 还活着，跑完会把状态覆盖回去
      // （调用方以为成功了，实际什么都没发生）。要说出来。
      // ⚠️ 但这两类情形**必须分开说**（2026-09-28 外部复核）：`#executions` 是
      // 「本进程已受理并正在推进」的集合，与 `#runAborts`（已登记在飞句柄）的差集
      // 就是「**已受理、未起跑**」。四条恢复路径先置 `running` 再 `#dispatch`、
      // 而句柄要到拿到槽位才登记 ⇒ 中间整个窗口都会落进这个差集 —— 对它说
      // 「不在本进程」是反话。调用方据此区分「稍后重试」与「得去找那个进程」。
      const acceptedHere = this.#executions.has(taskId);
      throw new TaskCancelError(
        409,
        acceptedHere
          ? `task ${taskId} 已在本进程受理，但尚未起跑（正在等并发槽位 / 走恢复前置）—— ` +
              `此刻取消无法与那条在等槽位的执行路径安全收口（会重复记账），暂不支持；` +
              `请待它起跑后再取消，或先降低并发压力`
          : `task ${taskId} 正在运行但不在本进程，本进程无法中断它（多进程部署见 spec §10 2026-09-28 ④）`,
      );
    }
    // 意图先记下：在飞那条路要靠它把 aborted 的收尾落成 cancelled（否则落成 failed）
    this.#cancels.add(taskId);
    if (inflight) {
      inflight.abort();
      return this.#awaitCancelled(taskId);
    }
    // queued / suspended：没有在飞 run（或它还没起跑），直接落终态 —— 记账由本方法做完，
    // 等槽位那趟 #execute 的 finally 靠 `#cancelSettled` 跳过它那一份（否则 onFinished 两次）。
    // ⚠️ `#cancelSettled` 只为 **queued** 而存（它有活着的、在等槽位的 #execute 来消费）；
    // suspended 的那趟 #execute 早在挂起时就走完了，条目加进去永远没人摘（泄漏）。
    // 既知边界（多进程）：他进程取消本进程**排队中**的任务时，本进程的 execute finally
    // 在自己的 `#cancelSettled` 里查不到 ⇒ onFinished 会双发（cancel 进程一次 + owner 一次）。
    const wasQueued = rec.status === 'queued';
    rec.status = 'cancelled';
    rec.error = abortedError();
    rec.finishedAt = Date.now();
    // 挂起痕迹清掉（`pendingApprovals` 与 `approvals` 的区别与既有终态口径一致：
    // 未决清单清掉、**已做出的决定**保留 —— 那是审计的一部分，随任务走）
    rec.pendingApprovals = undefined;
    rec.suspendedSince = undefined;
    rec.suspendedReason = undefined;
    rec.wakeAt = undefined;
    this.#unmarkSuspended(taskId);
    const saved = this.#safeSave(rec, 'outcome');
    this.#cancels.delete(taskId);
    if (wasQueued) this.#cancelSettled.add(taskId);
    const finish = (): TaskRecord => {
      this.#taskWaiters.notify(taskId);
      this.#streams.markDone(taskId);
      this.sessionInputs.delete(taskId);
      const key = rec.idempotencyKey;
      if (key !== undefined && this.#claims.get(key)?.taskId === taskId) this.#claims.delete(key);
      this.#notifyDrained();
      return { ...rec };
    };
    return isThenable(saved)
      ? Promise.resolve(saved)
          .then(() => this.#notifySinks(rec))
          .then(finish)
      : this.#notifySinks(rec).then(finish);
  }

  /**
   * 等一条**已请求取消**的在飞任务真收尾（宽限见 `CANCEL_GRACE_MS`）。
   *
   * 终态判据用 `isTerminalTask`（单一真源）—— 手写两值会让 `cancelled` 在这里被漏掉，
   * 等待就变成「等到超时」，症状是「取消没生效」。
   *
   * ⚠️ 宽限内没收尾 ⇒ **撤回意图 + 抛 409**，不假装：敢说「取消了」而那条 run 还活着的话，
   * 它跑完会把状态覆盖回去（调用方以为成功、实际什么都没发生）。不认 `signal` 的宿主正是
   * 这一类；`runTimeoutMs` 那条老路对同样情形是「放弃等待」（记录落 failed、槽位释放、
   * 底层执行照样跑完）—— 两者**刻意不同**：超时是宿主自己定的预算，取消是人手按的动作，
   * 骗人的代价不一样。
   */
  async #awaitCancelled(taskId: string): Promise<TaskRecord> {
    const deadline = Date.now() + CANCEL_GRACE_MS;
    for (;;) {
      const rec = await this.store.get(taskId);
      if (rec && isTerminalTask(rec)) return rec;
      const left = deadline - Date.now();
      if (left <= 0) {
        // 撤回意图（不删 `#runAborts`：那条 run 还在本进程里活着，句柄留给它自己的 finally 摘）
        this.#cancels.delete(taskId);
        throw new TaskCancelError(
          409,
          `task ${taskId} 的中断没有在 ${CANCEL_GRACE_MS}ms 内生效（宿主不认 signal？）—— 取消未发生`,
        );
      }
      await this.#taskWaiters.wait(taskId, Math.min(250, left));
    }
  }

  /**
   * 审批一个处于 `suspended` 的任务（HITL）。
   *
   * - **逐 tool_use_id 幂等**：已存在的决定不覆盖（第一次决定赢）—— 重复提交 /
   *   并发点击不会推翻已有决定，也不会让恢复段重复执行；
   * - **并发重入共享在飞那次**：同一任务的并发 approve（双击「批准」/两个审批人
   *   同时批）返回同一个 Promise —— 否则两个调用都在对方落库前读到
   *   `suspended`、各自判「决定齐了」、**各派发一次**（同一任务重复执行，
   *   与 resumePending 的闸门同一 bug 类）。被共享的那次覆盖不到的决定不丢：
   *   调用方从返回的记录看到任务仍在等待，重试即并入；
   * - 决定齐了就恢复：`status` 回 `running`、**先落库再派发**（与 `#redispatch`
   *   同一条纪律 —— 没落库就恢复，进程崩在窗口里会丢决定）；恢复段带着
   *   `rec.approvals` 与扩展后的消息历史（`rec.spec.messages`，末尾是含未决
   *   tool_use 的那条 assistant 消息）重进引擎循环；
   * - 决定**没**齐：只把本批决定落库，任务继续等（可能多轮审批）；
   * - 返回当前 TaskRecord（快照）。任务不存在抛 404 语义、状态不对抛 409 语义
   *   的 `TaskApproveError`。
   */
  async approve(
    taskId: string,
    decisions: ApprovalDecisions,
    opts: { decidedBy?: string } = {},
  ): Promise<TaskRecord> {
    const inflight = this.inflightApprovals.get(taskId);
    if (inflight) return inflight;
    const run = this.#approveInner(taskId, decisions, opts).finally(() => {
      this.inflightApprovals.delete(taskId);
    });
    this.inflightApprovals.set(taskId, run);
    return run;
  }

  /** 同一任务的在飞审批（approve 的重入闸，见上）。**与惰性超时恢复共用同一把闸** ——
   *  approve 与 #expireAndResume 都会「填决定 + 落库 + 派发」，不互斥就是同一任务跑两遍。 */
  private readonly inflightApprovals = new Map<string, Promise<TaskRecord>>();

  async #approveInner(
    taskId: string,
    decisions: ApprovalDecisions,
    opts: { decidedBy?: string },
  ): Promise<TaskRecord> {
    const rec = await this.store.get(taskId);
    if (!rec) throw new TaskApproveError(404, `task 不存在: ${taskId}`);
    if (rec.status !== 'suspended' || rec.suspendedReason !== 'approval') {
      throw new TaskApproveError(
        409,
        rec.status === 'suspended'
          ? `task ${taskId} 的挂起原因是 ${rec.suspendedReason ?? '未知'}，只有等人工审批的挂起能审批`
          : `task ${taskId} 当前状态为 ${rec.status}，只有挂起在等审批的任务才能审批`,
      );
    }
    const now = Date.now();
    // 入参校验（2026-09-28 外部深评 P1-2）：本批只许批**本任务待决的** id。
    // 不校验会怎样（实证：一次 approve 塞 5000 个无关键 ⇒ 记录从 246 字节撑到 419 KB）：
    // 多出来的键照样写进 `rec.approvals`、随每次 save 全文重写落库、并随任务**永久保留**
    // （终态也不清：审批记录是审计的一部分）⇒ 一个**认证调用方**单次请求就能把记录撑大，
    // 反复调用可无限叠加。拒整批而不是挑着收：与 `parseApproveBody`（形状全有或全无）、
    // `parseEventBody`（多一个字段即拒）同一条纪律 —— 调用方本来就该从记录的 `pendingApprovals`
    // 里读要批哪些 id。
    // ⚠️ 为什么**不需要**再给 `rec.approvals` 加常量上限：单次 approve 能新写的键 ⊆ 当前
    // `pendingApprovals`（挂起那一刻固定）。跨多轮挂起它会累计**历次**待决的并集
    // （决定是审计，终态也保留），但每一轮都对应真跑出来的模型回合与 tool_use ——
    // 调用方的单次输入无法放大体积，增长只能随真实运行发生。再加常量上限是一段
    // 永远触发不到的死代码（那不是护栏，是噪音）。
    const pendingIds = new Set(rec.pendingApprovals ?? []);
    const unknownIds = Object.keys(decisions).filter((id) => !pendingIds.has(id));
    if (unknownIds.length > 0) {
      throw new TaskApproveError(
        400,
        `decisions 里有 ${unknownIds.length} 个 id 不在本任务的待决列表里（如 ${unknownIds[0]}）—— 整批拒掉，记录不动`,
      );
    }
    rec.approvals ??= {};
    for (const [id, d] of Object.entries(decisions)) {
      if (rec.approvals[id]) continue; // 逐 id 幂等：第一次决定赢
      rec.approvals[id] = {
        approved: d.approved,
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
        ...(opts.decidedBy !== undefined ? { decidedBy: opts.decidedBy } : {}),
        decidedAt: now,
        ...(rec.suspendedSince !== undefined ? { requestedAt: rec.suspendedSince } : {}),
      };
    }
    // 惰性审批超时：人的决定先并入（先到先赢），仍空着的待决项由超时兜底成 deny
    if (approvalExpired(rec, now, this.approvalTimeoutMs)) fillTimeoutDenials(rec, now);
    const complete = approvalsComplete(rec);
    if (complete) {
      rec.status = 'running'; // 由 #executeInner 接管（acquireSlot → 恢复执行）
      rec.ownerId = this.ownerId;
    }
    // 先落库再派发 —— **真纪律，不是注释**：save 失败（同步抛 / 异步 reject）就
    // 绝不恢复执行（落不了库的决定不算决定：进程崩在窗口里会丢决定，重启后把
    // 同一件事再判一次、可能改判）。调用方拿到 reject，重试即可。
    await this.store.save(rec);
    if (complete) {
      // 离开挂起态（读数纪律②）：决定齐了这就是「醒来」那一刻
      this.#unmarkSuspended(taskId);
      // 派发走**唯一入口**（闸在 #dispatch 里判一次 —— 2026-09-28 外部深评 P1-1 的结构性修法）：
      // 决定已经在记录里，停机窗口里放行的是「重新排期」（下次启动认领），不是「吞掉」。
      this.#dispatch(rec);
    }
    return { ...rec };
  }

  /**
   * 投递一个事件给**挂起**的任务（2026-09-28 ⑥，run 事件投入口；
   * `POST /tasks/:id/events` 的宿主方法侧，与 approve/cancel 对称）。
   *
   * 语义（设计稿 §3 逐条的落点）：
   * - **只对 `suspended` 生效**：不存在 ⇒ 404；其余状态（含已终态）⇒ 409
   *   （「不唤醒已终态」是这条状态闸的推论，与 approve 同款「状态不对要说出来」）；
   * - **幂等**：`eventId` 给定时按 `rec.deliveredEventIds` 去重，重复 ⇒ 409
   *   （簿记随记录落库，重启不丢；有界 FIFO，见 MAX_DELIVERED_EVENT_IDS）。
   *   不给 `eventId` 就**没有恰好一次**：重复投递 = 重复进历史（如实，不假装）；
   * - **投完即续跑**（两种挂起原因都算 —— 对 timer 挂起这就是「提前醒」）：
   *   事件进 `rec.pendingEvents`、状态回 `running`，**先落库再派发**
   *   （与 approve / #wakeDueInner 同一条纪律：崩在窗口里不能丢事件）。
   *   事件**不**直接追加进 `rec.spec.messages` —— 续跑判定只认历史末尾一条
   *   （`tailToolUses`），追加 user 消息会把续跑判成新对话；注入由引擎在
   *   未决 tool_use 解决之后做（见 engine/loop.ts 的 deliverTaskEvents）；
   * - **不沿旧 wakeAt**：记录上的旧目标时刻不动（闸都 gate 在 suspended 上，
   *   状态一翻它就失效）；醒来重跑那一批时工具若再次 `deferUntil`，
   *   `wakeAt` 由新回合重新落定；
   * - drain 期间**仍允许**（与 approve 同理由：挂起的任务只有外部输入能推进）。
   *
   * 并发闸与 approve **不同款**：approve 共享在飞那次（决定是幂等合并），事件**串行成链**
   * （两条并发事件是两条不同的输入，共享 = 静默丢一条）。与其它恢复路径
   * （approve / 到期唤醒，各有自己的闸）的竞速：进闸后重读再判挡住绝大多数；
   * 剩下的窄窗口与既有「approve × wakeDue 分闸」同类（那两条按挂起原因天然互斥，
   * 事件两种原因都适用，是这个闸新盖的缝 —— 已记在 spec §10 2026-09-28 ⑥）。
   */
  signalTask(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    // 串行化（**不是** approve 那种「共享在飞那次」）：两个并发事件是**两条不同的输入**，
    // 共享在飞那次 = 后一条被静默丢掉；各自读-改-写而不互斥 = 双派发（与 resumePending
    // 的重入闸同一个 bug 类）。排成链：前一次落库完，这一次进闸后重读再判
    // （那时若已派发则状态是 running ⇒ 409 如实说出来，调用方可重试）。
    const prev = this.inflightSignals.get(taskId);
    const run = Promise.resolve(prev)
      .catch(() => undefined) // 前一次的 reject 已由它自己的调用方接走，这里只排队
      .then(() => this.#signalInner(taskId, event))
      .finally(() => {
        // 只摘自己：链上可能已有更新的节点（无条件 delete 会摘掉别人的）
        if (this.inflightSignals.get(taskId) === run) this.inflightSignals.delete(taskId);
      });
    this.inflightSignals.set(taskId, run);
    return run;
  }

  /** 同一任务的在飞事件投递（signalTask 的重入闸，见上） */
  private readonly inflightSignals = new Map<string, Promise<TaskRecord>>();

  async #signalInner(taskId: string, event: TaskEvent): Promise<TaskRecord> {
    const rec = await this.store.get(taskId);
    if (!rec) throw new TaskEventError(404, `task 不存在: ${taskId}`);
    if (rec.status !== 'suspended') {
      throw new TaskEventError(
        409,
        `task ${taskId} 当前状态为 ${rec.status}，只有挂起的任务能接收事件`,
      );
    }
    // 幂等去重（先判再改）：重复 ⇒ 409，记录一个字节不动（与 cancel 的「已终态」同款）
    if (event.eventId !== undefined && rec.deliveredEventIds?.includes(event.eventId)) {
      throw new TaskEventError(409, `事件 ${event.eventId} 已投递给 task ${taskId}（重复投递）`);
    }
    // 缓冲上限（2026-09-28 复审第三轮，定案 B：满了**说出来**，不静默丢）。
    // 判据次序 状态 ⇒ 幂等 ⇒ 容量：重复投递的那条本来就在缓冲里，报「重复投递」比报「满了」有用;
    // 两种 409 的**区别必须让调用方看得见** —— 重复投递是「已经在里面了」，满了是「没收下」。
    if ((rec.pendingEvents?.length ?? 0) >= MAX_PENDING_EVENTS) {
      throw new TaskEventError(
        409,
        `task ${taskId} 的待注入事件已达上限（${MAX_PENDING_EVENTS} 条）—— ${
          rec.suspendedReason === 'approval'
            ? '这条在等人工审批，而让它跑起来的唯一触发源是 approve（不在投递方手里）⇒ 要么等人批，要么 cancel 后重新提交'
            : '这条在等定时到点（approve 对它不适用）—— 到点它会自己醒来，缓冲里的事件在醒来那段注入；等不了就 cancel 后重新提交'
        }；本次事件**没有**被记录。`,
      );
    }
    rec.pendingEvents = [...(rec.pendingEvents ?? []), event];
    if (event.eventId !== undefined) {
      const ids = [...(rec.deliveredEventIds ?? []), event.eventId];
      rec.deliveredEventIds =
        ids.length > MAX_DELIVERED_EVENT_IDS
          ? ids.slice(ids.length - MAX_DELIVERED_EVENT_IDS)
          : ids;
    }
    rec.status = 'running'; // 由 #executeInner 接管（acquireSlot → 恢复执行）
    rec.ownerId = this.ownerId;
    // 先落库再派发 —— 与 #approveInner 同一条真纪律：save 失败就绝不恢复执行
    // （落不了库的事件不算投递：崩在窗口里会丢事件）。调用方拿到 reject，重试即可。
    await this.store.save(rec);
    // 离开挂起态（读数纪律②）：事件到了这就是「醒来」那一刻 —— 与 approve 的决定齐了同形
    this.#unmarkSuspended(taskId);
    // 派发走唯一入口（闸在 #dispatch 里）：停机窗口里不派发，事件留在 pendingEvents 上，
    // 下次启动的 resumePending 认领时注入。
    this.#dispatch(rec);
    return { ...rec };
  }

  /** 已受理但未达终态的任务数（queued + running）—— 健康检查与 drain 共用同一口径 */
  get inFlight(): number {
    return this.active;
  }

  /**
   * **本进程可见的挂起读数**（`/healthz` 的 `suspended` 段，配套 6）。
   *
   * 口径与 `inFlight` 同一张表：只数**本进程**经手的挂起 —— 跨进程要合并看板请自己聚合，
   * 不假装是全局面（别的进程挂起的记录这里看不见，重启后由首次扫描对齐，见下）。
   *
   * 三条维护纪律（这条读数的唯一风险是**漂移**，所以每条出口都要写清）：
   * ① 进挂起时登记（`#executeInner` 的挂起分支，与落库同一个分支）；
   * ② 离开挂起时除名（`approve` / 两条恢复路径 / 终态分支）；
   * ③ **每次 `resumePending` 扫描按 store 重建** —— 扫描本来就 `list()` 了全表，
   *    顺手对齐即可，把「漏了某个出口」从永久漂移降级成「下一次扫描前的偏差」。
   *
   * 为什么不留成 store 查询（每次 /healthz 扫全表）：`/healthz` 是探针端点（秒级频率），
   * 而 `list()` 要把**每条记录的完整 trace**取出来（sqlite/redis 下是全部反序列化）——
   * 拿它当健康检查的代价比它回答的问题大得多。
   */
  readonly #suspended = new Map<string, SuspendedEntry>();

  /** 挂起读数：按原因分组的条数 + 最早的目标时刻（无时间挂起时为 `null`） */
  get suspendedSummary(): SuspendedSummary {
    return summarizeSuspended(this.#suspended.values());
  }

  /** 登记一条挂起（纪律①）。原因缺失的记录不进表 —— 分不了组，宁可少数也不猜一个原因出来 */
  #markSuspended(rec: TaskRecord): void {
    if (rec.status !== 'suspended' || rec.suspendedReason === undefined) return;
    this.#suspended.set(rec.taskId, { reason: rec.suspendedReason, wakeAt: rec.wakeAt });
  }

  /** 除名（纪律②）：任务离开挂起态时调用（恢复、终态都算） */
  #unmarkSuspended(taskId: string): void {
    this.#suspended.delete(taskId);
  }

  /** 是否已进入优雅停机（drain 之后为 true）—— HTTP 宿主据此对新单回 503 */
  get isDraining(): boolean {
    return this.#drain.isDraining;
  }

  /**
   * 优雅停机：停止接单（此后 `submit` 抛错），等待已受理任务排空（或超时）。
   *
   * 返回是否排空干净：超时仍返回 `false`，**未完成的任务留在 store 里**，下次启动由
   * `resumePending` 续跑（所以 drain 不是「丢弃」，是「不再往前推」）。
   * - `timeoutMs` 缺省 0 = 一直等。
   * - 等待的是**所有已受理**的任务（queued 的也在内），不只是正在占槽位的那些。
   *
   * ⚠️ **这是一道单向闩：置位之后本进程不再推进任何任务，且没有复位路径**（`DrainGate` 只有
   * 置位，没有复位）。所以 `false`（排空超时）的含义不只是「还有在飞的」——它同时给宿主
   * 加了一条义务：**必须让进程退出**。理由（2026-09-28 PR #164 复核 §1，有探针实证）：
   * 停机窗口里被 `#dispatch` 拒掉的记录**已经落库**（`running`/`queued` + **本进程的 ownerId**），
   * 而本进程的 `resumePending` 会按 `own-process` 跳过它们（见 resume-policy.ts），`submit` 又
   * 已整体关闭 ⇒ 本进程内**没有任何自愈路径**。宿主若在 `false` 之后继续服务，这些记录会永远
   * 停在 `running`：`awaitTask` 不返回，`GET /tasks/:id/stream` 还会告诉客户端
   * `not-in-this-process`（说不对话：记录里的 ownerId 正是本进程）。只有**下一次进程启动**
   * 才会有人认领它们（ownerId 含 pid）。参考宿主（`examples/` 各示例的 `src/main.ts`）都是
   * `await drain(...)` 之后 `process.exit(...)`，与本条契约一致。
   */
  async drain(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    // 实现已外移到 drain-gate.ts（写前保留的契约注释仍在本方法上）
    return this.#drain.waitForIdle(() => this.active === 0, opts.timeoutMs ?? 0);
  }

  /**
   * 审批超时的**判定**已外移到 approval-policy.ts（`approvalExpired` / `fillTimeoutDenials` /
   * `approvalsComplete`）—— 下面是**编排**：进在飞闸、重读一遍、先落库再派发。
   */

  /**
   * 惰性超时扫描（HITL）：读到一个已超时的 awaiting 任务 ⇒ 自动全拒 + 落库 + 重派。
   * 与 #redispatch 同一条纪律：**先落库再派发**（没落库就恢复，进程崩在窗口里会
   * 丢掉超时决定、把同一件事再判一次）。
   *
   * 重入闸（2026-09-20，见 spec §10 当日条）：与 `approve` **共用同一把** per-taskId
   * 闸（inflightApprovals）。异步 store 的 `get` 返回**新副本**且有网络往返 —— 两个
   * 并发 poll（或 poll 与 approve）各自看到 awaiting 快照 ⇒ 双双填超时拒绝 + 双双
   * `#execute`（同一任务跑两遍）。在飞即跳过：另一路径自己会兜底（#approveInner
   * 里也有 approvalExpired 判定，见 approval-policy.ts），决定逐 id 幂等（第一次决定赢）。
   * 反之 approve 撞上在飞的超时恢复时共享其结果 —— 与人的决定竞速，先到先得。
   */
  #expireAndResume(rec: TaskRecord, now: number): void {
    if (this.inflightApprovals.has(rec.taskId)) return;
    const run = this.#expireAndResumeInner(rec, now).finally(() => {
      this.inflightApprovals.delete(rec.taskId);
    });
    this.inflightApprovals.set(rec.taskId, run);
    // poll / resumePending 路径没有调用方接 reject —— 订阅掉，不得逃逸成 unhandled rejection
    run.catch(() => undefined);
  }

  async #expireAndResumeInner(rec: TaskRecord, now: number): Promise<TaskRecord> {
    // 进闸后**重读一遍**再判：闸只互斥「进入」，挡不住「进闸前已取到的旧副本」——
    // 本记录的快照可能是在另一次恢复落库**之前**取的（异步 store 的 get 有往返），
    // 凭陈旧快照放行会把同一任务再派发一次。
    const fresh = await this.store.get(rec.taskId);
    const target = fresh ?? rec;
    if (target.status !== 'suspended' || !approvalExpired(target, now, this.approvalTimeoutMs)) {
      return target;
    }
    fillTimeoutDenials(target, now);
    target.status = 'running';
    target.ownerId = this.ownerId;
    let saved: MaybePromise<void>;
    try {
      saved = this.store.save(target);
    } catch {
      return target; // 同步落库失败则不派发（与下一条异步分支同纪律：先落库再派发）
    }
    if (isThenable(saved)) {
      // 落库失败则不派发（认领没落地就派发 = 重新打开重复执行窗口）
      try {
        await saved;
      } catch {
        return target;
      }
    }
    // 离开挂起态（读数纪律②）—— 落在**落库成功之后**：落不了库就不算恢复（没派发，读数也不动）
    this.#unmarkSuspended(target.taskId);
    // 派发走唯一入口（闸在 #dispatch 里）。⚠️ **这一条正是外部深评抓到的第四条路径**：
    // `#expireAndResume`（审批超时自动全拒并恢复）与 `approve` 不同触发源、同一形状，
    // 由 `poll()` 的惰性闸驱动 —— 而「停机中照常可轮询」是 HTTP 宿主的明确承诺
    // （LB / K8s preStop / 前端轮询）⇒ 停机后照样能起新 run。
    this.#dispatch(target);
    return target;
  }

  /**
   * poll 的读路径钩子：两条**惰性**的挂起闸各判一次（都不起定时器 —— 没人读的挂起不会自己动，
   * 与审批超时同一条纪律；崩溃/重启也不依赖任何在飞回调）。
   *
   * 写成 `else if` 而不是两个独立的 `if`：两条闸的原因判据本来就互斥（`approval` / `timer`），
   * 排他在这里是**写出来的**而不是「两个函数各自恰好正确」—— C 之前正是「一个状态兼职两件事」
   * 让审批那条闸去叫醒了等时刻的 run。
   */
  #lazyGates(rec: TaskRecord | undefined): TaskRecord | undefined {
    if (!rec) return rec;
    const now = Date.now();
    if (approvalExpired(rec, now, this.approvalTimeoutMs)) this.#expireAndResume(rec, now);
    else if (timerDue(rec, now)) this.#wakeDue(rec, now);
    return rec;
  }

  /** 在飞的到期唤醒（同一任务的重入闸，理由与 inflightApprovals 同款：两条路径都「落库 + 派发」）。 */
  private readonly inflightWakes = new Map<string, Promise<TaskRecord>>();

  /**
   * 取消的**意图**（2026-09-28 ④）。落库状态按意图判、不从 signal 反推 ——
   * 同一条 signal 有三个来源（调用方传入 / `runTimeoutMs` / 取消），反推不出「谁按的」。
   * 只在一次 run 的收尾判定里活着：登记在认领处，摘除在同一次 run 的 finally。
   */
  readonly #cancels = new Set<string>();

  /** 在飞 run 的中止句柄（**每任务一个**，同时服务超时与取消 —— 机制相同、意图不同）。 */
  readonly #runAborts = new Map<string, AbortController>();

  /**
   * 已由 `cancel` **自己**收尾过的任务。那趟等槽位的 `#execute` 还活着，它的 finally 会再记一遍账
   * （onFinished 触发两次 / 流被关两次）—— 用这个集合把「谁负责记账」说定：cancel 收尾了，
   * finally 就只做它自己那份（在飞递减、通知等待者、排空通知）。
   */
  readonly #cancelSettled = new Set<string>();

  /**
   * 到期唤醒（durable timer）：读到一条**在睡且到点**的挂起 ⇒ 认领 + 重派，醒来后重跑那一批。
   *
   * 与 `#expireAndResume` 逐条同形（进在飞闸、重读一遍、先落库再派发），理由一字不差；
   * 三处不同，都写在下面：drain 之后不唤（配套 5）、不填任何决定（时间挂起没有待决项）、
   * 以及**返回值**（见下）。
   *
   * @returns 是否真的接管了这次唤醒 —— decline 时 `false`。`resumePending` 的返回值是
   * 「我推进了几条」，把没推进的算进去就是谎报（drain 之后每次扫描都报「唤醒了 N 条」，
   * 而它们一条都没动）。⚠️ 审批那条（`#expireAndResume`）的计数口径略宽（在飞也计入），
   * 那是既有行为、本批不动它。
   */
  #wakeDue(rec: TaskRecord, now: number): boolean {
    // 配套 5（drain 后不唤醒）：停机是「不再往前推」，与 submit 在 drain 后回 503 同一条纪律。
    // 不设这道闸，一条天级的 sleeping run 会在停机窗口里被叫起来接着跑 —— 部署卡在它身上。
    // （重启后由新进程的首次 resumePending 唤醒：那时停机窗口早过去了。）
    if (this.#drain.isDraining) return false;
    if (this.inflightWakes.has(rec.taskId)) return false;
    const run = this.#wakeDueInner(rec, now).finally(() => {
      this.inflightWakes.delete(rec.taskId);
    });
    this.inflightWakes.set(rec.taskId, run);
    // poll / resumePending 路径没有调用方接 reject —— 订阅掉，不得逃逸成 unhandled rejection
    run.catch(() => undefined);
    return true;
  }

  async #wakeDueInner(rec: TaskRecord, now: number): Promise<TaskRecord> {
    // 进闸后**重读一遍**再判（与 #expireAndResumeInner 同因）：闸只互斥「进入」，
    // 挡不住「进闸前已取到的旧副本」——异步 store 的 get 有往返，凭陈旧快照放行会重复派发。
    const fresh = await this.store.get(rec.taskId);
    const target = fresh ?? rec;
    if (!timerDue(target, now)) return target;
    target.status = 'running';
    target.ownerId = this.ownerId;
    let saved: MaybePromise<void>;
    try {
      saved = this.store.save(target);
    } catch {
      return target; // 同步落库失败则不派发（先落库再派发，见 #expireAndResumeInner）
    }
    if (isThenable(saved)) {
      try {
        await saved;
      } catch {
        return target;
      }
    }
    // 离开挂起态（读数纪律②）—— 落库成功之后才算醒来
    this.#unmarkSuspended(target.taskId);
    // 派发走唯一入口（闸在 #dispatch 里判一次 —— 它同时盖住「进入时」与「窗口里刚进入停机」
    // 两个时点，这里不必再判一遍）。
    this.#dispatch(target);
    return target;
  }

  /**
   * **唯一的派发口**（2026-09-28 外部深评 P1-1 / P2-1 的结构性修法）。
   *
   * 为什么要有它：所有「先把状态落库成 `running`/`queued`、再派发 `#execute`」的路径
   * （`submit` / `approve` / `signalTask` / 到期唤醒 / 审批超时兜底 / `resumePending` 的认领）
   * **形状相同**，而停机闸原先散在各支里 —— 于是「这道闸覆盖几条路径」变成一份**靠人记**的清单：
   * 第二批修了三支、第四支（审批超时兜底，走 `poll()`）与第五支（认领循环）漏了，两处都在
   * `drain()` 返回 `true`（「排空干净」）之后**又起了新 run**（实证：`drain-race.test.ts`）。
   *
   * 修法：闸**只在这里判一次**，各支只管「先落库」的顺序（那条纪律不变）。
   * 源码级穷尽守卫在 `tests/transport/dispatch-guard.test.ts`：`this.#execute(` 与
   * `this.#executeInner(` 都只许出现在自己的那一个家里 —— 第五次新增恢复路径时构建就红，
   * 不靠记性。（钉两个而不是一个：`#executeInner` 是同一个旁路的另一半，绕过它还会连带
   * 绕过 `active++` 与 `#streams.open`，见那份用例的注释。）
   *
   * 语义：停机窗口里**不派发**。记录已落库（`running`/`queued` + 本进程 ownerId），
   * 留给下次启动的 `resumePending` 认领（ownerId 含 pid ⇒ 新进程必认领）—— at-least-once 兜底，
   * 与「先落库再派发」的崩窗同形；决定 / 事件都在记录里，不丢。
   * ⚠️ 「留给下次启动」成立的前提是**宿主真的退出**（见 `drain()` 的契约：单向闩 + 本进程内
   * 无自愈路径）。所以这里的拒绝**不静默**：首次拒绝打一条 `console.warn` 说清「谁、什么状态、
   * 谁来认领、宿主该做什么」—— 否则运维只看到一个停在 `running` 的任务，无从解释。
   * ⚠️ 对调用方**不抛错**（`submit` 的「停机中不接单 ⇒ 503」在那之前的早返回里，不在这一层）。
   */
  #dispatch(rec: TaskRecord): void {
    if (this.#drain.isDraining) {
      // **不静默**（2026-09-28 PR #164 复核 §1）：这里的拒绝等于「本进程此后不再推进任何任务」，
      // 而它此前是一条裸 `return` —— 运维只会看到一个停在 `running` 的任务，无从解释它为什么不跑
      // （`drain()` 的契约见上：宿主此刻必须退出，记录留给下次启动认领）。
      // 只报一次：停机窗口里每条被拒记录各报一条会把日志刷满，而它们的原因完全相同。
      if (!this.#dispatchRefusedWarned) {
        this.#dispatchRefusedWarned = true;
        console.warn(
          `[agentia] 停机中：已拒绝派发 task ${rec.taskId}（记录已落库成 ${rec.status}）—— ` +
            '本进程此后不再推进任何任务，它留给下次启动的 resumePending 认领；' +
            '宿主必须在 drain() 之后退出，否则这条记录会一直停在 running（见 usage-guide §7）',
        );
      }
      return;
    }
    void this.#execute(rec);
  }

  /** 「停机窗口里拒绝派发」的告警是否已出过（每次停机只报一条，见 `#dispatch`） */
  #dispatchRefusedWarned = false;

  /**
   * 当前**真正在排队**的任务数（`maxQueued` 的实时读数，诊断用）—— 与闸用的是**同一个**
   * `#queueDepth`，所以「看到的数」就是「判据的数」，不会各说各话。
   * 与 `inFlight` 的分工：`inFlight` 是「本进程已受理、未达终态」的全量（含在跑、含挂起），
   * 本读数是其中「排不上、在等槽位」的那一段。
   */
  get queued(): number {
    return this.#queueDepth();
  }

  /** 任务终态唤醒与等待：实现见 task-waiters.ts（`notify` / `wait`） */
  /** 排空通知：只在确无在飞任务时唤醒等待者（drain 的唯一出口）—— 判定在 drain-gate.ts */
  #notifyDrained(): void {
    this.#drain.signalIdle(() => this.active === 0);
  }

  /** 等到任务终态；超时抛错。`suspended` 不是终态 —— 继续等（人在路上 / 时刻未到）。 */
  async awaitTask(
    taskId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TaskRecord> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // intervalMs 现在只是**兜底轮询**间隔，不是主路径：本进程把任务写到终态会主动唤醒
    // （见 task-waiters.ts 的 notify）。默认从 5ms 放宽到 250ms —— 旧实现每 5ms 读一次 store，
    // 等 30s 就是约 6000 次读（SQLite/Redis 下是 6000 次往返）。用异步 store 且终态由
    // **他进程**写入时唤不醒，才靠这个间隔兜底。
    const intervalMs = opts.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // 走 poll 而不是裸 store.get：惰性审批超时的判定挂在那里（HITL）
      const rec = await this.poll(taskId);
      if (!rec) throw new Error(`task 不存在: ${taskId}`);
      // ⚠️ 终态集合走 `isTerminalTask` 这个**单一真源**：手写枚举会让新加的终态（`cancelled`）
      // 在这里被漏掉 —— 表现为「取消了但 awaitTask 一直等到超时」，看起来像取消没生效
      if (isTerminalTask(rec)) return rec;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`task ${taskId} 等待超时（${rec.status}）`);
      await this.#taskWaiters.wait(taskId, Math.min(intervalMs, left));
    }
  }

  /**
   * 宿主重启续跑：把 store 里 queued | running 的记录重新派发执行
   * （running 视为进程中断）。返回重派数量（异步 store 下返回 Promise<number>）。
   * 幂等键去重照常生效。
   *
   * `suspended`（HITL）**不捡**：它在等人、不是孤儿（进程没死也可能挂着）。
   * 但读到它会做**惰性判定**，两条闸各管各的原因：
   * - `approval`：配了 `approvalTimeoutMs` 且已超时的挂起任务自动全拒
   *   （`denied, reason: '审批超时'`）并重派；
   * - `timer`：`wakeAt` 已到的睡着的任务**唤醒并重派**（醒来重跑那一批）。
   *   ⚠️ `drain()` 之后不唤醒（配套 5）：停机窗口里天级的 run 被叫起来接着跑 = 部署卡死。
   *
   * **认领先落库、再派发**（见 `#redispatch`）；异步 store 的认领落库失败会让本方法
   * reject —— 宁可让调用方看见「续跑没做」，也不要静默放出一批会被重复执行的任务。
   *
   * 多进程共用一个 store 时靠 `ownerId` 区分他我：
   * - 本进程的记录一律跳过（它还在本进程内存里跑，重派 = 跑两遍）；
   * - `staleAfterMs > 0` 时启动他进程判定：**同主机就问 pid 还在不在**（在的不抢、
   *   不在的立刻抢），问不到（异主机 / 旧格式 ownerId）才退回保鲜期启发式。
   *   缺省 0 = 不判断、一律重派（单进程旧语义）。判定分级与边界见 `resume-policy.ts`。
   */
  resumePending(opts: ResumePendingOptions = {}): number | Promise<number> {
    // 重入闸：**并发**调用共享同一次扫描的结果，而不是各自再扫一遍。
    //
    // 为什么必须（2026-09-18 补）：「先落库再派发」只堵住了**串行**重扫 —— 认领是异步的
    // （异步 store 的 `list()` 返回反序列化的**新对象**），两个并发调用都在任一 `save`
    // 落地前 `list()` 到旧快照，`ownerId === this.ownerId` 的过滤对两份旧快照**双双失效**
    // ⇒ 同一个任务被派发两次（`app.run` 重复执行，副作用与花费翻倍）。
    //
    // 语义：闸门期间返回**在飞那次的 Promise**（同一个数），而不是 0 —— 0 会谎称
    // 「没派发任何东西」，而实际上派发了。调用方拿到的始终是本次扫描的真实结果。
    if (this.inflightResume) return this.inflightResume;
    const listed = this.store.list();
    const staleAfterMs = opts.staleAfterMs ?? 0;
    // 到期索引（2026-09-28 ⑤ 落地）：store 实现了 `listDue` 时，「到期唤醒」那一半的
    // 输入走索引（只回到期的记录），否则回退全表过滤 —— 语义不变，只是扫描规模不同。
    // ⚠️ 它**只**替代那一半的输入：挂起读数重建 / 审批超时 / 孤儿认领的职责
    // 仍是全表 `list()`（它们要的不只是「到期的」），别把整个扫描的输入源换掉。
    const dueListed = this.store.listDue === undefined ? undefined : this.store.listDue(Date.now());
    if (isThenable(listed) || (dueListed !== undefined && isThenable(dueListed))) {
      const run = Promise.all([listed, dueListed])
        .then(([recs, due]) => this.#redispatch(recs, staleAfterMs, due))
        .finally(() => {
          this.inflightResume = null;
        });
      this.inflightResume = run;
      return run;
    }
    const dispatched = this.#redispatch(listed, staleAfterMs, dueListed);
    if (isThenable(dispatched)) {
      const run = Promise.resolve(dispatched).finally(() => {
        this.inflightResume = null;
      });
      this.inflightResume = run;
      return run;
    }
    return dispatched;
  }

  /**
   * 在飞的 `resumePending`（重入闸，见上）。不用 boolean 而用 Promise：
   * 重入方要拿到**同一次扫描**的结果，而不是一个「你等着」的空数。
   */
  private inflightResume: Promise<number> | null = null;

  /**
   * 重新派发前**必须**先把 `ownerId` 认领落库 —— 否则「认领」只是内存里的一个记号。
   *
   * 病灶：此前这里只改内存里的 `status`/`ownerId` 就 `void #execute(rec)`，真正的 save
   * 要等到 `#executeInner`（还在 `#acquireSlot` 之后）。对 sqlite/redis 这类 `list()`
   * 返回**反序列化新对象**的 store，这段窗口里再调一次 `resumePending()` 读到的仍是旧
   * ownerId，`:305` 的过滤失效 → 同一个任务被再派发一次 → `app.run` 重复执行，副作用
   * 与花费翻倍。`InMemoryTaskStore` 存的是对象引用，恰好掩盖了这个问题。
   *
   * 返回类型刻意保持 `number | Promise<number>`：同步 store 的 save 是同步的，认领当场
   * 落地，返回数字（`submit`/`list` 那套「同步 store 保持同步门面」的约定不变）；只有
   * 真出现 thenable 才升级成 Promise，等所有认领落库后再统一派发。
   */
  #redispatch(
    recs: TaskRecord[],
    staleAfterMs: number,
    due?: TaskRecord[] | undefined,
  ): number | Promise<number> {
    const now = Date.now();
    // 挂起读数的对齐（读数纪律③）：扫描本来就拿到了全表，顺手把 `/healthz` 的读数
    // 按 store 重建一遍 —— 于是「漏了某个除名出口」只是下一次扫描前的偏差，不会永久漂移。
    // 顺带把**他进程**（或本进程上一世）留下的挂起也算进本进程可见的那些（口径见
    // suspendedSummary 的注释：本进程看得见的记录，不假装是全局面）。
    this.#suspended.clear();
    for (const rec of recs) {
      if (rec.status !== 'suspended' || rec.suspendedReason === undefined) continue;
      this.#suspended.set(rec.taskId, { reason: rec.suspendedReason, wakeAt: rec.wakeAt });
    }
    // 惰性审批超时扫描（HITL）：suspended **不捡走续跑**（它在等人，不是
    // 孤儿 —— 崩溃续跑语义不适用于「等审批」），但读到它时顺手判超时：
    // 到点自动全拒并重派（框架补的 deny 决定先进 store，再进引擎）。
    let expired = 0;
    for (const rec of recs) {
      if (rec.status !== 'suspended' || !approvalExpired(rec, now, this.approvalTimeoutMs))
        continue;
      expired++;
      this.#expireAndResume(rec, now);
    }
    // 到期唤醒（durable timer）：在睡且到点的 timer 挂起 ⇒ 认领 + 重派（醒来重跑那一批）。
    // 与上面那条循环并列而不是合并：两条闸的**原因判据互斥**，各读各的一眼可见；
    // 合并成一个循环会让「谁的责任」藏进条件里。drain 之后不唤（#wakeDue 里那道闸）。
    // 输入（2026-09-28 ⑤）：store 提供到期索引时 `due` 是「只回到期的」那一半 ——
    // 仍过 `timerDue` 复核（索引口径是 status+wakeAt，原因那一半由这里兜，且
    // #wakeDueInner 进闸后还会重读再判一次）。
    let woken = 0;
    for (const rec of due ?? recs) {
      if (!timerDue(rec, now)) continue;
      // 只算**真接管**的那些（drain / 已在飞 ⇒ 不算）—— 返回值是「推进了几条」的承诺
      if (this.#wakeDue(rec, now)) woken++;
    }
    // 认领判定外移到 resume-policy.ts：跳过原因具名化（terminal / suspended / own-process /
    // owner-alive / too-fresh），每条规则与边界都由那份纯函数的单测钉住
    const alive = (id: string): boolean | undefined => this.#ownerLiveness(id);
    const pending = recs.filter(
      (r) =>
        resumeSkipReason(r, { ownerId: this.ownerId, staleAfterMs, now, ownerAlive: alive }) ===
        undefined,
    );

    const claims: Promise<void>[] = [];
    for (const rec of pending) {
      rec.status = 'queued'; // 重新入队，由 #execute 统一推进
      rec.ownerId = this.ownerId; // 认领：此后本进程的记录不再被（自己）重派
      const saved = this.store.save(rec);
      if (isThenable(saved)) {
        // 落库失败则**不派发**：认领没落地，派发等于把上面那个重复执行的窗口重新打开
        claims.push(Promise.resolve(saved).then(() => this.#dispatch(rec)));
      } else {
        // 派发走唯一入口（闸在 #dispatch 里）—— 外部深评 P2-1：认领循环以前绕过了那道闸。
        this.#dispatch(rec);
      }
    }
    if (claims.length === 0) return pending.length + expired + woken;
    return Promise.all(claims).then(() => pending.length + expired + woken);
  }

  /**
   * 「这条记录的主人还活着吗」—— 绑上本机主机名后的 pid 存活判定（见 `owner-liveness.ts`）。
   *
   * 只被 `#redispatch` 用，且只在 `staleAfterMs > 0` 时真正被问到（那道闸在 resume-policy
   * 里，单源；缺省 0 = 不看他进程，与升级前逐字一致）。判定不写库、不改状态 —— 纯读数。
   */
  #ownerLiveness(ownerId: string): boolean | undefined {
    return ownerAlive(ownerId, this.#host);
  }

  /**
   * 在飞计数包裹层：#executeInner 是状态机主体，这里只负责 active 计数与排空通知。
   * 计数在**同步段**（第一个 await 之前）自增 —— 所以 `void this.#execute(rec)` 一返回，
   * 该任务就已经计入了，drain 不会漏掉「刚 submit、还没开始跑」的任务。
   */
  async #execute(rec: TaskRecord): Promise<void> {
    // 同步认领（在任何 await 之前）：同键并发提交的第二个 submit 立刻能看见它。
    // 挂起（suspended）**不释放** —— 那是「等人工」，不是终态；放了会让同键再起一个新任务。
    const key = rec.idempotencyKey;
    if (key !== undefined && !this.#claims.has(key)) this.#claims.set(key, rec);
    // 同步开流（在任何 await 之前）：`GET /tasks/:id/stream` 从这一刻起可以订阅。
    // 复用语义见 task-events.ts —— HITL 恢复 / 崩溃重投是**同一个任务**，序号接着走。
    this.#streams.open(rec.taskId);
    // 「本进程已受理」的起点（同步段，与 #streams.open 同处）：cancel 的 409 文案据此
    // 区分「排队未起跑」与「真不在本进程」。终点是整个 #execute 退出的 finally。
    this.#executions.add(rec.taskId);
    this.active++;
    // **在等槽位**的入口（同步段，与 `active++` 同处）—— 只看 id，出集合在「拿到槽位」
    // 那一刻（`#executeInner`）与本节 finally 两处，`add`/`delete` 幂等所以两处都安全。
    // 同步段入集合是这道闸**挡得住同步突发**的前提：`#dispatch` 是 submit 的最后一行，
    // `void this.#execute(rec)` 的 body 到第一个 await 之前全同步 ⇒ 一个循环里连续 submit
    // 时，每次读到的都是已含前几条的**准确**读数。
    this.#waiting.add(rec.taskId);
    try {
      await this.#executeInner(rec);
    } finally {
      this.#waiting.delete(rec.taskId);
      // 通知在飞递减**之前**：drain() 返回时保证「任务已终态 + 回调已发完」。
      // 内层 finally 保证回调万一抛错（理论上被吞掉）也不泄漏在飞计数。
      try {
        // HITL：挂起不是终态 —— onFinished 的承诺是「任务达终态」，对它不开火。
        // 已由 `cancel` 自己收尾过的那一条也不开火（`#cancelSettled`）：两处都记会触发两次
        if (rec.status !== 'suspended' && !this.#cancelSettled.has(rec.taskId)) {
          await this.#notifySinks(rec);
        }
      } finally {
        this.active--;
        // 记账的归属：cancel 收尾过的那一份已经做过（流收口 / 会话清理 / 认领释放），
        // 这里只消费掉标记，不重复 —— 在飞递减、等待者、排空通知照旧必达
        if (!this.#cancelSettled.delete(rec.taskId)) {
          // 终态即清理 HITL 会话回写快照（挂起则保留 —— 恢复段成功后还要用它）
          if (rec.status !== 'suspended') this.sessionInputs.delete(rec.taskId);
          // 任务流收口（挂起不算终态 —— 见 isTerminalTask 的注释：批了会接着跑，流得开着）。
          if (isTerminalTask(rec)) this.#streams.markDone(rec.taskId);
          // 释放同键认领：**只有终态才释放**（挂起仍在等人，同键提交不该另起一个任务）。
          // 判据用 taskId 比对而非 `claimed`：HITL 的恢复段是**另一次** #execute 调用
          // （approve / 超时兜底 / 崩溃恢复都会重派，且异步 store 交出的常是新副本对象），
          // 那次 `claimed` 必为 false —— 只看 `claimed` 会让挂起过的键**永不释放**（认领表泄漏，
          // 同键从此永远命中那条老记录）。
          if (
            key !== undefined &&
            rec.status !== 'suspended' &&
            this.#claims.get(key)?.taskId === rec.taskId
          ) {
            this.#claims.delete(key);
          }
        }
        // 任务已达终态并落库 → 唤醒 awaitTask 的等待者（放在递减之后，语义与 drain 一致）。
        // 挂起也唤醒：等待者看一眼状态继续等（suspended 不是终态），无副作用。
        this.#taskWaiters.notify(rec.taskId);
        this.#notifyDrained();
        // 「本进程已受理」的终点（与 #execute 同寿）。删在最后：此前若 cancel 挤进来，
        // 它看到的仍是「本进程在推进这条」，文案不会突然改口。
        this.#executions.delete(rec.taskId);
      }
    }
  }

  /** 通知任务完成回调。逐个 await，**sink 抛错被吞** —— 回调失败不得影响任务状态。 */
  async #notifySinks(rec: TaskRecord): Promise<void> {
    if (this.taskSinks.length === 0) return;
    // 传快照：回调拿到的是「此刻的终态」，之后记录再被改动不会串进回调持有的引用
    const snapshot = { ...rec };
    for (const sink of this.taskSinks) {
      try {
        await sink.onFinished(snapshot);
      } catch {
        /* 回调失败不影响任务状态（同 trace sink / memory 回写的防护） */
      }
    }
  }

  async #executeInner(rec: TaskRecord): Promise<void> {
    // 顶层容错：异步 store（网络客户端）任何一处 reject 都不得逃逸成
    // unhandled rejection（Node ≥15 默认终止进程）——任务标记失败尽力落库。
    try {
      // 异步 store 的幂等去重在此补齐（submit 同步门面无法 await）：
      // 同键已有 succeeded 记录 → 采纳其结果，不重复执行；queued/running 不采纳 ——
      // 重复执行本就是 at-least-once 允许的行为。同步 store 下 submit 已完成去重，
      // 这里查到的一般是 rec 自身（taskId 相同，直接放行）。
      // 注意（load-bearing）：该去重依赖 store.save 先写记录、后写 idem 索引的顺序
      // （见 redisStore 头注释）——索引指向自身时上面的 taskId 相等判断放行。
      if (rec.idempotencyKey) {
        const existing = await this.store.byIdempotency(rec.idempotencyKey);
        if (existing && existing.taskId !== rec.taskId && existing.status === 'succeeded') {
          rec.status = 'succeeded';
          rec.runId = existing.runId;
          rec.result = existing.result;
          rec.error = existing.error;
          rec.finishedAt = Date.now();
          // 采纳既有结果：落库失败也不该把一次已知成功的任务翻成 failed
          await this.#safeSave(rec, 'outcome');
          return;
        }
      }

      // 「出排队段」必须与「占槽」落在**同一次同步执行**里：`await acquire()` 的连续体要等
      // 一次微任务，而 `acquire` 内部的 `running++` 是同步的 —— 同一条任务在那一瞬被算两遍
      // ⇒ 排队深度虚高一格（`concurrency: 1` + `maxQueued: 1` 下第 2 条合法提交被误拒）。
      // 所以：**有空位就趁 await 之前出集合**（判据是快照 —— 判断与 acquire 之间没有 await，
      // 池子状态不会变）；排队等到的那些，则在 acquire 兑现后出集合（同一个 delete，幂等）。
      // ⚠️ 刻意**不**把 acquire 换成同步快路径：那会顺带少掉一次微任务，把「置 running」
      // 相对引擎推进的时刻提前，踩到既有用例里「等到 running 就当工具已挂在飞」的隐含假设
      // （`tests/transport/cancel.test.ts` 的前置断言当场红）。记账改原子，时序一个字不改。
      if (this.#slots.inUse < this.concurrency) this.#waiting.delete(rec.taskId);
      await this.#slots.acquire();
      this.#waiting.delete(rec.taskId); // 拿到槽位 = 离开排队段（此后归 concurrency 管）
      try {
        // 认领前**重读一遍**再判（异步 store 交出的是副本：拿 submit 时那个对象判不出
        // 「排队期间被取消了没有」）——与 `#wakeDueInner` 的「进闸后重读」同因。
        // 不判的后果：cancel 只把状态改了，任务**照跑**（记录说 cancelled、副作用真发生 ——
        // 最坏的一种谎）。
        // ⚠️ 判据**只挡终态**，别写成 `!== 'queued'`：恢复那几条路（approve / 到期唤醒 /
        // 崩溃重投）都**先**把状态置成 `running` 再派发 —— 那样写会把它们全挡死，
        // 症状是「恢复了但任务没跑」（本实现第一版就是这么错的，transport 套件当场挂住）。
        // ⚠️ 读失败**不改变既有行为**：这道闸只负责「明知已终态就别跑」，不负责把
        // store 读取故障升级成「任务起不来」（停机窗口里 store 已 close 是既有场景，
        // 那条路径的行为由 scheduler 的用例钉着）。
        let claimed: TaskRecord | undefined;
        try {
          claimed = (await this.store.get(rec.taskId)) ?? rec;
        } catch {
          claimed = undefined;
        }
        if (claimed && isTerminalTask(claimed)) {
          // 与 store 对齐再返回：外层 finally 会拿 `rec` 落一次 outcome，
          // 不同步的话会用**陈旧副本**把取消覆盖回 queued（任务从此既不起跑也不终态）。
          // 记账（sinks / 事件流 / 认领释放 / 等待者）交给**还活着**的那次 #execute 的 finally
          // ——它正是此刻在等槽位的这一条。
          Object.assign(rec, claimed);
          return;
        }
        // 在飞句柄**先**登记（在任何 await 与状态写之前）：cancel 的中断窗口从这里闭合
        this.#runAborts.set(rec.taskId, new AbortController());
        rec.status = 'running';
        rec.startedAt = Date.now();
        await this.store.save(rec);

        // 取消意图在收尾判定里要用两次：正常出口（`#cancels.has`）与**异常出口**
        // （拒绝式认 signal 的宿主 —— abort 后 reject，包 fetch 类客户端的常见写法）。
        // ⚠️ 必须声明在 try **之外**：`let` 是块级作用域，写在 try 里 catch 看不到它。
        let cancelIntent = false;
        try {
          // 会话注入（C4 的异步通道）：sessionId 是可序列化的引用，store 实例由
          // runner 持有 —— 执行前在这里换成 RunAppOptions.session。resumed 记录
          // 绕过 submit 的入口检查，所以「带了 sessionId 却没配 sessionStore」
          // 在本路径也要响亮失败（不静默降级成「没有会话」）。
          if (rec.spec.options?.sessionId !== undefined && this.sessionStore === undefined) {
            throw new Error(
              `任务 ${rec.taskId} 带了 options.sessionId，但本 runner 未配 sessionStore`,
            );
          }
          // **续跑段**的判定（不只是 HITL：时间挂起醒来也是续跑）—— 决定会话注入、
          // 链路关联与会话回写三条口径的走向（见下）。判据**不能**只看 `approvals`：
          // timer 挂起醒来时没有任何决定（approvals 是空的），但 `rec.spec.messages` 同样是
          // 挂起段落库的**扩展历史**（末尾是含未决 tool_use 的 assistant）—— 那三条口径
          // 一字不差地适用（`suspendedSince` 是「这条记录挂起过」的痕迹：挂起时写、终态才清）。
          const isResume = rec.approvals !== undefined || rec.suspendedSince !== undefined;
          // runTimeoutMs 到点即 abort（对尊重 signal 的客户端是真中止）；与调用方
          // 可能传入的 signal 合成，任一触发都中止本次 run。
          // 每任务**一个** controller，同时服务超时与取消（机制是同一条 signal，差别在意图）：
          // 它在认领处就登记进了 #runAborts，所以 cancel 找得到它
          const runAc = this.#runAborts.get(rec.taskId) ?? new AbortController();
          this.#runAborts.set(rec.taskId, runAc);
          const combined = combineSignals(rec.spec.options?.signal, runAc.signal);
          // 记账事件 → 本任务的流（`GET /tasks/:id/stream` 的数据源）。
          // 与任务 spec 里可能自带的那个**叠加**而不是覆盖（composeTraceEvents 的同一份理由）：
          // 两边都要收到 —— 覆盖会让其中一条静默失聪。
          const bridgeTraceEvents = composeTraceEvents(
            (e) => this.#streams.push(rec.taskId, e),
            rec.spec.options?.onTraceEvent,
          );
          const callOpts: RunInvocationOptions & {
            session?: { store: NonNullable<AsyncRunnerOptions['sessionStore']>; id: string };
          } = {
            ...(rec.spec.options ?? {}),
            // HITL 恢复段**不注入 session**（2026-09-20，spec §10 当日条）：恢复段的
            // rec.spec.messages 是挂起段落库的 suspendedMessages —— 已含 loadSession
            // 拼入的完整会话历史，再注入会让 run 层把 store 历史**再 prepend 一遍**
            // （历史翻倍、token 复利）；且成功后 appendSession 会把整段扩展历史
            // （含未决 tool_use 的 assistant）写进会话 —— 违反「只存对话轮次」不变量，
            // 留下孤立 tool_use + 连续两条 assistant，下一轮该会话直接撞 API 400。
            // 恢复段的会话回写由本类在成功后补写（见 #appendResumedSession）。
            ...(!isResume &&
            rec.spec.options?.sessionId !== undefined &&
            this.sessionStore !== undefined
              ? { session: { store: this.sessionStore, id: rec.spec.options.sessionId } }
              : {}),
            // 显式 undefined ≠ 不传（exactOptionalPropertyTypes）：无幂等键时不落这个键
            ...(rec.idempotencyKey !== undefined ? { idempotencyKey: rec.idempotencyKey } : {}),
            ...(rec.spec.options?.client !== undefined
              ? { client: rec.spec.options.client }
              : this.client !== undefined
                ? { client: this.client }
                : {}),
            // HITL 恢复段：审批决定随任务落库，重跑时原样进引擎（进程重启不丢）
            ...(rec.approvals !== undefined ? { approvals: rec.approvals } : {}),
            // 事件投入口（2026-09-28 ⑥）：挂起期间投递的事件随记录进引擎，由它在
            // 未决 tool_use 解决之后注入消息流（为什么不能由宿主直接追加进
            // spec.messages 的末尾：见 signalTask 与 engine/loop.ts 的注入点纪律）
            ...(rec.pendingEvents !== undefined && rec.pendingEvents.length > 0
              ? { events: rec.pendingEvents }
              : {}),
            // 恢复段的 trace 是一棵**新树**，经 traceContext link 挂到上一段 runId
            // （spec §9.2 的入站关联机制）——「挂起段 → 恢复段 → …」在观测后端连成一条链。
            // 判定依据：本段是续跑段（isResume）且已有上一段 runId；首次执行两者皆无。
            ...(isResume && rec.runId !== undefined
              ? { traceContext: { traceId: rec.runId } }
              : {}),
            rethrow: false, // 硬失败也以 failed 记录落库
            signal: combined,
            // 记账事件 → 本任务的流（见上面 bridgeTraceEvents 的注释）
            ...(bridgeTraceEvents !== undefined ? { onTraceEvent: bridgeTraceEvents } : {}),
          };
          try {
            const out = await this.#raceTimeout(
              this.app.run(rec.spec.messages, callOpts),
              rec.taskId,
              () => runAc.abort(),
            );
            rec.runId = out.run.runId;
            rec.result = out.result;
            rec.error = out.result.error;
            if (out.result.stopReason === 'suspended' && out.result.suspendedMessages) {
              // HITL 挂起：扩展后的消息历史（末尾是含未决 tool_use 的 assistant 消息）
              // 与待决清单、挂起时刻一起落库 —— approve / 惰性超时 / 重启后都靠它们。
              // 槽位照常释放（finally）、onFinished 不触发（#execute 的出口判断）、
              // finishedAt 不置（下面 finally 里按状态跳过）：它不是终态。
              rec.status = 'suspended';
              // 「本轮用户输入」快照必须在 overwrite **之前**取 —— 此刻 rec.spec.messages
              // 还是原始输入；恢复段成功后由 #appendResumedSession 拿它 + finalText 补写会话。
              // 只在首个挂起段快照（!isResume）：恢复段再挂起时 spec.messages 已是
              // 扩展历史（含会话前缀），拿它当「用户输入」就错了 —— 原快照仍在，不能丢。
              if (
                !isResume &&
                rec.spec.options?.sessionId !== undefined &&
                this.sessionStore !== undefined
              ) {
                this.sessionInputs.set(rec.taskId, rec.spec.messages);
              }
              rec.spec = { ...rec.spec, messages: out.result.suspendedMessages };
              rec.pendingApprovals = out.result.pendingApprovals;
              rec.suspendedSince = Date.now();
              // 挂起原因（2026-09-28 ①）：从结果形状里取，**不写死** ——
              // 写死成 'approval' 会让将来新增的挂起原因在落库这一步被悄悄改写成审批。
              rec.suspendedReason = out.result.suspendedReason;
              // 目标时刻（时间挂起才有）—— 同上，从结果形状里取，不按原因反推
              rec.wakeAt = out.result.wakeAt;
              // 挂起读数（纪律①）：与落库**同一个分支**登记，不另起一处判断
              this.#markSuspended(rec);
              // 事件簿记（2026-09-28 ⑥ 复审收口）：**注入过**就清 —— 事件已在挂起历史里
              // （suspendedMessages 含注入的 user 消息），簿记留着会让下次续跑**重复注入**
              // （真探针实证过：模型看到同一事件两次）。没注入（续跑入口的再挂起出口在
              // 注入点之前返回）则必须留住 —— 清掉就是丢事件。判据是结果上的
              // `eventsDelivered` 位，不是「是不是挂起」这个粗粒度。
              if (out.result.eventsDelivered) rec.pendingEvents = undefined;
            } else {
              // 取消：机制与 `runTimeoutMs` 一字不差（同一条 abort signal），**意图**不同 ——
              // 状态按意图落（超时 = failed、人取消 = cancelled）。意图从 `#cancels` 取，
              // 不从 signal 反推：同一条 signal 有三个来源（调用方 / 超时 / 取消）。
              const cancelled = this.#cancels.has(rec.taskId);
              rec.status = cancelled ? 'cancelled' : out.run.status;
              // 取消必须带**结构化原因**（「取消不是失败，但原因要可查」）：宿主自定义的
              // AppCallable 若不认 signal，它照旧返回一个正常结果 ⇒ `result.error` 是空的，
              // 那时记录里也得说清「这条是被取消的」（与超时那条的账一类）。
              if (cancelled && rec.error === undefined) rec.error = abortedError();
              // 终态后清掉挂起痕迹（决定保留：审批记录是审计的一部分，随任务走）
              rec.pendingApprovals = undefined;
              rec.suspendedSince = undefined;
              rec.suspendedReason = undefined;
              rec.wakeAt = undefined;
              // 事件簿记（2026-09-28 ⑥）：**终态没有第二次机会** —— 这条记录不会再被续跑，
              // 事件留着也没有注入点，清掉。
              // ⚠️ 判据与挂起分支**刻意不同**（复审第二轮把这里的注释改成真话，原先写的是
              // 「跑通到非挂起出口 ⇒ 引擎已把它们注入消息流」—— 那句在注入点**之前**就被
              // 中止/失败的出口上不成立）：挂起分支按 `eventsDelivered` 判（注入过才清、
              // 没注入要留 —— 下次续跑补上），这里无条件清。
              // 于是「恢复段在注入之前就 abort（取消 / runTimeoutMs）或整段失败」的那些终态，
              // 其事件**不会**进历史 —— 既成事实，不假装「已注入」；发件方从记录的终态与
              // error 看得到这条 run 的下场（要重试就重新提交一次：事件不跨终态重放）。
              rec.pendingEvents = undefined;
              // 离开挂起态（读数纪律②）：两处恢复路径负责「还没跑到终态」的那一半，
              // 这一支负责「跑到了终态」的那一半（兜底：恢复失败也会落到这里）
              this.#unmarkSuspended(rec.taskId);
              // HITL 恢复段 + 会话：本段没把 session 交给 run 层（见上面 callOpts 注释），
              // 会话回写由 runner 自己补 —— 口径与 run.ts 的 appendSession 一致。
              if (isResume && out.run.status === 'succeeded') {
                await this.#appendResumedSession(rec, out.result.finalText);
              }
            }
          } finally {
            // 正常收尾（没有源中止）时主动摘除挂在各源上的监听器 —— 宿主级共享
            // signal 是长寿的，不摘会按任务数累积（MaxListenersExceededWarning）
            releaseCombinedSignal(combined);
            // 在飞句柄与取消意图一起摘掉：意图只在**这次 run** 的收尾判定里有用（见下面那处）。
            // ⚠️ 意图的取值要留给 catch（`Set.delete` 返回布尔）：拒绝式认 signal 的宿主
            // 走的就是 catch —— 在这里丢掉意图，取消就会被记成 failed（正是要治的病）。
            this.#runAborts.delete(rec.taskId);
            cancelIntent = this.#cancels.delete(rec.taskId);
          }
        } catch (e) {
          // 意图先到 ⇒ cancelled（与「结果说成功、取消先到」同一条「意图赢」规则）——
          // 覆盖「abort 后 reject」的宿主路径；无意图的异常照旧是 failed。
          if (cancelIntent) {
            rec.status = 'cancelled';
            rec.error = abortedError();
          } else {
            rec.error = classifyError(e);
            rec.status = 'failed';
          }
        }
      } finally {
        // HITL：挂起不是「完成」—— finishedAt 不置（等待中的任务没有结束时刻）
        if (rec.status !== 'suspended') rec.finishedAt = Date.now();
        // 落库失败不遮罩、槽位必须释放：释放放在内层 finally，即便落库实现抛错也必达
        try {
          await this.#safeSave(rec, 'outcome');
        } finally {
          this.#slots.release();
        }
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = classifyError(e);
      rec.finishedAt = Date.now();
      await this.#safeSave(rec, 'outcome');
      console.error(`[agentia] task ${rec.taskId} 执行异常:`, e);
    }
  }

  /**
   * 尽力落库：**先包成 Promise 再挂 catch**。
   *
   * 同步 store（FileTaskStore 的 writeFileSync、node:sqlite）的 save 是**同步抛错**的。
   * 若写成 `Promise.resolve(this.store.save(rec)).catch(...)`，`this.store.save(rec)`
   * 会在 `Promise.resolve` 之前求值并同步抛出 —— 异常逃出 finally（跳过 #releaseSlot，
   * 并发槽位永久泄漏），再被外层 catch 里同一写法抛第二次，最终逃出 #execute 变成
   * unhandled rejection（Node ≥15 默认终止宿主进程）。
   */
  async #safeSave(rec: TaskRecord, phase: PersistFailureInfo['phase']): Promise<void> {
    try {
      await Promise.resolve().then(() => this.store.save(rec));
    } catch (error) {
      // 落库失败不遮罩主流程：任务结果仍在内存记录里可见。
      // 但它**必须有人能收到** —— 宿主无法自己发现这件事（见 onPersistError 的注释）。
      if (this.onPersistError) {
        try {
          // 传快照（与 #notifySinks 同纪律）：回调拿到的是「此刻的记录」，之后记录
          // 再被推进不会串进回调持有的引用（引用语义 store 下，活引用 = 回调能改写库里的记录）
          this.onPersistError({ record: { ...rec }, error, phase });
        } catch {
          /* 观测是辅助动作：回调抛错不得影响 run（与 onUnpricedModel 同口径） */
        }
      }
    }
  }

  /**
   * 超时竞速（runTimeoutMs > 0 时）：超时先 `onTimeout()`（abort 在飞请求）再 reject
   * → 任务按 failed 落库、槽位回收。尊重 signal 的客户端会被真中止；不尊重者只是
   * 停止等待（race 已订阅该 Promise，其后续 reject 不会变成 unhandled rejection）。
   * timer 必须 clear（否则每次任务都留一个定时器）。
   */
  async #raceTimeout<T>(p: Promise<T>, taskId: string, onTimeout?: () => void): Promise<T> {
    if (this.runTimeoutMs <= 0) return p;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            // TimeoutError（code='timeout'）：classifyError 归 `timeout` 一类账 ——
            // 与引擎工具超时 / MCP 桥兜底同口径（spec §10 2026-09-17 ②「超时自成一类」）。
            // 此前这里是裸 Error → 落 unknown，同一件事在异步宿主这条路径上记成另一本账。
            reject(new TimeoutError(`task ${taskId} 执行超时（${this.runTimeoutMs}ms）`));
          }, this.runTimeoutMs);
          // ⚠️ 不 unref：这个 reject 是 `awaitTask` / 调用方 await 的终点（spec §10 ④）。
          // 见 `tests/timeoutLiveness.test.ts`。
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * HITL 恢复段的会话回写（run 层 `appendSession` 的替身 —— 恢复段刻意不注入 session，
   * 见 #executeInner 的 callOpts 注释）。同 run.ts 的三条不变量：只在成功路径调用、
   * 只写「本轮用户输入 + 最终回复」（run 内部 tool 往返不进历史）、历史以 assistant
   * 结尾（无文本补占位）。回写失败吞掉 —— 辅助动作不得击穿任务（同 memory 回写防护）。
   *
   * 无快照（进程在挂起期间重启过）时**跳过**：宁可少一轮历史，也不凭猜测写。
   */
  async #appendResumedSession(rec: TaskRecord, finalText: string): Promise<void> {
    const sessionId = rec.spec.options?.sessionId;
    const input = this.sessionInputs.get(rec.taskId);
    if (sessionId === undefined || this.sessionStore === undefined || input === undefined) return;
    try {
      await this.sessionStore.append(sessionId, [
        ...input,
        // 占位文案与 runtime/run.ts 的 EMPTY_REPLY_MARK 保持同文（同一条会话不变量）
        { role: 'assistant', content: finalText || '（本次无文本输出）' },
      ]);
    } catch {
      /* 辅助动作失败不影响任务 */
    }
  }
}
