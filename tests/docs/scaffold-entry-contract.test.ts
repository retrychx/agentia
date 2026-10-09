import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 脚手架「入口契约」在交付面不得漂移（2026-10-09 把默认入口翻成服务时补的守卫）。
 *
 * **为什么需要它**：`agentia create` 的产物里，哪个文件是默认入口、哪个是一次性任务、
 * `.env` 读在哪个文件，都是使用者照着文档抄的**第一手信息**。这类口径本仓已经漂过两次：
 * ① 2026-09-22 拆出 `app.ts` 之后，官网 api 参考仍写着「脚手架 `main.ts` 首行已内置
 * `loadEnvFile`」—— 停了半个月（2026-10-09 复查时才翻到）；
 * ② 2026-10-09 把默认入口从「跑一次就退出」翻成「HTTP 服务」（设计稿
 * `docs/plans/2026-10-09-scaffold-default-service.md`）之后，仓库根 README、CLI README
 * 与官网两版 docs 页都残留了**翻转前**的说法。
 * 两次 `tsc`、单测、八步门禁**全绿**：它们扫源码与产物，不看散文，而读者看到的偏偏是
 * 散文那份。与 `no-legacy-terms.test.ts` 同一类病（改口径时类型系统看不见），只是这两次
 * 改的是**角色**与**归属**而不是名字 —— 所以那条守卫抓不到它。
 *
 * **覆盖范围**：只列「描述脚手架生成了什么」的面向使用者表面 —— 含官网 api 参考页那种
 * **借某个 API 条目顺带描述脚手架**的写法（`loadEnvFile` 那一行就是）。`docs/spec.md` /
 * `docs/plans/` / `CHANGELOG.md` 含**历史决策与历史版本记录**，如实引用旧形状是正确的
 * —— 刻意不入列（同 `no-legacy-terms.test.ts` 的取舍）。同理不入列 `examples/`：
 * 那里各工程自己的 `main.ts` / `app.ts` 是各自的角色，与脚手架的契约无关。
 *
 * ⚠️ 每条判据都带**防真空下限**：名词一改（入口文件再改名 / `create` 命令换写法 / 读 `.env`
 * 的函数换名字），判据会「扫不到任何东西」然后全绿 —— 那种绿是本仓最贵的失效形态
 * （`docs/guards.md` §3）。
 *
 * ⚠️ **射程**（别把它读成「这几层之外的漂移也守得住」）：
 * ① 整份表面**从不**提一次性入口 —— 守得住（这正是 2026-10-09 实际发生的那次）；
 * ② 某一行在**列举**产出（同一行还出现 ≥2 个其它脚手架文件）却没提它 —— 守得住；
 * ③ 某一行把 `loadEnvFile` 挂在默认入口上、又不提装配模块 —— 守得住（2026-09-22 那次）；
 * ④ **不在射程内**：目录树那种「一行只写一个文件」的列举里少一条、散文把两个入口名折到
 *    相邻两行、以及**没写出 `loadEnvFile` 这个标识符**的 `.env` 归属句（例如只说「首行读
 *    `.env`」）。④ 的共同点是「一行看不出来」或「判不出来」，硬判要么误红要么看着像守住了
 *    （§3 第 1 条：误报的门禁最终会被人关掉，等于没有）。
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** 描述脚手架产物的面向使用者表面（相对仓库根） */
const SURFACES: readonly string[] = [
  'README.md',
  'docs/usage-guide.md',
  'packages/cli/README.md',
  'packages/cli/templates/README.md',
  'packages/website/src/fragments/docs.html',
  'packages/website/src/fragments/en/docs.html',
  'packages/website/src/fragments/api.html',
  'packages/website/src/fragments/en/api.html',
];

/** 建工程的命令：某份表面出现它 = 它正在讲「脚手架生成了什么」 */
const SCAFFOLD_CMD = 'agentia create';

/**
 * 默认入口的文件名。用**词边界**匹配而不是裸 `includes`：`main.ts` 是 `domain.ts` 的子串，
 * 裸包含会把无关的行算进来。
 */
const DEFAULT_ENTRY = /(^|[^A-Za-z0-9_])main\.ts/;

/** 一次性入口的文件名 —— 漏了它，读者会以为脚手架只有一个入口 */
const ONESHOT_ENTRY = 'batch.ts';

