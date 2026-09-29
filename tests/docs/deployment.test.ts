/*
 * `docs/deployment.md`（上线清单）的守卫 —— 评审 P1-3。
 *
 * 为什么需要它：这份清单的价值**完全依赖完备性** —— 「上线前自检」漏一格，漏的那格就是
 * 别人的生产事故。而文档没有编译期保护：节被删、链接指向不存在的路径、最关键的那条边界
 * （`/healthz` 与 `/metrics` **不鉴权**）被「精简」掉，都不会有任何信号。这与本仓反复踩的
 * 「对外承诺没有守卫 ⇒ 会腐烂」是同一类病，只是这次承诺的是**完备性**。
 *
 * 守五件事：
 * ① **节的完备性**：§0–§10 十一个节标题一个不少（清单的骨架）；
 * ② **路径真实**：正文里反引号写的仓库内路径（docs/ examples/ 前缀）必须存在 ——
 *    清单指错路比没有清单更坏（下一个人照着走到 404）；
 * ③ **关键机制词在场**：`resumePending` / `drain` / `authenticate` / `budget_exceeded` /
 *    `单宿主写者` —— 上线后果最重的五件事，缺任何一个都该红；
 * ④ **如实锚**：「不鉴权」必须出现（`/healthz` 与 `/metrics`）—— 这条是 usage-guide §7
 *    已知边界里最容易被清单「忘了说」的一条，说漏了等于替读者把攻击面藏起来；
 * ⑤ **自检形态下限**：§10 至少 8 条 `- [ ]` 复选框 —— 清单退化成散文时它就不再可执行。
 *
 * 反向验证过 5 条（各恰好点名，还原后 sha256 逐字节一致，记录见 docs/guards.md §1.4）：
 * ① 删「## 9. 回滚」节标题 ⇒ 红①；② `examples/deploy/` 改成 `examples/deployy/` ⇒ 红②；
 * ③ 摘掉 `resumePending` 全部提及 ⇒ 红③；④ 删「不鉴权」句 ⇒ 红④；
 * ⑤ §10 砍到 3 条复选框 ⇒ 红⑤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(repoRoot, 'docs', 'deployment.md');
const md = readFileSync(DOC, 'utf8');

/** ① 节的完备性 —— §0–§10（新增节时同步这里；删节必须先想清楚「哪一格谁替我守」。 */
const SECTIONS = [
  '## 0. 先决：版本怎么锁',
  '## 1. 运行环境与密钥',
  '## 2. 任务存储（耐久与恢复的根基）',
  '## 3. 入口与网络边界',
  '## 4. 健康检查与就绪',
  '## 5. 优雅停机（顺序是死的）',
  '## 6. 资源上限（失控保险丝）',
  '## 7. 可观测',
  '## 8. 多副本',
  '## 9. 回滚',
  '## 10. 上线前自检',
] as const;

test('① 十一个节一个不少（清单的骨架）', () => {
  const missing = SECTIONS.filter((s) => !md.includes(s));
  assert.deepEqual(
    missing,
    [],
    `docs/deployment.md 缺节：${missing.join(' / ')} —— 上线清单漏节 = 漏掉的那格由使用者在生产上发现。`,
  );
});

test('② 反引号里的仓库内路径必须真实存在', () => {
  const tokens = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  const prefixes = ['docs/', 'examples/', 'src/', 'tests/', 'scripts/'];
  const bad: string[] = [];
  for (const t of tokens) {
    if (!prefixes.some((p) => t.startsWith(p))) continue;
    if (/[*?<>{}|\s]/.test(t)) continue; // 通配 / 带空格的泛称不查
    if (!existsSync(join(repoRoot, t))) bad.push(t);
  }
  assert.deepEqual(
    bad,
    [],
    `deployment.md 指向不存在的路径：${bad.join(' / ')} —— 清单指错路比没有清单更坏。`,
  );
});

test('③ 上线后果最重的五件事必须在场', () => {
  const must = ['resumePending', 'drain', 'authenticate', 'budget_exceeded', '单宿主写者'] as const;
  const missing = must.filter((w) => !md.includes(w));
  assert.deepEqual(
    missing,
    [],
    `deployment.md 缺关键机制词：${missing.join(' / ')} —— 这五个是「漏了会出生产事故」级别的。`,
  );
});

test('④ 如实锚：/healthz 与 /metrics 的「不鉴权」必须说出来', () => {
  assert.ok(
    md.includes('/healthz') && md.includes('/metrics') && md.includes('不鉴权'),
    'deployment.md 必须如实写出「/healthz 与 /metrics 不鉴权」（usage-guide §7 的已知边界），' +
      '说漏了等于替读者把攻击面藏起来。',
  );
});

test('⑤ §10 至少 8 条复选框（清单退化成散文时要红）', () => {
  const boxes = md.match(/^- \[ \]/gm) ?? [];
  assert.ok(
    boxes.length >= 8,
    `§10 自检只剩 ${boxes.length} 条复选框（应 ≥8）—— 上线清单退化成散文时不再可执行。`,
  );
});
