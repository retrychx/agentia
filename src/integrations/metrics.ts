import { capabilityKindOf } from '../core/trace.js';
import type { Trace, TraceSink } from '../core/trace.js';
import { percentile } from '../core/stats.js';

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

/** 能力维度指标（`snapshot().capabilities[label]`） */
export interface CapabilityMetrics {
  /** 该能力的调用次数 */
  calls: number;
  /** 其中失败次数（工具 `ok:false`；skill/subagent 的 capability span `status:'error'`） */
  errors: number;
  /** 单次调用耗时（毫秒）的窗口内精确分位；无样本时 0 */
  latencyP50: number;
  latencyP95: number;
  /** 仅 skill/subagent：子孙 llm.turn 的 token 聚合（四类之和）；工具为 null */
  tokens: number | null;
  /** 仅 skill/subagent：估算成本（美元）；未定价或工具为 null */
  costUsd: number | null;
}

/** 模型维度指标（`snapshot().models[model]`） */
export interface ModelMetrics {
  /** 该模型的 llm.turn 次数 */
  turns: number;
  /** 四类 token 之和 */
  tokens: number;
  /** 已定价部分的成本（美元）；全未定价时为 0 */
  costUsd: number;
  /** 成本估不出来的 turn 数（模型不在价格表内，且未用 priceOverrides 覆盖）*/
  unpricedTurns: number;
  latencyP50: number;
  latencyP95: number;
}

/** 评分维度指标（`snapshot().scores[key]`，key 为 `name@source`，source 缺省时裸 name） */
export interface ScoreMetrics {
  /** 最近一次评分值（gauge 语义 —— 分数不是累加量） */
  value: number;
  /** 评分条数 */
  count: number;
  /** 评分值合计（平均 = sum / count） */
  sum: number;
}

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
  /**
   * 能力维度（`labelMode:'none'` 时为空对象）。超 `maxCapabilities` 的键折叠在
   * `'__other__'` —— 该桶照常累加，所以这里的**总量**不受上限影响。
   */
  capabilities: Record<string, CapabilityMetrics>;
  /** 模型维度；超 `maxModels` 的键折叠在 `'__other__'`（同上：总量不丢） */
  models: Record<string, ModelMetrics>;
  /**
   * 评分维度（key 为 `name@source`，source 缺省时裸 name；无评分时为空对象）；
   * 超 `maxScores` 的键折叠在 `'__other__'`。
   */
  scores: Record<string, ScoreMetrics>;
  /** 因 `maxCapabilities` 上限被归入 `__other__` 的不同能力数 */
  droppedCapabilities: number;
  /** 因 `maxModels` 上限被归入 `__other__` 的不同模型数 */
  droppedModels: number;
  /** 因 `maxScores` 上限被归入 `__other__` 的不同评分维度数 */
  droppedScores: number;
  // 注：三个计数各自最多记账 1024 个不同键，满了以后是**下界**（那已是键空间失控的
  // 量级，报警够用）。要精确值就得为无界键空间留一本无界的账 —— 与设上限的初衷相反。
}

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

/** 超过基数上限后新键的兜底标签（能力 / 模型 / 评分三个维度共用） */
const OTHER_LABEL = '__other__';

/**
 * 折叠计数最多记这么多个**不同**键（每个维度各一本）。计数只用于报警「基数爆了」，
 * 不值得为它留一本无界的账 —— 那等于把上限又拆掉一角。正常上限（50~200）下这个数
 * 远够用：真要记满，说明键空间已经失控，此时「≥1024」和精确值一样能说明问题。
 */
const MAX_DROPPED_TRACKING = 1024;

/**
 * 标签基数配额：三个维度共用的「有界键空间」。
 *
 * 键第一次出现且在额度内 → 分到自己的标签（**永远认自己**，不会时而被折叠时而不折叠）；
 * 超限 → 归入 `OTHER_LABEL`。
 *
 * 被折叠的键记进 `over`，只为回答「多少个**不同**的键被折叠了」；这本账自身也有界
 * （`MAX_DROPPED_TRACKING`），满了以后 `dropped` 是下界。
 */
class KeyBudget {
  private readonly assigned = new Set<string>();
  private readonly over = new Set<string>();

  constructor(private readonly max: number) {}