/**
 * 同一行里还出现的**其它脚手架产出**。一行里出现 **≥2 个**才算「这一行在列举脚手架生成了
 * 哪些文件」（建工程那一格 / 文件分工表 / README 的快速开始注释就是这种形状）。
 *
 * 为什么是「≥2」而不是「≥1」：**宁可窄，不要误报**（`docs/guards.md` §3 第 1 条）。
 * 散文里顺带提一句 `app.ts` 的行很多（例如「`.env` 由 `app.ts` 读」），而它们常把
 * `main.ts` / `batch.ts` 折到下一行 —— 按 ≥1 判会当场误红（本守卫第一版就是这么红的）。
 *
 * 为什么要这一层：只查「整份文件提不提一次性入口」太粗 —— 删掉某**一处**枚举里的它，
 * 其余位置还留着，判据照样绿（变异 M1/M3 第一次跑就是这么漏的）。
 */
const OTHER_SCAFFOLD_FILES: readonly string[] = [
  'app.ts',
  'registry.ts',
  'dev.config.ts',
  'session-store.ts',
];

/** 一行里至少要有这么多个「其它脚手架产出」才算在列举 */
const MIN_OTHER_FILES_FOR_ENUM_LINE = 2;

/**
 * **翻转前**用来形容默认入口的措辞，出现即失败。
 *
 * 字面量**只活在这个数组里**：散文（本文件其它注释、CHANGELOG、spec）一律写成「翻转前的
 * 说法」—— 否则下一个人 grep 这个术语时，会先命中守卫自己的注释，而注释里出现它
 * 并不表示文档漂移了。
 */
const STALE_ENTRY_WORDING: readonly string[] = ['薄入口', 'thin entry point'];

/**
 * 装配模块：`.env` 归它读。与默认入口同现、却不提它 ⇒ 这篇表面把 `.env` 挂到了入口上
 * （装配/入口分离契约里最贵的一处错 —— 挂错一侧时 `agentia dev` 静默读不到 `.env`，
 * 用户看到的是「没配 key」，然后去怀疑框架）。
 */
const ASSEMBLY_MODULE = 'app.ts';

/** 读 `.env` 的 API 名。用它当触发词（而不是「`.env`」）是刻意的：窄，不误报。 */
const ENV_LOADER = 'loadEnvFile';

/**
 * 提到 `ENV_LOADER` 的表面数下限。**这是本判据真正的防真空阀**：函数一改名（或 `.env`
 * 读取换了别的 API），逐行判据会一行都判不到然后全绿。2026-10-09 实测 7（八份表面里
 * 只有 `packages/cli/README.md` 不提它）。
 */
const MIN_SURFACES_NAMING_ENV_LOADER = 6;

/**
 * 被「`ENV_LOADER` 与默认入口同现」真正判过的行数下限。2026-10-09 修完后实测 **1**
 * （只剩 `docs/usage-guide.md` 那条「必须在 `app.ts`、不能在入口」的 ⚠️ 规则本身）。
 * 低是正常的 —— 这条判据是「矛盾检测」，不是「穷举检测」；跌破 0 说明那条规则被删了。
 */
const MIN_ENV_LOADER_LINES = 1;

/** 在盘上真被「整份文件」那条判过的表面数下限。2026-10-09 实测 5（只有 templates/README.md
 *  不提 `agentia create` 命令 ⇒ 不适用）。跌破先弄清是「名词改了」还是「文件被搬了」，再调。 */
const MIN_CHECKED_SURFACES = 4;

/** 在盘上真被「枚举行」那条判过的行数下限。2026-10-09 实测 4（三个 `create` 那一格 + CLI README
 *  的快速开始注释）。 */
