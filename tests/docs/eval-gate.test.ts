/**
 * 评测即发布闸门（`examples/eval-gate`）——**判据本身**的守卫 + 文档双向覆盖。
 *
 * 为什么值得一条守卫：这套判据是「能不能发」的那句话，而它最容易的退化方式**不是算错**，
 * 是**泄成 `EvalReport.ok` 的转发**（「用例都过就通过」）—— 那样它就不再防「删掉失败用例」
 * 与「拿旧结论当基线」这两件事，而两条都不会报错。所以这里除了四类判定的正例，
 * 还有一条**反面断言**：`report.ok === false` 的报告，只要那条失败**在基线里也是失败**，
 * 闸门就必须**通过**（已知坏不拦发布）= 证明它没有转发 report.ok。
 *
 * 文档 ↔ 示例的导出面双向覆盖同 `tests/docs/observability.test.ts` 的口径（集合相等，不是子串）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalReport } from '../../src/index.js';
import {
  baselineFrom,
  caseKey,
  formatGateReport,
  parseBaseline,
  runGate,
  serializeBaseline,
} from '../../examples/eval-gate/src/gate.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_SRC = join(repoRoot, 'examples', 'eval-gate', 'src', 'gate.ts');
const DOC = join(repoRoot, 'docs', 'eval-gate.md');

/** 造一份评测报告（只填判定用得到的字段） */
function report(name: string, cases: Array<[string, boolean]>): EvalReport {
  const passed = cases.filter(([, ok]) => ok).length;
  return {
    name,
    total: cases.length,
    passed,
    failed: cases.length - passed,
    ok: passed === cases.length,
    cases: cases.map(([n, ok]) => ({ name: n, ok })),
  };
}

const base = report('demo', [
  ['通过的那条', true],
  ['坏的那条', false],
]);

