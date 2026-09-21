import type { TraceRecordEvent } from '../core/trace.js';

/**
 * 任务记账事件流 —— **每任务的事件缓冲 + 订阅表**（`AsyncRunner` 拆分的又一块纯件）。
 *
 * 为什么单独一件：`GET /tasks/:id/stream` 要「连上就能重放 + 之后转实时 + 终态收口」，
 * 这三件事全是**纯记账**，与 store / 引擎 / 槽位无关；留在 855 行的 `AsyncRunner` 里
 * 只会让它再长一截，而这块恰好是最容易用单测钉住的（内存边界、丢最旧、序号连续性）。
 *
 * ## 三条设计约束（都有理由，别按直觉改）
 *
 * 1. **序号是流自己的，不是 recorder 的 `seq`。** 一个异步任务可能跨**多个 run 段**
 *    （HITL 挂起→恢复、崩溃恢复重投）：每段是**独立的一次 run**（新 recorder，`seq` 从 1 重来），
 *    而流的读者要的是一条**连续的**流。所以本类给每条流维护自己的单调序号（从 1 起），
 *    SSE 的 `Last-Event-ID` 与 `?from=` 都指它。事件体里那个 `seq` 原样保留（属于那一段 run）。
 * 2. **有界 + 丢最旧 + 明示。** 内存不能被「跑了就不管的任务」拖垮：每条流最多存
 *    `maxEvents` 条，超了丢**最旧**的，并把「小于 `droppedBefore` 的序号已不在缓冲里」
 *    告诉订阅者（`replay()` 的返回值 / `stream.truncated` 帧）—— **不静默**。
 * 3. **终态缓冲区只保留最近 `retainTerminal` 条。** 留下的意义是「刚跑完就连上来也能重放」；
 *    更早的任务连接上来只能拿到终态（不假装还能重放）。留多了等于把内存换成没人看的历史。
 *
 * ⚠️ 内存量级（文档里要给使用者一个数）：单条事件正文受 `maxEventChars` 约束（入参/成功出参
 * 缺省 2000 字符），所以 500 条 × 2 KB ≈ 1 MB/任务，16 条终态 ≈ 16 MB 上限 —— 量级可控。
 */
export interface TaskEventStreamsOptions {
  /** 每条流最多保留多少条事件（超出丢最旧）；缺省 500 */
  maxEvents?: number;
  /** 终态流的保留条数（LRU，超出即丢最旧的终态流）；缺省 16 */
  retainTerminal?: number;
}

/** 一条事件在**流**里的位置（`index` 是流自己的序号，不是 recorder 的 seq） */
export interface TaskStreamEvent {
  index: number;
  event: TraceRecordEvent;
}

export interface TaskReplay {
  /** 待补发的事件（`from` 之后，或全部可用的） */
  events: TaskStreamEvent[];
  /** 小于它的序号已不在缓冲里（缺席 = 没有任何丢弃）；订阅者应据此发 `stream.truncated` */
  droppedBefore?: number;
  /** 该任务是否已到终态（调用方据此发 `task.end` 并关闭） */
  done: boolean;
}

/** 缺省上限 —— 与文档里写的数字必须一致（`usage-guide` §7） */
export const TASK_STREAM_DEFAULT_MAX_EVENTS = 500;
export const TASK_STREAM_DEFAULT_RETAIN_TERMINAL = 16;

interface StreamState {
  /** 已缓冲的事件（有界，丢最旧） */
  events: TaskStreamEvent[];
  /** 下一条事件的**流**序号 */
  nextIndex: number;
  /** 小于它的序号已不在缓冲里（0 = 从未丢弃） */
  firstAvailable: number;
  done: boolean;
  subscribers: Set<(e: TaskStreamEvent) => void>;
  /** 终态通知（markDone 时调一次）—— 实时订阅者靠它收口（否则流永远不结束） */
  doneListeners: Set<() => void>;
}

export class TaskEventStreams {
  private readonly streams = new Map<string, StreamState>();
  private readonly maxEvents: number;
  private readonly retainTerminal: number;

  constructor(opts: TaskEventStreamsOptions = {}) {
    this.maxEvents = Math.max(1, opts.maxEvents ?? TASK_STREAM_DEFAULT_MAX_EVENTS);
    this.retainTerminal = Math.max(0, opts.retainTerminal ?? TASK_STREAM_DEFAULT_RETAIN_TERMINAL);
  }

  /** 这条流在场吗（在场 = 本进程见过它的记账） */
  has(taskId: string): boolean {
    return this.streams.has(taskId);
  }