  /** 取键的标签：额度内原样返回，超限返回 `OTHER_LABEL` */
  take(key: string): string {
    if (this.assigned.has(key)) return key;
    if (this.assigned.size < this.max) {
      this.assigned.add(key);
      return key;
    }
    if (this.over.size < MAX_DROPPED_TRACKING) this.over.add(key);
    return OTHER_LABEL;
  }

  /** 被折叠的**不同**键数（记满 `MAX_DROPPED_TRACKING` 后为下界） */
  get dropped(): number {
    return this.over.size;
  }

  /** 清空配额（`reset()` 用）—— 与 `capabilities` / `models` / `scores` 三张表同步清 */
  reset(): void {
    this.assigned.clear();
    this.over.clear();
  }
}

/**
 * 时长统计：环形窗口（算窗口内精确分位）+ 累积直方图（算可聚合的 bucket）。
 * run / 能力 / 模型共用同一个实现，保证三种粒度的口径与取整完全一致。
 */
class DurationStat {
  private readonly ring: number[] = [];
  private cursor = 0;
  /** 每桶非累积计数：counts[i] 对应 le = bounds[i]；末位是 +Inf 桶 */
  private readonly counts: number[];
  private total = 0;
  private sum = 0;

  constructor(
    private readonly windowSize: number,
    private readonly bounds: readonly number[],
  ) {
    this.counts = new Array(bounds.length + 1).fill(0);
  }

  add(ms: number): void {
    this.total++;
    this.sum += ms;
    if (this.ring.length < this.windowSize) this.ring.push(ms);
    else {
      this.ring[this.cursor] = ms;
      this.cursor = (this.cursor + 1) % this.windowSize;
    }
    let i = 0;
    while (i < this.bounds.length && ms > this.bounds[i]!) i++;
    this.counts[i]!++;
  }

  get count(): number {
    return this.total;
  }

  get sumMs(): number {
    return this.sum;
  }

  get windowSamples(): number {
    return this.ring.length;
  }

  /**
   * 窗口内精确分位（Prometheus 的 quantile 语义：取第 ceil(q·n) 个样本）。
   * 算法单源在 `core/stats.ts` —— 与 `report.ts` 的时长 p50/p95 必须同口径，
   * 否则同一条 trace 在看板与报告里会有两个 p95。
   */
  percentile(q: number): number {
    if (this.ring.length === 0) return 0;
    const sorted = [...this.ring].sort((a, b) => a - b);
    return percentile(sorted, q);
  }

  /** 累积 bucket 计数（长度 = bounds+1，末位为 +Inf = count）—— Prometheus 文本语义 */
  cumulative(): number[] {
    const out: number[] = [];
    let running = 0;
    for (const c of this.counts) {
      running += c;
      out.push(running);
    }
    return out;
  }

  /** 每桶**非累积**计数 —— OTLP histogram 的 bucketCounts 语义（与 cumulative() 千万别混用） */
  perBucket(): number[] {
    return [...this.counts];
  }

  get boundsList(): readonly number[] {
    return this.bounds;
  }

  reset(): void {
    this.ring.length = 0;
    this.cursor = 0;
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
  }
}

/** 能力累加器：调用数 / 失败数 / 时长；skill·subagent 还带 token 与成本 */
interface CapabilityAcc {
  calls: number;
  errors: number;
  stat: DurationStat;
  tokens: number | null;
  costUsd: number | null;
}

interface ModelAcc {
  turns: number;
  tokens: number;
  costUsd: number;
  unpricedTurns: number;
  stat: DurationStat;
}

