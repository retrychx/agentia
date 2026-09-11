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
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), items.length)
      : items.length;
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
 * `timeoutMs` 非正数 = 不设超时（直接返回原 promise）。
 */
export async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  if (!(timeoutMs > 0)) return p;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref?.(); // 兜底计时器不该让宿主为它续命
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
