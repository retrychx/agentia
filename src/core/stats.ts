/**
 * Agentia —— 统计小工具（**单源**）。
 *
 * `percentile` 此前在 `integrations/metrics.ts`（直方图窗口的分位，导出给看板）与
 * `integrations/report.ts`（时长报告的 p50/p95）各有一份。两处口径**必须**一致
 * （都取 Prometheus 语义的「最近 rank」），分开演化就会出现「看板 p95 ≠ 报告 p95」——
 * 同一条 trace、两个数，用户无从判断该信哪个。
 *
 * 入参是**已排序**数组：排序成本留给调用方决定 —— metrics 每次要复制滑动窗口再排，
 * report 只排一次复用给 p50/p95。本函数不替它们做这个选择。
 *
 * core 是叶子层：本文件零 import。
 */

/**
 * 分位数：取 `ceil(q · n)` 处的样本（Prometheus 的 quantile 语义 —— 不是线性插值）。
 * 空数组返回 0；`rank` 钳到 `[1, n]`，所以 `q=0` 也返回最小样本，不会越界读 `-1`。
 */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}
