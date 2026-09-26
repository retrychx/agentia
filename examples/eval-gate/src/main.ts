/**
 * 跑闸门（**这一步就是 CI 里那一步**）。
 *
 * ```bash
 * tsx src/main.ts            # 对基线判定：有回归或删用例 ⇒ 退出码 1
 * tsx src/main.ts --update   # 把本次结论写成新基线（**人工核对后提交**）
 * ```
 *
 * 退出码：`0` 通过 / `1` 不通过（有回归或删用例）/ `2` 环境错误（读不到或解析不了基线）。
 * 把 `2` 与 `1` 分开是刻意的：**「基线文件坏了」不该被读成「我的 agent 退化了」**。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineFrom,
  formatGateReport,
  parseBaseline,
  runGate,
  serializeBaseline,
  type GateBaseline,
} from './gate.js';
import { suites } from './suite.js';

const here = dirname(fileURLToPath(import.meta.url));
/** 基线路径：`--baseline <path>` 可换一份（CI 里基线常放在别处；e2e 也用它喂「被改坏的」基线） */
function baselinePath(): string {
  const i = process.argv.indexOf('--baseline');
  return i >= 0 && process.argv[i + 1]
    ? resolve(process.argv[i + 1]!)
    : join(here, '..', 'baseline.json');
}
const BASELINE_PATH = baselinePath();
const update = process.argv.includes('--update');

const reports = [];
for (const s of suites) reports.push(await s.run());

if (update) {
  const next = baselineFrom(reports);
  writeFileSync(BASELINE_PATH, serializeBaseline(next));
  console.log(`已写入基线：${BASELINE_PATH}`);
  console.log(formatGateReport(runGate(reports, next)));
  console.log('\n⚠️ 基线要**人工核对**后提交 —— 它记的是「我们接受这些结论」这句话。');
  process.exit(0);
}

let baseline: GateBaseline;
try {
  baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
} catch (e) {
  console.error(`读不到基线 ${BASELINE_PATH}：${e instanceof Error ? e.message : String(e)}`);
  console.error(
    '先跑一次 `npm run update`（= `node dist/main.js --update`）生成它，人工核对后提交。',
  );
  process.exit(2);
}

const gate = runGate(reports, baseline);
console.log(formatGateReport(gate));
process.exit(gate.ok ? 0 : 1);
