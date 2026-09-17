import type { SpanError } from '../core/trace.js';
import { interruptibleSleep } from '../core/timeout.js';
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
 * ⚠️ 与默认 client 内置重试叠加：默认 client（integrations/anthropic.ts）自己会对
 * 429/5xx/连接错误重试（缺省 2 次，与 SDK 缺省语义对齐）。框架层是更外层的兜底
 * （覆盖 client 层放弃后、以及 OpenAI 兼容客户端）。两层同时开最多会打
 * `(1+clientRetries) × maxAttempts` 次请求 —— 建议二选一调（把这里设
 * `maxAttempts: 1`，或把 client 的 `maxRetries` 设小）。
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

/**
 * 剔除**显式 `undefined`** 的键。
 *
 * `{ ...DEFAULTS, ...o }` 里，`o` 上值为 `undefined` 的键会**照常覆盖**默认值 ——
 * 它不是「没给」，而是「给了一个 undefined」。tsconfig 未开
 * `exactOptionalPropertyTypes`，所以 `{ maxAttempts: cfg.retries }` 这类
 * spread/透传组装出来的配置能带着 undefined 过类型检查，一路抵达 resolveRetry。
 */
function definedOnly(o: RetryOptions | undefined): RetryOptions {
  const out: RetryOptions = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** 归一重试配置：`undefined` → 缺省策略（**缺省开启**）；`false` → null（关闭）。 */
export function resolveRetry(o: RetryOptions | false | undefined): ResolvedRetry | null {
  if (o === false) return null;
  // 用 definedOnly 兜住显式 undefined，否则旧写法会把缺省覆盖掉：
  // `maxAttempts: undefined` → `!(undefined >= 1)` 成立 → **重试被静默关闭**，
  // 而 run 根快照记的是 config.retry.maxAttempts: 0（看起来像用户主动关的）；
  // `baseDelayMs: undefined` → backoffDelay 每次算出 NaN，退避失效且 trace 里
  // `llm.retry.delayMs` 记 NaN。两者都与「undefined → 缺省策略」的文档相反。
  const merged = { ...DEFAULT_RETRY, ...definedOnly(o) };
  if (!(merged.maxAttempts >= 1)) return null; // maxAttempts < 1 等同关闭
  return {
    ...merged,
    isRetryable: o?.isRetryable ?? ((e: unknown) => classifyError(e).retryable),
    onRetry: o?.onRetry ?? ((): void => {}),
  };
}

/**
 * 指数退避 + 上限 + 抖动：attempt 从 1 起，`base * 2^(attempt-1)` 封顶 maxDelayMs。
 *
 * ⚠️ **不要**与 `integrations/anthropic.ts` 的 `backoffMs` 合并（2026-09-17 去重时
 * 明确留下的例外）。两者形似而策略不同，合一就是改行为：
 * - 本函数：抖动**均匀分布** ±jitter（缺省 ±20%），底数/上限来自 `RetryOptions`；
 * - 那个：±25% 固定抖动，且**优先尊重 `retry-after`**（秒数或 HTTP-date）——
 *   限流窗口是上游说了算，框架不该拿自己的指数曲线去猜。它只在 client 层有意义。
 * 层也不同：本函数是引擎的兜底重试（覆盖 client 放弃之后的场景），那个在 client 内部。
 */
export function backoffDelay(attempt: number, r: ResolvedRetry): number {
  const exp = r.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, r.maxDelayMs);
  const jitter = r.jitter > 0 ? capped * r.jitter * (Math.random() * 2 - 1) : 0;
  return Math.max(0, Math.round(capped + jitter));
}

/**
 * 可被 signal 中断的 sleep（退避期间收到取消就不必再等）。
 *
 * 实现单源在 `core/timeout.ts`（2026-09-17 去重）：`integrations/anthropic.ts` 的
 * client 层退避需要**逐字相同**的语义，而它只能依赖 core —— 那份重复是被分层约束
 * 逼出来的，所以合一的落点只能是 core。这里只钉住本层的取消文案。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return interruptibleSleep(ms, signal, 'run 已被取消');
}
