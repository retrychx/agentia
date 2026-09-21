import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。 */
const DIST = fileURLToPath(new URL('../dist/templates.js', import.meta.url));
let T = null;
if (existsSync(DIST)) T = await import(new URL('../dist/templates.js', import.meta.url).href);
const SKIP = !T ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

describe('templates 目录约定（四分类目录，无伞形词）', { skip: SKIP }, () => {
  it('四个分类目录都在 src/ 下，且与四个能力类型一一对应', () => {
    assert.deepEqual(T.CAPABILITY_DIR_LIST, [
      'src/tools',
      'src/skills',
      'src/prompts',
      'src/subagents',
    ]);
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

  it('main.ts 模板的 discover 按【本文件位置】解析，且列全四分类目录（顺序即装配顺序）', () => {
    // 原实现是 cwd 相对的 'src/tools' 等：dev（tsx src/main.ts）恰好对，但 `node dist/main.js`
    // 会去加载 src 下的 .ts 源码 —— 装饰器不是可擦除的类型语法，Node 直接抛
    // "Invalid or unexpected token"，即**生产路径从未通过**；换个 cwd 跑则连目录都找不到。
    const main = T.mainTs('demo');
    for (const dir of T.CAPABILITY_DIR_LIST) {
      const bare = dir.replace(/^src\//, '');
      assert.ok(main.includes(`'${bare}'`), `main.ts 缺分类目录 ${bare}`);
    }
    assert.ok(main.indexOf("'tools'") < main.indexOf("'skills'"), '分类顺序即装配顺序，不能被重排');
    assert.ok(main.includes('import.meta.url'), 'main.ts 必须按本文件位置解析（而非 cwd）');
    assert.ok(!main.includes("'src/tools'"), "main.ts 不该再出现 cwd 相对的 'src/tools'");
    assert.ok(
      main.includes('existsSync'),
      'main.ts 必须过滤不存在的分类目录：tsc 不为空目录产出 dist/<分类>/，而 discover 对显式给出的不存在路径是报错的',
    );
  });

  it('脚手架 package.json：dev 走 CLI 的 dev，且 CLI 装进 devDependencies（版本与框架同批）', () => {
    const pkg = JSON.parse(T.projectPackageJson('demo'));
    assert.equal(
      pkg.scripts.dev,
      'agentia dev',
      'npm run dev 应与 agentia dev 同一条路（含 inspector）',
    );
    assert.ok(
      pkg.devDependencies['@migor/cli'],
      'CLI 必须进 devDependencies：否则工程内 npx agentia 会去 registry 拉最新版（无 pin、需联网）',
    );
    assert.ok(pkg.dependencies['@migor/agentia'], '框架仍应是 dependencies');
    assert.equal(
      pkg.devDependencies['@migor/cli'],
      pkg.dependencies['@migor/agentia'],
      '两包同批发布，pin 的版本必须一致',
    );
  });

  it('main.ts 模板在 run 失败时给出原因并置非零退出码', () => {
    // run 失败**不抛**（硬失败记进 result.error），模板若不显式检查就会「打印空行 + 退出 0」，
    // 让首次运行（如没配 ANTHROPIC_API_KEY）看起来像成功 —— 实测过这个静默失败。
    const main = T.mainTs('demo');
    assert.ok(main.includes('result.error'), 'main.ts 应检查 result.error');
    assert.ok(main.includes('result.stopReason'), 'main.ts 应打印 stopReason');
    assert.ok(main.includes('process.exitCode = 1'), 'main.ts 失败时应置非零退出码');
  });

  it('.env 三件套：生成 .env / .env.example，且 .gitignore 必须挡住 .env', () => {
    // 这三行是一组契约，少一行就是事故：生成 .env 却不 ignore = 把 key 送进用户的第一个 commit；
    // ignore 了 .env 却没有 main.ts 的 loadEnvFile() = 文件形同废纸（用户只会看到「没配 key」）。
    const ignore = T.projectGitignore();
    assert.ok(
      ignore.split('\n').includes('.env'),
      `.gitignore 模板必须含独立的 .env 行，实际：${JSON.stringify(ignore)}`,
    );
    assert.ok(ignore.split('\n').includes('.env.local'), '.gitignore 模板应含 .env.local');

    const env = T.projectDotEnv();
    assert.ok(env.includes('ANTHROPIC_API_KEY='), '.env 模板应给出 key 的空位');
    assert.ok(
      !env.includes('sk-ant-'),
      '.env 模板不得预填假 key（会让首次运行变成 401 而不是「没配」）',
    );

    const example = T.projectDotEnvExample();
    assert.ok(example.includes('ANTHROPIC_API_KEY='), '.env.example 应列 key');
    assert.ok(example.includes('.env'), '.env.example 应说明「复制成 .env」的用法');

    // 接线：main.ts 模板里必须有一句独立调用（框架不自动读 .env）
    const main = T.mainTs('demo');
    assert.ok(/^loadEnvFile\(\);$/m.test(main), 'main.ts 模板应有独立的 loadEnvFile(); 调用');
    assert.ok(
      /import \{[^}]*\bloadEnvFile\b[^}]*\} from/.test(main),
      'main.ts 模板应从框架导入 loadEnvFile（否则生成的项目编译不过）',
    );
  });
});

/**
 * 模板目录 ↔ CLI 源码的**双向**一致性。
 *
 * 事故（2026-09-21）：模板目录加了 `scripts/clean.mjs`、`package.json` 的 build 脚本也引用了它，
 * 但 `create.ts` 忘了把它写出去 —— 生成的项目 `npm run build` 第一步就 MODULE_NOT_FOUND。
 * 所有单元测试全绿：它们问的都是「某个模板函数返回了什么」，**没人从模板目录出发反问「谁用了它」**。
 * 是 e2e 里那句**字面跑 `npm run build`** 照出来的（测试自己复刻命令时也照不出来 —— 复刻的那份
 * 绕过了产物自己那条链）。
 *
 * 这个描述块不依赖 dist（只读仓库里的模板与源码），所以未构建时也照跑。
 */
describe('模板目录 ↔ CLI 源码：双向引用必须成立', () => {
  const cliRoot = fileURLToPath(new URL('..', import.meta.url));
  const templatesDir = join(cliRoot, 'templates');
  const srcDir = join(cliRoot, 'src');

  /** 列 templates/ 下所有文件的相对路径（POSIX 分隔符，与 renderTemplate 的写法一致） */
  const templateFiles = (dir = templatesDir, base = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? templateFiles(join(dir, e.name), `${base}${e.name}/`)
        : [`${base}${e.name}`],
    );

  /** CLI 源码全文（src/ 下的 .ts）—— 引用检查用「名字确实出现过」就够 */
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  const read = (f) => readFileSync(join(srcDir, f), 'utf8');
  const srcText = srcFiles.map(read).join('\n');
  /** 除模板访问层之外的全部源码：**只有它们才算「有人真写了这个文件」** */
  const callersText = srcFiles
    .filter((f) => f !== 'templates.ts')
    .map(read)
    .join('\n')
    // 掐掉 import 语句：`import { cleanMjs } from './templates.js'` 也算「名字出现过」，
    // 靠它过闸就等于放行「导入了但从不调用」—— 那正是事故形态（写进 import、没写进 create）。
    .replace(/^import[\s\S]*?from\s+'[^']+';/gm, '');
  const templatesText = read('templates.ts');

  it('模板目录里每个文件都被源码字面引用（防拼错/防改名漏改）', () => {
    const orphans = templateFiles().filter((rel) => !srcText.includes(`'${rel}'`));
    assert.deepEqual(
      orphans,
      [],
      `这些模板文件没有任何源码引用它们：\n${orphans.join('\n')}\n` +
        '—— 生成的项目会缺这个文件，而单测大概率还是绿的（见本描述块头注释）',
    );
  });

  it('模板访问层的每个 accessor 都必须有调用方（漏写 = 生成物缺文件）', () => {
    // 这一步才是 2026-09-21 那个事故的真正守卫：`cleanMjs()` 存在、路径也存在，只是**没人调它**
    // —— 生成的项目缺 `scripts/clean.mjs`，而 build 脚本第一步就要跑它（MODULE_NOT_FOUND）。
    // 判据是「**除访问层之外**有人引用这个 accessor」，不是「这个名字在仓库里出现过」。
    // 只查 accessor（体内调了 renderTemplate 的函数）—— 纯 helper（如 kebabToSnake）只在层内用，合法。
    const code = templatesText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const accessors = code
      .split(/\nexport\s+/)
      .slice(1)
      .map((block) => ({
        name: /^(?:function|const)\s+([A-Za-z_$][\w$]*)/.exec(block)?.[1],
        block,
      }))
      .filter((a) => a.name && /renderTemplate\(/.test(a.block))
      .map((a) => a.name);
    assert.ok(
      accessors.length >= 10,
      `只解析到 ${accessors.length} 个 accessor —— 抽词器可能退化了`,
    );
    const unused = accessors.filter((n) => !new RegExp(`\\b${n}\\b`).test(callersText));
    assert.deepEqual(
      unused,
      [],
      `templates.ts 的 accessor 没有任何调用方（模板写了却没被写出去）：\n${unused.join('\n')}\n` +
        '—— 生成的项目会缺对应文件（真发生过：clean.mjs）',
    );
  });

  it('源码里每个 renderTemplate 路径都真实存在（防拼错）', () => {
    const refs = [...srcText.matchAll(/renderTemplate\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(refs.length >= 10, `只解析到 ${refs.length} 个模板引用 —— 抽词器可能退化了`);
    const missing = refs.filter((rel) => !existsSync(join(templatesDir, rel)));
    assert.deepEqual(missing, [], `源码引用了不存在的模板：\n${missing.join('\n')}`);
  });
});
