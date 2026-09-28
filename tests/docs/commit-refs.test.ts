/*
 * 元守卫 —— 文档里引用的**提交**必须真实落在主干上。
 *
 * 为什么需要它：2026-09-23 真踩过一次。`docs/plans/2026-09-23-cli-structure.md` 写
 * 「提交 `83902c2`」—— 那是**分支提交**。该批走 squash 合并，`83902c2` 根本不在 main 的
 * 祖先链上（`git merge-base --is-ancestor 83902c2 origin/main` 为否），于是在 main 的
 * **全新克隆**里 `git show 83902c2` 会直接报未知修订。这条引用一路合进了 main，
 * 没有任何东西拦它 —— 因为 `tests/docs/guards-registry.test.ts` 只读 `docs/guards.md`，
 * **`docs/**` 里的提交引用当时不受任何守卫**。
 *
 * 这与本仓反复踩的「文档承诺了、代码没有」是同一类病：文档引用了一个**不在当前主干上**的东西，
 * 而读者会去信它。（改完文档请顺手 `git show <sha>` 自证一次。）
 *
 * ## 判据
 *
 * 只认**反引号里 7–40 位十六进制、且真能解析成一个 commit 对象**的 token：
 * - 不能「看起来像 SHA 就判」—— `deadbeef` / `ff00ff` 这类十六进制词不是提交，硬判会误报；
 * - 也不能只看「能不能解析」—— `83902c2` 是**真实存在的** commit 对象（分支还在远端），
 *   它坏在**不在主干上**。所以真正的判据是 `merge-base --is-ancestor <sha> <主干>`。
 *
 * ## 主干 ref 与浅克隆
 *
 * 主干取 `origin/main` → `origin/HEAD` → `HEAD` 里第一个能解析成 commit 的。
 * ⚠️ **浅克隆下历史不可见**，所有历史 SHA 都解析不出来 ⇒ 本守卫会**空转**（vacuously green）。
 * 所以下面那条「解析下限」同时充当**历史可得性探针**：跌破就是跑在浅克隆里 ——
 * CI 的 `actions/checkout` 需要 `fetch-depth: 0`（`.github/workflows/ci.yml` 的 verify job 已设）。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = join(repoRoot, 'docs');

/** 跑一条 git 命令；非零退出（含「对象不存在」「不是祖先」）一律返回 null —— 调用方按 null 判「否」。 */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** 主干基点：`origin/main` → `origin/HEAD` → `HEAD`（取第一个能解析成 commit 的）。 */
function baseRef(): string | null {
  for (const ref of ['origin/main', 'origin/HEAD', 'HEAD']) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) return ref;
  }
  return null;
}

/** 递归列出 docs 下全部 `.md`（返回相对 docs 的路径，便于报错时直接定位） */
function markdownFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...markdownFiles(join(dir, e.name), rel));
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}

/** 反引号里 7–40 位十六进制 —— 提交引用的**候选**（能不能当提交由 git 判，不靠这个正则） */
const SHA_IN_BACKTICKS = /`([0-9a-f]{7,40})`/g;

/**
 * **历史快照目录**（前缀，相对 `docs/`）：`docs/reviews/<日期>/` —— 逐字入库的外部复核报告
 * （2026-09-28 起，见 `docs/spec.md` §10 ⑲ 与 `docs/reviews/2026-09-28/README.md` §0）。
 *
 * 对它们**只做「是不是 commit 对象」的判定，不做「在不在主干上」的判定**。
 *
 * 为什么这是对的（而不是给腐化开后门）：那些 SHA 记录的是**复核当时**的提交，而本仓一律
 * squash 合并 ⇒ 分支提交**必然**不在 main 的祖先链上（这正是本守卫存在的理由，见文件头注）。
 * 换句话说，本目录里出现「不在主干上的 SHA」是**它的正常形态**，不是引用腐化 ——
 * 要求它们可解析，等于要求把快照**改写成今天的视角**，与「逐字保留」的约定直接冲突、
 * 也与这份文档的用途（读者要的是「当时那份代码在哪」）冲突。
 *
 * ⚠️ **豁免不静默**：下面 `archived` 计数把「走了这条路」记下来，并**钉住目录非空** ——
 * 否则目录被删/改名之后，这段豁免会变成一段没人察觉的**死豁免**（下一次有人把真引用写坏，
 * 只要写在这个前缀下就永远不被拦），那才是真正的后门。
 *
 * 实测走这条豁免的形态（2026-09-28）：`DEEP-REVIEW-2026-09-28.md` 里的 `3c6898f`
 * （「待注入事件缓冲的上限」那个分支提交，squash 后即从主干消失）——本守卫上线当天就抓到它。
 */
