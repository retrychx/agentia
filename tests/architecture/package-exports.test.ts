/*
 * 架构守卫 —— 「公开 API 边界」的**可执行版本**（2026-09-29 上生产评审 P2-2）。
 *
 * 为什么需要它：`README.md` / 官网的「稳定性与版本策略」节已经写明
 * 「**不**承诺深路径导入（`dist/**`）」—— 但在 2026-09-29 之前，两个**已发布**包的
 * `package.json` 里**没有 `exports` 字段**，于是那句话是一句**没有机制的话**：
 * 评审实测 `import('@migor/agentia/dist/index.js')` 真的能进，且
 * `require('@migor/agentia')` 能拿到 81 个导出。任何一个这么写的使用者都会把内部模块路径
 * 当成 API —— 一次重构就把他打碎，而且**没有任何信号**。
 *
 * ⇒ 这正是本仓反复记的那个形态（`docs/guards.md` 头注）：**承诺写在文档里、没有门禁**。
 * 本守卫把承诺变成机制，并钉住四件事：
 *
 *   ① 两个已发布包都声明 `exports`（`@migor/trace-view` 早就有 —— 先例在仓里）；
 *   ② `@migor/agentia` 的根入口带 `types` 条件且**排第一**（TS 按书写顺序匹配），
 *      目标与顶层 `main` / `types` 指向**同一个文件**（`./` 前缀归一后相等 —— 两侧写法天然不同，防「两处口径各写各的」）；
 *   ③ **除根入口与 manifest 外不开放任何子路径** —— 深导入被封死；
 *   ④ `files` 必须含 `dist`（否则 `exports` 指向的东西根本不进 tarball）。
 *
 * ## 为什么是「真解析」而不是文本断言
 *
 * `exports` 的形态很容易**看着对、实际错**（条件顺序、相对路径少了 `./`、键名拼错），
 * 而这些错法**只有真跑一遍 Node 的解析算法**才现形 —— `scripts/e2e-cli.ts` 第 9 步
 * （「真 pack → 真装 → 真跑」）记着同一条教训。所以本守卫自建一个临时夹具
 * （`node_modules/@migor/*` 各放一份**真实 manifest 的逐字拷贝** + `exports` 指名要存在的
 * 空文件），再 `createRequire().resolve()` 真解析：
 *   - 根入口 / `package.json` 必须解析成功；
 *   - 任意深路径必须报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 * ⚠️ **刻意不用符号链接指向仓库**：那样夹具会依赖 `dist/` 已构建（没 build 过的机器上
 * 会红成「守卫坏了」），且批量删时会被环境的安全删除垫片按文件数拦下（本仓踩过）。
 * 拷贝真 manifest + 放假文件 ⇒ 与构建顺序解耦，测的仍是**真 `exports` map**。
 *
 * ## ⚠️ 为什么 `@migor/cli` 的 `exports` **只放开 `./package.json`**
 *
 * 它的公共面是**可执行文件**（`bin.agentia`），不是模块：入口 `packages/cli/src/cli.ts`
 * 末尾是 `process.exitCode = main(process.argv.slice(2))` —— **顶层副作用，没有 main 守卫**
 * ⇒ 把 `"."` 指过去等于承诺「import 这个包会直接跑 CLI」。那两件事都不该承诺，
 * 所以只留 manifest（工具读它的常规请求），其余封死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 已发布的包（`@migor/trace-view` / `-observability` / `-eval-gate` 都 `private: true`，不在射程内）。 */
const PUBLISHED = [
  { name: '@migor/agentia', dir: '.' },
  { name: '@migor/cli', dir: 'packages/cli' },
] as const;

const readManifest = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as Record<string, unknown>;

test('两个已发布包都声明了 exports（公开面边界不得靠「没人这么写」维持）', () => {
  for (const { name, dir } of PUBLISHED) {
    const m = readManifest(dir);
    const exp = m.exports as Record<string, unknown> | undefined;
    assert.ok(
      exp && typeof exp === 'object',
      `${name} 的 package.json 没有 \`exports\` 字段 —— 「不承诺深路径导入」这句对外承诺就没有机制：` +
        '`@migor/agentia/dist/**` 会重新变成可导入的内部路径，而文档里还写着不承诺。' +
        '（先例：@migor/trace-view 的 exports 早就在。）',
    );
    assert.equal(
      exp['./package.json'],
      './package.json',
      `${name} 的 exports 必须放开 \`./package.json\` —— 这是工具（打包器 / 类型解析器 / 脚本）读清单的常规请求，` +
        '封掉它会把「封深路径」变成「整包不可读」。',
    );
  }
});

