import type { Span, Trace, TraceSink } from '../core/trace.js';

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
  /** 能力维度（`labelMode:'none'` 时为空对象） */
  capabilities: Record<string, CapabilityMetrics>;
  /** 模型维度 */
  models: Record<string, ModelMetrics>;
  /** 评分维度（key 为 `name@source`，source 缺省时裸 name；无评分时为空对象） */
  scores: Record<string, ScoreMetrics>;
  /** 因 `maxCapabilities` 上限被归入 `__other__` 的不同能力数（未开启上限时为 0） */
  droppedCapabilities: number;
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
   * 注意：每个能力/模型各持一个窗口 → 内存上限 ≈ (1 + 能力数 + 模型数) × windowSize。
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
/** 缺省时长桶（毫秒）：覆盖"工具几十毫秒 → run 几十秒"的常见区间 */
export const DEFAULT_BUCKETS: readonly number[] = [
  25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];

/** 超过 maxCapabilities 后的兜底标签 */
const OTHER_CAPABILITY = '__other__';

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

  /** 窗口内精确分位（Prometheus 的 quantile 语义：取第 ceil(q·n) 个样本） */
  percentile(q: number): number {
    if (this.ring.length === 0) return 0;
    const sorted = [...this.ring].sort((a, b) => a - b);
    const rank = Math.ceil(q * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
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

/** 能力 span 的类型标签：`attributes.skill` → 'skill'，`attributes.subagent` → 'subagent'，否则 'capability' */
function capabilityKindOf(span: Span): string {
  if (span.attributes.skill !== undefined) return 'skill';
  if (span.attributes.subagent !== undefined) return 'subagent';
  return 'capability';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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
  /** 已分配独立标签的能力键（超 maxCapabilities 后新键归 __other__） */
  const assignedCapabilities = new Set<string>();
  /** 被归入 __other__ 的不同能力键 */
  const dropped = new Set<string>();

  const newCapability = (): CapabilityAcc => ({
    calls: 0,
    errors: 0,
    stat: new DurationStat(windowSize, buckets),
    tokens: null,
    costUsd: null,
  });

  /** 能力标签分配：labelMode 决定粒度，maxCapabilities 决定基数上限 */
  const labelFor = (kind: string, name: string): string | null => {
    if (labelMode === 'none') return null;
    if (labelMode === 'kind') return kind;
    const key = `${kind}:${name}`;
    if (assignedCapabilities.has(key)) return key;
    if (assignedCapabilities.size >= maxCapabilities) {
      dropped.add(key);
      return OTHER_CAPABILITY;
    }
    assignedCapabilities.add(key);
    return key;
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
        const key = `${body.name}\t${source}`;
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
        const model = span.name;
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
      const tab = key.indexOf('\t');
      const name = key.slice(0, tab);
      const source = key.slice(tab + 1);
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
      droppedCapabilities: dropped.size,
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
        const tab = key.indexOf('\t');
        const l = `{name="${escLabel(key.slice(0, tab))}",source="${escLabel(key.slice(tab + 1))}"}`;
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
    const sum = (
      name: string,
      value: number,
      help: string,
      attrs: OtlpAttr[],
      monotonic = true,
    ) => ({
      name,
      description: help,
      sum: {
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: monotonic,
        dataPoints: [
          { attributes: attrs, startTimeUnixNano: start, timeUnixNano: now, asInt: String(value) },
        ],
      },
    });
    // 浮点指标（成本）必须走 asDouble —— OTLP 的 asInt 是 string 编码 int64，
    // 塞浮点（如 0.25）会让 collector 直接拒收整批数据
    const sumDouble = (name: string, value: number, help: string, attrs: OtlpAttr[]) => ({
      name,
      description: help,
      sum: {
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: true,
        dataPoints: [
          { attributes: attrs, startTimeUnixNano: start, timeUnixNano: now, asDouble: value },
        ],
      },
    });
    // gauge 没有理由只收 int：评分值是浮点，统一走 asDouble
    const gauge = (name: string, value: number, help: string, attrs: OtlpAttr[]) => ({
      name,
      description: help,
      gauge: {
        dataPoints: [
          { attributes: attrs, startTimeUnixNano: start, timeUnixNano: now, asDouble: value },
        ],
      },
    });
    const hist = (name: string, stat: DurationStat, help: string, attrs: OtlpAttr[]) => ({
      name,
      description: help,
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [
          {
            attributes: attrs,
            startTimeUnixNano: start,
            timeUnixNano: now,
            count: stat.count,
            sum: stat.sumMs,
            // OTLP 的 bucketCounts 是每桶**非累积**计数（Prometheus 文本才是累积语义）
            bucketCounts: stat.perBucket(),
            explicitBounds: [...stat.boundsList],
          },
        ],
      },
    });

    const metrics: unknown[] = [
      sum(`${p}runs_total`, s.runs, 'run 总数', []),
      sum(`${p}runs_failed_total`, s.failed, '失败的 run 数', []),
      sum(`${p}tokens_total`, tokens.input, '输入 token 累计', [strAttr('kind', 'input')]),
      sum(`${p}tokens_total`, tokens.output, '输出 token 累计', [strAttr('kind', 'output')]),
      sum(`${p}tokens_total`, tokens.cacheRead, '缓存读 token 累计', [
        strAttr('kind', 'cache_read'),
      ]),
      sum(`${p}tokens_total`, tokens.cacheCreation, '缓存写 token 累计', [
        strAttr('kind', 'cache_creation'),
      ]),
      sumDouble(`${p}cost_usd_total`, s.costUsd, '累计成本估算（美元）', []),
      hist(`${p}run_duration_ms`, runStat, 'run 时长（毫秒）', []),
    ];
    for (const label of [...capabilities.keys()].sort()) {
      const acc = capabilities.get(label)!;
      const attrs = [strAttr('capability', label)];
      metrics.push(sum(`${p}capability_calls_total`, acc.calls, '能力调用次数', attrs));
      metrics.push(sum(`${p}capability_errors_total`, acc.errors, '能力失败次数', attrs));
      metrics.push(hist(`${p}capability_duration_ms`, acc.stat, '能力调用耗时（毫秒）', attrs));
      if (acc.tokens !== null)
        metrics.push(sum(`${p}capability_tokens_total`, acc.tokens, '子孙 token 合计', attrs));
      if (acc.costUsd !== null)
        metrics.push(
          sumDouble(`${p}capability_cost_usd_total`, acc.costUsd, '估算成本（美元）', attrs),
        );
    }
    for (const model of [...models.keys()].sort()) {
      const acc = models.get(model)!;
      const attrs = [strAttr('model', model)];
      metrics.push(sum(`${p}model_turns_total`, acc.turns, '模型往返次数', attrs));
      metrics.push(sum(`${p}model_tokens_total`, acc.tokens, '模型 token 合计', attrs));
      metrics.push(
        sumDouble(`${p}model_cost_usd_total`, acc.costUsd, '模型估算成本（美元）', attrs),
      );
      if (acc.unpricedTurns > 0) {
        metrics.push(
          sum(`${p}model_unpriced_turns_total`, acc.unpricedTurns, '未定价 turn 数', attrs),
        );
      }
      metrics.push(hist(`${p}model_duration_ms`, acc.stat, '模型往返耗时（毫秒）', attrs));
    }
    for (const key of [...scores.keys()].sort()) {
      const acc = scores.get(key)!;
      const tab = key.indexOf('\t');
      const attrs = [strAttr('name', key.slice(0, tab)), strAttr('source', key.slice(tab + 1))];
      metrics.push(gauge(`${p}score`, acc.value, '最近一次评分', attrs));
      metrics.push(sum(`${p}score_total`, acc.count, '评分条数', attrs));
    }

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
        throw new Error(`OTLP metrics 导出失败: HTTP ${res.status} ${text}`);
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
      assignedCapabilities.clear();
      dropped.clear();
    },
  };
}
