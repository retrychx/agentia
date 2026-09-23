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

test('docs/** 引用的提交必须真在主干上（引用不得腐化）', () => {
  const base = baseRef();
  assert.ok(
    base !== null,
    '取不到任何可比对的主干 ref（origin/main / origin/HEAD / HEAD 都解析不出来）',
  );

  const offenders: string[] = [];
  let resolved = 0;

  for (const rel of markdownFiles(DOCS)) {
    const md = readFileSync(join(DOCS, rel), 'utf8');
    const seen = new Set<string>();
    for (const m of md.matchAll(SHA_IN_BACKTICKS)) {
      const sha = m[1];
      if (seen.has(sha)) continue;
      seen.add(sha);
      // 解析不成 commit ⇒ 它只是某个十六进制词，不是提交引用，跳过
      if (git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) === null) continue;
      resolved += 1;
      // 非零退出 = 不是祖先 ⇒ 引用了一个不在主干上的提交
      if (git(['merge-base', '--is-ancestor', sha, base]) === null) {
        offenders.push(`docs/${rel}: ${sha}`);
      }
    }
  }

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
