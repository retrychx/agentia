import type { Span, Trace, TraceSink, Usage } from '../core/trace.js';

/**
 * Agentia —— 指标（D3 → 可观测下沉 E2/E3/E4/E5）。
 *
 * `MetricsSink` **天然满足** `TraceSink` → `createApp({ sinks: [metricsSink()] })` 即接入，
 * **零新出口**（与 `createOtlpExporter` 同款）。全部数值从 `Trace` 派生，宿主不需要
 * 在业务代码里埋点。
 *
 * 三个维度（都是**进程内累加**，不是分布式聚合）：
 * - **run 级**：总数 / 失败数 / token 四类 / 成本 / 时长；
 * - **单元级**（E2）：`tool` 来自 turn 上的 `tool.output` 事件（E1 补的 `durationMs`/`ok`），
 *   `skill` / `subagent` 来自 `unit` span（tracer 已把子孙 llm.turn 的 usage 聚合上去）；
 *   `@Prompt` 不建 span、无独立耗时，**不产出**单元指标（如实缺省，不硬凑）；
 * - **模型级**（E3）：来自 `llm.turn` span（其 `name` 即模型 id）。
 *
 * 时长同时给两种口径，**并存不冲突**：
 * - **histogram**（`*_bucket` / `*_sum` / `*_count`，累积语义）—— 抓取端可跨实例任意聚合；
 * - **窗口内精确分位**（`*{quantile=...}` gauge）—— 单实例排障时更好读。
 *
 * 零依赖：Prometheus 文本与 OTLP/JSON 都手写（纯文本 / JSON，不值得为此引客户端库）。
 */

/** 单元维度指标（`snapshot().units[label]`） */
export interface UnitMetrics {
  /** 该单元的调用次数 */
  calls: number;
  /** 其中失败次数（工具 `ok:false`；skill/subagent 的 unit span `status:'error'`） */
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
  /** 单元维度（`labelMode:'none'` 时为空对象） */
  units: Record<string, UnitMetrics>;
  /** 模型维度 */
  models: Record<string, ModelMetrics>;
  /** 因 `maxUnits` 上限被归入 `__other__` 的不同单元数（未开启上限时为 0） */
  droppedUnits: number;
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
  /** 导出失败回调（缺省吞掉 —— 观测失败不得击穿业务） */
  onExportError?: (err: unknown) => void;
  /**
   * 时长分位保留的样本数（环形窗口，缺省 1024，**run / 单元 / 模型各自独立**）。
   * 分位是**窗口内精确值**而非全历史近似 —— 长跑宿主不会被无界数组拖住内存，
   * 代价是分位只反映最近这么多条样本（这也是监控想要的）。
   * 注意：每个单元/模型各持一个窗口 → 内存上限 ≈ (1 + 单元数 + 模型数) × windowSize。
   */
  windowSize?: number;
  /** 指标名前缀，缺省 `agentia_` */
  prefix?: string;
  /**
   * 单元标签粒度（E2）：
   * - `'unit'`（缺省）—— 按 `kind:name`（如 `tool:search`）；
   * - `'kind'` —— 只按类型（`tool` / `skill` / `subagent`），基数极小；
   * - `'none'` —— 完全不产出单元指标。
   */
  labelMode?: 'unit' | 'kind' | 'none';
  /**
   * 单元标签基数上限（缺省 200，仅 `labelMode:'unit'` 生效）。
   * 超出后新单元归入 `unit="__other__"` —— 用户可定义任意多工具，裸打标签会打爆 Prometheus。
   */
  maxUnits?: number;
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
const DEFAULT_MAX_UNITS = 200;
/** 缺省时长桶（毫秒）：覆盖"工具几十毫秒 → run 几十秒"的常见区间 */
export const DEFAULT_BUCKETS: readonly number[] = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/** 超过 maxUnits 后的兜底标签 */
const OTHER_UNIT = '__other__';

/**
 * 时长统计：环形窗口（算窗口内精确分位）+ 累积直方图（算可聚合的 bucket）。
 * run / 单元 / 模型共用同一个实现，保证三种粒度的口径与取整完全一致。
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

  /** 累积 bucket 计数（长度 = bounds+1，末位为 +Inf = count） */
  cumulative(): number[] {
    const out: number[] = [];
    let running = 0;
    for (const c of this.counts) {
      running += c;
      out.push(running);
    }
    return out;
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

/** 单元累加器：调用数 / 失败数 / 时长；skill·subagent 还带 token 与成本 */
interface UnitAcc {
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

/** 单元 span 的类型标签：`attributes.skill` → 'skill'，`attributes.subagent` → 'subagent'，否则 'unit' */
function unitKindOf(span: Span): string {
  if (span.attributes.skill !== undefined) return 'skill';
  if (span.attributes.subagent !== undefined) return 'subagent';
  return 'unit';
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
  const maxUnits = opts.maxUnits ?? DEFAULT_MAX_UNITS;
  if (!(maxUnits > 0)) {
    throw new Error(`metricsSink: maxUnits 必须为正数，收到 ${opts.maxUnits}`);
  }
  const labelMode = opts.labelMode ?? 'unit';
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]! <= buckets[i - 1]!) {
      throw new Error(`metricsSink: buckets 必须严格升序，收到 [${buckets.join(', ')}]`);
    }
  }
  const p = opts.prefix ?? 'agentia_';
  const intervalMs = opts.intervalMs ?? 60_000;
  const serviceName = opts.serviceName ?? 'agentia';
  const startedAtMs = Date.now();