const HISTORICAL_PREFIXES = ['reviews/'];

test('docs/** 引用的提交必须真在主干上（引用不得腐化）', () => {
  const base = baseRef();
  assert.ok(
    base !== null,
    '取不到任何可比对的主干 ref（origin/main / origin/HEAD / HEAD 都解析不出来）',
  );

  const offenders: string[] = [];
  let resolved = 0;
  /** 走了「历史快照」豁免的**文件**数 —— 只用来钉住豁免不空转（见 HISTORICAL_PREFIXES 注释） */
  let archived = 0;

  for (const rel of markdownFiles(DOCS)) {
    const historical = HISTORICAL_PREFIXES.some((p) => rel.startsWith(p));
    if (historical) archived += 1;
    const md = readFileSync(join(DOCS, rel), 'utf8');
    const seen = new Set<string>();
    for (const m of md.matchAll(SHA_IN_BACKTICKS)) {
      const sha = m[1];
      if (seen.has(sha)) continue;
      seen.add(sha);
      // 解析不成 commit ⇒ 它只是某个十六进制词，不是提交引用，跳过
      // （历史快照里被 GC 掉的分支提交也走这里：那时它连对象都不是了，本就无从解析）
      if (git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) === null) continue;
      resolved += 1;
      // 历史快照只判到「是个 commit 对象」为止，不再判在不在主干上（理由见 HISTORICAL_PREFIXES）
      if (historical) continue;
      // 非零退出 = 不是祖先 ⇒ 引用了一个不在主干上的提交
      if (git(['merge-base', '--is-ancestor', sha, base]) === null) {
        offenders.push(`docs/${rel}: ${sha}`);
      }
    }
  }

  // 豁免不得空转：一个文件都没命中 ⇒ 目录被删/改名了 —— 那这段豁免就是「写在这个前缀下的
  // 坏引用永远不被拦」的后门。要么修前缀，要么删掉豁免。
  assert.ok(
    HISTORICAL_PREFIXES.length === 0 || archived > 0,
    'HISTORICAL_PREFIXES 的历史快照豁免零命中（docs/ 下没有匹配的文件）—— 这是死豁免，不是豁免',
  );

  // 下限的作用**不是**「防整节被删」，而是**探浅克隆**：浅克隆下历史不可见 ⇒ resolved 归零 ⇒
  // 上面的循环一个都验不了、本守卫空转。实测值 6（2026-09-23，docs 全量）。
  // 不收紧到 6：删掉一处引用是合法编辑，而这里要拦的是「一个都验不了」。
  assert.ok(
    resolved >= 1,
    `一个提交引用都没验到（resolved=${resolved}）—— 大概率跑在**浅克隆**里（历史不可见），` +
      '本守卫会空转。CI 的 checkout 需要 fetch-depth: 0。',
  );
  assert.deepEqual(
    offenders,
    [],
    '文档引用了**不在主干上**的提交 —— squash 合并后分支提交会从 main 的祖先链上消失，' +
      '读者 `git show` 会报未知修订。改成合入提交（带 `(#NNN)` 的那个）：\n' +
      offenders.join('\n'),
  );
});
