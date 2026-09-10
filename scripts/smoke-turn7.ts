// Turn 7 冒烟：目录约定 + 发现机制 + CLI 端到端。
// agentia create 脚手架 → agentia g 生成四类单元 → 注册表 codemod →
// discoverProviders/createApp({discover}) 装配 → mock 模型跑通一次 run。
// 运行：npm run smoke:turn7（先 build 框架与 CLI，再 tsx 跑本脚本）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 注意：从 dist 而非 src 导入 —— 生成项目 import 'agentia' 解析到 dist/index.js，
// 装饰器注册表（WeakMap）必须在同一模块实例里，否则 collect* 收不到 spec。
import { createApp, discoverProviders, SystemPrompt } from '../dist/index.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const tmp = mkdtempSync(join(tmpdir(), 'agentia-turn7-'));
const cli = (args: string[], cwd: string): string =>
  execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });

try {
  // —— 1) create：项目骨架 ——
  cli(['create', 'demo-app', '--dir', tmp], tmp);
  const proj = join(tmp, 'demo-app');
  for (const f of ['package.json', 'tsconfig.json', 'src/main.ts', 'units.ts', 'units/hello/index.ts']) {
    assert(existsSync(join(proj, f)), `create 缺文件: ${f}`);
  }

  // —— 2) g：四类单元各一个 ——
  cli(['g', 'subagent', 'doc-reviewer'], proj);
  cli(['g', 'skill', 'note-writer'], proj);
  cli(['g', 'prompt', 'style-guide'], proj);
  cli(['g', 'tool', 'echo-back'], proj);
  assert(existsSync(join(proj, 'units/doc-reviewer/system.md')), 'subagent 应带 system.md');
  assert(existsSync(join(proj, 'units/style-guide/asset.md')), 'prompt 应带 asset.md');

  // —— 3) 注册表 codemod ——
  const registry = readFileSync(join(proj, 'units.ts'), 'utf8');
  for (const tok of ['hello', 'doc-reviewer', 'note-writer', 'style-guide', 'echo-back']) {
    assert(registry.includes(`'${tok}'`), `units.ts 缺 token: ${tok}`);
  }
  assert(registry.includes("import DocReviewer from './units/doc-reviewer/index.js';"), '缺 subagent import');

  // 幂等/错误路径：同名再 g 报错
  let dupFailed = false;
  try {
    cli(['g', 'tool', 'echo-back'], proj);
  } catch {
    dupFailed = true;
  }
  assert(dupFailed, '重复 g 同名应失败');

  // —— 4) 让生成项目的 `import 'agentia'` 可解析（symlink 回仓库根，框架已 build 到 dist）——
  mkdirSync(join(proj, 'node_modules'), { recursive: true });
  symlinkSync(repoRoot, join(proj, 'node_modules', 'agentia'), 'dir');

  // —— 5) 发现机制：discoverProviders ——
  const unitsDir = join(proj, 'units');
  const discovered = await discoverProviders(unitsDir);
  const tokens = discovered.map((p) => p.provide).sort();
  assert(
    JSON.stringify(tokens) === JSON.stringify(['doc-reviewer', 'echo-back', 'hello', 'note-writer', 'style-guide']),
    `发现 token=${tokens}`,
  );

  // —— 6) createApp({ discover }) + mock 模型：装配五单元并真跑一个工具 ——
  let secondParams: unknown = null;
  let i = 0;
  const script = [
    () => ({
      id: 'm1',
      model: 'claude-opus-5',
      stop_reason: 'tool_use' as const,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'echo_back', input: { text: 'smoke' } }],
    }),
    (params: unknown) => {
      secondParams = params;
      return {
        id: 'm2',
        model: 'claude-opus-5',
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'done' }],
      };
    },
  ];
  const client = {
    messages: {
      stream: (params: unknown) => ({ on() {}, finalMessage: async () => script[i++](params) }),
    },
  };

  const app = await createApp({
    name: 'turn7-app',
    discover: unitsDir,
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

  // —— 7) 注册表路线：import 生成的 units.ts 显式装配 ——
  const registryMod = await import(`${proj}/units.ts`);
  const app2 = createApp({
    name: 'turn7-registry',
    providers: registryMod.providers,
    system: new SystemPrompt().add('role', '测试装配', true),
  });
  assert(app2.tools.length === 5, `注册表路线菜单=${app2.tools.map((t) => t.name)}`);

  console.log('SMOKE-TURN7 PASS');
  console.log(JSON.stringify({
    scaffolded: proj.replace(tmp, '<tmp>'),
    discoveredTokens: tokens,
    menu,
    runStatus: run.status,
    toolResultReachedModel: s.includes('echo: smoke'),
    registryRouteTools: app2.tools.length,
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
