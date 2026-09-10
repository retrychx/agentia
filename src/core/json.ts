/** 任意值 → 字符串：string 原样，其余 JSON.stringify，循环引用等异常回落 String()。 */
export function stringifySafe(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}
