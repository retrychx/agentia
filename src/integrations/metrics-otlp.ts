import type { DurationStat, MetricsState } from './metrics-state.js';
import { scoreLabels } from './metrics-state.js';
import { otlpPartialSuccess, readOtlpResponseBody } from './otlp-partial.js';

/**
 * metricsSink 的 **OTLP/JSON 导出**（E5）：从 `MetricsState` 组装 payload + POST 到
 * `${endpoint}/v1/metrics`。只读状态、不改账。module 级 export，不进公共面（`src/index.ts`）。
 */

/**
 * OTLP metrics 导出失败（带数值 `status`）。
 *
 * 为什么不能抛裸 `Error`：`engine/errors.ts` 的分类是鸭子类型，只看数据属性。
 * 裸 Error 会被判 `unknown` + `retryable:false` —— 宿主在 `onExportError` 里拿不到
 * status，也就没法区分「collector 拒收（4xx，改配置）」与「collector 挂了（5xx，等它回来）」。
 * 形状与 `otlp.ts` 的 `OtlpExportError` 一致（同层两处导出器不该有两种错误形状）。
 *
 * 注：本处抛错由 `onExportError` 接住并按「观测失败不得击穿业务」吞掉 —— 带 status 是为了
 * **可判断**，不是为了让谁重试。
 */
export class MetricsExportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MetricsExportError';
    this.status = status;
  }
}

/** `buildOtlpPayload` 的组装入参（值都来自 `metricsSink` 的已校验选项） */
export interface OtlpMetricsOptions {
  /** 指标名前缀（同 `MetricsSinkOptions.prefix`） */
  prefix: string;
  /** OTLP resource 的 `service.name` */
  serviceName: string;
  /** sink 创建时刻（epoch 毫秒）—— 所有数据点的 `startTimeUnixNano` */
  startedAtMs: number;
  /** resource 的额外属性（除自动加的 `service.name`） */
  resourceAttributes?: Record<string, string>;
}

/** `flushOtlpMetrics` 的入参 = payload 组装入参 + 传输入参 */
export interface OtlpFlushOptions extends OtlpMetricsOptions {
  /** 采集端基地址（尾部斜杠已去掉） */
  endpoint: string;
  /** 单次导出请求超时（毫秒）；非正数 = 不限 */
  timeoutMs: number;
  /** 导出失败回调（观测失败不得击穿业务） */
  onExportError?: (err: unknown) => void;
}

// —— OTLP/JSON 导出（E5）——
// epoch 毫秒 ×1e6 ≈ 1.7e18 > 2^53，double 直接乘会丢精度 —— 必须先取整再转 BigInt
const nanos = (ms: number): string => String(BigInt(Math.round(ms)) * 1_000_000n);
type OtlpAttr = { key: string; value: Record<string, unknown> };
const strAttr = (key: string, v: string): OtlpAttr => ({ key, value: { stringValue: v } });

