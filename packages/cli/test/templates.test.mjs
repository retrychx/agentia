import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
