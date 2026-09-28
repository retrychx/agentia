/**
 * 并发槽位池 —— 从 AsyncRunner 里抽出的第一个协作件（纯原语、零依赖）。
 *
 * 为什么单独成件：AsyncRunner 一个类同时扛状态机/并发/幂等/恢复/审批/session/超时/持久化，
 * 并发槽位是其中**唯一不碰 store、不碰引擎**的一块 —— 先把它抽出来并配单测，后续抽块才有基线。
 *
 * 语义与原 `#acquireSlot` / `#releaseSlot` **逐字一致**：
 * - 超限时 `acquire()` 的 promise 进 FIFO 队列等（此时任务记录仍由调用方留在 store 里为 queued）；
 * - `release()` **把槽位直接移交**给队首等待者（不是先减再让等待者自增）—— 移交期间计数不变，
 *   所以「同时最多 limit 个」这条不变量在中间态也成立；
 * - 没有等待者时才真正归还计数。
 */
export class SlotPool {
  private running = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /**
   * **同步**取槽位：有空位就当场占下并回 `true`，否则**什么都不做**并回 `false`。
   *
   * 为什么要有它（2026-09-28）：`acquire()` 返回的 promise 即使立刻兑现，调用方也要等
   * 一次微任务才拿到槽位 —— 而 async.ts 的排队段闸要靠「一条任务**是否已持槽**」算排队深度。
   * 只走 `await acquire()` 的话，「占槽」发生在同步段（`running++`）、「出排队段」却晚一个
   * 微任务，同一条任务在那一瞬被算两遍 ⇒ 深度虚高一格 ⇒ `concurrency: 1` + `maxQueued: 1`
   * 下第 2 条合法提交被误拒。有了快路径，调用方能在**同一次同步执行**里占槽 + 出集合，
   * 读数与判据因此在同一个 tick 内自洽（用例：`tests/transport/max-queued.test.ts`）。
   */
  tryAcquire(): boolean {
    if (this.running < this.limit) {
      this.running++;
      return true;
    }
    return false;
  }

  /** 取槽位：未到上限立刻兑现，否则排队 */
  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => this.waitQueue.push(resolve));
  }

  /** 还槽位：有等待者则移交（计数不变），否则归还 */
  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }

  /**
   * 当前占用数。
   *
   * ⚠️ 2026-09-28 起它**不再是「测试用」**：`AsyncRunner` 的排队段闸（`maxQueued`）
   * 用它算「此刻还有几个空槽位」—— 判据是「**真正在排队的深度** = 已受理未持槽的任务数
   * − 当前空槽位数」（见 async.ts 的 `#queueDepth`）。先前那句「测试用；对外暴露的是
   * active」是一句**会误导人**的自述：它让读代码的人以为改这个读数不影响行为。
   * 读到它想改语义时，请连着 `#queueDepth` 一起看 —— 那里写着为什么不能只看等待队列长度。
   */
  get inUse(): number {
    return this.running;
  }
}
