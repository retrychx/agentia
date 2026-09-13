import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 伞形术语改名（2026-09-13，见 spec §10）的回归守卫。
 *
 * **为什么需要它**：这类漂移不会被类型系统发现 —— 改名时 `tsc` 与单测全绿，文档里却还写着
 * `readonly unit:` / `labelMode?='unit'` / `units/`，使用者照着抄就是错的（本轮实际漏过三处，
 * 是人工 grep 才挖出来的）。所以把「面向使用者的表面不得出现旧术语」钉成一条测试。
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
];

const SCAN_EXT = new Set(['.ts', '.js', '.mjs', '.md', '.html', '.json']);

/** 面向使用者的表面（历史决策文档不在内） */
function userFacingFiles(): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        const child = join(p, e);
        if (statSync(child).isDirectory()) push(child);
        else if (SCAN_EXT.has(extname(child))) out.push(child);
      }
    } else if (SCAN_EXT.has(extname(p))) {
      out.push(p);
    }
  };
  out.push(join(repoRoot, 'README.md'));
  out.push(join(repoRoot, 'docs/usage-guide.md'));
  push(join(repoRoot, 'packages/website/src/fragments'));
  push(join(repoRoot, 'packages/website/src/scripts'));
  push(join(repoRoot, 'examples'));
  return out;
}

describe('伞形术语改名：面向使用者的表面不得残留旧术语', () => {
  const files = userFacingFiles();

  it('扫描面非空（守卫自身不能空跑）', () => {
    assert.ok(files.length >= 10, `扫描文件过少（${files.length}），守卫可能空跑`);
  });

  it('README / usage-guide / 官网 / 示例里没有旧术语与旧目录约定', () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const term of LEGACY_TERMS) {
          if (line.includes(term)) {
            hits.push(`${relative(repoRoot, file)}:${i + 1} 出现「${term}」 → ${line.trim().slice(0, 90)}`);
          }
        }
      });
    }
    assert.deepEqual(hits, [], `旧术语残留：\n  ${hits.join('\n  ')}`);
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
  });
});
