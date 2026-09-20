import type { Trace, TraceSink } from '../core/trace.js';
import { MetricsState } from './metrics-state.js';
import type { MetricsSnapshot } from './metrics-state.js';
import { renderPrometheus } from './metrics-render.js';
import { flushOtlpMetrics } from './metrics-otlp.js';

// 结构拆分（2026-09-20）：累加/快照在 `metrics-state.ts`（MetricsState），
// Prometheus 文本渲染在 `metrics-render.ts`（renderPrometheus），OTLP 组装与导出在
// `metrics-otlp.ts`（buildOtlpPayload / flushOtlpMetrics / MetricsExportError）。
// 均为同层 module 级 export，不进公共面；本文件只留选项校验、定时器与组装。
export type {
  CapabilityMetrics,
  ModelMetrics,
  ScoreMetrics,
  MetricsSnapshot,
} from './metrics-state.js';
export { MetricsExportError } from './metrics-otlp.js';

/**
 * Agentia —— 指标（D3 → 可观测下沉 E2/E3/E4/E5）。
 *
 * `MetricsSink` **天然满足** `TraceSink` → `createApp({ sinks: [metricsSink()] })` 即接入，
 * **零新出口**（与 `createOtlpExporter` 同款）。全部数值从 `Trace` 派生，宿主不需要
 * 在业务代码里埋点。
 *
 * 三个维度（都是**进程内累加**，不是分布式聚合）：
 * - **run 级**：总数 / 失败数 / token 四类 / 成本 / 时长；
 * - **能力级**（E2）：`tool` 来自 turn 上的 `tool.output` 事件（E1 补的 `durationMs`/`ok`），
 *   `skill` / `subagent` 来自 `capability` span（tracer 已把子孙 llm.turn 的 usage 聚合上去）；
 *   `@Prompt` 不建 span、无独立耗时，**不产出**能力指标（如实缺省，不硬凑）；
 * - **模型级**（E3）：来自 `llm.turn` span（其 `name` 即模型 id）。
 * - **评分级**（R7 质量闭环）：来自 run 根 span 的 `score` 事件（`attachScore` 写入）——
 *   gauge 记**最近一次**值（分数不是累加量），counter 记条数；label 为 `name` × `source`。
 *
 * 时长同时给两种口径（histogram 与分位 gauge 必须用**不同指标名**，见 `render()` 注释）：
 * - **histogram**（`*_bucket` / `*_sum` / `*_count`，累积语义）—— 抓取端可跨实例任意聚合；
 * - **窗口内精确分位**（`*_last{quantile=...}` gauge）—— 单实例排障时更好读。
 *
 * 零依赖：Prometheus 文本与 OTLP/JSON 都手写（纯文本 / JSON，不值得为此引客户端库）。
 */