describe('eval-gate：判据（四类判定 + 一条反面断言）', () => {
  it('全过 + 基线一致 ⇒ 通过', () => {
    const g = runGate(base, baselineFrom(base));
    assert.equal(g.ok, true);
    assert.deepEqual(g.regressions, []);
    assert.deepEqual(g.removed, []);
    assert.equal(g.total, 2);
    assert.equal(g.passed, 1);
  });

  it('回归：基线通过 → 这次失败 ⇒ 不通过，且点名是哪条', () => {
    const baseline = baselineFrom(report('demo', [['通过的那条', true]]));
    const g = runGate(report('demo', [['通过的那条', false]]), baseline);
    assert.equal(g.ok, false);
    assert.deepEqual(g.regressions, [caseKey('demo', '通过的那条')]);
  });

  it('删用例：基线里有、这次没跑 ⇒ 不通过（删掉失败用例不是通过的方式）', () => {
    const g = runGate(
      base,
      baselineFrom(
        report('demo', [
          ['通过的那条', true],
          ['坏的那条', false],
          ['后来被删掉的', true],
        ]),
      ),
    );
    assert.equal(g.ok, false);
    assert.deepEqual(g.removed, [caseKey('demo', '后来被删掉的')]);
    assert.deepEqual(g.regressions, []);
  });

  it('新增用例 / 修好了的用例 ⇒ 放行，但各自记账（added / recovered）', () => {
    const baseline = baselineFrom(
      report('demo', [
        ['通过的那条', true],
        ['坏的那条', false],
      ]),
    );
    const current = report('demo', [
      ['通过的那条', true],
      ['坏的那条', true], // 修好了
      ['新加的一条', true], // 基线里没有
    ]);
    const g = runGate(current, baseline);
    assert.equal(g.ok, true);
    assert.deepEqual(g.recovered, [caseKey('demo', '坏的那条')]);
    assert.deepEqual(g.added, [caseKey('demo', '新加的一条')]);
  });

  it('⚠️ 反面断言：它**不是** `EvalReport.ok` 的转发 —— 已知失败不拦发布', () => {
    // 报告里有一条 fail（report.ok === false），但那条在基线里**也是** fail ⇒ 闸门通过。
    // 若哪天有人把 runGate 改成 `return { ok: report.ok }`，这条立刻红。
    const baseline = baselineFrom(base);
    const g = runGate(base, baseline);
    assert.equal(base.ok, false, '前提：这份报告的 ok 是 false');
    assert.equal(g.ok, true, '闸门只拦「新的坏消息」，不转发 report.ok');
  });

  it('多套件：键是 `<套件名>::<用例名>`，同名用例不互相串', () => {
    const a = report('套件A', [['同名用例', true]]);
    const b = report('套件B', [['同名用例', false]]);
    const baseline = baselineFrom([a, b]);
    assert.deepEqual(Object.keys(baseline.cases).sort(), [
      caseKey('套件A', '同名用例'),
      caseKey('套件B', '同名用例'),
    ]);
    assert.equal(runGate([a, b], baseline).ok, true);
  });

  it('基线形状不对 ⇒ 抛错（空基线会让闸门永远绿，比没有闸门更危险）', () => {
    assert.throws(() => parseBaseline('不是 json'), /基线不是合法 JSON/);
    assert.throws(() => parseBaseline('[]'), /必须是对象/);
    assert.throws(() => parseBaseline('{"name":"x"}'), /缺少 cases/);
    assert.throws(() => parseBaseline('{"name":"x","cases":{"a":"yes"}}'), /不是布尔值/);
    assert.throws(() => parseBaseline('{"name":"x","cases":{}}'), /空基线会让闸门永远绿/);
  });

  it('序列化 ↔ 解析往返一致，且键排序稳定（人读 diff 不乱跳）', () => {
    const b = baselineFrom(
      report('demo', [
        ['z', true],
        ['a', false],
        ['m', true],
      ]),
    );
    const json = serializeBaseline(b);
    assert.deepEqual(parseBaseline(json), b);
    assert.deepEqual(Object.keys(JSON.parse(json).cases), [
      caseKey('demo', 'a'),
      caseKey('demo', 'm'),
      caseKey('demo', 'z'),
    ]);
  });

  it('报告文本能一眼看出「为什么没过」（CI 日志里就靠它）', () => {
    const baseline = baselineFrom(report('demo', [['坏的那条', true]]));
    const text = formatGateReport(runGate(report('demo', [['坏的那条', false]]), baseline));
    assert.match(text, /✗ 回归 1 条/);
    assert.match(text, /demo::坏的那条/);
    assert.match(text, /不通过/);
  });
});

describe('eval-gate：文档 ↔ 示例的导出面互为真值（集合相等，不是子串）', () => {
  const src = readFileSync(GATE_SRC, 'utf8');
  const doc = readFileSync(DOC, 'utf8');

  /** `export function/interface/type/const <name>`（含 `export type { … }` 形态留待需要时再扩） */
  function exportsOf(): string[] {
    const out = new Set<string>();
    for (const m of src.matchAll(
      /^export\s+(?:async\s+)?(?:function|interface|type|const)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      out.add(m[1]!);
    }
    for (const m of src.matchAll(/^export\s+type\s*\{([^}]*)\}/gm)) {
      for (const part of m[1]!.split(',')) {
        const n = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (n) out.add(n);
      }
    }
    return [...out].sort();
  }

  it('每个导出都在文档里出现（反向全覆盖 + 防真空下限）', () => {
    const names = exportsOf();
    assert.ok(names.length >= 8, `只抠出 ${names.length} 个导出 —— 解析锚点坏了`);
    const missing = names.filter((n) => !new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(doc));
    assert.deepEqual(missing, [], `docs/eval-gate.md 没写这些导出：${missing.join(' / ')}`);
  });

  it('文档里的四类判定关键词与实现一致（口径不许各说各话）', () => {
    for (const phrase of ['回归', '删用例', '新增用例', 'recovered']) {
      assert.ok(doc.includes(phrase), `文档里缺「${phrase}」这一类判定的说明`);
    }
  });
});
