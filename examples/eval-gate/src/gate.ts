/**
 * Agentia —— 评测即发布闸门（`eval-gate`）。
 *
 * ## 它补的是哪一环
 *
 * 框架已经给了三件：`defineEval`（用例 + 断言 → `EvalReport`）、`agentia harvest`
 * （线上 trace → 用例骨架）、`agentia diff`（两条 trace 的 A/B）。缺的是把它们收成
 * **一个判据**：*这一版能不能发*。`EvalReport.ok` 回答不了这个问题 —— 它只说「本次
 * 用例全过」，不说「比上一版好还是坏」，更防不住「把失败的用例删掉 = 通过」。
 *
 * 本模块就是那份判据，且**只消费公共类型面**（可直接拷进你的工程）：
 *
 *   本次报告（一个或多个套件）  +  基线（上一次被接受的结论）  →  GateReport{ ok, … }
 *
 * ## 判定规则（就三条，刻意少）
 *
 * 1. **回归**：基线里通过、这次失败 ⇒ 不通过。**这是唯一能让 `ok` 为 false 的新坏消息**。
 * 2. **删用例**：基线里有、这次没跑 ⇒ 不通过。否则「删掉那条总失败的用例」就成了过闸门
 *    最省事的办法 —— 而它正好是这套机制最该防住的作弊。
 * 3. 新增用例（基线里没有）⇒ 放行，但列进 `added` 提醒你更新基线把它纳入；
 *    基线里失败、这次通过 ⇒ 放行，列进 `recovered`（好消息不是通过的理由，但值得看）。
 *
 * 「基线里本来就失败」的用例不阻塞发布 —— 那说明团队选择了「先记着」而不是「不许发」。
 * 这条留给你：要么修，要么用 `--update` 显式改基线（它会打印 diff 让你看见）。
 *
 * ## 用法
 *
 * ```ts
 * import { runGate, parseBaseline, formatGateReport } from './gate.js';
 * import { suites } from './suite.js';
 *
 * const reports = [];
 * for (const s of suites) reports.push(await s.run());
 * const gate = runGate(reports, parseBaseline(readFileSync('baseline.json', 'utf8')));
 * console.log(formatGateReport(gate));
 * process.exit(gate.ok ? 0 : 1);   // ← CI 里就是这一步
 * ```
 */
import type { EvalReport } from '@migor/agentia';

/** 基线：**上一次被接受的结论**。刻意只存「用例键 → 通过与否」，不存 trace。 */
export interface GateBaseline {
  /** 基线名（人读） */
  name: string;
  /** 生成时间（人读；**不参与判定** —— 判定只看结论，不看时间） */
  generatedAt: string;
  /** `套件名::用例名` → 当时是否通过 */
  cases: Record<string, boolean>;
}

/** 用例键：`<套件名>::<用例名>`（一个工程通常有多个 eval 文件，键要能区分） */
export function caseKey(suiteName: string, caseName: string): string {
  return `${suiteName}::${caseName}`;
}

export interface GateCaseDelta {
  key: string;
  /** 基线里的结论（`undefined` = 基线里没有这条用例） */
  baseline: boolean | undefined;
  current: boolean;
}

export interface GateReport {
  /** 通过 = 无回归且无删用例 */
  ok: boolean;
  /** 本次跑的套件名（人读） */
  suites: string[];
  total: number;
  passed: number;
  failed: number;
  /** 基线通过 → 这次失败。**唯一能让 ok 为 false 的新坏消息** */
  regressions: string[];
  /** 基线失败 → 这次通过 */
  recovered: string[];
  /** 基线里没有的新用例（放行，但该更新基线） */
  added: string[];
  /** 基线里有、这次没跑 —— 视为不通过（防「删掉失败用例」） */
  removed: string[];
  cases: GateCaseDelta[];
}

/**
 * 从报告生成基线（`--update` 用它）。
 *
 * ⚠️ 基线**要人工核对后提交进仓库**：它是「我们接受这些结论」这句话的落款。
 * 自动更新只会把「这次跑出来的样子」记成标准 —— 包括那些其实已经坏了的用例。
 */
export function baselineFrom(reports: EvalReport | readonly EvalReport[]): GateBaseline {
  const list = Array.isArray(reports) ? reports : [reports as EvalReport];
  const cases: Record<string, boolean> = {};
  for (const r of list) {
    for (const c of r.cases) cases[caseKey(r.name, c.name)] = c.ok;
  }
  return {
    name: list.map((r) => r.name).join(' + '),
    generatedAt: new Date().toISOString(),
    cases,
  };
}

