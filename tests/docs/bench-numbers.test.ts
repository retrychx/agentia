/*
 * 「性能量级」三面的守卫 —— README / README.en / 官网 docs 页（2026-09-29，成熟度评审 P2-1）。
 *
 * ## 为什么需要它
 *
 * 评审实测到：本仓**有五个基准**（`scripts/bench-*.ts`），每个都能给出「换实现能省掉什么」的
 * 形状结论 —— 而对外文档面（`README.md` / `README.en.md` / 官网 docs 页）**一个性能数字都没有**
 * （`grep -nE "bench|ms" README.md` ⇒ 0 命中）。「零依赖」这类形容词不参与比较，**数字才参与**。
 *
 * 但把数字写进 README 会立刻踩本仓的老病：**写死的读数会腐烂**。而这一次有个额外的约束 ——
 *
 * ## ⚠️ 这里刻意**不**做的事：不把基准跑进守卫
 *
 * 五个基准是**计时类**的，而本仓早就定了处置（`docs/plans/2026-09-22-dev-debug-loop.md`：
 * 「与 `bench:trace` 同档，不进 verify-all / CI，要看时跑」）—— 计时基准在 CI 机器上只会制造抖动。
 * ⇒ 本守卫**不跑基准**，也就不假装能守住那些毫秒。它守的是另外三件真正能被机械复算的事：
 *
 *   ① 五个基准**每个都给了复跑命令**，且命令指向的脚本文件**真实存在**
 *      （文档给一条跑不通的命令，效果与写错数字一样 —— 读者照抄才发现是空的）；
 *   ② 每个面都**写清了「毫秒不是承诺」**（防有人把本机量级抄进营销文案当 SLA）；
 *   ③ 每个面都**写清了「基准刻意不进 CI」**（防有人把它塞进 CI，然后文档还写着「刻意不进」）。
 *
 * 换句话：这个守卫守的是**「读者能不能自己复算出那一列」**，而不是「那一列是多少」。
 * 对本仓而言，前者才是能机械复算的那一半。
 *
 * ## 反向验证（2026-09-29，逐条摘掉，各恰好点名那条）
 *
 *   ① `README.md` 的 `npx tsx scripts/bench-resume-scan.ts 10000` 改成
 *      `npx tsx scripts/bench-resume-scann.ts` ⇒ 只红「每个基准都有可跑的复跑命令 · README.md」；
 *   ② `README.en.md` 的 `npm run bench:otlp` 改成 `npm run bench:otlpp` ⇒ 只红英文那条
 *      （该 script 不在 `package.json` ⇒ 解析不到 ⇒ 覆盖断言当场漏一个）；
 *   ③ 官网 `docs.html` 的 `<section id="perf">` **整段**摘掉 ⇒ 红该面的三条（复跑命令 / 免责 /
 *      不进 CI）。⚠️ 侧栏锚点那条**不**跟着红 —— 它守的是**另一件事**（侧栏有没有入口），
 *      本节删了它照样绿；想要「这一节没了」的信号，靠的是这里那三条；
 *   ④ 中文 README 的「毫秒数不是承诺」那句删掉 ⇒ 只红免责那条（**不是**整节消失 —— 说明它测的是
 *      「这句还在不在」，而这句正是防误读的那一句）；
 *   ⑤ 英文 README 的 "deliberately not in CI" 改成 "deliberately skipped in CI" ⇒ 只红「不进 CI」那条。
 *   五条还原后 `sha256` 逐字节一致。
 *
 * ## 射程（刻意不做的部分）
 *
 * 不校验毫秒数（本机量级、且基准刻意不进 CI）、不校验表格排版、不评价该不该放这一节。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

/** 五个基准 —— 与 `scripts/` 目录**双向相等**：多一个没写进文档、少一个指向不存在的文件，都要红 */
const BENCH_SCRIPTS = [
  'scripts/bench-app-assembly.ts',
  'scripts/bench-trace-cost.ts',
  'scripts/bench-otlp-snapshot.ts',
  'scripts/bench-resume-scan.ts',
  'scripts/bench-redis-due.ts',
];

type Face = {
  file: string;
  /** 该面这一节的起始标记（找不到 ⇒ 解析锚点没了，直接红） */
  marker: string;
  /** 该面的语言 —— 免责/不进 CI 的措辞天然不同，断言也因此分语言写 */
  lang: 'zh' | 'en';
};

const FACES: Face[] = [
  { file: 'README.md', marker: '## 性能量级', lang: 'zh' },
  { file: 'README.en.md', marker: '## Performance order of magnitude', lang: 'en' },
  { file: 'packages/website/src/fragments/docs.html', marker: '<section id="perf">', lang: 'zh' },
];

const pkgScripts = JSON.parse(read('package.json')).scripts as Record<string, string>;

