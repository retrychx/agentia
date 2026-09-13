import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 伞形术语改名（2026-09-13，见 spec §10）的回归守卫。
 *
 * **为什么需要它**：这类漂移不会被类型系统发现 —— 改名时 `tsc` 与单测全绿，文档里却还写着
 * `readonly unit:` / `labelMode?='unit'` / `units/`，使用者照着抄就是错的（本轮实际漏过三处，
 * 是人工 grep 才挖出来的）。所以把「面向使用者的表面不得出现旧术语」钉成一条测试。
 *
 * **覆盖范围**：不止 `usage-guide` —— 第一次落地时只扫了 README / usage-guide / 官网
 * `fragments`+`scripts` / examples，结果**漏掉四类发布面**：npm 包的 `README.md` 与
 * `package.json` 的 `description`（都随包发布）、官网 `pages`+`components`+`layouts`
 * 与静态资源（`.astro` / `.svg` 当时不在扫描扩展名里，Nav 标签与 meta description 全在盲区）、
 * 以及 CLI 源码里的 `--help` 用法串与报错措辞（字符串漂移类型系统看不见）。现已补齐。
 *
 * **排除** `docs/spec.md` / `docs/roadmap.md` / `docs/plans/`：它们含**历史决策记录**，
 * 如实引用旧名是正确的 —— 改掉反而篡改历史。
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** 旧的伞形术语（标识符 / 字面量 / 目录约定），出现即失败 */
const LEGACY_TERMS: readonly string[] = [
  // 公共类型名
  'UnitMiddleware',
  'UnitCall',
  'UnitNext',
  'UnitType',
  'UnitMetrics',
  'UnitReport',
  'UnitDecoratorContext',
  'SkillUnit',
  'SubAgentUnit',
  // 常量 / 内部标识符
  'UNIT_TYPES',
  'UNIT_ICO',
  // 字段
  'maxUnits',
  'droppedUnits',
  // 指标名与标签
  'agentia_unit_',
  'labelMode: \'unit\'',
  'labelMode:\'unit\'',
  "labelMode?='unit'",
  // 结构面写法
  'readonly unit:',
  '{ unit; input',
  // 旧目录约定
  'units/',
  'units.ts',
];

/**
 * 中文旧伞形词：禁「单元」，但**放行「单元测试」**（unit test，与目录约定无关的通用词）。
 * 设计文档 §4 的附带决定：中文里「单元」一并改称「能力」（与既有「能力包」同族）。
 */
const LEGACY_ZH = /单元(?!测试)/;

/**
 * 显式豁免块：**允许**在标记之间如实引用旧术语（如「从老布局 `units/` 迁移」的说明）——
 * 与 spec §10 决策记录同理，这类内容点不出旧名就讲不清。
 *
 * 必须打标记才生效，所以**不会**让未来的漂移悄悄藏进来；下方另有一条断言把全仓豁免行数
 * 钉在上限（豁免只能是「有理由的少数」，不能变成把守卫关掉的开关）。
 */
const ALLOW_BEGIN = '<!-- no-legacy-terms: allow -->';
const ALLOW_END = '<!-- /no-legacy-terms: allow -->';

/** 全仓允许的豁免行数上限（超过说明有人在拿豁免当开关用） */
const ALLOW_MAX_LINES = 6;

const SCAN_EXT = new Set(['.ts', '.js', '.mjs', '.md', '.html', '.json', '.astro', '.svg']);

/**
 * 路径级排除：这些文件**整份**都是「旧术语的迁移机制」，每处命名都承重
 * （同 `docs/spec.md` 决策记录的道理）。仍受类型系统与 CLI 自己的单测约束。
 */
const EXCLUDED_FILES = new Set([join(repoRoot, 'packages/cli/src/layout.ts')]);

/** 递归收集目录下的可扫描文件（跳过 node_modules / dist / .astro 产物与排除文件） */
function collect(p: string, out: string[]): void {
  for (const e of readdirSync(p)) {
    if (e === 'node_modules' || e === 'dist' || e === '.astro') continue;
    const child = join(p, e);
    if (EXCLUDED_FILES.has(child)) continue;
    if (statSync(child).isDirectory()) collect(child, out);
    else if (SCAN_EXT.has(extname(child))) out.push(child);
  }
}

