import { randomUUID } from 'node:crypto';
import type { MessageParam } from '../core/message.js';
import type { ModelClient } from '../core/tool.js';
import type { AgentRunResult } from '../engine/types.js';
import { classifyError } from '../engine/errors.js';
import type { RunStatus } from '../core/run.js';
import { normalizeMessages, TaskInputError } from '../engine/spec.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import { InMemoryTaskStore, isThenable, nextTaskId } from '../store/store.js';
import type { MaybePromise, TaskRecord, TaskStore } from '../store/store.js';
import { combineSignals, releaseCombinedSignal } from '../core/abort.js';
import { TimeoutError } from '../core/timeout.js';

/**
 * Agentia —— 异步任务宿主（spec §6.3 异步 / §6.5 确定性 / §6.6 换宿主不换语义）。
 *
 * - submit 即回（queued），后台驱动状态机 queued → running → succeeded/failed；
 *   工具标了 `approval: 'required'` 时 run 可在回合间挂起为 **awaiting_approval**
 *   （HITL：非终态、不占并发槽、不触发 TaskSink.onFinished），`approve()` 给齐决定后恢复；
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

/** `approve` 的入参：一批 tool_use_id → 批准/拒绝（理由可选） */
export type ApprovalDecisions = Record<string, { approved: boolean; reason?: string }>;

/**
 * `approve` 的失败：带 HTTP 语义的状态码（404 = 任务不存在，409 = 任务当前不在
 * `awaiting_approval` 状态），HTTP 宿主据此回对应响应。
 * module 级 export —— 不进公共导出面（纯宿主内部实现细节）。
 */
export class TaskApproveError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'TaskApproveError';
    this.status = status;
  }
}

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
  /** 任务完成回调（进程内）；见 TaskSink */
  taskSinks?: TaskSink[];
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
   * `awaiting_approval` 任务时，若它挂起已超过该值，框架自动把**全部待决项**写成
   * 「denied，reason: '审批超时'」并恢复执行（模型收到拒绝理由，可自行换路）。
   * 也就是说超时只在「有人读它」时生效 —— 没人读的任务不会自己动（进程里不养定时器，
   * 崩溃/重启也不依赖任何在飞回调）。
   */
  approvalTimeoutMs?: number;
}

