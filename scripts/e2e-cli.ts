// CLI 端到端验证：目录约定 + 发现机制 + CLI 端到端。
// agentia create 脚手架 → agentia g 生成四类能力 → 注册表 codemod →
// discoverProviders/createApp({discover}) 装配 → mock 模型跑通一次 run。
// 运行：npm run e2e（先 build 框架与 CLI，再 tsx 跑本脚本）
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const npmCache = mkdtempSync(join(tmpdir(), 'agentia-npm-cache-'));
const cli = (args: string[], cwd: string): string =>
  execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });

try {
  // —— 1) create：项目骨架 ——
  cli(['create', 'demo-app', '--dir', tmp], tmp);
  const proj = join(tmp, 'demo-app');
  for (const f of [
    'package.json',
    'tsconfig.json',
    'src/main.ts',
    'src/registry.ts',
    'src/tools/hello/index.ts',
    'scripts/copy-assets.mjs',
    'AGENTS.md',
  ]) {
    assert(existsSync(join(proj, f)), `create 缺文件: ${f}`);
  }
  // 四个分类目录都建出来（空目录靠 .gitkeep 进版本库）：目录名自解释，用户一看就知道新能力往哪放
  for (const d of ['src/tools', 'src/skills', 'src/prompts', 'src/subagents']) {
    assert(existsSync(join(proj, d, '.gitkeep')), `create 应建出 ${d}/（含 .gitkeep）`);
  }
  // .env 三件套必须同时到位 —— 生成 .env 却不把它写进 .gitignore，等于把 key 送进用户的第一个 commit
  for (const f of ['.env', '.env.example', '.gitignore']) {
    assert(existsSync(join(proj, f)), `create 缺文件: ${f}`);
  }
  const ignoreLines = readFileSync(join(proj, '.gitignore'), 'utf8').split('\n');
  assert(
    ignoreLines.includes('.env'),
    `.gitignore 必须忽略 .env（否则脚手架生成的 .env 会被提交），实际：${ignoreLines.join(' | ')}`,
  );
  // 接线：生成的 main.ts 真的调了 loadEnvFile —— 框架**不自动**读 .env，全靠这一行。
  // 必须锚到**独立语句行**（`^loadEnvFile();$`）：先写成「文本里含 loadEnvFile()」，
  // 结果被同文件注释里的那句说明满足了 —— 把调用删掉门禁照样绿（反向验证抓到的假绿）。
  // 这一条是语法层面的（要知道它真能被读到，见下面 4b 的行为验证）。
  const mainSrc = readFileSync(join(proj, 'src/main.ts'), 'utf8');
  assert(
    /^loadEnvFile\(\);$/m.test(mainSrc),
    'src/main.ts 里应有独立的 `loadEnvFile();` 调用（否则生成的 .env 形同废纸）',
  );
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
  assert(
    existsSync(join(proj, 'src/subagents/doc-reviewer/index.ts')),
    'subagent 应落在 src/subagents/',
  );

  // —— 3) 注册表 codemod ——
  const registry = readFileSync(join(proj, 'src/registry.ts'), 'utf8');
  for (const tok of ['hello', 'doc-reviewer', 'note-writer', 'style-guide', 'echo-back']) {
    assert(registry.includes(`'${tok}'`), `src/registry.ts 缺 token: ${tok}`);
  }
  // import 前缀按分类目录走（相对 src/registry.ts）
  for (const rel of [
    './tools/hello/index.js',
    './subagents/doc-reviewer/index.js',
    './skills/note-writer/index.js',
    './prompts/style-guide/index.js',
    './tools/echo-back/index.js',
  ]) {
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

  // —— 4b) .env 真的会被读到（跑一遍脚手架入口的同一句，而不是只看文件在不在）——
  // 这里最危险的是**静默失败**：文件生成得漂漂亮亮、key 却没进 process.env，用户只会看到
  // 「没配 key」的报错，然后去怀疑框架。所以按行为验，不按存在性验。
  writeFileSync(
    join(proj, '.env'),
    `${readFileSync(join(proj, '.env'), 'utf8')}AGENTIA_E2E_DOTENV=ok\n`,
  );
  writeFileSync(
    join(proj, 'env-probe.mjs'),
    "import { loadEnvFile } from '@migor/agentia';\nprocess.stdout.write(JSON.stringify(loadEnvFile()));\n",
  );
  // 先清掉环境里可能同名的键：**真实环境变量优先**是刻意语义（单测里钉着），
  // 不清就分不清「文件被读了」和「环境里本来就有」—— 本机 export 过 key 的人最容易踩
  const probeEnv = { ...process.env };
  delete probeEnv.AGENTIA_E2E_DOTENV;
  const applied = JSON.parse(
    execFileSync(process.execPath, ['env-probe.mjs'], {
      cwd: proj,
      encoding: 'utf8',
      env: probeEnv,
    }),
  ) as Record<string, string>;
  assert(
    applied.AGENTIA_E2E_DOTENV === 'ok',
    `.env 没被 loadEnvFile 读到：${JSON.stringify(applied)}`,
  );
  rmSync(join(proj, 'env-probe.mjs'), { force: true });

  // —— 4c) 脚手架模板过 tsc：生成的 tsconfig 原样做底（strict / NodeNext / include 全生效），
  // overlay 只补「临时项目在 tmp，解析不到仓库的 @types/node」这一条路径 ——
  // '@migor/agentia' 已由上面 4) 的 node_modules 软链解决（解析到 dist 的 .d.ts，即发布形态）。
  // 此前模板从未经 tsc 检查：模板里一个类型错误要等用户 npm install 后才暴露。
  writeFileSync(
    join(proj, 'tsconfig.check.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: {
          noEmit: true,
          typeRoots: [join(repoRoot, 'node_modules', '@types')],
        },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.check.json'],
    { cwd: proj, stdio: 'inherit' },
  );

  // —— 4d) 生产构建链真跑一遍：脚手架承诺的 `npm run build` = tsc 出 dist + 资产跟随拷贝。
  // 此前脚手架只有 dev/typecheck，没有 build/start —— 「拿去部署」第一步就断（外部 review
  // 抓出；且 asset() 按文件位置解析，.md 不拷进 dist 时生产形态必坏）。这里用同一 overlay
  // 思路真 emit（typeRoots 指向仓库 @types；outDir/rootDir 来自生成物 tsconfig 本身），
  // 再跑生成物自己的 copy-assets，断言 dist 产物与 .md 资产都就位。
  writeFileSync(
    join(proj, 'tsconfig.build.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { typeRoots: [join(repoRoot, 'node_modules', '@types')] },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: proj, stdio: 'inherit' },
  );
  execFileSync(process.execPath, [join(proj, 'scripts', 'copy-assets.mjs')], {
    cwd: proj,
    stdio: 'inherit',
  });
  for (const f of [
    'dist/main.js',
    'dist/prompts/style-guide/asset.md',
    'dist/subagents/doc-reviewer/system.md',
  ]) {
    assert(existsSync(join(proj, f)), `生产构建缺产物: ${f}（npm run build 的承诺没兑现）`);
  }
  // 脚手架 package.json 的 scripts 承诺（build/start 都在，用户拿到的是完整打包链）
  const scaffoldPkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const s of ['dev', 'build', 'start', 'typecheck']) {
    assert(typeof scaffoldPkg.scripts[s] === 'string', `脚手架 package.json 缺 scripts.${s}`);
  }

  // —— 5) 发现机制：discoverProviders（四分类目录数组，顺序即装配顺序）——
  const capabilityDirs = ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'].map((d) =>
    join(proj, d),
  );
  const discovered = await discoverProviders(capabilityDirs);
  const tokens = discovered.map((p) => p.provide).sort();
  assert(
    JSON.stringify(tokens) ===
      JSON.stringify(['doc-reviewer', 'echo-back', 'hello', 'note-writer', 'style-guide']),
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
    JSON.stringify(menu) ===
      JSON.stringify(['doc_reviewer', 'echo_back', 'hello', 'note_writer', 'style_guide']),
    `菜单=${menu}`,
  );

  const { run, result } = await app.run([{ role: 'user', content: '回显一下' }], { client });
  assert(run.status === 'succeeded', `run.status=${run.status}`);
  assert(result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);
  const s = JSON.stringify(secondParams);
  assert(
    s.includes('tool_result') && s.includes('echo: smoke'),
    '发现的工具应真的被执行并回 tool_result',
  );

  // —— 7) 注册表路线：import 生成的 src/registry.ts 显式装配 ——
  const registryMod = await import(`${proj}/src/registry.ts`);
  const app2 = createApp({
    name: 'cli-registry',
    providers: registryMod.providers,
    system: new SystemPrompt().add('role', '测试装配', true),
  });
  assert(app2.tools.length === 5, `注册表路线菜单=${app2.tools.map((t) => t.name)}`);

  // —— 8) 发布物完整性：CHANGELOG.md 必须在两个 npm 包里（npm 的「总是包含」只覆盖
  // README/LICENSE，CHANGELOG 不在其列 —— 曾因 files 只写 dist 漏发，外部 review 抓出）——
  // npm cache 走临时目录：runner / 沙箱的 ~/.npm 属主异常（EPERM）会把环境问题误判成
  // 代码问题（外部 review 真踩到），门禁不该依赖宿主 npm 缓存的健康。
  for (const [label, dir] of [
    ['@migor/agentia', repoRoot],
    ['@migor/cli', join(repoRoot, 'packages', 'cli')],
  ] as const) {
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', npmCache], {
        cwd: dir,
        encoding: 'utf8',
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const paths = packed[0]!.files.map((f) => f.path);
    assert(
      paths.includes('CHANGELOG.md'),
      `${label} 的 npm 包里没有 CHANGELOG.md（files: ${JSON.stringify(paths.slice(0, 5))}…）`,
    );
  }

  console.log('E2E-CLI PASS');
  console.log(
    JSON.stringify(
      {
        scaffolded: proj.replace(tmp, '<tmp>'),
        discoveredTokens: tokens,
        menu,
        runStatus: run.status,
        toolResultReachedModel: s.includes('echo: smoke'),
        registryRouteTools: app2.tools.length,
        projectAgentsMdBytes: guide.length,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(npmCache, { recursive: true, force: true });
}
