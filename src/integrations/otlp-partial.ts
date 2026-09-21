/**
 * Agentia —— **OTLP 的 HTTP 200 不等于「全部接收」**。
 *
 * 规范允许 collector 用 `200 OK` + `partialSuccess` 告知「我收了一部分」：例如某条 span 的
 * 属性过大被丢掉。只查 `res.ok` 就会把它读成完全成功 —— 使用者的看板少数据，而框架说一切正常
 * （2026-09-21 外部复核指出，traces 与 metrics 两个导出器都只查 `res.ok`）。
 *
 * ⚠️ **`partialSuccess` 在场不等于失败**：规范里 `{}` 或 `{rejectedSpans: 0, errorMessage: ''}`
 * 是「全部接收」的另一种写法（有 collector 恒发这个键）。所以判据只有两条：
 * 「真拒收了」或「给了非空 errorMessage」—— 不是「这个键存不存在」。
 *
 * 这是本仓那条老纪律的又一例：**记录了原因 ≠ 记录了后果**。规范里写了 200 可以表示部分成功，
 * 而代码里没有任何一处读它 —— 于是「部分成功」这条后果在实际行为里是隐形的。
 */

/** `rejectedSpans` / `rejectedDataPoints` 的两种线上形态：int64 数字，或（protobuf JSON）字符串 */
function rejectedCount(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 从 OTLP 响应体里取「部分接收」的理由；**全部接收时返回 `undefined`**。
 *
 * @param kind 这一侧 OTLP 用的字段名：traces 是 `rejectedSpans`，metrics 是 `rejectedDataPoints`
 */
export function otlpPartialSuccess(
  body: unknown,
  kind: 'spans' | 'dataPoints',
): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const ps = (body as { partialSuccess?: unknown }).partialSuccess;
  if (typeof ps !== 'object' || ps === null) return undefined;
  const rec = ps as Record<string, unknown>;

  const parts: string[] = [];
  const n = rejectedCount(kind === 'spans' ? rec.rejectedSpans : rec.rejectedDataPoints);
  if (n !== undefined && n > 0) parts.push(`rejected_${kind}=${n}`);
  const msg = rec.errorMessage;
  if (typeof msg === 'string' && msg.trim() !== '')
    parts.push(`error_message=${msg.trim().slice(0, 200)}`);

  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * 读一个可能为空 / 非 JSON 的响应体 —— **解析失败一律当「没有信息」，不当作失败**：
 * 有的 collector / 代理会回 200 + 空体，那不该因为「我们解析不了」而变成一次假失败。
 */
export async function readOtlpResponseBody(res: {
  text?: () => Promise<string>;
}): Promise<unknown> {
  if (typeof res.text !== 'function') return undefined;
  try {
    const raw = await res.text();
    if (raw.trim() === '') return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
