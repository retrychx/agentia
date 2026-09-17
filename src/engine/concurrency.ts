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

/**
 * 超时原语（`TIMED_OUT` 哨兵 + `withTimeout`）已**下沉到 `core/timeout.ts`**：
 * 它与 `integrations/mcp.ts` 的 MCP 调用超时共用同一实现 —— 此前是两份，而
 * 「超时是硬的」那次收紧只落进了这里，桥那份留在竞速判定上（见 `docs/spec.md` §10 ⑤）。
 *
 * 这里**原样再导出**：`engine/turn.ts` 与既有测试的 import 路径与名字保持不变，
 * 单源化对它们零影响。
 */
export { TIMED_OUT, withTimeout } from '../core/timeout.js';
