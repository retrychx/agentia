/**
 * 任务终态等待表 —— 从 AsyncRunner 里抽出的第五个（也是最后一个）协作件
 * （slot-pool → approval-policy → drain-gate → resume-policy → 这里）。
 *
 * 为什么单独成件：`awaitTask` 是**双通道**的 —— 主路径是事件唤醒（本进程把任务写到终态时
 * 主动叫醒），兜底是轮询（他进程写终态时唤不醒，只能靠间隔唤醒后自己重读 store）。
 * 两条通道各自的语义、以及"超时到底算 resolve 还是 reject"这类边界，混在 900 行的类里
 * 只能透过 `awaitTask` 的整体行为间接观察；抽出来后可以直接打在表本身。
 *
 * ⚠️ 覆盖范围（这是本模块最重要的一条约束）：**只覆盖本进程写终态**。他进程写的终态唤不醒
 * 这里的等待者 —— 那是 `awaitTask` 用 `intervalMs` 兜底轮询的原因，不是缺陷。
 *
 * `wait()` 到期是 **resolve 而不是 reject**：它只是"该醒来看一眼了"，超时的判定权在
 * `awaitTask` 的循环里（它重读 store、算 deadline、再决定继续等还是抛错）。
 */
export class TaskWaiters {
  /** taskId → 等待者；仅覆盖本进程写终态（他进程写靠兜底轮询） */
  private readonly waiters = new Map<string, Array<() => void>>();

  /** 任务终态唤醒：本进程写终态的统一出口调用（成功 / 失败 / 采纳既有结果各路径） */
  notify(taskId: string): void {
    const waiters = this.waiters.get(taskId);
    if (!waiters || waiters.length === 0) return;
    this.waiters.delete(taskId);
    for (const w of waiters) w();
  }

  /** 等「本进程把该任务写到终态」或被 timeoutMs 兜底唤醒（二者先到先返回） */
  wait(taskId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.waiters.get(taskId);
        if (waiters) {
          const i = waiters.indexOf(finish);
          if (i >= 0) waiters.splice(i, 1);
          if (waiters.length === 0) this.waiters.delete(taskId);
        }
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const waiters = this.waiters.get(taskId);
      if (waiters) waiters.push(finish);
      else this.waiters.set(taskId, [finish]);
    });
  }

  /** 当前登记的等待者总数（单测与诊断用） */
  get count(): number {
    let n = 0;
    for (const list of this.waiters.values()) n += list.length;
    return n;
  }
}
