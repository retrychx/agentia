// CLI 端到端验证：目录约定 + 发现机制 + CLI 端到端。
// agentia create 脚手架 → agentia g 生成四类能力 → 注册表 codemod →
// discoverProviders/createApp({discover}) 装配 → mock 模型跑通一次 run。
// 运行：npm run e2e（先 build 框架与 CLI，再 tsx 跑本脚本）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 注意：从 dist 而非 src 导入 —— 生成项目 import '@migor/agentia' 解析到 dist/index.js，
// 装饰器注册表（WeakMap）必须在同一模块实例里，否则 collect* 收不到 spec。
import { createApp, discoverProviders, SystemPrompt } from '../dist/index.js';
// 共用 mock 走 tests/helpers（AGENTS.md：那是**共用** mock client）—— 别在本脚本里手搓一份
import { mockClient, toolUseMsg, endTurnMsg } from '../tests/helpers.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const tmp = mkdtempSync(join(tmpdir(), 'agentia-cli-'));
const cli = (args: string[], cwd: string): string =>
  execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });

try {
  // —— 1) create：项目骨架 ——
  cli(['create', 'demo-app', '--dir', tmp], tmp);
  const proj = join(tmp, 'demo-app');
  for (const f of ['package.json', 'tsconfig.json', 'src/main.ts', 'src/registry.ts', 'src/tools/hello/index.ts', 'AGENTS.md']) {
    assert(existsSync(join(proj, f)), `create 缺文件: ${f}`);
  }
  // 四个分类目录都建出来（空目录靠 .gitkeep 进版本库）：目录名自解释，用户一看就知道新能力往哪放
  for (const d of ['src/tools', 'src/skills', 'src/prompts', 'src/subagents']) {
    assert(existsSync(join(proj, d, '.gitkeep')), `create 应建出 ${d}/（含 .gitkeep）`);
  }
  // tsconfig 必须只 include 'src' —— 能力目录/注册表全在 src 下，一个 include 全覆盖。
  // 曾经是 ['src', 'capabilities.ts'] 却漏掉能力目录本身 → 未登记的能力静默不参与类型检查。
  const tsconfig = JSON.parse(readFileSync(join(proj, 'tsconfig.json'), 'utf8'));
  assert(
    JSON.stringify(tsconfig.include) === JSON.stringify(['src']),
    `脚手架 tsconfig.include 应为 ['src']，实际 ${JSON.stringify(tsconfig.include)}`,
  );

  // 使用者向 AI 说明：单源 docs/usage-guide.md → 构建拷进 dist/AGENTS.md → create 写进项目。
  // 三段任一断掉，AI 辅助编码就退化成「猜 API」，所以这里按内容验。
  const guide = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  for (const needle of [
    'declare module', // Blackboard 声明合并
    'fromZod', // schema 单一事实来源
    'RunContext',
    'createApp',
    '@SubAgent',
    '已知边界', // 如实标注的边界（不写就没有）
  ]) {
    assert(guide.includes(needle), `项目 AGENTS.md 缺少关键内容: ${needle}`);
  }
  assert(guide.length > 5000, `项目 AGENTS.md 过短（${guide.length}）`);

  // —— 2) g：四类能力各一个 ——
  cli(['g', 'subagent', 'doc-reviewer'], proj);
  cli(['g', 'skill', 'note-writer'], proj);
  cli(['g', 'prompt', 'style-guide'], proj);
  cli(['g', 'tool', 'echo-back'], proj);
  assert(existsSync(join(proj, 'src/subagents/doc-reviewer/system.md')), 'subagent 应带 system.md');
  assert(existsSync(join(proj, 'src/prompts/style-guide/asset.md')), 'prompt 应带 asset.md');

  // 分类落位：type → 目录（目录名就是类型）
  assert(existsSync(join(proj, 'src/tools/echo-back/index.ts')), 'tool 应落在 src/tools/');
  assert(existsSync(join(proj, 'src/skills/note-writer/index.ts')), 'skill 应落在 src/skills/');
  assert(existsSync(join(proj, 'src/prompts/style-guide/index.ts')), 'prompt 应落在 src/prompts/');
  assert(existsSync(join(proj, 'src/subagents/doc-reviewer/index.ts')), 'subagent 应落在 src/subagents/');

  // —— 3) 注册表 codemod ——
  const registry = readFileSync(join(proj, 'src/registry.ts'), 'utf8');
  for (const tok of ['hello', 'doc-reviewer', 'note-writer', 'style-guide', 'echo-back']) {
    assert(registry.includes(`'${tok}'`), `src/registry.ts 缺 token: ${tok}`);
  }
  // import 前缀按分类目录走（相对 src/registry.ts）
  for (const rel of ['./tools/hello/index.js', './subagents/doc-reviewer/index.js', './skills/note-writer/index.js', './prompts/style-guide/index.js', './tools/echo-back/index.js']) {
    assert(registry.includes(`from '${rel}'`), `src/registry.ts 缺 import: ${rel}`);
  }

  // 幂等/错误路径：同名再 g 报错
  let dupFailed = false;
  try {
    cli(['g', 'tool', 'echo-back'], proj);
  } catch {
    dupFailed = true;
  }
  assert(dupFailed, '重复 g 同名应失败');

  // —— 4) 让生成项目的 `import '@migor/agentia'` 可解析（symlink 回仓库根，框架已 build 到 dist）——
  mkdirSync(join(proj, 'node_modules', '@migor'), { recursive: true });
  symlinkSync(repoRoot, join(proj, 'node_modules', '@migor', 'agentia'), 'dir');

  // —— 5) 发现机制：discoverProviders（四分类目录数组，顺序即装配顺序）——
  const capabilityDirs = ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'].map((d) => join(proj, d));
  const discovered = await discoverProviders(capabilityDirs);
  const tokens = discovered.map((p) => p.provide).sort();
  assert(
    JSON.stringify(tokens) === JSON.stringify(['doc-reviewer', 'echo-back', 'hello', 'note-writer', 'style-guide']),
    `发现 token=${tokens}`,
  );

  // —— 6) createApp({ discover }) + mock 模型：装配五能力并真跑一个工具 ——
  // 复用 tests/helpers.ts 的共用 mock：手搓那份的类型不完整，是给 scripts/ 接上类型检查时才暴露的
  // （共用版在 helpers 里以 `as never` 收口，且被全部单测覆盖）。onParams 用来抓第二次往返的入参。
  let secondParams: unknown = null;
  const { client } = mockClient([
    toolUseMsg('echo_back', { text: 'smoke' }),
    {
      onParams: (p) => {
        secondParams = p;
      },
      message: endTurnMsg('done'),
    },
  ]);

  const app = await createApp({
    name: 'cli-app',
    discover: capabilityDirs,
    system: new SystemPrompt().add('role', '测试装配', true),
  });
  const menu = app.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(menu) === JSON.stringify(['doc_reviewer', 'echo_back', 'hello', 'note_writer', 'style_guide']),
    `菜单=${menu}`,
  );

  const { run, result } = await app.run([{ role: 'user', content: '回显一下' }], { client });
  assert(run.status === 'succeeded', `run.status=${run.status}`);
  assert(result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);
  const s = JSON.stringify(secondParams);
  assert(s.includes('tool_result') && s.includes('echo: smoke'), '发现的工具应真的被执行并回 tool_result');

  // —— 7) 注册表路线：import 生成的 src/registry.ts 显式装配 ——
  const registryMod = await import(`${proj}/src/registry.ts`);
  const app2 = createApp({
    name: 'cli-registry',
    providers: registryMod.providers,
    system: new SystemPrompt().add('role', '测试装配', true),
  });
  assert(app2.tools.length === 5, `注册表路线菜单=${app2.tools.map((t) => t.name)}`);

  console.log('E2E-CLI PASS');
  console.log(JSON.stringify({
    scaffolded: proj.replace(tmp, '<tmp>'),
    discoveredTokens: tokens,
    menu,
    runStatus: run.status,
    toolResultReachedModel: s.includes('echo: smoke'),
    registryRouteTools: app2.tools.length,
    projectAgentsMdBytes: guide.length,
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