/** 面向使用者的表面（历史决策文档不在内） */
function userFacingFiles(): string[] {
  const out: string[] = [];
  const addFile = (p: string): void => {
    if (existsSync(p) && SCAN_EXT.has(extname(p))) out.push(p);
  };

  // 仓库根：README + npm 包描述
  addFile(join(repoRoot, 'README.md'));
  addFile(join(repoRoot, 'package.json'));

  // 单源文档 + 可观测配方
  addFile(join(repoRoot, 'docs/usage-guide.md'));
  addFile(join(repoRoot, 'docs/observability.md'));

  // 官网整棵 src（页面 / 组件 / 布局 / 正文片段 / 客户端脚本）+ 静态资源
  collect(join(repoRoot, 'packages/website/src'), out);
  collect(join(repoRoot, 'packages/website/public'), out);

  // 各发布包的 README（npm 上会显示的）与 package.json（description 会显示）
  for (const pkg of ['cli', 'trace-view', 'website']) {
    addFile(join(repoRoot, `packages/${pkg}/package.json`));
    addFile(join(repoRoot, `packages/${pkg}/README.md`));
  }

  // CLI 源码里的**用户可见文本**（`--help` 用法串、报错措辞）—— 类型系统看不见这类字符串漂移，
  // 必须靠本条守卫（`layout.ts` 是迁移机制，按路径排除，见 EXCLUDED_FILES）
  collect(join(repoRoot, 'packages/cli/src'), out);

  // 示例（只 import 公共面，是「抄了就用」的样板）
  collect(join(repoRoot, 'examples'), out);

  return out;
}

describe('伞形术语改名：面向使用者的表面不得残留旧术语', () => {
  const files = userFacingFiles();

  it('扫描面非空（守卫自身不能空跑）', () => {
    assert.ok(files.length >= 20, `扫描文件过少（${files.length}），守卫可能空跑`);
    // 三类曾漏掉的发布面必须真的在扫描面里，否则守卫形同虚设
    for (const needle of ['packages/cli/README.md', 'package.json', 'Nav.astro', 'index.astro', 'packages/cli/src/cli.ts']) {
      assert.ok(
        files.some((f) => f.endsWith(needle)),
        `扫描面应包含 ${needle}（曾漏掉的发布面）`,
      );
    }
  });

  it('README / usage-guide / 官网 / 示例 / 发布包 里没有旧术语与旧目录约定', () => {
    const hits: string[] = [];
    let allowedLines = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let allowed = false;
      text.split('\n').forEach((line, i) => {
        if (line.includes(ALLOW_BEGIN)) {
          allowed = true;
          return;
        }
        if (line.includes(ALLOW_END)) {
          allowed = false;
          return;
        }
        if (allowed) {
          allowedLines += 1;
          return;
        }
        for (const term of LEGACY_TERMS) {
          if (line.includes(term)) {
            hits.push(`${relative(repoRoot, file)}:${i + 1} 出现「${term}」 → ${line.trim().slice(0, 90)}`);
          }
        }
        if (LEGACY_ZH.test(line)) {
          hits.push(`${relative(repoRoot, file)}:${i + 1} 出现中文旧词「单元」 → ${line.trim().slice(0, 90)}`);
        }
      });
      assert.equal(allowed, false, `${relative(repoRoot, file)} 的豁免块没有闭合（缺 ${ALLOW_END}）`);
    }
    assert.deepEqual(hits, [], `旧术语残留：\n  ${hits.join('\n  ')}`);
    assert.ok(
      allowedLines <= ALLOW_MAX_LINES,
      `豁免行数 ${allowedLines} 超过上限 ${ALLOW_MAX_LINES} —— 豁免只该给「必须点出旧名才讲得清」的少数段落，不是关掉守卫的开关`,
    );
  });

  it('新术语确实出现在该出现的地方（防止「扫了一堆空文件」的假绿）', () => {
    const guide = readFileSync(join(repoRoot, 'docs/usage-guide.md'), 'utf8');
    for (const needle of ['src/tools', 'src/skills', 'src/prompts', 'src/subagents', 'src/registry.ts', 'CapabilityMiddleware']) {
      assert.ok(guide.includes(needle), `usage-guide 应写明 ${needle}`);
    }
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    for (const needle of ['src/tools', 'src/registry.ts']) {
      assert.ok(readme.includes(needle), `README 应写明 ${needle}`);
    }
    // 发布面已改为四分类目录（曾写成 units.ts / units/<name>/）
    const cliReadme = readFileSync(join(repoRoot, 'packages/cli/README.md'), 'utf8');
    for (const needle of ['src/registry.ts', '四分类', 'src/tools']) {
      assert.ok(cliReadme.includes(needle), `CLI README 应写明 ${needle}`);
    }
    // 官网首页导航标签已改称「能力」（曾是「单元」）
    const nav = readFileSync(join(repoRoot, 'packages/website/src/components/Nav.astro'), 'utf8');
    assert.ok(nav.includes('>能力<'), '首页导航标签应为「能力」');
  });
});
