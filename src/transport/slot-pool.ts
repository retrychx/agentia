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

  /** 取槽位：未到上限立刻兑现，否则排队 */
  acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return Promise.resolve();
    }
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

  /** 当前占用数（测试用；AsyncRunner 对外暴露的是 active，不是它） */
  get inUse(): number {
    return this.running;
  }
}
