import type { SpanError } from '../core/trace.js';
import { classifyError } from './errors.js';

/**
 * Agentia —— 模型请求的重试与退避（spec §6.5 确定性工程）。
 *
 * 消费 `classifyError().retryable`（此前该标记只产出、无人消费）：429 / 5xx /
 * 连接失败自动重试，400 一类的确定性错误立即失败。
 *
 * **只重试尚未产出任何文本的尝试** —— 已流出一半的文本无法撤回，重试会造成
 * 重复输出。这条约束由 engine/loop.ts 保证（它才知道有没有吐过文本）。
 *
 * ⚠️ 与 SDK 内置重试叠加：Anthropic SDK 自己会对 429/5xx 重试（默认 2 次）。
 * 框架层是更外层的兜底（覆盖 SDK 放弃后、以及 OpenAI 兼容客户端）。两层同时开
 * 最多会打 `(1+sdkAttempts) × maxAttempts` 次请求 —— 建议二选一调（把这里设
 * `maxAttempts: 1`，或把 SDK 的 `maxRetries` 设小）。
 */
export interface RetryOptions {
  /** 最大尝试次数（含首次）；1 = 关闭。缺省 3 */
  maxAttempts?: number;
  /** 首次退避毫秒，指数增长；缺省 500 */
  baseDelayMs?: number;
  /** 退避上限毫秒；缺省 8000 */
  maxDelayMs?: number;
  /** 抖动比例 0~1（避免并发 run 同时重试打爆上游）；缺省 0.2 */
  jitter?: number;
  /** 判定是否可重试；缺省 `(e) => classifyError(e).retryable` */
  isRetryable?: (err: unknown) => boolean;
  /** 重试前回调（观测用；trace 里另有 `llm.retry` 事件） */
  onRetry?: (info: { attempt: number; delayMs: number; error: SpanError }) => void;
}

/** 缺省重试参数（不含两个函数字段 —— 它们在 resolveRetry 里注入） */
export const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: 0.2,
} as const;

export type ResolvedRetry = Required<RetryOptions>;

/** 归一重试配置：`undefined` → 缺省策略（**缺省开启**）；`false` → null（关闭）。 */
export function resolveRetry(o: RetryOptions | false | undefined): ResolvedRetry | null {
  if (o === false) return null;
  const merged = { ...DEFAULT_RETRY, ...(o ?? {}) };
  if (!(merged.maxAttempts >= 1)) return null; // maxAttempts < 1 等同关闭
  return {
    ...merged,
    isRetryable: o?.isRetryable ?? ((e: unknown) => classifyError(e).retryable),
    onRetry: o?.onRetry ?? ((): void => {}),
  };
}

/** 指数退避 + 上限 + 抖动：attempt 从 1 起，`base * 2^(attempt-1)` 封顶 maxDelayMs。 */
export function backoffDelay(attempt: number, r: ResolvedRetry): number {
  const exp = r.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, r.maxDelayMs);
  const jitter = r.jitter > 0 ? capped * r.jitter * (Math.random() * 2 - 1) : 0;
  return Math.max(0, Math.round(capped + jitter));
}

/** 可被 signal 中断的 sleep（退避期间收到取消就不必再等） */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const abortError = (): Error => Object.assign(new Error('run 已被取消'), { name: 'AbortError' });
    // 已中止：立即 reject（此处 timer 尚未创建，绝不能去 clear）
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