/** run 时长：取根 span（`trace.rootSpanId`）的起止；根没收尾（如 sink 在失败路径拿到半截）时返回 undefined */
function runDurationMs(trace: Trace): number | undefined {
  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  if (!root || root.endedAt === undefined) return undefined;
  return root.endedAt - root.startedAt;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 评分键 → 指标标签。键有两种形态：**折叠桶**（`__other__`，整个键就是标签，不含 `\t`）
 * 与正常的 `name\tsource`（source 缺省为 ''）。两个出口（Prometheus 文本 / OTLP）共用一处
 * 解码 —— 各切各的必然有一处把折叠桶切成乱码。
 */
function scoreLabels(key: string): { name: string; source: string } {
  if (key === OTHER_LABEL) return { name: OTHER_LABEL, source: '' };
  const tab = key.indexOf('\t');
  return { name: key.slice(0, tab), source: key.slice(tab + 1) };
}

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

  let runs = 0;
  let failed = 0;
  let costUsd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const runStat = new DurationStat(windowSize, buckets);

  const capabilities = new Map<string, CapabilityAcc>();
  const models = new Map<string, ModelAcc>();
  /** 评分累加器：key = `${name}\t${source}`（source 缺省 ''；\t 不会出现在正常评分名里，做天然分隔符） */
  const scores = new Map<string, ScoreMetrics>();
  // 三个维度的键空间都封在这些配额里 —— 没有它们，三张 Map 与各自的时长窗口都是无界的
  const capBudget = new KeyBudget(maxCapabilities);
  const modelBudget = new KeyBudget(maxModels);
  const scoreBudget = new KeyBudget(maxScores);

  const newCapability = (): CapabilityAcc => ({
    calls: 0,
    errors: 0,
    stat: new DurationStat(windowSize, buckets),
    tokens: null,
    costUsd: null,
  });

  /** 能力标签分配：labelMode 决定粒度，capBudget 决定基数上限 */
  const labelFor = (kind: string, name: string): string | null => {
    if (labelMode === 'none') return null;
    if (labelMode === 'kind') return kind;
    return capBudget.take(`${kind}:${name}`);
  };

  const accumulate = (trace: Trace): void => {
    runs++;
    if (trace.status === 'error') failed++;
    const u = trace.totalUsage;
    tokens.input += u.inputTokens;
    tokens.output += u.outputTokens;
    tokens.cacheRead += u.cacheReadTokens;
    tokens.cacheCreation += u.cacheCreationTokens;
    if (u.costEstimate != null) costUsd += u.costEstimate;

    const d = runDurationMs(trace);
    if (d !== undefined) runStat.add(d);

    // —— 评分（R7）：只认根 span 的 score 事件（attachScore 的写入位置）；
    // body 宽容读取 —— name 不是 string / value 不是有限 number 就跳过，观测不击穿业务
    const rootSpan = trace.spans.find((s) => s.spanId === trace.rootSpanId);
    if (rootSpan) {
      for (const e of rootSpan.events) {
        if (e.name !== 'score') continue;
        const body = e.body as Record<string, unknown> | null;
        if (!body || typeof body !== 'object') continue;
        if (typeof body.name !== 'string') continue;
        if (typeof body.value !== 'number' || !Number.isFinite(body.value)) continue;
        const source = typeof body.source === 'string' ? body.source : '';
        const key = scoreBudget.take(`${body.name}\t${source}`);
        const acc = scores.get(key) ?? { value: 0, count: 0, sum: 0 };
        acc.value = body.value; // gauge 语义：覆盖为最近一次
        acc.count++;
        acc.sum += body.value;
        scores.set(key, acc);
      }
    }

    for (const span of trace.spans) {
      if (span.kind === 'capability') {
        const label = labelFor(capabilityKindOf(span), span.name);
        // 时长与错误无论哪种 labelMode 都要累计；labelMode:'none' 时整块跳过
        if (label !== null) {
          const acc = capabilities.get(label) ?? newCapability();
          acc.calls++;
          if (span.status === 'error') acc.errors++;
          if (span.endedAt !== undefined) acc.stat.add(Math.max(0, span.endedAt - span.startedAt));
          // capability.usage = 子孙 llm.turn 聚合（tracer 写入）；工具没有这个语义
          if (span.usage) {
            const sum =
              span.usage.inputTokens +
              span.usage.outputTokens +
              span.usage.cacheReadTokens +
              span.usage.cacheCreationTokens;
            acc.tokens = (acc.tokens ?? 0) + sum;
            if (span.usage.costEstimate != null)
              acc.costUsd = (acc.costUsd ?? 0) + span.usage.costEstimate;
          }
          capabilities.set(label, acc);
        }
        continue;
      }
      if (span.kind === 'llm.turn') {
        const model = modelBudget.take(span.name);
        const acc = models.get(model) ?? {
          turns: 0,
          tokens: 0,
          costUsd: 0,
          unpricedTurns: 0,
          stat: new DurationStat(windowSize, buckets),
        };
        acc.turns++;
        if (span.usage) {
          acc.tokens +=
            span.usage.inputTokens +
            span.usage.outputTokens +
            span.usage.cacheReadTokens +
            span.usage.cacheCreationTokens;
          if (span.usage.costEstimate != null) acc.costUsd += span.usage.costEstimate;
          else acc.unpricedTurns++; // 有计量却算不出成本 = 模型不在价格表内
        }
        if (span.endedAt !== undefined) acc.stat.add(Math.max(0, span.endedAt - span.startedAt));
        models.set(model, acc);
        // 普通工具的耗时/成败在 turn 的 tool.output 事件上（E1）—— 能力指标的另一路数据源
        for (const e of span.events) {
          if (e.name !== 'tool.output') continue;
          const body = e.body as Record<string, unknown> | null;
          if (!body || typeof body !== 'object' || typeof body.tool !== 'string') continue;
          const label = labelFor('tool', body.tool);
          if (label === null) continue;
          const tacc = capabilities.get(label) ?? newCapability();
          tacc.calls++;
          if (body.ok === false) tacc.errors++;
          tacc.stat.add(Math.max(0, num(body.durationMs)));
          capabilities.set(label, tacc);
        }
      }
    }
  };

  const snapshot = (): MetricsSnapshot => {
    const capabilityOut: Record<string, CapabilityMetrics> = {};
    if (labelMode !== 'none') {
      for (const [label, acc] of capabilities) {
        capabilityOut[label] = {
          calls: acc.calls,
          errors: acc.errors,
          latencyP50: acc.stat.percentile(0.5),
          latencyP95: acc.stat.percentile(0.95),
          tokens: acc.tokens,
          costUsd: acc.costUsd,
        };
      }
    }
    const modelOut: Record<string, ModelMetrics> = {};
    for (const [model, acc] of models) {
      modelOut[model] = {
        turns: acc.turns,
        tokens: acc.tokens,
        costUsd: acc.costUsd,
        unpricedTurns: acc.unpricedTurns,
        latencyP50: acc.stat.percentile(0.5),
        latencyP95: acc.stat.percentile(0.95),
      };
    }
    const scoreOut: Record<string, ScoreMetrics> = {};
    for (const [key, acc] of scores) {
      // 折叠桶没有 `name@source` 可黏（也不该有），原样以 `__other__` 出
      if (key === OTHER_LABEL) {
        scoreOut[OTHER_LABEL] = { ...acc };
        continue;
      }
      const { name, source } = scoreLabels(key);
      scoreOut[source === '' ? name : `${name}@${source}`] = { ...acc };
    }
    return {
      runs,
      failed,
      latencyP50: runStat.percentile(0.5),
      latencyP95: runStat.percentile(0.95),
      tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
      costUsd,
      capabilities: capabilityOut,
      models: modelOut,
      scores: scoreOut,
      droppedCapabilities: capBudget.dropped,
      droppedModels: modelBudget.dropped,
      droppedScores: scoreBudget.dropped,
    };
  };

  /**
   * 一个指标家族的完整块：HELP/TYPE 各**恰好一行**，后接全部样本行。
   * expfmt 对同名指标的第二条 HELP/TYPE 是**硬错误**（整次 scrape 失败），
   * 所以家族头必须集中在这里发一次，绝不能让每条样本自带；同名指标也只能有一种 TYPE
   * （histogram 与分位 gauge 因此拆成 `*_duration_ms` 与 `*_duration_ms_last` 两个名字）。
   */
  const family = (
    name: string,
    type: 'counter' | 'gauge' | 'histogram',
    help: string,
    samples: string[],
  ): string => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${samples.join('\n')}\n`;

  /** Prometheus label 值转义：\、"、换行必须转义，否则一个含引号的能力名/模型名就损坏整页 exposition */
  const escLabel = (v: string): string =>
    v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

  /** 一个 stat 的 histogram 样本（bucket 累积 + sum + count），labels 形如 `{k="v"}` */
  const histogramSamples = (name: string, stat: DurationStat, labels = ''): string[] => {
    const inner = labels ? labels.slice(1, -1) + ',' : ''; // 去掉外层 {} 再补逗号
    const at = (extra: string): string => `{${inner}${extra}}`;
    const out: string[] = [];
    const cum = stat.cumulative();
    for (let i = 0; i < stat.boundsList.length; i++) {
      out.push(`${name}_bucket${at(`le="${stat.boundsList[i]}"`)} ${cum[i]}`);
    }
    out.push(`${name}_bucket${at(`le="+Inf"`)} ${stat.count}`);
    out.push(`${name}_sum${labels} ${stat.sumMs}`);
    out.push(`${name}_count${labels} ${stat.count}`);
    return out;
  };

  const render = (): string => {
    const out: string[] = [];
    out.push(
      family(`${p}runs_total`, 'counter', 'run 总数（成功 + 失败）', [`${p}runs_total ${runs}`]),
    );
    out.push(
      family(`${p}runs_failed_total`, 'counter', '失败的 run 数（trace.status=error）', [
        `${p}runs_failed_total ${failed}`,
      ]),
    );
    out.push(
      family(
        `${p}tokens_total`,
        'counter',
        'token 累计（kind 分项：input / output / cache_read / cache_creation）',
        [
          `${p}tokens_total{kind="input"} ${tokens.input}`,
          `${p}tokens_total{kind="output"} ${tokens.output}`,
          `${p}tokens_total{kind="cache_read"} ${tokens.cacheRead}`,
          `${p}tokens_total{kind="cache_creation"} ${tokens.cacheCreation}`,
        ],
      ),
    );
    out.push(
      family(`${p}cost_usd_total`, 'counter', '累计成本估算（美元）', [
        `${p}cost_usd_total ${costUsd}`,
      ]),
    );
    // 基数上限的**可见性**：被折叠掉的不同键数。与 `snapshot()` 的同名字段一一对应 ——
    // 此前只有 snapshot() 有、render() 没有，于是「按文档把 metricsSink 接到 /metrics」的部署
    // **完全看不见折叠发生**（静默丢失）；而同一份文件对「算不出成本的 turn」专门发了
    // `model_unpriced_turns_total`，口径不一致。
    // 与 unpriced 不同：**恒定发三行**（不是 >0 才发）—— 「0 → N」这个变化本身就是要告警的信号。
    out.push(
      family(`${p}dropped_keys`, 'gauge', '因基数上限被折叠的不同键数（kind 分项）', [
        `${p}dropped_keys{kind="capability"} ${capBudget.dropped}`,
        `${p}dropped_keys{kind="model"} ${modelBudget.dropped}`,
        `${p}dropped_keys{kind="score"} ${scoreBudget.dropped}`,
      ]),
    );
    // 时长：histogram（可跨实例聚合）+ 窗口内精确分位（单实例好读），两种口径并存。
    // 分位 gauge 必须用另一个名字 `*_last` —— 同名指标只允许一种 TYPE，
    // 先发 histogram 再发 gauge 会被 expfmt 判硬错误，整次 scrape 失败。
    out.push(
      family(`${p}run_duration_ms`, 'histogram', 'run 时长（毫秒）', [
        ...histogramSamples(`${p}run_duration_ms`, runStat),
      ]),
    );
    out.push(
      family(`${p}run_duration_ms_last`, 'gauge', 'run 时长分位（毫秒，滑动窗口内精确值）', [
        `${p}run_duration_ms_last{quantile="0.5"} ${runStat.percentile(0.5)}`,
        `${p}run_duration_ms_last{quantile="0.95"} ${runStat.percentile(0.95)}`,
      ]),
    );

    // —— 能力维度（E2）：同一家族的样本跨 label 聚合，家族头只发一次 ——
    const capLabels = [...capabilities.keys()].sort();
    if (capLabels.length > 0) {
      const calls: string[] = [];
      const errors: string[] = [];
      const durations: string[] = [];
      const durationQuantiles: string[] = [];
      const capabilityTokens: string[] = [];
      const capabilityCosts: string[] = [];
      for (const label of capLabels) {
        const acc = capabilities.get(label)!;
        const lv = escLabel(label);
        const l = `{capability="${lv}"}`;
        calls.push(`${p}capability_calls_total${l} ${acc.calls}`);
        errors.push(`${p}capability_errors_total${l} ${acc.errors}`);
        durations.push(...histogramSamples(`${p}capability_duration_ms`, acc.stat, l));
        durationQuantiles.push(
          `${p}capability_duration_ms_last{capability="${lv}",quantile="0.5"} ${acc.stat.percentile(0.5)}`,
          `${p}capability_duration_ms_last{capability="${lv}",quantile="0.95"} ${acc.stat.percentile(0.95)}`,
        );
        if (acc.tokens !== null)
          capabilityTokens.push(`${p}capability_tokens_total${l} ${acc.tokens}`);
        if (acc.costUsd !== null)
          capabilityCosts.push(`${p}capability_cost_usd_total${l} ${acc.costUsd}`);
      }
      out.push(family(`${p}capability_calls_total`, 'counter', '能力调用次数', calls));
      out.push(family(`${p}capability_errors_total`, 'counter', '能力失败次数', errors));
      out.push(
        family(`${p}capability_duration_ms`, 'histogram', '能力调用耗时（毫秒）', durations),
      );
      out.push(
        family(
          `${p}capability_duration_ms_last`,
          'gauge',
          '能力调用耗时分位（窗口内精确值）',
          durationQuantiles,
        ),
      );
      if (capabilityTokens.length > 0) {
        out.push(
          family(
            `${p}capability_tokens_total`,
            'counter',
            'skill/subagent 的子孙 token 合计',
            capabilityTokens,
          ),
        );
      }
      if (capabilityCosts.length > 0) {
        out.push(
          family(
            `${p}capability_cost_usd_total`,
            'counter',
            'skill/subagent 的估算成本（美元）',
            capabilityCosts,
          ),
        );
      }
    }

    // —— 模型维度（E3）——
    const modelNames = [...models.keys()].sort();
    if (modelNames.length > 0) {
      const turns: string[] = [];
      const modelTokens: string[] = [];
      const modelCosts: string[] = [];
      const unpriced: string[] = [];
      const durations: string[] = [];
      const durationQuantiles: string[] = [];
      for (const model of modelNames) {
        const acc = models.get(model)!;
        const mv = escLabel(model);
        const l = `{model="${mv}"}`;
        turns.push(`${p}model_turns_total${l} ${acc.turns}`);
        modelTokens.push(`${p}model_tokens_total${l} ${acc.tokens}`);
        modelCosts.push(`${p}model_cost_usd_total${l} ${acc.costUsd}`);
        if (acc.unpricedTurns > 0)
          unpriced.push(`${p}model_unpriced_turns_total${l} ${acc.unpricedTurns}`);
        durations.push(...histogramSamples(`${p}model_duration_ms`, acc.stat, l));
        durationQuantiles.push(
          `${p}model_duration_ms_last{model="${mv}",quantile="0.5"} ${acc.stat.percentile(0.5)}`,
          `${p}model_duration_ms_last{model="${mv}",quantile="0.95"} ${acc.stat.percentile(0.95)}`,
        );
      }
      out.push(family(`${p}model_turns_total`, 'counter', '模型往返次数', turns));
      out.push(
        family(`${p}model_tokens_total`, 'counter', '模型 token 合计（四类之和）', modelTokens),
      );
      out.push(
        family(
          `${p}model_cost_usd_total`,
          'counter',
          '模型估算成本（美元，仅已定价部分）',
          modelCosts,
        ),
      );
      if (unpriced.length > 0) {
        out.push(
          family(
            `${p}model_unpriced_turns_total`,
            'counter',
            '算不出成本的 turn 数（模型不在价格表内）',
            unpriced,
          ),
        );
      }
      out.push(family(`${p}model_duration_ms`, 'histogram', '模型往返耗时（毫秒）', durations));
      out.push(
        family(
          `${p}model_duration_ms_last`,
          'gauge',
          '模型往返耗时分位（窗口内精确值）',
          durationQuantiles,
        ),
      );
    }

    // —— 评分维度（R7）：gauge 记最近一次值、counter 记条数，label 为 name × source ——
    if (scores.size > 0) {
      const gaugeSamples: string[] = [];
      const counterSamples: string[] = [];
      for (const key of [...scores.keys()].sort()) {
        const acc = scores.get(key)!;
        const { name, source } = scoreLabels(key);
        const l = `{name="${escLabel(name)}",source="${escLabel(source)}"}`;
        gaugeSamples.push(`${p}score${l} ${acc.value}`);
        counterSamples.push(`${p}score_total${l} ${acc.count}`);
      }
      out.push(
        family(`${p}score`, 'gauge', '最近一次评分（label 为评分维度与来源）', gaugeSamples),
      );
      out.push(family(`${p}score_total`, 'counter', '评分条数', counterSamples));
    }
    return out.join('');
  };

  // —— OTLP/JSON 导出（E5）——
  // epoch 毫秒 ×1e6 ≈ 1.7e18 > 2^53，double 直接乘会丢精度 —— 必须先取整再转 BigInt
  const nanos = (ms: number): string => String(BigInt(Math.round(ms)) * 1_000_000n);
  type OtlpAttr = { key: string; value: Record<string, unknown> };
  const strAttr = (key: string, v: string): OtlpAttr => ({ key, value: { stringValue: v } });

  const buildOtlpPayload = () => {
    const now = nanos(Date.now());
    const start = nanos(startedAtMs);
    const s = snapshot();
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
    sum(`${p}tokens_total`, tokens.input, tokensHelp, [strAttr('kind', 'input')]);
    sum(`${p}tokens_total`, tokens.output, tokensHelp, [strAttr('kind', 'output')]);
    sum(`${p}tokens_total`, tokens.cacheRead, tokensHelp, [strAttr('kind', 'cache_read')]);
    sum(`${p}tokens_total`, tokens.cacheCreation, tokensHelp, [strAttr('kind', 'cache_creation')]);
    sumDouble(`${p}cost_usd_total`, s.costUsd, '累计成本估算（美元）', []);
    hist(`${p}run_duration_ms`, runStat, 'run 时长（毫秒）', []);

    for (const label of [...capabilities.keys()].sort()) {
      const acc = capabilities.get(label)!;
      const attrs = [strAttr('capability', label)];
      sum(`${p}capability_calls_total`, acc.calls, '能力调用次数', attrs);
      sum(`${p}capability_errors_total`, acc.errors, '能力失败次数', attrs);
      hist(`${p}capability_duration_ms`, acc.stat, '能力调用耗时（毫秒）', attrs);
      if (acc.tokens !== null)
        sum(`${p}capability_tokens_total`, acc.tokens, '子孙 token 合计', attrs);
      if (acc.costUsd !== null)
        sumDouble(`${p}capability_cost_usd_total`, acc.costUsd, '估算成本（美元）', attrs);
    }
    for (const model of [...models.keys()].sort()) {
      const acc = models.get(model)!;
      const attrs = [strAttr('model', model)];
      sum(`${p}model_turns_total`, acc.turns, '模型往返次数', attrs);
      sum(`${p}model_tokens_total`, acc.tokens, '模型 token 合计', attrs);
      sumDouble(`${p}model_cost_usd_total`, acc.costUsd, '模型估算成本（美元）', attrs);
      if (acc.unpricedTurns > 0) {
        sum(`${p}model_unpriced_turns_total`, acc.unpricedTurns, '未定价 turn 数', attrs);
      }
      hist(`${p}model_duration_ms`, acc.stat, '模型往返耗时（毫秒）', attrs);
    }
    for (const key of [...scores.keys()].sort()) {
      const acc = scores.get(key)!;
      const { name, source } = scoreLabels(key);
      const attrs = [strAttr('name', name), strAttr('source', source)];
      gauge(`${p}score`, acc.value, '最近一次评分', attrs);
      sum(`${p}score_total`, acc.count, '评分条数', attrs);
    }

    // 基数上限可见性（与 Prometheus 侧 `*_dropped_keys{kind=…}` 同名同义）：
    // 三个 kind 收进同一个 gauge Metric
    const droppedHelp = '因基数上限被折叠的不同键数';
    gauge(`${p}dropped_keys`, capBudget.dropped, droppedHelp, [strAttr('kind', 'capability')]);
    gauge(`${p}dropped_keys`, modelBudget.dropped, droppedHelp, [strAttr('kind', 'model')]);
    gauge(`${p}dropped_keys`, scoreBudget.dropped, droppedHelp, [strAttr('kind', 'score')]);

    const metrics = [...metricTable.values()];

    const resourceAttrs: OtlpAttr[] = [
      strAttr('service.name', serviceName),
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
  };

  const flush = async (): Promise<void> => {
    if (format !== 'otlp') return; // prometheus 模式：拉取式，无主动导出
    let payload: unknown;
    try {
      payload = buildOtlpPayload();
    } catch (e) {
      opts.onExportError?.(e);
      return;
    }
    try {
      const res = await fetch(`${otlpEndpoint}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new MetricsExportError(
          res.status,
          `OTLP metrics 导出失败: HTTP ${res.status} ${text}`,
        );
      }
    } catch (e) {
      opts.onExportError?.(e); // 观测失败不得击穿业务
    }
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
      accumulate(trace);
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
      runs = 0;
      failed = 0;
      costUsd = 0;
      tokens.input = 0;
      tokens.output = 0;
      tokens.cacheRead = 0;
      tokens.cacheCreation = 0;
      runStat.reset();
      capabilities.clear();
      models.clear();
      scores.clear();
      capBudget.reset();
      modelBudget.reset();
      scoreBudget.reset();
    },
  };
}
