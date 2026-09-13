import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 对构建产物测试（未构建时跳过而非报错）。 */
const DIST = fileURLToPath(new URL('../dist/templates.js', import.meta.url));
let T = null;
if (existsSync(DIST)) T = await import(new URL('../dist/templates.js', import.meta.url).href);
const SKIP = !T ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

describe('templates 目录约定（四分类目录，无伞形词）', { skip: SKIP }, () => {
  it('四个分类目录都在 src/ 下，且与四个能力类型一一对应', () => {
    assert.deepEqual(T.CAPABILITY_DIR_LIST, ['src/tools', 'src/skills', 'src/prompts', 'src/subagents']);
    assert.deepEqual(Object.keys(T.CAPABILITY_DIRS).sort(), [...T.CAPABILITY_TYPES].sort());
  });

  it('脚手架 tsconfig 的 include 覆盖全部能力目录', () => {
    // 原实现是 include: ['src', 'capabilities.ts']，漏了能力目录本身 ——
    // 未登记进注册表的能力（discover 路线允许不登记）静默不参与类型检查。
    const ts = JSON.parse(T.projectTsconfig());
    assert.deepEqual(ts.include, ['src']);
    for (const dir of T.CAPABILITY_DIR_LIST) {
      assert.ok(dir.startsWith('src/'), `${dir} 必须在 include 的 src 下`);
    }
  });

  it('注册表落在 src/ 下（不再是项目根的伞形词文件）', () => {
    assert.equal(T.REGISTRY_PATH, 'src/registry.ts');
  });

  it('main.ts 模板的 discover 列全四分类目录（顺序即装配顺序）', () => {
    const main = T.mainTs('demo');
    for (const dir of T.CAPABILITY_DIR_LIST) assert.ok(main.includes(`'${dir}'`), `main.ts 缺 ${dir}`);
  });

  it('main.ts 模板在 run 失败时给出原因并置非零退出码', () => {
    // run 失败**不抛**（硬失败记进 result.error），模板若不显式检查就会「打印空行 + 退出 0」，
    // 让首次运行（如没配 ANTHROPIC_API_KEY）看起来像成功 —— 实测过这个静默失败。
    const main = T.mainTs('demo');
    assert.ok(main.includes('result.error'), 'main.ts 应检查 result.error');
    assert.ok(main.includes('result.stopReason'), 'main.ts 应打印 stopReason');
    assert.ok(main.includes('process.exitCode = 1'), 'main.ts 失败时应置非零退出码');
  });
});
