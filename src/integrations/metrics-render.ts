import type { DurationStat, MetricsState } from './metrics-state.js';
import { scoreLabels } from './metrics-state.js';

/**
 * metricsSink 的 **Prometheus 文本渲染**（`text/plain; version=0.0.4`，零依赖手写）。
 * 只读 `MetricsState`，不改账。module 级 export，不进公共面（`src/index.ts`）。
 */

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

export function renderPrometheus(state: MetricsState, p: string): string {
  const out: string[] = [];
  out.push(
    family(`${p}runs_total`, 'counter', 'run 总数（成功 + 失败）', [
      `${p}runs_total ${state.runs}`,
    ]),
  );
  out.push(
    family(`${p}runs_failed_total`, 'counter', '失败的 run 数（trace.status=error）', [
      `${p}runs_failed_total ${state.failed}`,
    ]),
  );
  out.push(
    family(
      `${p}tokens_total`,
      'counter',
      'token 累计（kind 分项：input / output / cache_read / cache_creation）',
      [
        `${p}tokens_total{kind="input"} ${state.tokens.input}`,
        `${p}tokens_total{kind="output"} ${state.tokens.output}`,
        `${p}tokens_total{kind="cache_read"} ${state.tokens.cacheRead}`,
        `${p}tokens_total{kind="cache_creation"} ${state.tokens.cacheCreation}`,
      ],
    ),
  );
  out.push(
    family(`${p}cost_usd_total`, 'counter', '累计成本估算（美元）', [
      `${p}cost_usd_total ${state.costUsd}`,
    ]),
  );
  // 基数上限的**可见性**：被折叠掉的不同键数。与 `snapshot()` 的同名字段一一对应 ——
  // 此前只有 snapshot() 有、render() 没有，于是「按文档把 metricsSink 接到 /metrics」的部署
  // **完全看不见折叠发生**（静默丢失）；而同一份文件对「算不出成本的 turn」专门发了
  // `model_unpriced_turns_total`，口径不一致。
  // 与 unpriced 不同：**恒定发三行**（不是 >0 才发）—— 「0 → N」这个变化本身就是要告警的信号。
  out.push(
    family(`${p}dropped_keys`, 'gauge', '因基数上限被折叠的不同键数（kind 分项）', [
      `${p}dropped_keys{kind="capability"} ${state.capBudget.dropped}`,
      `${p}dropped_keys{kind="model"} ${state.modelBudget.dropped}`,
      `${p}dropped_keys{kind="score"} ${state.scoreBudget.dropped}`,
    ]),
  );
  // 时长：histogram（可跨实例聚合）+ 窗口内精确分位（单实例好读），两种口径并存。
  // 分位 gauge 必须用另一个名字 `*_last` —— 同名指标只允许一种 TYPE，
  // 先发 histogram 再发 gauge 会被 expfmt 判硬错误，整次 scrape 失败。
  out.push(
    family(`${p}run_duration_ms`, 'histogram', 'run 时长（毫秒）', [
      ...histogramSamples(`${p}run_duration_ms`, state.runStat),
    ]),
  );
  out.push(
    family(`${p}run_duration_ms_last`, 'gauge', 'run 时长分位（毫秒，滑动窗口内精确值）', [
      `${p}run_duration_ms_last{quantile="0.5"} ${state.runStat.percentile(0.5)}`,
      `${p}run_duration_ms_last{quantile="0.95"} ${state.runStat.percentile(0.95)}`,
    ]),
  );

  // —— 能力维度（E2）：同一家族的样本跨 label 聚合，家族头只发一次 ——
  const capLabels = [...state.capabilities.keys()].sort();
  if (capLabels.length > 0) {
    const calls: string[] = [];
    const errors: string[] = [];
    const durations: string[] = [];
    const durationQuantiles: string[] = [];
    const capabilityTokens: string[] = [];
    const capabilityCosts: string[] = [];
    for (const label of capLabels) {
      const acc = state.capabilities.get(label)!;
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
    out.push(family(`${p}capability_duration_ms`, 'histogram', '能力调用耗时（毫秒）', durations));
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
  const modelNames = [...state.models.keys()].sort();
  if (modelNames.length > 0) {
    const turns: string[] = [];
    const modelTokens: string[] = [];
    const modelCosts: string[] = [];
    const unpriced: string[] = [];
    const durations: string[] = [];
    const durationQuantiles: string[] = [];
    for (const model of modelNames) {
      const acc = state.models.get(model)!;
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
  if (state.scores.size > 0) {
    const gaugeSamples: string[] = [];
    const counterSamples: string[] = [];
    for (const key of [...state.scores.keys()].sort()) {
      const acc = state.scores.get(key)!;
      const { name, source } = scoreLabels(key);
      const l = `{name="${escLabel(name)}",source="${escLabel(source)}"}`;
      gaugeSamples.push(`${p}score${l} ${acc.value}`);
      counterSamples.push(`${p}score_total${l} ${acc.count}`);
    }
    out.push(family(`${p}score`, 'gauge', '最近一次评分（label 为评分维度与来源）', gaugeSamples));
    out.push(family(`${p}score_total`, 'counter', '评分条数', counterSamples));
  }
  return out.join('');
}
