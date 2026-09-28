/*
 * 架构守卫 —— OTLP 导出路径**不得依赖 `MetricsState.snapshot()`**（外部深评 S4）。
 *
 * ## 报告说的 与 实际量到的
 *
 * 外部报告的修法是「让 `snapshot()` 的分位计算可选」。读源码 + 实测后结论不同：
 * **这条路径根本不需要 snapshot**。`metrics-otlp.ts` 对 state 的读法全是「公开字段 /
 * 公开 map 直接遍历」——三个标量（`runs` / `failed` / `costUsd`）、`tokens` / `runStat` /
 * `runLabels` / `capabilities` / `models` / `scores` / 两个 exemplar —— 一个分位都不读，
 * 却仍调了一次 `state.snapshot()`（原 78 行）只为拿那三个标量。而这三个标量**本身就是
 * `MetricsState` 的公开字段**。
 *
 * 代价实测（`npm run bench:otlp`，见 `scripts/bench-otlp-snapshot.ts`；满 1024 窗口 / 30 个组合）：
 *   p50+p95 单个 233.8 µs ｜ snapshot() 整体 5929.6 µs ｜ buildOtlpPayload() 41.6 µs
 *   ⇒ OTLP 每 flush 实际要用的只有那 41.6 µs，省掉的是 99.3%
 * 且**每个 flush 都付一次**（拉取式 Prometheus 侧无此问题：那里确实要分位）。
 *
 * ## 为什么本守卫是**行为**断言而不是源码扫描
 *
 * invariant 是「调用图里没有 snapshot」，最直接的写法是扫描 `metrics-otlp.ts` 里有没有
 * `.snapshot(`。但那要自带一个注释遮蔽器 —— 而**被守的源码注释里本身就写着
 * `state.snapshot()`**（说明为什么不许调它）。靠遮蔽器区分「注释里的」与「代码里的」，
 * 会让守卫的成败取决于遮蔽器的正确性（本仓在 `tool-event-names.test.ts` 里已经为这类
 * 遮蔽器付过一次代价：第一版漏了 `${}` 表达式段，是自证样本当场抓出的）。
 *
 * 换成行为断言后，判据只有一个、且与注释无关：**把 `state.snapshot` 换成会抛的桩，
 * 再跑导出路径**。有人加回 `state.snapshot()` ⇒ 当场红；没人加 ⇒ 绿，且绿是真的
 * （下面第一条就是「这枚雷真的会炸」的阳性对照，防真空）。
 *
 * ## 第二组断言在防什么
 *
 * 光「不抛」还不够：**把 snapshot 换成 `return {} as any` 也能不抛**。所以同时断言
 * 三个标量真的从 state 的公开字段读出来了（`runs_total` / `runs_failed_total` /
 * `cost_usd_total` 的值与字段一致）—— 即「删掉 snapshot 没有顺手丢数据」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsState } from '../../src/integrations/metrics-state.js';
import { buildOtlpPayload } from '../../src/integrations/metrics-otlp.js';

const PREFIX = 'agentia_';

/** OTLP/JSON 里我们断言到的那一层（只写用得到的字段，不把协议抄一遍） */
interface MetricShape {
  name: string;
  description: string;
  sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: unknown[] };
}

/** 取 `resourceMetrics[0].scopeMetrics[0].metrics`，按 name 建表 —— 结构异常即断言失败 */
function metricsOf(payload: unknown): Map<string, MetricShape> {
  const envelope = payload as {
    resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: MetricShape[] }> }>;
  };
  const metrics = envelope.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics;
  assert.ok(
    Array.isArray(metrics),
    'payload 结构异常：resourceMetrics[0].scopeMetrics[0].metrics 缺失',
  );
  return new Map(metrics.map((m) => [m.name, m]));
}

/** 组装入参：只给 `buildOtlpPayload` 真正读的三个字段（`endpoint` / `timeoutMs` 是 flush 侧的） */
const buildOpts = {
  prefix: PREFIX,
  serviceName: 'agentia-s4-guard',
  startedAtMs: 1_700_000_000_000,
};