/**
 * 解析基线 JSON。**形状不对就抛错** —— 一个能解析成空基线的坏文件会让闸门永远绿
 * （没有任何回归可报），那比没有闸门更危险。
 */
export function parseBaseline(json: string): GateBaseline {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`基线不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('基线必须是对象：{ name, generatedAt, cases }');
  }
  const o = raw as Partial<GateBaseline>;
  if (typeof o.name !== 'string' || o.name === '') throw new Error('基线缺少 name');
  if (typeof o.cases !== 'object' || o.cases === null || Array.isArray(o.cases)) {
    throw new Error('基线缺少 cases（用例键 → 通过与否 的对象）');
  }
  const cases: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(o.cases)) {
    if (typeof v !== 'boolean') throw new Error(`基线 cases["${k}"] 不是布尔值`);
    cases[k] = v;
  }
  if (Object.keys(cases).length === 0) throw new Error('基线 cases 为空 —— 空基线会让闸门永远绿');
  return { name: o.name, generatedAt: o.generatedAt ?? '', cases };
}

/** 序列化基线（与 `parseBaseline` 对偶；键排序让人读 diff 稳定） */
export function serializeBaseline(b: GateBaseline): string {
  const cases: Record<string, boolean> = {};
  for (const k of Object.keys(b.cases).sort()) cases[k] = b.cases[k]!;
  return `${JSON.stringify({ ...b, cases }, null, 2)}\n`;
}

/**
 * 判定（**纯函数**：给报告与基线，出能不能发）。
 *
 * 纯函数是刻意的：这套判据的全部承重逻辑都不需要真跑 agent —— 于是它可以被单测，
 * 也能在「拿历史报告比对」的场景里离线用。
 */
export function runGate(
  reports: EvalReport | readonly EvalReport[],
  baseline: GateBaseline,
): GateReport {
  const list = Array.isArray(reports) ? reports : [reports as EvalReport];
  const regressions: string[] = [];
  const recovered: string[] = [];
  const added: string[] = [];
  const cases: GateCaseDelta[] = [];
  const seen = new Set<string>();
  let total = 0;
  let passed = 0;

  for (const r of list) {
    for (const c of r.cases) {
      const key = caseKey(r.name, c.name);
      seen.add(key);
      total++;
      if (c.ok) passed++;
      const was = baseline.cases[key];
      cases.push({ key, baseline: was, current: c.ok });
      if (was === undefined) added.push(key);
      else if (was && !c.ok) regressions.push(key);
      else if (!was && c.ok) recovered.push(key);
    }
  }
  const removed = Object.keys(baseline.cases).filter((k) => !seen.has(k));

  return {
    ok: regressions.length === 0 && removed.length === 0,
    suites: list.map((r) => r.name),
    total,
    passed,
    failed: total - passed,
    regressions,
    recovered,
    added,
    removed,
    cases,
  };
}

/** 人读的一页报告（CI 日志里直接能看懂「为什么没过」） */
export function formatGateReport(g: GateReport): string {
  const lines: string[] = [];
  lines.push(`评测闸门：${g.suites.join(' + ')}`);
  lines.push(`  用例 ${g.total}：通过 ${g.passed} / 失败 ${g.failed}`);
  if (g.regressions.length > 0) {
    lines.push(`  ✗ 回归 ${g.regressions.length} 条（基线通过 → 这次失败）—— **这是不通过的原因**`);
    for (const n of g.regressions) lines.push(`      · ${n}`);
  }
  if (g.removed.length > 0) {
    lines.push(`  ✗ 基线里有、这次没跑 ${g.removed.length} 条 —— **删用例不是通过的方式**`);
    for (const n of g.removed) lines.push(`      · ${n}`);
  }
  if (g.recovered.length > 0) {
    lines.push(`  ↑ 修好了 ${g.recovered.length} 条（基线失败 → 这次通过）`);
    for (const n of g.recovered) lines.push(`      · ${n}`);
  }
  if (g.added.length > 0) {
    lines.push(`  + 新用例 ${g.added.length} 条（基线里还没有，记得 --update 纳入）`);
    for (const n of g.added) lines.push(`      · ${n}`);
  }
  lines.push(g.ok ? '  ⇒ 通过：没有回归、没有删用例' : '  ⇒ 不通过：先看上面两条 ✗');
  return lines.join('\n');
}