/** resumePending 的启动扫描选项 */
export interface ResumePendingOptions {
  /**
   * 他进程任务的「保鲜期」（毫秒）；缺省 0 = 不判断，一律重派（重启即续跑）。
   * > 0 时跳过 startedAt/createdAt 距今不足该值的他进程记录 —— 那些任务大概
   * 正在别的进程里跑着，抢过来会重复执行。0 适合单进程部署（旧语义）。
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
  /** 本进程标识：写进认领的 TaskRecord.ownerId，供 resumePending 区分他我 */
  readonly ownerId: string;
  private readonly client: ModelClient | undefined;
  private readonly sessionStore: AsyncRunnerOptions['sessionStore'];
  private readonly concurrency: number;
  private readonly runTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private running = 0;
  private readonly waitQueue: Array<() => void> = [];
  /** 已受理但未达终态的任务数（queued + running）—— /healthz 与 drain 共用 */
  private active = 0;
  private draining = false;
  private readonly drainWaiters: Array<() => void> = [];
  /** 任务终态唤醒表：taskId → 等待者。仅覆盖**本进程**写终态（他进程写靠兜底轮询） */
  readonly #taskWaiters = new Map<string, Array<() => void>>();
  private readonly taskSinks: TaskSink[];
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
    this.concurrency = opts.concurrency ?? Number.POSITIVE_INFINITY;
    if (!(this.concurrency > 0)) {
      throw new Error(`concurrency 必须为正数，收到 ${opts.concurrency}`);
    }
    this.runTimeoutMs = opts.runTimeoutMs ?? 0;
    if (!Number.isFinite(this.runTimeoutMs) || this.runTimeoutMs < 0) {
      // NaN/Infinity 都不能放给 setTimeout：两者都会被钳到 1ms，每个任务立即「超时」失败
      // （且 NaN 会绕过 `< 0` 检查静默通过）。要「不限」请传 0（缺省）。
      throw new Error(`runTimeoutMs 必须为 ≥ 0 的有限数（0 = 不限），收到 ${opts.runTimeoutMs}`);
    }
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0;
    if (!Number.isFinite(this.approvalTimeoutMs) || this.approvalTimeoutMs < 0) {
      // 同 runTimeoutMs：非有限数会让「已挂起多久」的比较静默失效或立即超时
      throw new Error(
        `approvalTimeoutMs 必须为 ≥ 0 的有限数（0 = 不限），收到 ${opts.approvalTimeoutMs}`,
      );
    }
    this.ownerId = `p${process.pid}-${randomUUID().slice(0, 8)}`;
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
    if (this.draining) {
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
      const existing = this.store.byIdempotency(opts.idempotencyKey);
      if (isThenable(existing)) {
        // 异步 store 返回 Promise —— 同步门面无法 await，去重交给 #execute。
        // 但**必须订阅它**：byIdempotency 的 reject（Redis 抖动等）若无人处理就是
        // unhandledRejection（Node ≥15 默认终止宿主进程）。这里只做「查不到既有记录」
        // 处理，拒绝即视为无记录，交 #execute 的去重兜底。
        existing.catch(() => undefined);
      } else if (existing && existing.status !== 'failed') {
        return { ...existing }; // at-least-once 去重：不重复执行
      }
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
        void this.#safeSave(rec);
      });
    }
    void this.#execute(rec);
    // 返回浅拷贝：记录会被后台状态机原地推进，调用方拿到的是提交时刻的快照
    return { ...rec };
  }

  /** 查任务当前记录（异步 store 下返回 Promise，调用方 await） */
  poll(taskId: string): MaybePromise<TaskRecord | undefined> {
    const rec = this.store.get(taskId);
    // 惰性审批超时（HITL）：读到 awaiting 记录时顺手判定 —— 到点就自动全拒并重派
    if (isThenable(rec)) return rec.then((r) => this.#lazyExpireApproval(r));
    return this.#lazyExpireApproval(rec);
  }

  byIdempotency(key: string): MaybePromise<TaskRecord | undefined> {
    return this.store.byIdempotency(key);
  }

  list(): MaybePromise<TaskRecord[]> {
    return this.store.list();
  }

  /**
   * 审批一个处于 `awaiting_approval` 的任务（HITL）。
   *
   * - **逐 tool_use_id 幂等**：已存在的决定不覆盖（第一次决定赢）—— 重复提交 /
   *   并发点击不会推翻已有决定，也不会让恢复段重复执行；
   * - **并发重入共享在飞那次**：同一任务的并发 approve（双击「批准」/两个审批人
   *   同时批）返回同一个 Promise —— 否则两个调用都在对方落库前读到
   *   `awaiting_approval`、各自判「决定齐了」、**各派发一次**（同一任务重复执行，
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
    if (rec.status !== 'awaiting_approval') {
      throw new TaskApproveError(
        409,
        `task ${taskId} 当前状态为 ${rec.status}，只有 awaiting_approval 才能审批`,
      );
    }
    const now = Date.now();
    rec.approvals ??= {};
    for (const [id, d] of Object.entries(decisions)) {
      if (rec.approvals[id]) continue; // 逐 id 幂等：第一次决定赢
      rec.approvals[id] = {
        approved: d.approved,
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
        ...(opts.decidedBy !== undefined ? { decidedBy: opts.decidedBy } : {}),
        decidedAt: now,
        ...(rec.approvalPendingSince !== undefined
          ? { requestedAt: rec.approvalPendingSince }
          : {}),
      };
    }
    // 惰性审批超时：人的决定先并入（先到先赢），仍空着的待决项由超时兜底成 deny
    if (this.#approvalExpired(rec, now)) this.#fillTimeoutDenials(rec, now);
    const complete = (rec.pendingApprovals ?? []).every((id) => rec.approvals?.[id] !== undefined);
    if (complete) {
      rec.status = 'running'; // 由 #executeInner 接管（acquireSlot → 恢复执行）
      rec.ownerId = this.ownerId;
    }
    // 先落库再派发 —— **真纪律，不是注释**：save 失败（同步抛 / 异步 reject）就
    // 绝不恢复执行（落不了库的决定不算决定：进程崩在窗口里会丢决定，重启后把
    // 同一件事再判一次、可能改判）。调用方拿到 reject，重试即可。
    await this.store.save(rec);
    if (complete) void this.#execute(rec);
    return { ...rec };
  }

  /** 已受理但未达终态的任务数（queued + running）—— 健康检查与 drain 共用同一口径 */
  get inFlight(): number {
    return this.active;
  }

  /** 是否已进入优雅停机（drain 之后为 true）—— HTTP 宿主据此对新单回 503 */
  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * 优雅停机：停止接单（此后 `submit` 抛错），等待已受理任务排空（或超时）。
   *
   * 返回是否排空干净：超时仍返回 `false`，**未完成的任务留在 store 里**，下次启动由
   * `resumePending` 续跑（所以 drain 不是「丢弃」，是「不再往前推」）。
   * - `timeoutMs` 缺省 0 = 一直等。
   * - 等待的是**所有已受理**的任务（queued 的也在内），不只是正在占槽位的那些。
   */
  async drain(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    this.draining = true;
    const timeoutMs = opts.timeoutMs ?? 0;
    if (this.active === 0) return true;
    const drained = new Promise<boolean>((resolve) => this.drainWaiters.push(() => resolve(true)));
    if (timeoutMs <= 0) return drained;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        drained,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          // ⚠️ 不 unref：`drain()` 返回的正是这个 false —— 计时器的触发就是「调用方的 await 得以结束」
          // 的条件。unref 过它 ⇒ 空事件循环下进程先退出，停机等待没有任何结论
          // （见 `tests/timeoutLiveness.test.ts` 与 spec §10 ④）。
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 审批超时判定（HITL，**惰性**：不起定时器，只在 approve / poll / resumePending
   * 读到 awaiting 记录时判）。基准是 `approvalPendingSince`（挂起时刻，挂起时落库）；
   * 缺失时按 startedAt → createdAt 退化（容忍手工塞进来的记录）。
   */
  #approvalExpired(rec: TaskRecord, now: number): boolean {
    return (
      this.approvalTimeoutMs > 0 &&
      rec.status === 'awaiting_approval' &&
      now - (rec.approvalPendingSince ?? rec.startedAt ?? rec.createdAt) > this.approvalTimeoutMs
    );
  }

  /**
   * 超时自动拒绝：**仍空着的**待决项补上 deny（已有人工决定的不覆盖 —— 第一次决定赢）。
   * 决定写到 `rec.approvals`，由调用方负责落库与重派。
   */
  #fillTimeoutDenials(rec: TaskRecord, now: number): void {
    rec.approvals ??= {};
    for (const id of rec.pendingApprovals ?? []) {
      if (rec.approvals[id]) continue;
      rec.approvals[id] = {
        approved: false,
        reason: '审批超时',
        decidedBy: 'system',
        decidedAt: now,
        ...(rec.approvalPendingSince !== undefined
          ? { requestedAt: rec.approvalPendingSince }
          : {}),
      };
    }
  }

  /**
   * 惰性超时扫描（HITL）：读到一个已超时的 awaiting 任务 ⇒ 自动全拒 + 落库 + 重派。
   * 与 #redispatch 同一条纪律：**先落库再派发**（没落库就恢复，进程崩在窗口里会
   * 丢掉超时决定、把同一件事再判一次）。
   *
   * 重入闸（2026-09-20，见 spec §10 当日条）：与 `approve` **共用同一把** per-taskId
   * 闸（inflightApprovals）。异步 store 的 `get` 返回**新副本**且有网络往返 —— 两个
   * 并发 poll（或 poll 与 approve）各自看到 awaiting 快照 ⇒ 双双填超时拒绝 + 双双
   * `#execute`（同一任务跑两遍）。在飞即跳过：另一路径自己会兜底（#approveInner
   * 里也有 #approvalExpired 判定），决定逐 id 幂等（第一次决定赢）。
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
    if (target.status !== 'awaiting_approval' || !this.#approvalExpired(target, now)) {
      return target;
    }
    this.#fillTimeoutDenials(target, now);
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
    void this.#execute(target);
    return target;
  }

  /** poll 的读路径钩子：读到 awaiting 且已超时 ⇒ 惰性判掉（见 #approvalExpired） */
  #lazyExpireApproval(rec: TaskRecord | undefined): TaskRecord | undefined {
    if (!rec) return rec;
    const now = Date.now();
    if (this.#approvalExpired(rec, now)) this.#expireAndResume(rec, now);
    return rec;
  }

  /** 任务终态唤醒：在 #execute 的统一出口调用，覆盖成功 / 失败 / 采纳既有结果各路径 */
  #notifyTaskDone(taskId: string): void {
    const waiters = this.#taskWaiters.get(taskId);
    if (!waiters || waiters.length === 0) return;
    this.#taskWaiters.delete(taskId);
    for (const w of waiters) w();
  }

  /** 等「本进程把该任务写到终态」或被 timeoutMs 兜底唤醒（二者先到先返回） */
  #waitTaskDone(taskId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.#taskWaiters.get(taskId);
        if (waiters) {
          const i = waiters.indexOf(finish);
          if (i >= 0) waiters.splice(i, 1);
          if (waiters.length === 0) this.#taskWaiters.delete(taskId);
        }
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const waiters = this.#taskWaiters.get(taskId);
      if (waiters) waiters.push(finish);
      else this.#taskWaiters.set(taskId, [finish]);
    });
  }

  /** 排空通知：只在确无在飞任务时唤醒等待者（drain 的唯一出口） */
  #notifyDrained(): void {
    if (this.active !== 0 || this.drainWaiters.length === 0) return;
    const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
    for (const w of waiters) w();
  }

  /** 等到任务终态；超时抛错。`awaiting_approval` 不是终态 —— 继续等（人在路上）。 */
  async awaitTask(
    taskId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TaskRecord> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // intervalMs 现在只是**兜底轮询**间隔，不是主路径：本进程把任务写到终态会主动唤醒
    // （见 #notifyTaskDone）。默认从 5ms 放宽到 250ms —— 旧实现每 5ms 读一次 store，
    // 等 30s 就是约 6000 次读（SQLite/Redis 下是 6000 次往返）。用异步 store 且终态由
    // **他进程**写入时唤不醒，才靠这个间隔兜底。
    const intervalMs = opts.intervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // 走 poll 而不是裸 store.get：惰性审批超时的判定挂在那里（HITL）
      const rec = await this.poll(taskId);
      if (!rec) throw new Error(`task 不存在: ${taskId}`);
      if (rec.status === 'succeeded' || rec.status === 'failed') return rec;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`task ${taskId} 等待超时（${rec.status}）`);
      await this.#waitTaskDone(taskId, Math.min(intervalMs, left));
    }
  }

  /**
   * 宿主重启续跑：把 store 里 queued | running 的记录重新派发执行
   * （running 视为进程中断）。返回重派数量（异步 store 下返回 Promise<number>）。
   * 幂等键去重照常生效。
   *
   * `awaiting_approval`（HITL）**不捡**：它在等人、不是孤儿（进程没死也可能挂着）。
   * 但读到它会做**惰性超时判定**：配了 `approvalTimeoutMs` 且已超时的挂起任务
   * 自动全拒（`denied, reason: '审批超时'`）并重派。
   *
   * **认领先落库、再派发**（见 `#redispatch`）；异步 store 的认领落库失败会让本方法
   * reject —— 宁可让调用方看见「续跑没做」，也不要静默放出一批会被重复执行的任务。
   *
   * 多进程共用一个 store 时靠 `ownerId` 区分他我：
   * - 本进程的记录一律跳过（它还在本进程内存里跑，重派 = 跑两遍）；
   * - `staleAfterMs > 0` 时，startedAt/createdAt 距今不足该值的他进程记录也跳过
   *   （大概正被那个进程执行）。缺省 0 = 不判断、一律重派（单进程旧语义）。
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
    if (isThenable(listed)) {
      const run = Promise.resolve(listed)
        .then((recs) => this.#redispatch(recs, staleAfterMs))
        .finally(() => {
          this.inflightResume = null;
        });
      this.inflightResume = run;
      return run;
    }
    const dispatched = this.#redispatch(listed, staleAfterMs);
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
  #redispatch(recs: TaskRecord[], staleAfterMs: number): number | Promise<number> {
    const now = Date.now();
    // 惰性审批超时扫描（HITL）：awaiting_approval **不捡走续跑**（它在等人，不是
    // 孤儿 —— 崩溃续跑语义不适用于「等审批」），但读到它时顺手判超时：
    // 到点自动全拒并重派（框架补的 deny 决定先进 store，再进引擎）。
    let expired = 0;
    for (const rec of recs) {
      if (rec.status !== 'awaiting_approval' || !this.#approvalExpired(rec, now)) continue;
      expired++;
      this.#expireAndResume(rec, now);
    }
    const pending = recs.filter((r) => {
      if (r.status !== 'queued' && r.status !== 'running') return false;
      if (r.ownerId === this.ownerId) return false; // 自己的一定还活着
      if (staleAfterMs > 0 && r.ownerId !== undefined) {
        const since = r.startedAt ?? r.createdAt;
        if (now - since < staleAfterMs) return false; // 他进程刚起的，别抢
      }
      return true;
    });

    const claims: Promise<void>[] = [];
    for (const rec of pending) {
      rec.status = 'queued'; // 重新入队，由 #execute 统一推进
      rec.ownerId = this.ownerId; // 认领：此后本进程的记录不再被（自己）重派
      const saved = this.store.save(rec);
      if (isThenable(saved)) {
        // 落库失败则**不派发**：认领没落地，派发等于把上面那个重复执行的窗口重新打开
        claims.push(Promise.resolve(saved).then(() => void this.#execute(rec)));
      } else {
        void this.#execute(rec);
      }
    }
    if (claims.length === 0) return pending.length + expired;
    return Promise.all(claims).then(() => pending.length + expired);
  }

  /**
   * 在飞计数包裹层：#executeInner 是状态机主体，这里只负责 active 计数与排空通知。
   * 计数在**同步段**（第一个 await 之前）自增 —— 所以 `void this.#execute(rec)` 一返回，
   * 该任务就已经计入了，drain 不会漏掉「刚 submit、还没开始跑」的任务。
   */
  async #execute(rec: TaskRecord): Promise<void> {
    this.active++;
    try {
      await this.#executeInner(rec);
    } finally {
      // 通知在飞递减**之前**：drain() 返回时保证「任务已终态 + 回调已发完」。
      // 内层 finally 保证回调万一抛错（理论上被吞掉）也不泄漏在飞计数。
      try {
        // HITL：挂起不是终态 —— onFinished 的承诺是「任务达终态」，对它不开火
        if (rec.status !== 'awaiting_approval') await this.#notifySinks(rec);
      } finally {
        this.active--;
        // 终态即清理 HITL 会话回写快照（挂起则保留 —— 恢复段成功后还要用它）
        if (rec.status !== 'awaiting_approval') this.sessionInputs.delete(rec.taskId);
        // 任务已达终态并落库 → 唤醒 awaitTask 的等待者（放在递减之后，语义与 drain 一致）。
        // 挂起也唤醒：等待者看一眼状态继续等（awaiting_approval 不是终态），无副作用。
        this.#notifyTaskDone(rec.taskId);
        this.#notifyDrained();
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
          await this.#safeSave(rec);
          return;
        }
      }

      await this.#acquireSlot();
      try {
        rec.status = 'running';
        rec.startedAt = Date.now();
        await this.store.save(rec);

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
          // HITL 恢复段（带审批决定重进引擎）的判定 —— 决定会话注入与回写的走向（见下）
          const isResume = rec.approvals !== undefined;
          // runTimeoutMs 到点即 abort（对尊重 signal 的客户端是真中止）；与调用方
          // 可能传入的 signal 合成，任一触发都中止本次 run。
          const timeoutAc = new AbortController();
          const combined = combineSignals(rec.spec.options?.signal, timeoutAc.signal);
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
            // 恢复段的 trace 是一棵**新树**，经 traceContext link 挂到上一段 runId
            // （spec §9.2 的入站关联机制）——「挂起段 → 恢复段 → …」在观测后端连成一条链。
            // 判定依据：有决定且已有上一段 runId = 本次是恢复执行；首次执行两者皆无。
            ...(rec.approvals !== undefined && rec.runId !== undefined
              ? { traceContext: { traceId: rec.runId } }
              : {}),
            rethrow: false, // 硬失败也以 failed 记录落库
            signal: combined,
          };
          try {
            const out = await this.#raceTimeout(
              this.app.run(rec.spec.messages, callOpts),
              rec.taskId,
              () => timeoutAc.abort(),
            );
            rec.runId = out.run.runId;
            rec.result = out.result;
            rec.error = out.result.error;
            if (out.result.stopReason === 'awaiting_approval' && out.result.suspendedMessages) {
              // HITL 挂起：扩展后的消息历史（末尾是含未决 tool_use 的 assistant 消息）
              // 与待决清单、挂起时刻一起落库 —— approve / 惰性超时 / 重启后都靠它们。
              // 槽位照常释放（finally）、onFinished 不触发（#execute 的出口判断）、
              // finishedAt 不置（下面 finally 里按状态跳过）：它不是终态。
              rec.status = 'awaiting_approval';
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
              rec.approvalPendingSince = Date.now();
            } else {
              rec.status = out.run.status;
              // 终态后清掉挂起痕迹（决定保留：审批记录是审计的一部分，随任务走）
              rec.pendingApprovals = undefined;
              rec.approvalPendingSince = undefined;
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
          }
        } catch (e) {
          rec.error = classifyError(e);
          rec.status = 'failed';
        }
      } finally {
        // HITL：挂起不是「完成」—— finishedAt 不置（等待中的任务没有结束时刻）
        if (rec.status !== 'awaiting_approval') rec.finishedAt = Date.now();
        // 落库失败不遮罩、槽位必须释放：释放放在内层 finally，即便落库实现抛错也必达
        try {
          await this.#safeSave(rec);
        } finally {
          this.#releaseSlot();
        }
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = classifyError(e);
      rec.finishedAt = Date.now();
      await this.#safeSave(rec);
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
  async #safeSave(rec: TaskRecord): Promise<void> {
    try {
      await Promise.resolve().then(() => this.store.save(rec));
    } catch {
      // 落库失败不遮罩主流程：任务结果仍在内存记录里可见
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

  /** 并发槽位：超限则排队等待（任务记录保持 queued，由 store 可见） */
  #acquireSlot(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waitQueue.push(resolve));
  }

  #releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next(); // 槽位直接移交给等待者，running 计数不变
    } else {
      this.running--;
    }
  }
}