/** 一个带三个标量的 state —— 值刻意互不相等，避免「读错字段也恰好对」 */
function stateWithScalars(): MetricsState {
  // `MetricsState` 的构造入参**全是必填**（缺省值在 metrics.ts 的 sink 侧解析，构造期不做兜底：
  // 认下缺省值的人就是写进 trace 的人 —— 同一口径）。所以这里显式写全。
  const state = new MetricsState({
    windowSize: 1024,
    maxCapabilities: 64,
    maxModels: 64,
    maxScores: 64,
    labelMode: 'capability',
    buckets: [50, 100, 250, 500, 1000, 2500, 5000],
    labelKeys: [],
    maxLabelValues: 64,
    maxLabelCombos: 64,
  });
  state.runs = 7;
  state.failed = 2;
  state.costUsd = 1.25;
  return state;
}

/**
 * 把 `snapshot` 换成会抛的**桩**（实例自有属性遮蔽原型上的方法）。
 *
 * `(): never` 让类型上仍可赋给 `() => MetricsSnapshot`，同时保证这个桩不可能「假装成功」。
 */
function armSnapshotTrap(state: MetricsState): void {
  state.snapshot = (): never => {
    throw new Error('OTLP 导出路径调了 state.snapshot()（分位数是纯白算，见守卫文件头注）');
  };
}

describe('OTLP 导出路径不依赖 MetricsState.snapshot()（S4）', () => {
  it('这枚雷真的会炸（阳性对照：桩确实装上了，否则下面的绿是真空）', () => {
    const state = stateWithScalars();
    armSnapshotTrap(state);
    assert.throws(
      () => state.snapshot(),
      /调了 state\.snapshot\(\)/,
      '桩没装上 ⇒ 后面「不抛」的断言毫无意义',
    );
  });

  it('装了桩之后 buildOtlpPayload 照样出全量 payload（有人加回 snapshot ⇒ 当场红）', () => {
    const state = stateWithScalars();
    armSnapshotTrap(state);
    const metrics = metricsOf(buildOtlpPayload(state, { ...buildOpts }));
    // 射程钉：payload 不是空壳。空 state 下恰好 6 个 Metric（三个标量 + tokens + run 耗时直方图 +
    // dropped_keys）—— 远小于 6 就说明扫在退化状态上，下面「每个都读到」的断言会失去意义。
    assert.ok(
      metrics.size >= 6,
      `payload 里的 Metric 太少（${metrics.size} 个）—— 守卫可能扫在空状态上`,
    );
    for (const name of [
      `${PREFIX}runs_total`,
      `${PREFIX}runs_failed_total`,
      `${PREFIX}cost_usd_total`,
      `${PREFIX}run_duration_ms`,
    ]) {
      assert.ok(metrics.has(name), `payload 缺 ${name}`);
    }
  });

  it('三个标量真的从 state 的公开字段读出来（删掉 snapshot 没顺手丢数据）', () => {
    const state = stateWithScalars();
    armSnapshotTrap(state);
    const metrics = metricsOf(buildOtlpPayload(state, { ...buildOpts }));

    const pointOf = (name: string): Record<string, unknown> => {
      const dp = metrics.get(name)?.sum?.dataPoints[0] as Record<string, unknown> | undefined;
      assert.ok(dp, `${name} 没有数据点`);
      return dp;
    };

    // 计数器走 asInt（string 编码 int64）；成本是浮点，必须 asDouble（塞 asInt 会让 collector 拒收整批）
    assert.equal(pointOf(`${PREFIX}runs_total`).asInt, '7');
    assert.equal(pointOf(`${PREFIX}runs_failed_total`).asInt, '2');
    assert.equal(pointOf(`${PREFIX}cost_usd_total`).asDouble, 1.25);
    // 反向：读数必须来自**公开字段**而不是某个自带副本 —— 改字段，payload 跟着变
    state.runs = 8;
    state.failed = 3;
    state.costUsd = 2.5;
    const after = metricsOf(buildOtlpPayload(state, { ...buildOpts }));
    const pointAfter = (name: string): Record<string, unknown> =>
      after.get(name)?.sum?.dataPoints[0] as Record<string, unknown>;
    assert.equal(
      pointAfter(`${PREFIX}runs_total`).asInt,
      '8',
      'runs_total 未跟随 state.runs —— 读的不是公开字段',
    );
    assert.equal(pointAfter(`${PREFIX}runs_failed_total`).asInt, '3');
    assert.equal(pointAfter(`${PREFIX}cost_usd_total`).asDouble, 2.5);
  });
});
