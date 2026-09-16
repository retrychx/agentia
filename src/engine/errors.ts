import type { SpanError } from '../core/trace.js';

/**
 * Agentia —— 异常分类（engine 对厂商 SDK 零运行时 import）。
 *
 * 分类是**鸭子类型**：默认 client（`integrations/anthropic.ts`）自研化后抛的是
 * 带数值 `status` 的 `AnthropicApiError` 与 fetch 的原生网络错误（TypeError 带 cause），
 * 不再是 SDK 错误类。同套判法对第三方 SDK 错误同样适用（它们的错误类也带 `status`）。
 *
 * 历史教训（2026-09-13 实测，当时因此保留 instanceof）：厂商 SDK 的错误类
 * `name` 恒为 `'Error'`、`type` 为 null，鸭子类型只能靠 `constructor.name` ——
 * **压缩即失效**。所以这里只认**数据属性**（`status` 数值 / `cause` / errno `code` /
 * 内建 DOMException 的 `name`），一概不碰构造函数名。
 */

/** 是否中断异常（DOMException / 普通 Error 都可能是，靠 name 判定） */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** 取错误的可读 message（Error 取 .message，其余 String 兜底） */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** errno 形态的连接错误码（Node 网络层稳定产出，不靠 message 文案） */
const CONNECTION_CODES =
  /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)$/;

/**
 * 无 status 的网络型错误 → connection。
 * 稳的判法（不过拟合 message 字符串）：
 * - fetch 的网络失败是 `TypeError` 且带 `cause`（undici 保证，cause 里常有 errno）；
 * - 带 errno `code` 属性的 Error（Node 网络层直接抛的形态）；
 * - `name === 'TimeoutError'` 的 DOMException（`AbortSignal.timeout` / 默认 client 的
 *   timeout 合成信号）—— 内建 name 是规范值，不受压缩影响。
 */
function isConnectionError(e: object): boolean {
  if (e instanceof TypeError && (e as { cause?: unknown }).cause != null) return true;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_CODES.test(code)) return true;
  return (e as { name?: unknown }).name === 'TimeoutError';
}

/** 把任意异常分类成 trace 可用的 SpanError（可重试 vs 不可重试）。 */
export function classifyError(e: unknown): SpanError {
  if (isAbortError(e)) {
    return { type: 'aborted', message: 'run 已被取消', retryable: false };
  }
  if (typeof e === 'object' && e !== null) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      if (status === 429) return { type: 'rate_limit', message: messageOf(e), retryable: true };
      if (status >= 500) return { type: 'server', message: messageOf(e), retryable: true };
      return { type: 'api', message: messageOf(e), retryable: false };
    }
    if (isConnectionError(e)) {
      return { type: 'connection', message: messageOf(e), retryable: true };
    }
  }
  if (e instanceof Error) {
    return { type: 'unknown', message: e.message, retryable: false };
  }
  return { type: 'unknown', message: String(e), retryable: false };
}