export interface MetricsSinkOptions {
  /**
   * 输出形态：
   * - `'prometheus'`（缺省）—— `render()` 出 Prometheus 文本，宿主挂到 `GET /metrics`；
   * - `'otlp'` —— 用全局 `fetch` POST 到 `${endpoint}/v1/metrics`（OTLP/JSON，零依赖）。
   *   必须给 `endpoint`（不给就构造期抛错，比"静默不导出"好）。
   */
  export?: 'prometheus' | 'otlp';
  /** `export:'otlp'` 的采集端基地址，例如 http://localhost:4318（尾部斜杠会被去掉） */
  endpoint?: string;
  /**
   * `export:'otlp'` 的导出间隔（毫秒），缺省 60000。
   * `0` = 每次 `export(trace)` 后立即导出（由框架 await，会拖慢收尾，仅测试/低流量用）。
   * 定时器已 `unref()`，不会阻止进程退出。
   */
  intervalMs?: number;
  /** `export:'otlp'` 的 resource 属性（除自动加的 `service.name`） */
  resourceAttributes?: Record<string, string>;
  /** `export:'otlp'` 的 service.name，缺省 'agentia' */
  serviceName?: string;
  /**
   * 单次导出请求超时（毫秒），缺省 10000；非正数 = 不限。
   * 裸 fetch 没有超时：collector 半开连接（accept 后永不回包）会让 `intervalMs:0` 模式
   * 的 run 收尾永久挂起。超时按导出失败处理（交 onExportError）——观测失败不击穿业务。
   */
  timeoutMs?: number;
  /** 导出失败回调（缺省吞掉 —— 观测失败不得击穿业务） */
  onExportError?: (err: unknown) => void;
  /**
   * 时长分位保留的样本数（环形窗口，缺省 1024，**run / 能力 / 模型各自独立**）。
   * 分位是**窗口内精确值**而非全历史近似 —— 长跑宿主不会被无界数组拖住内存，
   * 代价是分位只反映最近这么多条样本（这也是监控想要的）。
   *
   * 注意：每个能力/模型各持一个窗口，所以 windowSize 只是**系数**；真正封住内存的是
   * 三个基数上限（`maxCapabilities` / `maxModels` / `maxScores`）—— 上限 **×** 窗口
   * 才是常驻内存的上界，缺一个都是无界（见 `maxModels` 的注释）。
   */
  windowSize?: number;
  /** 指标名前缀，缺省 `agentia_` */
  prefix?: string;
  /**
   * 能力标签粒度（E2）：
   * - `'capability'`（缺省）—— 按 `kind:name`（如 `tool:search`）；
   * - `'kind'` —— 只按类型（`tool` / `skill` / `subagent`），基数极小；
   * - `'none'` —— 完全不产出能力指标。
   */
  labelMode?: 'capability' | 'kind' | 'none';
  /**
   * 能力标签基数上限（缺省 200，仅 `labelMode:'capability'` 生效）。
   * 超出后新能力归入 `capability="__other__"` —— 用户可定义任意多工具，裸打标签会打爆 Prometheus。
   */
  maxCapabilities?: number;
  /**
   * 模型维度基数上限（缺省 50）。超出后新模型归入 `"__other__"`
   * —— `model` 是 per-run 可覆盖的（`app.run(m, { model })`），
   * 上游把版本号/日期拼进模型 id（`claude-x-20260101`）时键会无界增长；
   * 而每个模型键都持一个 `windowSize` 环形窗口 + 一个直方图 → **无上限 = 无界内存**。
   *
   * 折叠**只丢标签粒度，不丢量**：`__other__` 桶照常累加 turn / token / 成本，
   * `snapshot().models` 的总量仍然对得上。被折叠的不同模型数见 `snapshot().droppedModels`。
   */
  maxModels?: number;
  /**
   * 评分维度基数上限（缺省 200）。评分键是 `name@source`（`attachScore` 的 name × source），
   * eval 名若由调用方拼出来（带时间戳/用例名）同样是无界键 → 同上折叠进 `"__other__"`。
   * 折叠后 gauge 语义（最近一次值）保留，只是不再区分是哪个评分维度；
   * 条数 / 总和照常累加，被折叠的不同评分维度数见 `snapshot().droppedScores`。
   */
  maxScores?: number;
  /** 时长直方图的桶边界（毫秒，升序）；缺省见 DEFAULT_BUCKETS */
  buckets?: readonly number[];
}

export interface MetricsSink extends TraceSink {
  snapshot(): MetricsSnapshot;
  /** Prometheus 文本格式（`text/plain; version=0.0.4`），零依赖手写 */
  render(): string;
  /** 主动导出一次（`export:'otlp'` 时有意义；prometheus 模式为空操作）。失败按 onExportError 处理 */
  flush(): Promise<void>;
  /** 停掉定时导出（进程收尾 / 测试用） */
  stop(): void;
  /** 清空累计（测试 / 多租户轮换用） */
  reset(): void;
}