/** 抠出该面这一节的正文：markdown 到下一个同级标题，HTML 到 `</section>` */
function sectionOf(text: string, face: Face): string {
  const start = text.indexOf(face.marker);
  assert.notEqual(start, -1, `${face.file} 找不到「${face.marker}」—— 这一节没了（或标记被改）`);
  const rest = text.slice(start + face.marker.length);
  if (face.file.endsWith('.html')) {
    const end = rest.indexOf('</section>');
    return end === -1 ? rest : rest.slice(0, end);
  }
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * 从一段文本里抽出**所有能被机器判定的复跑命令**对应的脚本路径。
 *
 * 两种形态都得认：`npm run bench:X`（要走 `package.json` 解一层 —— 只有 3 个基准注册了 script）
 * 与 `npx tsx scripts/bench-Y.ts`（直接给路径）。
 */
function referencedScripts(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/npm run (bench:[A-Za-z0-9:_-]+)/g)) {
    const cmd = pkgScripts[m[1]];
    assert.ok(
      cmd,
      `${m[1]} 不在 package.json 的 scripts 里 —— 文档给了一条跑不通的命令` +
        '（要么补 script，要么写成 `npx tsx scripts/....ts`）',
    );
    const s = /(scripts\/[A-Za-z0-9._-]+\.ts)/.exec(cmd);
    assert.ok(s, `package.json 的 ${m[1]} 里解析不出脚本路径（实际：${cmd}）`);
    found.push(s[1]);
  }
  for (const m of text.matchAll(/(scripts\/bench-[A-Za-z0-9._-]+\.ts)/g)) found.push(m[1]);
  return found;
}

describe('性能量级 · 三面互为镜像（README / README.en / 官网）', () => {
  for (const face of FACES) {
    it(`${face.file}：五个基准每个都有可跑的复跑命令`, () => {
      const text = sectionOf(read(face.file), face);
      const refs = new Set(referencedScripts(text));

      // 自证：解析器退化成 0 命中会让下面的「每个都有」变成「每个都没有」⇒ 反而不红（静默全绿）
      assert.ok(
        refs.size >= BENCH_SCRIPTS.length,
        `${face.file} 只解析出 ${refs.size} 条复跑命令（期望 ≥ ${BENCH_SCRIPTS.length}）` +
          ` —— 抽出来的：${[...refs].join(', ') || '（空）'}`,
      );

      for (const bench of BENCH_SCRIPTS) {
        assert.ok(
          refs.has(bench),
          `${face.file} 没有给出「${bench}」的复跑命令 —— 读者复算不了那一列`,
        );
        assert.ok(
          existsSync(join(repoRoot, bench)),
          `${face.file} 指向的 ${bench} 不存在 —— 文档给了一条跑不通的命令（效果与写错数字一样）`,
        );
      }
    });

    it(`${face.file}：写清了「毫秒不是承诺」`, () => {
      const text = sectionOf(read(face.file), face);
      const re = face.lang === 'zh' ? /不是承诺/ : /not a promise/i;
      assert.match(
        text,
        re,
        `${face.file} 的性能量级节里没有「毫秒不是承诺」这句 —— 本机量级被抄走当 SLA 会错，` +
          '那一句正是防误读的那一句',
      );
    });

    it(`${face.file}：写清了「基准刻意不进 CI」`, () => {
      const text = sectionOf(read(face.file), face);
      const re = face.lang === 'zh' ? /不进 CI/ : /not in CI/i;
      assert.match(
        text,
        re,
        `${face.file} 的性能量级节里没有「基准刻意不进 CI」这句 —— 计时基准在 CI 上只制造抖动` +
          '（`docs/plans/2026-09-22-dev-debug-loop.md`：要看时跑）。这句没了，意味着有人把它塞进了 CI' +
          ' 却忘了改文档，或者反过来 —— 两种都要看得见。',
      );
    });
  }

  it('官网这一节进了侧栏（有 #perf 锚点）', () => {
    const html = read('packages/website/src/fragments/docs.html');
    assert.match(html, /<a href="#perf">/, '官网 docs 页的侧栏没有 #perf 链接 —— 这一节读者找不到');
  });

  it('自证：BENCH_SCRIPTS 与 scripts/ 目录里的 bench 文件双向相等', () => {
    // ① 守卫列的每个文件都得真在（防写错守卫自己）
    for (const bench of BENCH_SCRIPTS) {
      assert.ok(
        existsSync(join(repoRoot, bench)),
        `守卫列了 ${bench}，但文件不存在 —— 守卫自己写错了`,
      );
    }
    // ② 目录里的 bench 文件都得被守卫列到（新增基准 ⇒ 必须同步进三面文档）
    const actual = readdirSync(join(repoRoot, 'scripts'))
      .filter((f) => /^bench-.*\.ts$/.test(f))
      .map((f) => `scripts/${f}`)
      .sort();
    assert.deepEqual(
      actual,
      [...BENCH_SCRIPTS].sort(),
      'scripts/ 里的 bench 文件与本守卫列的清单不一致 —— 新增基准要同时改 BENCH_SCRIPTS 与三面文档',
    );
  });
});
