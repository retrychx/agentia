import type { Trace, TraceSink } from '../core/trace.js';

/**
 * Agentia —— 指标（D3）。
 *
 * `MetricsSink` **天然满足** `TraceSink` → `createApp({ sinks: [metricsSink()] })` 即接入，
 * **零新出口**（与 `createOtlpExporter` 同款）。全部数值从 `Trace` 派生，宿主不需要
 * 在业务代码里埋点。
 *
 * 只做「进程内累加 + Prometheus 文本 /metrics」；OTLP metrics 导出**后置**（roadmap D3）。
 * 零依赖：Prometheus 文本格式手写（它是纯文本，不值得为此引一个客户端库）。
 */

/** 进程内累计快照（`snapshot()` 返回） */
export interface MetricsSnapshot {
  /** 投递过 trace 的 run 总数（= `export` 被调用次数） */
  runs: number;
  /** 其中 `trace.status === 'error'` 的条数（含 budget_exceeded / aborted / error） */
  failed: number;
  /** run 时长（根 span `endedAt - startedAt`）分位，毫秒；窗口内无样本时 0 */
  latencyP50: number;
  latencyP95: number;
  /**
   * 累计 token —— 口径 = **四类之和**（input + output + cacheRead + cacheCreation），
   * 与 `BudgetGuard` 的 token 口径一致。分项在 `render()` 里以 label 给出，不会丢。
   */
  tokens: number;
  /** 累计成本估算（美元）；模型不在价格表内时该 run 不计入（见 usage.ts） */
  costUsd: number;
}

export interface MetricsSinkOptions {
  /**
   * 输出形态：`'prometheus'`（缺省，`render()` 出 Prometheus 文本）。
   * `'otlp'` **尚未实现** —— 传了会在构造期抛错（比返回一份看不出问题的空指标好）。
   */
  export?: 'prometheus' | 'otlp';
  /**
   * 延迟分位保留的样本数（环形窗口，缺省 1024）。
   * 分位是**窗口内精确值**而非全历史近似 —— 长跑宿主不会被无界数组拖住内存，
   * 代价是分位只反映最近这么多条 run（这也是监控想要的）。
   */
  windowSize?: number;
  /** 指标名前缀，缺省 `agentia_` */
  prefix?: string;
}

export interface MetricsSink extends TraceSink {
  snapshot(): MetricsSnapshot;
  /** Prometheus 文本格式（`text/plain; version=0.0.4`），零依赖手写 */
  render(): string;
  /** 清空累计（测试 / 多租户轮换用） */
  reset(): void;
}

const DEFAULT_WINDOW = 1024;

/** 最近 rank 分位（Prometheus 的 quantile 语义：取第 ceil(q·n) 个样本） */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** run 时长：取根 span（`trace.rootSpanId`）的起止；根没收尾（如 sink 在失败路径拿到半截）时返回 undefined */
function runDurationMs(trace: Trace): number | undefined {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  if (!root || root.endedAt === undefined) return undefined;
  return root.endedAt - root.startedAt;
}

export function metricsSink(opts: MetricsSinkOptions = {}): MetricsSink {
  const format = opts.export ?? 'prometheus';
  if (format !== 'prometheus') {
    throw new Error(
      `metricsSink: export='${String(format)}' 尚未实现（OTLP metrics 导出后置，见 roadmap D3）；` +
        `目前只支持 'prometheus'`,
    );
  }
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW;
  if (!(windowSize > 0)) {
    throw new Error(`metricsSink: windowSize 必须为正数，收到 ${opts.windowSize}`);
  }
  const p = opts.prefix ?? 'agentia_';

  let runs = 0;
  let failed = 0;
  let costUsd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  // 环形窗口：只留最近 windowSize 条 run 时长（分位用），不保留全历史
  const durations: number[] = [];
  let cursor = 0;

  const snapshot = (): MetricsSnapshot => {
    const sorted = [...durations].sort((a, b) => a - b);
    return {
      runs,
      failed,
      latencyP50: percentile(sorted, 0.5),
      latencyP95: percentile(sorted, 0.95),
      tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
      costUsd,
    };
  };

  return {
    export(trace: Trace): void {
      runs++;
      if (trace.status === 'error') failed++;
      const u = trace.totalUsage;
      tokens.input += u.inputTokens;
      tokens.output += u.outputTokens;
      tokens.cacheRead += u.cacheReadTokens;
      tokens.cacheCreation += u.cacheCreationTokens;
      if (u.costEstimate != null) costUsd += u.costEstimate;

      const d = runDurationMs(trace);
      if (d !== undefined) {
        if (durations.length < windowSize) durations.push(d);
        else {
          durations[cursor] = d;
          cursor = (cursor + 1) % windowSize;
        }
      }
    },

    snapshot,

    render(): string {
      const s = snapshot();
      const line = (name: string, type: 'counter' | 'gauge', value: number, help: string, labels = ''): string =>
        `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${labels} ${value}\n`;
      const out: string[] = [];
      out.push(line(`${p}runs_total`, 'counter', s.runs, 'run 总数（成功 + 失败）'));
      out.push(line(`${p}runs_failed_total`, 'counter', s.failed, '失败的 run 数（trace.status=error）'));
      out.push(line(`${p}tokens_total`, 'counter', tokens.input, '输入 token 累计', '{kind="input"}'));
      out.push(line(`${p}tokens_total`, 'counter', tokens.output, '输出 token 累计', '{kind="output"}'));
      out.push(line(`${p}tokens_total`, 'counter', tokens.cacheRead, '缓存读 token 累计', '{kind="cache_read"}'));
      out.push(
        line(`${p}tokens_total`, 'counter', tokens.cacheCreation, '缓存写 token 累计', '{kind="cache_creation"}'),
      );
      out.push(line(`${p}cost_usd_total`, 'counter', costUsd, '累计成本估算（美元）'));
      // 分位：窗口内精确值（不是 Prometheus 原生 histogram / summary，见 options.windowSize）
      out.push(
        line(`${p}run_duration_ms`, 'gauge', s.latencyP50, 'run 时长分位（毫秒，滑动窗口内精确值）', '{quantile="0.5"}'),
      );
      out.push(
        line(`${p}run_duration_ms`, 'gauge', s.latencyP95, 'run 时长分位（毫秒，滑动窗口内精确值）', '{quantile="0.95"}'),
      );
      out.push(line(`${p}run_duration_ms_count`, 'gauge', durations.length, '窗口内已记录的 run 时长样本数'));
      return out.join('');
    },

    reset(): void {
      runs = 0;
      failed = 0;
      costUsd = 0;
      tokens.input = 0;
      tokens.output = 0;
      tokens.cacheRead = 0;
      tokens.cacheCreation = 0;
      durations.length = 0;
      cursor = 0;
    },
  };
}