const DEFAULT_WINDOW = 1024;
const DEFAULT_MAX_CAPABILITIES = 200;
/** 模型 id 实际就那么几个，默认给 50 已经很宽（够覆盖多版本并存的灰度期） */
const DEFAULT_MAX_MODELS = 50;
/** 评分维度 = `name@source`，一个应用的 eval 个数是有限的，默认与能力同宽 */
const DEFAULT_MAX_SCORES = 200;
/** 缺省时长桶（毫秒）：覆盖"工具几十毫秒 → run 几十秒"的常见区间 */
export const DEFAULT_BUCKETS: readonly number[] = [
  25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];

export function metricsSink(opts: MetricsSinkOptions = {}): MetricsSink {
  const format = opts.export ?? 'prometheus';
  if (format !== 'prometheus' && format !== 'otlp') {
    throw new Error(`metricsSink: export 只支持 'prometheus' | 'otlp'，收到 ${String(format)}`);
  }
  const otlpEndpoint = opts.endpoint?.replace(/\/+$/, '');
  if (format === 'otlp' && !otlpEndpoint) {
    throw new Error(`metricsSink: export:'otlp' 必须给 endpoint（如 http://localhost:4318）`);
  }
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW;
  if (!(windowSize > 0)) {
    throw new Error(`metricsSink: windowSize 必须为正数，收到 ${opts.windowSize}`);
  }
  const maxCapabilities = opts.maxCapabilities ?? DEFAULT_MAX_CAPABILITIES;
  if (!(maxCapabilities > 0)) {
    throw new Error(`metricsSink: maxCapabilities 必须为正数，收到 ${opts.maxCapabilities}`);
  }
  const maxModels = opts.maxModels ?? DEFAULT_MAX_MODELS;
  if (!(maxModels > 0)) {
    throw new Error(`metricsSink: maxModels 必须为正数，收到 ${opts.maxModels}`);
  }
  const maxScores = opts.maxScores ?? DEFAULT_MAX_SCORES;
  if (!(maxScores > 0)) {
    throw new Error(`metricsSink: maxScores 必须为正数，收到 ${opts.maxScores}`);
  }
  const labelMode = opts.labelMode ?? 'capability';
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]! <= buckets[i - 1]!) {
      throw new Error(`metricsSink: buckets 必须严格升序，收到 [${buckets.join(', ')}]`);
    }
  }
  const p = opts.prefix ?? 'agentia_';
  const intervalMs = opts.intervalMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const serviceName = opts.serviceName ?? 'agentia';
  const startedAtMs = Date.now();

  const state = new MetricsState({
    windowSize,
    maxCapabilities,
    maxModels,
    maxScores,
    labelMode,
    buckets,
  });

  const snapshot = (): MetricsSnapshot => state.snapshot();

  const render = (): string => renderPrometheus(state, p);

  const flush = async (): Promise<void> => {
    if (format !== 'otlp') return; // prometheus 模式：拉取式，无主动导出
    await flushOtlpMetrics(state, {
      prefix: p,
      serviceName,
      startedAtMs,
      // 构造期校验保证 otlp 模式下 endpoint 必填
      endpoint: otlpEndpoint!,
      timeoutMs,
      // exactOptionalPropertyTypes：可选字段不能赋 undefined，只能条件展开
      ...(opts.resourceAttributes !== undefined
        ? { resourceAttributes: opts.resourceAttributes }
        : {}),
      ...(opts.onExportError !== undefined ? { onExportError: opts.onExportError } : {}),
    });
  };

  const timer =
    format === 'otlp' && intervalMs > 0
      ? setInterval(() => {
          void flush();
        }, intervalMs)
      : undefined;
  // 定时导出不该把进程吊住
  timer?.unref?.();

  return {
    export(trace: Trace): void | Promise<void> {
      state.accumulate(trace);
      // intervalMs=0：立即导出并由框架 await；否则只累加，定时器负责导出
      if (format === 'otlp' && intervalMs === 0) return flush();
      return undefined;
    },

    snapshot,
    render,
    flush,

    stop(): void {
      if (timer) clearInterval(timer);
    },

    reset(): void {
      state.reset();
    },
  };
}
