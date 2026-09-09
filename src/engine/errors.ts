import Anthropic from '@anthropic-ai/sdk';
import type { SpanError } from '../core/trace.js';

/** 把任意异常分类成 trace 可用的 SpanError（可重试 vs 不可重试）。 */
export function classifyError(e: unknown): SpanError {
  if (e instanceof Anthropic.RateLimitError) {
    return { type: 'rate_limit', message: e.message, retryable: true };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { type: 'connection', message: e.message, retryable: true };
  }
  if (e instanceof Anthropic.InternalServerError) {
    return { type: 'server', message: e.message, retryable: true };
  }
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return { type: 'api', message: e.message, retryable: status >= 500 || status === 429 };
  }
  if (e instanceof Error) {
    return { type: 'unknown', message: e.message, retryable: false };
  }
  return { type: 'unknown', message: String(e), retryable: false };
}
