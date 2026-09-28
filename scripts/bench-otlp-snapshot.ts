/**
 * OTLP 导出成本的基准（bench，**不进 verify-all / CI** —— 与 bench:trace / e2e:live 同档，要看时才跑）。
 *
 * 为什么要有它：外部深评 S4 的题目是「metrics-otlp 白算分位」。这类题的答案必须是**数字**。
 * 结论（2026-09-28）：`metrics-otlp.ts` 原来每次 flush 调一次 `state.snapshot()`，
 * 却只从结果里读 `runs` / `failed` / `costUsd` **三个标量** —— 而这三个本来就是
 * `MetricsState` 的公开字段；它对 capabilities / models / runLabels 全是**直接遍历公开 map**，
 * 一个分位字段都不读。`snapshot()` 却会为**每个**组合各算 p50 + p95，而
 * `DurationStat.percentile()` 是 `[...ring].sort()` ⇒ 满窗口下每组合 2 次 1024 元素拷贝+排序。
 *
 * 本脚本只量三件事，不做推断：
 *   ① `DurationStat.percentile()` 满窗口下的单次成本（含 copy+sort）—— 单价的来源；
 *   ② `MetricsState.snapshot()` 在真实组合数下的整体成本 —— 与①互相印证；
 *   ③ `buildOtlpPayload()` 现在的成本 —— 即「删掉那次 snapshot 之后每次 flush 实际付的钱」。
 *
 * 组合数取 OTLP 的真实遍历口径：capabilities + models + runLabels + run 自身。
 *
 *   npm run bench:otlp                     # 满 1024 窗口 / 20 capabilities + 5 models + 4 run 标签
 *   WINDOW=256 N_CAPS=4 N_MODELS=1 npm run bench:otlp
 */
import { DurationStat, MetricsState } from '../src/integrations/metrics-state.js';
import { buildOtlpPayload } from '../src/integrations/metrics-otlp.js';

/** 分位窗口（`MetricsSinkOptions.windowSize` 的缺省是 1024；窗口不满时 percentile 便宜得多） */
const WINDOW = Number(process.env.WINDOW ?? '1024');
/** 组合数：OTLP 会为每个 capability / model / run 标签各取一次分位 */
const N_CAPS = Number(process.env.N_CAPS ?? '20');
const N_MODELS = Number(process.env.N_MODELS ?? '5');
const N_RUNLABELS = Number(process.env.N_RUNLABELS ?? '4');

/** 一个**窗口已满**的 DurationStat：空窗口下 percentile 立刻返回，量不到东西 */
function filled(): DurationStat {
  const st = new DurationStat(WINDOW, [50, 100, 250, 500, 1000, 2500, 5000]);
  for (let i = 0; i < WINDOW; i++) st.add((i * 7919) % 5000);
  return st;
}

function timeIt(label: string, iters: number, fn: () => unknown): number {
  for (let i = 0; i < Math.max(10, iters / 10); i++) fn(); // 预热
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const us = Number(process.hrtime.bigint() - t0) / 1000 / iters;
  console.log(`   ${label}: ${us.toFixed(2)} µs/次`);
  return us;
}

/** 造一个「像真在跑的进程」的 state：组合各就各位、每个的窗口都满 */
function loadedState(): MetricsState {
  const state = new MetricsState({
    windowSize: WINDOW,
    maxCapabilities: 64,
    maxModels: 64,
    maxScores: 64,
    labelMode: 'capability',
    buckets: [50, 100, 250, 500, 1000, 2500, 5000],
    labelKeys: ['tenant'],
    maxLabelValues: 64,
    maxLabelCombos: 64,
  });
  // 这三个 map 的**值形状**由 metrics-state.ts 内部持有类定义，只给测试/基准造的裸对象
  // 用 `as never` 塞进去（本脚本只喂 snapshot() 与 buildOtlpPayload() 的读路径）。
  for (let i = 0; i < N_CAPS; i++) {
    state.capabilities.set(`cap${i}`, {
      calls: 10,
      errors: 0,
      stat: filled(),
      tokens: 1,
      costUsd: 0.1,
    } as never);
  }
  for (let i = 0; i < N_MODELS; i++) {
    state.models.set(`m${i}`, {
      turns: 10,
      tokens: 100,
      costUsd: 1,
      unpricedTurns: 0,
      stat: filled(),
    } as never);
  }
  for (let i = 0; i < N_RUNLABELS; i++) {
    state.runLabels.set(`k${i}=v`, {
      pairs: [[`k${i}`, 'v']],
      runs: 1,
      failed: 0,
      tokens: 1,
      costUsd: 0.1,
      stat: filled(),
    } as never);
  }
  state.runs = 1000;
  state.failed = 13;
  state.costUsd = 42.5;
  return state;
}

const combos = N_CAPS + N_MODELS + N_RUNLABELS + 1; // +1 = run 自身的 runStat

console.log(`① 单个分位计算（窗口满 ${WINDOW}）`);
const stat = filled();
const perPercentile = timeIt('percentile(0.5) + percentile(0.95)', 2000, () => {
  stat.percentile(0.5);
  stat.percentile(0.95);
});

console.log('\n② snapshot() 整体（真实组合数）');
const state = loadedState();
const snapUs = timeIt(`snapshot()（${combos} 个组合 × 2 次分位）`, 500, () => state.snapshot());

console.log('\n③ buildOtlpPayload()（删掉那次 snapshot 之后每次 flush 实际付的钱）');
const payloadUs = timeIt('buildOtlpPayload()', 500, () =>
  buildOtlpPayload(state, { prefix: 'agentia_', serviceName: 'bench', startedAtMs: 0 }),
);

console.log('\n④ 算数');
console.log(
  `   组合数 ${combos}（capabilities ${N_CAPS} + models ${N_MODELS} + runLabels ${N_RUNLABELS} + run 1）`,
);
console.log(`   按单价外推（应与实测同量级）：${((perPercentile * combos) / 1000).toFixed(3)} ms`);
console.log(`   实测 snapshot()：        ${(snapUs / 1000).toFixed(3)} ms`);
console.log(`   实测 buildOtlpPayload()：${(payloadUs / 1000).toFixed(3)} ms`);
console.log(
  `   ⇒ 每次 flush 省掉 ≈ ${(snapUs / 1000).toFixed(3)} ms（原实现 = snapshot + payload 两笔都付）`,
);
console.log('   注：省掉的这笔**与 flush 频率成正比**，与 OTLP 是否真的被消费无关。');
