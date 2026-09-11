/**
 * Agentia —— 中断信号合成（零依赖）。
 *
 * 一条 run 的中断可能来自多个源头：调用方显式传入、HTTP 客户端断开、
 * AsyncRunner 的 runTimeoutMs 超时、宿主停机。任一触发都应中止本次 run。
 *
 * Node 18 没有 `AbortSignal.any`，这里手写兜底（Node 20.3+ 才有）。
 */

/** 合成多个中断源：任一已中止 / 后中止即中止；忽略 undefined；全空返回**永不中止**的 signal。 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  // 单源直接复用，避免多包一层 listener
  if (real.length === 1) return real[0];

  const ac = new AbortController();
  for (const s of real) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
  }
  if (!ac.signal.aborted) {
    for (const s of real) s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