export function buildOtlpPayload(state: MetricsState, opts: OtlpMetricsOptions): unknown {
  const p = opts.prefix;
  const now = nanos(Date.now());
  const start = nanos(opts.startedAtMs);
  const s = state.snapshot();
  // OTLP 数据模型：Metric 身份 = name(+type/unit)。**同名**数据点必须合并进一个 Metric
  // 的 dataPoints —— 规范里同名多 Metric 是 semantic error（consumer 可拒收整批），
  // 同名 Metric 各带一份 description 同样冲突。对照 Prometheus 侧 render() 的 family()：
  // 同名样本收进同一家族、家族头只发一次。这里按 name 建表聚合，助手只做
  // 「查表取已建 Metric，append dataPoint」。
  interface OtlpMetric {
    name: string;
    description: string;
    sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: unknown[] };
    gauge?: { dataPoints: unknown[] };
    histogram?: { aggregationTemporality: number; dataPoints: unknown[] };
  }
  const metricTable = new Map<string, OtlpMetric>();
  /** 查表取已建 Metric，没有则建；同名只保留首次的 description（冲突描述本身是 semantic error） */
  const takeMetric = (name: string, help: string): OtlpMetric => {
    let m = metricTable.get(name);
    if (!m) {
      m = { name, description: help };
      metricTable.set(name, m);
    }
    return m;
  };
  const sum = (
    name: string,
    value: number,
    help: string,
    attrs: OtlpAttr[],
    monotonic = true,
  ): void => {
    const m = takeMetric(name, help);
    m.sum ??= { aggregationTemporality: 2, isMonotonic: monotonic, dataPoints: [] };
    m.sum.dataPoints.push({
      attributes: attrs,
      startTimeUnixNano: start,
      timeUnixNano: now,
      asInt: String(value),
    });
  };
  // 浮点指标（成本）必须走 asDouble —— OTLP 的 asInt 是 string 编码 int64，
  // 塞浮点（如 0.25）会让 collector 直接拒收整批数据
  const sumDouble = (name: string, value: number, help: string, attrs: OtlpAttr[]): void => {
    const m = takeMetric(name, help);
    m.sum ??= { aggregationTemporality: 2, isMonotonic: true, dataPoints: [] };
    m.sum.dataPoints.push({
      attributes: attrs,
      startTimeUnixNano: start,
      timeUnixNano: now,
      asDouble: value,
    });
  };
  // gauge 没有理由只收 int：评分值是浮点，统一走 asDouble
  const gauge = (name: string, value: number, help: string, attrs: OtlpAttr[]): void => {
    const m = takeMetric(name, help);
    m.gauge ??= { dataPoints: [] };
    m.gauge.dataPoints.push({
      attributes: attrs,
      startTimeUnixNano: start,
      timeUnixNano: now,
      asDouble: value,
    });
  };
  const hist = (name: string, stat: DurationStat, help: string, attrs: OtlpAttr[]): void => {
    const m = takeMetric(name, help);
    m.histogram ??= { aggregationTemporality: 2, dataPoints: [] };
    m.histogram.dataPoints.push({
      attributes: attrs,
      startTimeUnixNano: start,
      timeUnixNano: now,
      count: stat.count,
      sum: stat.sumMs,
      // OTLP 的 bucketCounts 是每桶**非累积**计数（Prometheus 文本才是累积语义）
      bucketCounts: stat.perBucket(),
      explicitBounds: [...stat.boundsList],
    });
  };

  sum(`${p}runs_total`, s.runs, 'run 总数', []);
  sum(`${p}runs_failed_total`, s.failed, '失败的 run 数', []);
  // tokens_total：四类 kind 分项收进**同一个** Metric；description 与 Prometheus 侧
  // render() 的 family() 统一成同一句总述（同名 Metric 各带一份描述是 semantic error）
  const tokensHelp = 'token 累计（kind 分项：input / output / cache_read / cache_creation）';
  sum(`${p}tokens_total`, state.tokens.input, tokensHelp, [strAttr('kind', 'input')]);
  sum(`${p}tokens_total`, state.tokens.output, tokensHelp, [strAttr('kind', 'output')]);
  sum(`${p}tokens_total`, state.tokens.cacheRead, tokensHelp, [strAttr('kind', 'cache_read')]);
  sum(`${p}tokens_total`, state.tokens.cacheCreation, tokensHelp, [
    strAttr('kind', 'cache_creation'),
  ]);
  sumDouble(`${p}cost_usd_total`, s.costUsd, '累计成本估算（美元）', []);
  hist(`${p}run_duration_ms`, state.runStat, 'run 时长（毫秒）', []);

  for (const label of [...state.capabilities.keys()].sort()) {
    const acc = state.capabilities.get(label)!;
    const attrs = [strAttr('capability', label)];
    sum(`${p}capability_calls_total`, acc.calls, '能力调用次数', attrs);
    sum(`${p}capability_errors_total`, acc.errors, '能力失败次数', attrs);
    hist(`${p}capability_duration_ms`, acc.stat, '能力调用耗时（毫秒）', attrs);
    if (acc.tokens !== null)
      sum(`${p}capability_tokens_total`, acc.tokens, '子孙 token 合计', attrs);
    if (acc.costUsd !== null)
      sumDouble(`${p}capability_cost_usd_total`, acc.costUsd, '估算成本（美元）', attrs);
  }
  for (const model of [...state.models.keys()].sort()) {
    const acc = state.models.get(model)!;
    const attrs = [strAttr('model', model)];
    sum(`${p}model_turns_total`, acc.turns, '模型往返次数', attrs);
    sum(`${p}model_tokens_total`, acc.tokens, '模型 token 合计', attrs);
    sumDouble(`${p}model_cost_usd_total`, acc.costUsd, '模型估算成本（美元）', attrs);
    if (acc.unpricedTurns > 0) {
      sum(`${p}model_unpriced_turns_total`, acc.unpricedTurns, '未定价 turn 数', attrs);
    }
    hist(`${p}model_duration_ms`, acc.stat, '模型往返耗时（毫秒）', attrs);
  }
  for (const key of [...state.scores.keys()].sort()) {
    const acc = state.scores.get(key)!;
    const { name, source } = scoreLabels(key);
    const attrs = [strAttr('name', name), strAttr('source', source)];
    gauge(`${p}score`, acc.value, '最近一次评分', attrs);
    sum(`${p}score_total`, acc.count, '评分条数', attrs);
  }

  // 基数上限可见性（与 Prometheus 侧 `*_dropped_keys{kind=…}` 同名同义）：
  // 三个 kind 收进同一个 gauge Metric
  const droppedHelp = '因基数上限被折叠的不同键数';
  gauge(`${p}dropped_keys`, state.capBudget.dropped, droppedHelp, [strAttr('kind', 'capability')]);
  gauge(`${p}dropped_keys`, state.modelBudget.dropped, droppedHelp, [strAttr('kind', 'model')]);
  gauge(`${p}dropped_keys`, state.scoreBudget.dropped, droppedHelp, [strAttr('kind', 'score')]);

  const metrics = [...metricTable.values()];

  const resourceAttrs: OtlpAttr[] = [
    strAttr('service.name', opts.serviceName),
    ...Object.entries(opts.resourceAttributes ?? {}).map(([k, v]) => strAttr(k, v)),
  ];
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [{ scope: { name: 'agentia' }, metrics }],
      },
    ],
  };
}

export async function flushOtlpMetrics(state: MetricsState, opts: OtlpFlushOptions): Promise<void> {
  let payload: unknown;
  try {
    payload = buildOtlpPayload(state, opts);
  } catch (e) {
    opts.onExportError?.(e);
    return;
  }
  try {
    const res = await fetch(`${opts.endpoint}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(opts.timeoutMs > 0 ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new MetricsExportError(res.status, `OTLP metrics 导出失败: HTTP ${res.status} ${text}`);
    }
    // 200 **不等于全部接收**：collector 可以回 200 + `partialSuccess`（判据见 otlp-partial.ts）。
    // 读成成功就是「指标少了一半而框架说一切正常」—— 与 traces 侧同一处缺陷、同一个修法。
    const partial = otlpPartialSuccess(await readOtlpResponseBody(res), 'dataPoints');
    if (partial !== undefined) {
      throw new MetricsExportError(200, `OTLP metrics 导出被部分接收（HTTP 200）: ${partial}`);
    }
  } catch (e) {
    opts.onExportError?.(e); // 观测失败不得击穿业务
  }
}
