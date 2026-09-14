/**
 * Agentia —— 有界并发与超时（C2）。零依赖，供「同一回合的并行工具调用」用。
 */

/**
 * 有界并发 map：最多 `limit` 个 `fn` 同时在飞，**结果顺序与输入一致**
 * （调用方按序拼 tool_result，模型靠 tool_use_id 配对，顺序改动会打乱可读性）。
 *
 * `limit` 非正数或非有限值一律视为**不限**（= 旧行为 `Promise.all`）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width =
    Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), items.length) : items.length;
  // 取号自增在同步段完成（`next++` 在读 item 之前），所以 worker 之间不会重号。
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** 超时哨兵：区分「超时」与「工具恰好返回了 undefined」 */
export const TIMED_OUT = Symbol('agentia.timed-out');

/**
 * 给一个 promise 套超时；超时返回 `TIMED_OUT`。
 *
 * ⚠️ **不取消底层** —— `AgentTool.run` 拿不到 signal（那会破坏现有签名），所以
 * 「超时」的语义是**放弃等待**：副作用可能已经发生，只是我们不等了。
 * 想真停下来的工具请自行读 `ToolRunContext.signal`（框架传了，但**不强制**工具中断
 * —— 见 core/tool.ts 的说明：工具副作用无法回滚）。
 *
 * **超时是硬的**（2026-09-14 收紧，见 `docs/spec.md` §10）：判定不看竞速结果，而看**实测耗时**。
 * 原因：`Promise.race` 不是硬保证 —— 两个计时器在同一毫秒内建、又因事件循环被饿住而同批到期时，
 * 列表顺序决定谁先 resolve，**超预算的工具能赢过截止计时器**（实测 `60ms 工具 vs 20ms 预算`
 * 在 8 倍 CPU 超订下 1200 次翻转 1 次，记成 `ok: true`，护栏静默失效）。
 * 代价是语义收紧：`21ms 完成 / 20ms 预算` 由「成功」变「超时」—— 这正确，
 * 「预算」本来就是对**实际耗时**的承诺，不是对调度运气的承诺。
 *
 * `timeoutMs` 非正数 = 不设超时（直接返回原 promise）。
 *
 * ⚠️ **截止计时器绝不可 `unref()`**（2026-09-14 修正，见 `docs/spec.md` §10 ④）：
 * 这个计时器的**触发本身就是「被 await 的 promise 得以 settle」的条件**。一旦 unref，
 * 当它是事件循环里唯一的把手时，进程会在它触发前直接退出 —— `await` **永不 settle**。
 * 实测（空事件循环、挂死的 promise，Node 22 与 26 一个样）：
 *
 * | 计时器 | 结果 |
 * |---|---|
 * | `unref()` | 进程退出（顶层 await 未 settle），**什么都没返回** |
 * | 不 unref | `settled: TIMED_OUT`，exit 0 |
 *
 * 「兜底计时器不该让宿主为它续命」这条理由对**没人 await 的兜底 tick**（scheduler 的下一拍、
 * SSE 心跳、metrics 刷盘）成立，对**「等待的终点」**不成立：那正是调用方在等的东西。
 */
export async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  if (!(timeoutMs > 0)) return p;
  const startedAt = Date.now();
  // 在**工具 settle 的那个微任务里**记时间，而不是 `await` 恢复之后再记：
  // 微任务紧跟在 resolve 它的那次回调之后跑，所以这个时刻最贴近「工具真正完成」。
  // 若改成 await 恢复后再测，宿主在「工具完成 → 恢复」之间被饿住会把按时完成的工具误判成超时。
  let settledAt = 0;
  const tracked = p.then(
    (v) => {
      settledAt = Date.now();
      return v;
    },
    (e) => {
      settledAt = Date.now();
      throw e;
    },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      tracked,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        // ⚠️ 不 unref：它的触发是「这个 await 得以结束」的条件（详见函数头注释的实测表）。
        // unref 过它 ⇒ 空事件循环下进程先退出，await 永不 settle。
      }),
    ]);
    // 竞速只当快路径；最终以实测耗时兜底判定（见上面注释里的翻转样本）。
    if (out === TIMED_OUT) return TIMED_OUT;
    return settledAt - startedAt >= timeoutMs ? TIMED_OUT : out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