const MIN_ENUM_LINES = 3;

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('脚手架入口契约：交付面不得漂移', () => {
  it('扫描面非空、每份都读得到（守卫自身不能空跑）', () => {
    assert.ok(SURFACES.length >= 8, `扫描面只有 ${SURFACES.length} 份`);
    for (const f of SURFACES) {
      assert.ok(read(f).length > 200, `${f} 内容过短 —— 路径读错了？`);
    }
  });

  it('讲脚手架产物的表面必须同时点名两个入口', () => {
    const checked: string[] = [];
    const missing: string[] = [];
    for (const f of SURFACES) {
      const text = read(f);
      if (!text.includes(SCAFFOLD_CMD) || !DEFAULT_ENTRY.test(text)) continue;
      checked.push(f);
      if (!text.includes(ONESHOT_ENTRY)) missing.push(f);
    }
    assert.ok(
      checked.length >= MIN_CHECKED_SURFACES,
      `只有 ${checked.length} 份表面真的被这条判过（下限 ${MIN_CHECKED_SURFACES}）—— 判据在空转：\n` +
        `  命中：${checked.join(', ') || '（无）'}`,
    );
    assert.deepEqual(
      missing,
      [],
      '这些表面点名了脚手架的默认入口，却没提一次性入口 —— 读者会以为脚手架只有一个入口：\n' +
        missing.map((f) => `  ${f}`).join('\n'),
    );
  });

  it('列举脚手架产出的那一行必须带上一次性入口（逐行判，防「只删一处枚举」）', () => {
    const hits: string[] = [];
    let linesChecked = 0;
    for (const f of SURFACES) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (!DEFAULT_ENTRY.test(line)) return;
          const others = OTHER_SCAFFOLD_FILES.filter((o) => line.includes(o));
          if (others.length < MIN_OTHER_FILES_FOR_ENUM_LINE) return;
          linesChecked += 1;
          if (!line.includes(ONESHOT_ENTRY)) {
            hits.push(`${f}:${i + 1} → ${line.trim().slice(0, 90)}`);
          }
        });
    }
    assert.ok(
      linesChecked >= MIN_ENUM_LINES,
      `只判到 ${linesChecked} 行枚举（下限 ${MIN_ENUM_LINES}）—— 判据在空转（名词改了？）`,
    );
    assert.deepEqual(
      hits,
      [],
      '这些行在列举脚手架的产出，却没提一次性入口 —— 读者会以为脚手架只有一个入口：\n' +
        hits.map((h) => `  ${h}`).join('\n'),
    );
  });

  it('不得用翻转前的措辞形容默认入口', () => {
    const hits: string[] = [];
    for (const f of SURFACES) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (!DEFAULT_ENTRY.test(line)) return;
          for (const w of STALE_ENTRY_WORDING) {
            if (line.includes(w)) {
              hits.push(`${f}:${i + 1} 「${w}」与默认入口同现 → ${line.trim().slice(0, 80)}`);
            }
          }
        });
    }
    assert.deepEqual(hits, [], `默认入口被写成了单次入口：\n  ${hits.join('\n  ')}`);
  });

  it('讲 `.env` 读取的那一行不得把 loadEnvFile 挂在默认入口上', () => {
    const hits: string[] = [];
    let linesChecked = 0;
    let surfacesNamingLoader = 0;
    for (const f of SURFACES) {
      const text = read(f);
      if (text.includes(ENV_LOADER)) surfacesNamingLoader += 1;
      text.split('\n').forEach((line, i) => {
        if (!line.includes(ENV_LOADER)) return;
        if (!DEFAULT_ENTRY.test(line)) return;
        linesChecked += 1;
        if (!line.includes(ASSEMBLY_MODULE)) {
          hits.push(
            `${f}:${i + 1} 把 ${ENV_LOADER} 挂在默认入口上却没提 ${ASSEMBLY_MODULE} → ${line.trim().slice(0, 90)}`,
          );
        }
      });
    }
    assert.ok(
      surfacesNamingLoader >= MIN_SURFACES_NAMING_ENV_LOADER,
      `只有 ${surfacesNamingLoader} 份表面提到 ${ENV_LOADER}（下限 ${MIN_SURFACES_NAMING_ENV_LOADER}）` +
        '—— 判据在空转：读 `.env` 的 API 改名了？',
    );
    assert.ok(
      linesChecked >= MIN_ENV_LOADER_LINES,
      `「${ENV_LOADER} 与默认入口同现」的行只判到 ${linesChecked} 行（下限 ${MIN_ENV_LOADER_LINES}）` +
        ' —— 判据在空转',
    );
    assert.deepEqual(
      hits,
      [],
      `${ENV_LOADER} 归装配模块 ${ASSEMBLY_MODULE} 读，不归入口 —— 挂错一侧时 \`agentia dev\` 会静默读不到 .env：\n` +
        hits.map((h) => `  ${h}`).join('\n'),
    );
  });

  it('正向：单源与 CLI README 真的写明了两个入口（防「扫了一堆空文件」的假绿）', () => {
    const guide = read('docs/usage-guide.md');
    assert.match(guide, /`src\/main\.ts`/, 'usage-guide 的文件表应逐字写出 src/main.ts');
    assert.match(guide, /`src\/batch\.ts`/, 'usage-guide 的文件表应逐字写出 src/batch.ts');
    assert.match(guide, /默认入口/, 'usage-guide 应写明「默认入口」这个角色');

    const cliReadme = read('packages/cli/README.md');
    assert.ok(DEFAULT_ENTRY.test(cliReadme), 'CLI README 应写明 src/main.ts');
    assert.ok(cliReadme.includes(ONESHOT_ENTRY), 'CLI README 应写明 src/batch.ts');
  });
});
