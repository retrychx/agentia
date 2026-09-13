/**
 * `agentia report <file.jsonl>` —— 从 trace 落盘文件生成**调优报告**（G1 的 CLI 薄壳）。
 *
 * 回答的是调优第一步的问题：「**哪个单元慢 / 贵 / 爱失败**」—— 有了它才知道该拧哪个旋钮
 * （budgetTokens / keepToolPairs / maxCostUsd / toolTimeoutMs …）。
 *
 * 输入格式（每行一个 JSON，两种都收）：
 * - 裸 Trace（含 `spans`）—— 如 `createOtlpExporter` 之外的本地落盘、或自己 writeFile 的记录；
 * - TaskRecord（含 `result.trace` 或 `trace`）—— 如 `FileTaskStore` / `SqliteTaskStore` 的导出。
 *
 * 聚合实现**不在这里** —— 复用 `@migor/trace-view` 的 `summarizeTrace`
 * （构建期由 scripts/copy-assets.mjs 拷进 dist/inspector/）。CLI 因此保持零 npm 运行时依赖，
 * 且与 inspector 面板/官网 playground 共用同一份聚合口径（避免两处漂移）。
 */
import { readFile } from 'node:fs/promises';

interface SummaryRow {
  unit: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  tokens: number | null;
  costUsd: number | null;
}

interface TraceLike {
  traceId?: string;
  status?: string;
  spans?: unknown[];
}

/** 从一行 JSON 里把 trace 抠出来（裸 Trace 或包在记录里的 Trace） */
function extractTrace(v: unknown): TraceLike | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.spans)) return o as TraceLike;
  const result = o.result as Record<string, unknown> | undefined;
  const rt = result?.trace as Record<string, unknown> | undefined;
  if (rt && Array.isArray(rt.spans)) return rt as TraceLike;
  const trace = o.trace as Record<string, unknown> | undefined;
  if (trace && Array.isArray(trace.spans)) return trace as TraceLike;
  return null;
}

/** 打印一张按总耗时降序的单元排行（跨多行记录时按单元合并） */
export async function reportCommand(args: string[]): Promise<number> {
  const file = args[0];
  // 失败一律**抛错**（而不是就地设 process.exitCode）—— 本命令是异步的，
  // 就地设的 exitCode 会被 cli.ts 末尾那句 `process.exitCode = main(...)` 覆盖成 0。
  if (file === undefined || args.length > 1) {
    throw new Error('用法：agentia report <trace.jsonl>');
  }

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到文件 ${file}（${(e as Error).message}）`);
  }

  const traces: TraceLike[] = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const t = extractTrace(JSON.parse(s));
      if (t) traces.push(t);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  if (traces.length === 0) {
    throw new Error(
      `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
        (badLines > 0 ? `；另有 ${badLines} 行无法解析` : ''),
    );
  }

  // 聚合口径与 inspector 面板 / 官网 playground 同源（构建期拷进来的 trace-view 产物）
  const { summarizeTrace } = (await import(
    new URL('./inspector/summary.js', import.meta.url).href
  )) as { summarizeTrace: (t: unknown) => SummaryRow[] };

  const merged = new Map<string, SummaryRow>();
  let okRuns = 0;
  for (const t of traces) {
    if (t.status !== 'error') okRuns += 1;
    for (const row of summarizeTrace(t)) {
      const cur = merged.get(row.unit);
      if (!cur) merged.set(row.unit, { ...row });
      else {
        cur.calls += row.calls;
        cur.errors += row.errors;
        cur.totalMs += row.totalMs;
        cur.maxMs = Math.max(cur.maxMs, row.maxMs);
        if (row.tokens != null) cur.tokens = (cur.tokens ?? 0) + row.tokens;
        if (row.costUsd != null) cur.costUsd = (cur.costUsd ?? 0) + row.costUsd;
      }
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls);

  const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
  console.log(`trace 文件  ${file}`);
  console.log(`runs       ${traces.length}（失败 ${traces.length - okRuns}）${badLines > 0 ? `  ·  跳过无法解析 ${badLines} 行` : ''}`);
  console.log('');
  if (rows.length === 0) {
    console.log('（没有可归因的单元：这些 trace 里既没有 unit span，也没有 tool.output 事件）');
    return 0;
  }
  console.log(
    `${pad('unit', 34)} ${pad('calls', 6)} ${pad('err', 5)} ${pad('total', 9)} ${pad('max', 9)} ${pad('tokens', 9)} ${pad('cost', 12)}`,
  );
  let total = 0;
  let errs = 0;
  for (const r of rows) {
    total += r.totalMs;
    errs += r.errors;
    console.log(
      `${pad(r.unit, 34)} ${pad(String(r.calls), 6)} ${pad(String(r.errors), 5)} ` +
        `${pad(fmtMs(r.totalMs), 9)} ${pad(fmtMs(r.maxMs), 9)} ` +
        `${pad(r.tokens != null ? String(r.tokens) : '-', 9)} ` +
        `${pad(r.costUsd != null ? r.costUsd.toFixed(6) : '-', 12)}`,
    );
  }
  console.log('');
  console.log(`合计耗时 ${fmtMs(total)}  ·  失败 ${errs} 次  ·  单元 ${rows.length} 个`);
  return 0;
}