test('@migor/agentia 的根入口：types 条件排第一，且与顶层 main/types 指向同一个文件', () => {
  const m = readManifest('.');
  const exp = m.exports as Record<string, { types?: string; default?: string }>;
  const root = exp['.'];
  assert.ok(
    root && typeof root === 'object',
    'exports["."] 必须是条件对象（本包只有 ESM 一种产物，故不写 import/require 两条假分流）',
  );

  const keys = Object.keys(root);
  assert.equal(
    keys[0],
    'types',
    `exports["."] 的第一个条件必须是 \`types\`（实际顺序：${keys.join(' / ')}）。` +
      'TS 按**书写顺序**匹配条件，types 排后面会解析不到声明文件 —— 而 JS 侧照样能跑，' +
      '于是错法是静默的（类型全丢、没有报错）。',
  );

  // ⚠️ 两侧写法**天然不同**：`exports` 的目标必须带 `./`，而顶层 `main`/`types` 的惯例不带
  //    ⇒ 比较前先归一，否则红的是「写法」而不是「指向不同的文件」。
  const norm = (p: string | undefined) => (p ?? '').replace(/^\.\//, '');
  assert.equal(
    norm(root.types),
    norm(m.types as string),
    'exports["."].types 与顶层 `types` 不是同一个文件 —— 两处口径必须同源，否则「老解析器看 A、新解析器看 B」。',
  );
  assert.equal(
    norm(root.default),
    norm(m.main as string),
    'exports["."].default 与顶层 `main` 不是同一个文件 —— 同上：两处写同一个东西就不许漂。',
  );
});

test('除根入口与 manifest 外不开放任何子路径（这就是「不承诺深路径导入」的机制）', () => {
  const agentia = readManifest('.');
  assert.deepEqual(
    Object.keys(agentia.exports as Record<string, unknown>).sort(),
    ['.', './package.json'].sort(),
    '@migor/agentia 的 exports 多写了子路径 —— 每多一条都是一次「其实承诺了内部路径」的宣称。' +
      '新增公开子路径要走 docs/spec.md §10 决策记录 + 改 README 的承诺范围表。',
  );

  // 目标必须落在 dist/（`./package.json` 除外）—— 防有人把 `src/**` 或仓库根暴露出去。
  for (const [key, value] of Object.entries(agentia.exports as Record<string, unknown>)) {
    if (key === './package.json') continue;
    const targets =
      typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
    for (const t of targets) {
      assert.ok(
        t.startsWith('./dist/'),
        `exports["${key}"] 指向 ${t} —— 发布面只允许 ./dist/**（源码不进 tarball）`,
      );
    }
  }

  // 自证：`files` 不含 dist 时，上面那些目标一个都不会出现在包里（守卫自己会变成空头承诺）
  assert.ok(
    Array.isArray(agentia.files) && (agentia.files as string[]).includes('dist'),
    'package.json 的 `files` 不含 `dist` —— exports 指着的文件不进 tarball，边界声明就成了空话。',
  );

  const cli = readManifest('packages/cli');
  assert.deepEqual(
    Object.keys(cli.exports as Record<string, unknown>),
    ['./package.json'],
    '@migor/cli 的 exports 只该放开 `./package.json`（理由见文件头：它的公共面是 bin，入口有顶层副作用）。' +
      '给它加 `"."` 等于承诺「import 这个包会直接执行 CLI 命令行」。',
  );
});

test('真解析：根入口与 manifest 进得去，深路径必须报 ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
  const fix = mkdtempSync(join(tmpdir(), 'agentia-exports-probe-'));
  try {
    writeFileSync(
      join(fix, 'package.json'),
      JSON.stringify({ name: 'exports-probe', private: true, type: 'module' }),
    );
    for (const { name, dir } of PUBLISHED) {
      const pkgDir = join(fix, 'node_modules', ...name.split('/'));
      mkdirSync(pkgDir, { recursive: true });
      // 逐字拷贝真 manifest：测的必须是仓库里那份 exports，不是这里重写的一份
      writeFileSync(
        join(pkgDir, 'package.json'),
        readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'),
      );
      // `exports` 指名要存在的目标 —— `require.resolve` 会查存在性，但不会加载文件内容
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};\n');
    }

    const req = createRequire(join(fix, 'package.json'));
    // ⚠️ `require.resolve` 返回**真实路径**：macOS 上 `tmpdir()` 给 `/var/...` 而 realpath 是
    //    `/private/var/...` ⇒ 期望值必须过一遍 realpath，否则红的是「路径写法」而不是「解析结果」。
    const realFix = realpathSync(fix);
    const inFix = (name: string, ...rest: string[]) =>
      join(realFix, 'node_modules', ...name.split('/'), ...rest);

    assert.equal(
      req.resolve('@migor/agentia'),
      inFix('@migor/agentia', 'dist', 'index.js'),
      '根入口解析结果与 exports["."].default 对不上（或 exports 写歪了 —— 文本断言看不出这一类）。',
    );
    assert.equal(
      req.resolve('@migor/agentia/package.json'),
      inFix('@migor/agentia', 'package.json'),
      'manifest 必须放行：工具靠它读包元数据。',
    );
    assert.equal(
      req.resolve('@migor/cli/package.json'),
      inFix('@migor/cli', 'package.json'),
      'manifest 必须放行（CLI 的 exports 只留这一条）。',
    );

    const blocked = [
      '@migor/agentia/dist/index.js',
      '@migor/agentia/dist/engine/loop.js',
      '@migor/agentia/src/index.ts',
      '@migor/cli',
      '@migor/cli/dist/cli.js',
    ];
    for (const spec of blocked) {
      assert.throws(
        () => req.resolve(spec),
        (e: NodeJS.ErrnoException) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `\`${spec}\` 居然解析成功了 —— exports 没封住，README 那句「不承诺深路径导入」就还是空话` +
          '（评审 2026-09-29 实测改动前 `@migor/agentia/dist/index.js` 真能进）。',
      );
    }
  } finally {
    rmSync(fix, { recursive: true, force: true });
  }
});