  /** 开一条流（已存在则**复用**：HITL 恢复 / 崩溃重投都是同一个任务，序号必须接着走） */
  open(taskId: string): void {
    const existing = this.streams.get(taskId);
    if (!existing) {
      this.streams.set(taskId, {
        events: [],
        nextIndex: 1,
        firstAvailable: 0,
        done: false,
        subscribers: new Set(),
        doneListeners: new Set(),
      });
      return;
    }
    // 复用：只把「已完成」摘掉 —— 恢复段是同一个任务的续篇，缓冲与序号都接着用
    existing.done = false;
  }

  /**
   * 记一条事件：入缓冲 + 广播给订阅者。
   * 超上限时丢**最旧**的一条（`firstAvailable` 前移）—— 读者据此知道前面被截了。
   *
   * ⚠️ **终态之后到达的事件直接忽略**：流已经以 `task.end` 收口，再往里塞会让下游看到
   * 「结束后还有事件」这种自相矛盾的流。丢掉的只有收尾残尾（超时工具的后台事件那一类）；
   * 权威的完整 trace 仍由 sink 出口交付（那条路不受本类影响）。
   */
  push(taskId: string, event: TraceRecordEvent): void {
    const s = this.streams.get(taskId);
    if (!s || s.done) return;
    const item: TaskStreamEvent = { index: s.nextIndex++, event };
    s.events.push(item);
    if (s.events.length > this.maxEvents) {
      const dropped = s.events.shift()!;
      s.firstAvailable = dropped.index + 1;
    }
    // 广播：先拷订阅者集合（回调里可能退订），单个抛错不影响其它订阅者
    for (const l of [...s.subscribers]) {
      try {
        l(item);
      } catch {
        /* 观测不击穿业务（与 flushSinks 同款） */
      }
    }
  }

  /**
   * 订阅实时事件 + 终态通知；返回退订函数。**不含**重放（重放走 `replay()`，调用方先补后订）。
   *
   * 为什么要 `onDone`：**终态是流的一部分**，不是「没有更多事件」了事 —— 没有它，
   * 实时订阅者永远等不到收口（HTTP 那条流就永远挂着，客户端以为任务还在跑）。
   */
  subscribe(
    taskId: string,
    listener: (e: TaskStreamEvent) => void,
    onDone?: () => void,
  ): () => void {
    const s = this.streams.get(taskId);
    if (!s) return () => {};
    s.subscribers.add(listener);
    if (onDone) s.doneListeners.add(onDone);
    return () => {
      s.subscribers.delete(listener);
      if (onDone) s.doneListeners.delete(onDone);
    };
  }

  /** 该任务的订阅者数（用例要断言「流关掉后没人还挂在表里」） */
  subscriberCount(taskId: string): number {
    const s = this.streams.get(taskId);
    return s ? s.subscribers.size + s.doneListeners.size : 0;
  }

  /**
   * 取待补发的事件。`from` 语义 = 「我手上已有到 `from` 为止，给我之后的」
   *（SSE 的 `Last-Event-ID` 就是它，`?from=` 也是）。
   */
  replay(taskId: string, from?: number): TaskReplay {
    const s = this.streams.get(taskId);
    if (!s) return { events: [], done: false };
    const lower = Number.isFinite(from) ? (from as number) : 0;
    return {
      events: s.events.filter((e) => e.index > lower),
      ...(s.firstAvailable > 0 ? { droppedBefore: s.firstAvailable } : {}),
      done: s.done,
    };
  }

  /** 标记终态：此后不再有事件（`task.end` 由调用方发），并按 LRU 丢掉最旧的终态流 */
  markDone(taskId: string): void {
    const s = this.streams.get(taskId);
    if (!s) return;
    s.done = true;
    // 先广播终态再考虑淘汰：订阅者要能收口（单个抛错不影响其它订阅者）
    for (const l of [...s.doneListeners]) {
      try {
        l();
      } catch {
        /* 观测不击穿业务（与 push 同款） */
      }
    }
    this.#evictTerminal();
  }

  /** 丢弃某条流（终态 LRU 用） */
  forget(taskId: string): void {
    this.streams.delete(taskId);
  }

  /** 终态流超过保留条数 ⇒ 从最旧的开始丢（Map 的插入序即 LRU 序；恢复段 `open()` 会把它当新流） */
  #evictTerminal(): void {
    const doneIds: string[] = [];
    for (const [taskId, s] of this.streams) {
      if (s.done) doneIds.push(taskId);
    }
    let excess = doneIds.length - this.retainTerminal;
    for (const taskId of doneIds) {
      if (excess <= 0) return;
      // 还有订阅者的终态流**不丢**：那是一条还没被读完的流（丢了下游会莫名断在半路）。
      // 跳过它但不算「减掉一个」，于是继续往后找真正能丢的。
      if (this.streams.get(taskId)!.subscribers.size > 0) continue;
      this.streams.delete(taskId);
      excess -= 1;
    }
  }
}
