import type { Span, SpanEvent, Trace } from '../core/trace.js';

/**
 * Agentia —— OTLP trace 导出（spec §9.3 生产方向，roadmap R3）。
 *
 * 把一次 run 的 Trace 映射为 OTLP/JSON（resourceSpans → scopeSpans → spans），
 * 用全局 fetch POST 到 `${endpoint}/v1/traces`，零外部依赖：
 * - traceId/spanId/parentSpanId：内部用 UUID，OTLP 要求 hex —— 去掉 '-' 即 32 位 hex；
 * - kind 固定 SPAN_KIND_INTERNAL(1)；时间 ms × 1e6 转 string 纳秒；
 * - status：ok → STATUS_CODE_OK，error → STATUS_CODE_ERROR（附 error.message）；
 * - attributes 展平 span.attributes + usage（usage.* 前缀）；
 * - events → OTLP events（body 的原始类型字段进 attributes，其余 JSON 化）。
 *
 * 非 2xx 抛错（含状态码与响应前 200 字符）。导出失败不影响 run 本身 —— 调用方自行取舍。
 */

export interface OtlpExporterOptions {
  /** collector 基地址，例如 http://localhost:4318（尾部斜杠会被去掉） */
  endpoint: string;
  /** 额外请求头（鉴权等） */
  headers?: Record<string, string>;
  /** resource 的 service.name，缺省 'agentia' */
  serviceName?: string;
}

export interface OtlpExporter {
  export(trace: Trace): Promise<void>;
}

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

function toValue(v: string | number | boolean): OtlpValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  // OTLP int64 走 string；小数用 double
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

/** 内部 UUID → OTLP hex（去掉 '-' 即 32 位小写 hex） */
function hexId(id: string): string {
  return id.replaceAll('-', '');
}

/** ms → string 纳秒 */
function nanos(ms: number): string {
  return String(Math.round(ms * 1e6));
}

function spanAttributes(span: Span): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = Object.entries(span.attributes).map(([key, v]) => ({
    key,
    value: toValue(v),
  }));
  if (span.usage) {
    const u = span.usage;
    attrs.push(
      { key: 'usage.inputTokens', value: toValue(u.inputTokens) },
      { key: 'usage.outputTokens', value: toValue(u.outputTokens) },
      { key: 'usage.cacheReadTokens', value: toValue(u.cacheReadTokens) },
      { key: 'usage.cacheCreationTokens', value: toValue(u.cacheCreationTokens) },
    );
    if (u.costEstimate !== undefined) {
      attrs.push({ key: 'usage.costEstimate', value: toValue(u.costEstimate) });
    }
  }
  return attrs;
}

function eventAttributes(body: unknown): OtlpAttribute[] {
  if (body === undefined) return [];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return Object.entries(body as Record<string, unknown>).map(([key, v]) => ({
      key,
      value:
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? toValue(v)
          : { stringValue: JSON.stringify(v) },
    }));
  }
  return [{ key: 'body', value: { stringValue: JSON.stringify(body) } }];
}

function mapEvent(e: SpanEvent) {
  return {
    timeUnixNano: nanos(e.time),
    name: e.name,
    attributes: eventAttributes(e.body),
  };
}

function mapSpan(span: Span) {
  return {
    traceId: hexId(span.traceId),
    spanId: hexId(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: hexId(span.parentSpanId) } : {}),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(span.startedAt),
    ...(span.endedAt !== undefined ? { endTimeUnixNano: nanos(span.endedAt) } : {}),
    attributes: spanAttributes(span),
    events: span.events.map(mapEvent),
    status:
      span.status === 'error'
        ? {
            code: 'STATUS_CODE_ERROR',
            ...(span.error ? { message: span.error.message } : {}),
          }
        : { code: 'STATUS_CODE_OK' },
  };
}

export function createOtlpExporter(opts: OtlpExporterOptions): OtlpExporter {
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const serviceName = opts.serviceName ?? 'agentia';

  return {
    async export(trace: Trace): Promise<void> {
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
            },
            scopeSpans: [
              {
                scope: { name: 'agentia' },
                spans: trace.spans.map(mapSpan),
              },
            ],
          },
        ],
      };
      const res = await fetch(`${endpoint}/v1/traces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...opts.headers,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new Error(`OTLP 导出失败: HTTP ${res.status} ${text}`);
      }
    },
  };
}