  let runs = 0;
  let failed = 0;
  let costUsd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const runStat = new DurationStat(windowSize, buckets);

  const units = new Map<string, UnitAcc>();
  const models = new Map<string, ModelAcc>();
  /** 已分配独立标签的单元键（超 maxUnits 后新键归 __other__） */
  const assignedUnits = new Set<string>();
  /** 被归入 __other__ 的不同单元键 */
  const dropped = new Set<string>();

  const newUnit = (): UnitAcc => ({
    calls: 0,
    errors: 0,
    stat: new DurationStat(windowSize, buckets),
    tokens: null,
    costUsd: null,
  });

  /** 单元标签分配：labelMode 决定粒度，maxUnits 决定基数上限 */
  const labelFor = (kind: string, name: string): string | null => {
    if (labelMode === 'none') return null;
    if (labelMode === 'kind') return kind;
    const key = `${kind}:${name}`;
    if (assignedUnits.has(key)) return key;
    if (assignedUnits.size >= maxUnits) {
      dropped.add(key);
      return OTHER_UNIT;
    }
    assignedUnits.add(key);
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

    for (const span of trace.spans) {
      if (span.kind === 'unit') {
        const label = labelFor(unitKindOf(span), span.name);
        // 时长与错误无论哪种 labelMode 都要累计；labelMode:'none' 时整块跳过
        if (label !== null) {
          const acc = units.get(label) ?? newUnit();
          acc.calls++;
          if (span.status === 'error') acc.errors++;
          if (span.endedAt !== undefined) acc.stat.add(Math.max(0, span.endedAt - span.startedAt));
          // unit.usage = 子孙 llm.turn 聚合（tracer 写入）；工具没有这个语义
          if (span.usage) {
            const sum =
              span.usage.inputTokens +
              span.usage.outputTokens +
              span.usage.cacheReadTokens +
              span.usage.cacheCreationTokens;
            acc.tokens = (acc.tokens ?? 0) + sum;
            if (span.usage.costEstimate != null) acc.costUsd = (acc.costUsd ?? 0) + span.usage.costEstimate;
          }
          units.set(label, acc);
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
        // 普通工具的耗时/成败在 turn 的 tool.output 事件上（E1）—— 单元指标的另一路数据源
        for (const e of span.events) {
          if (e.name !== 'tool.output') continue;
          const body = e.body as Record<string, unknown> | null;
          if (!body || typeof body !== 'object' || typeof body.tool !== 'string') continue;
          const label = labelFor('tool', body.tool);
          if (label === null) continue;
          const tacc = units.get(label) ?? newUnit();
          tacc.calls++;
          if (body.ok === false) tacc.errors++;
          tacc.stat.add(Math.max(0, num(body.durationMs)));
          units.set(label, tacc);
        }
      }
    }
  };

  const snapshot = (): MetricsSnapshot => {
    const unitOut: Record<string, UnitMetrics> = {};
    if (labelMode !== 'none') {
      for (const [label, acc] of units) {
        unitOut[label] = {
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
    return {
      runs,
      failed,
      latencyP50: runStat.percentile(0.5),
      latencyP95: runStat.percentile(0.95),
      tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
      costUsd,
      units: unitOut,
      models: modelOut,
      droppedUnits: dropped.size,
    };
  };

  const line = (
    name: string,
    type: 'counter' | 'gauge',
    value: number,
    help: string,
    labels = '',
  ): string => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${labels} ${value}\n`;

  /** 一个 histogram 的三段输出（bucket 累积 + sum + count） */
  const histogram = (name: string, stat: DurationStat, help: string, labels = ''): string => {
    const inner = labels ? labels.slice(1, -1) + ',' : ''; // 去掉外层 {} 再补逗号
    const at = (extra: string): string => `{${inner}${extra}}`;
    const out: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    const cum = stat.cumulative();
    for (let i = 0; i < stat.boundsList.length; i++) {
      out.push(`${name}_bucket${at(`le="${stat.boundsList[i]}"`)} ${cum[i]}`);
    }
    out.push(`${name}_bucket${at(`le="+Inf"`)} ${stat.count}`);
    out.push(`${name}_sum${labels} ${stat.sumMs}`);
    out.push(`${name}_count${labels} ${stat.count}`);
    return out.join('\n') + '\n';
  };

  const render = (): string => {
    const out: string[] = [];
    out.push(line(`${p}runs_total`, 'counter', runs, 'run 总数（成功 + 失败）'));
    out.push(line(`${p}runs_failed_total`, 'counter', failed, '失败的 run 数（trace.status=error）'));
    out.push(line(`${p}tokens_total`, 'counter', tokens.input, '输入 token 累计', '{kind="input"}'));
    out.push(line(`${p}tokens_total`, 'counter', tokens.output, '输出 token 累计', '{kind="output"}'));
    out.push(line(`${p}tokens_total`, 'counter', tokens.cacheRead, '缓存读 token 累计', '{kind="cache_read"}'));
    out.push(
      line(`${p}tokens_total`, 'counter', tokens.cacheCreation, '缓存写 token 累计', '{kind="cache_creation"}'),
    );
    out.push(line(`${p}cost_usd_total`, 'counter', costUsd, '累计成本估算（美元）'));
    // 时长：histogram（可跨实例聚合）+ 窗口内精确分位（单实例好读），两种口径并存
    out.push(histogram(`${p}run_duration_ms`, runStat, 'run 时长（毫秒）'));
    out.push(
      line(`${p}run_duration_ms`, 'gauge', runStat.percentile(0.5), 'run 时长分位（毫秒，滑动窗口内精确值）', '{quantile="0.5"}'),
    );
    out.push(
      line(`${p}run_duration_ms`, 'gauge', runStat.percentile(0.95), 'run 时长分位（毫秒，滑动窗口内精确值）', '{quantile="0.95"}'),
    );

    // —— 单元维度（E2）——
    for (const label of [...units.keys()].sort()) {
      const acc = units.get(label)!;
      const l = `{unit="${label}"}`;
      out.push(line(`${p}unit_calls_total`, 'counter', acc.calls, '单元调用次数', l));
      out.push(line(`${p}unit_errors_total`, 'counter', acc.errors, '单元失败次数', l));
      out.push(histogram(`${p}unit_duration_ms`, acc.stat, '单元调用耗时（毫秒）', l));
      out.push(
        line(`${p}unit_duration_ms`, 'gauge', acc.stat.percentile(0.5), '单元调用耗时分位（窗口内精确值）', `{unit="${label}",quantile="0.5"}`),
      );
      out.push(
        line(`${p}unit_duration_ms`, 'gauge', acc.stat.percentile(0.95), '单元调用耗时分位（窗口内精确值）', `{unit="${label}",quantile="0.95"}`),
      );
      if (acc.tokens !== null) {
        out.push(line(`${p}unit_tokens_total`, 'counter', acc.tokens, 'skill/subagent 的子孙 token 合计', l));
      }
      if (acc.costUsd !== null) {
        out.push(line(`${p}unit_cost_usd_total`, 'counter', acc.costUsd, 'skill/subagent 的估算成本（美元）', l));
      }
    }

    // —— 模型维度（E3）——
    for (const model of [...models.keys()].sort()) {
      const acc = models.get(model)!;
      const l = `{model="${model}"}`;
      out.push(line(`${p}model_turns_total`, 'counter', acc.turns, '模型往返次数', l));
      out.push(line(`${p}model_tokens_total`, 'counter', acc.tokens, '模型 token 合计（四类之和）', l));
      out.push(line(`${p}model_cost_usd_total`, 'counter', acc.costUsd, '模型估算成本（美元，仅已定价部分）', l));
      if (acc.unpricedTurns > 0) {
        out.push(
          line(`${p}model_unpriced_turns_total`, 'counter', acc.unpricedTurns, '算不出成本的 turn 数（模型不在价格表内）', l),
        );
      }
      out.push(histogram(`${p}model_duration_ms`, acc.stat, '模型往返耗时（毫秒）', l));
      out.push(
        line(`${p}model_duration_ms`, 'gauge', acc.stat.percentile(0.5), '模型往返耗时分位（窗口内精确值）', `{model="${model}",quantile="0.5"}`),
      );
      out.push(
        line(`${p}model_duration_ms`, 'gauge', acc.stat.percentile(0.95), '模型往返耗时分位（窗口内精确值）', `{model="${model}",quantile="0.95"}`),
      );
    }
    return out.join('');
  };

  // —— OTLP/JSON 导出（E5）——
  const nanos = (ms: number): string => String(Math.round(ms * 1e6));
  type OtlpAttr = { key: string; value: Record<string, unknown> };
  const strAttr = (key: string, v: string): OtlpAttr => ({ key, value: { stringValue: v } });

  const buildOtlpPayload = () => {
    const now = nanos(Date.now());
    const start = nanos(startedAtMs);
    const s = snapshot();
    const sum = (name: string, value: number, help: string, attrs: OtlpAttr[], monotonic = true) => ({
      name,
      description: help,
      sum: {
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: monotonic,
        dataPoints: [{ attributes: attrs, startTimeUnixNano: start, timeUnixNano: now, asInt: String(value) }],
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
            bucketCounts: stat.cumulative(),
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
      sum(`${p}tokens_total`, tokens.cacheRead, '缓存读 token 累计', [strAttr('kind', 'cache_read')]),
      sum(`${p}tokens_total`, tokens.cacheCreation, '缓存写 token 累计', [strAttr('kind', 'cache_creation')]),
      sum(`${p}cost_usd_total`, s.costUsd, '累计成本估算（美元）', []),
      hist(`${p}run_duration_ms`, runStat, 'run 时长（毫秒）', []),
    ];
    for (const label of [...units.keys()].sort()) {
      const acc = units.get(label)!;
      const attrs = [strAttr('unit', label)];
      metrics.push(sum(`${p}unit_calls_total`, acc.calls, '单元调用次数', attrs));
      metrics.push(sum(`${p}unit_errors_total`, acc.errors, '单元失败次数', attrs));
      metrics.push(hist(`${p}unit_duration_ms`, acc.stat, '单元调用耗时（毫秒）', attrs));
      if (acc.tokens !== null) metrics.push(sum(`${p}unit_tokens_total`, acc.tokens, '子孙 token 合计', attrs));
      if (acc.costUsd !== null) metrics.push(sum(`${p}unit_cost_usd_total`, acc.costUsd, '估算成本（美元）', attrs));
    }
    for (const model of [...models.keys()].sort()) {
      const acc = models.get(model)!;
      const attrs = [strAttr('model', model)];
      metrics.push(sum(`${p}model_turns_total`, acc.turns, '模型往返次数', attrs));
      metrics.push(sum(`${p}model_tokens_total`, acc.tokens, '模型 token 合计', attrs));
      metrics.push(sum(`${p}model_cost_usd_total`, acc.costUsd, '模型估算成本（美元）', attrs));
      if (acc.unpricedTurns > 0) {
        metrics.push(sum(`${p}model_unpriced_turns_total`, acc.unpricedTurns, '未定价 turn 数', attrs));
      }
      metrics.push(hist(`${p}model_duration_ms`, acc.stat, '模型往返耗时（毫秒）', attrs));
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
      units.clear();
      models.clear();
      assignedUnits.clear();
      dropped.clear();
    },
  };
}
