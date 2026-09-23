/*
 * 架构守卫 —— 「零反射」这条**策略声明**的可执行版本。
 *
 * 为什么需要它：`docs/guards.md` §2「待守」长期只挂着这一行。官网首屏写着 `<b>0</b> 反射`
 * （`packages/website/src/fragments/index.html` 的 hero-stats），特性卡写着「零反射装饰器」，
 * 而 `tests/docs/api-page.test.ts` 只能钉「首屏别把它删了」—— 它逐条推导 `4 类能力` /
 * `3 类触发` / `0 个运行时依赖` 那几个数字，**唯独这一条推导不出来**，于是登记进了 §2。
 *
 * 为什么当初「推导不出来」：`src/toolkit/` 里本来就有 `Reflect.ownKeys`（收集方法名，
 * 含 symbol key）与 `Reflect.apply`（按动态 key 调方法）—— 它们是**普通反射 API**，
 * 与「反射式 DI」无关。所以判据不能是「`Reflect.*` 出现了几次」。
 * ⚠️ §2 那行当时猜的守卫形状（「除 `Reflect.ownKeys` 外不得使用 `Reflect.*`」）**是错的**：
 * 它会当场把 3 处正当的 `Reflect.apply` 判成违规（`toolkit/prompt.ts` / `skill.ts` / `tool.ts`）。
 *
 * 可判定的口径直接取自**框架自己的决策原文**（`docs/spec.md` 的「已定决策」段）：
 *   「标准装饰器（ECMAScript Stage 3），不用 `experimentalDecorators` /
 *     `emitDecoratorMetadata` / `reflect-metadata`。因此不支持构造器参数反射 —— DI 采用
 *     模块内显式 `providers` + factory 装配。框架的元数据一律显式声明（装饰器参数即配置，
 *     外加 `WeakMap`/注册表存储），不依赖 `design:paramtypes`。」
 * ⇒ 拆成三组可机械判定的否定断言，与那句话逐项对应（下面 ①②③ 三个 test）：
 *   ① 开关面 ↔ `experimentalDecorators` / `emitDecoratorMetadata`（**根闸**：不打开它，
 *      `tsc` 根本不发射 `design:*` 元数据，后面两条都无从谈起）；
 *   ② 依赖面 ↔ `reflect-metadata`（`Reflect.getMetadata` 这套 API 的**唯一来源**）；
 *   ③ 源码面 ↔ `Reflect.*Metadata` API 的调用（读元数据的动作本身）。
 * ④⑤ 是让 ①②③ 可证伪的阳性对照与回归钉，⑥ 钉住走查的射程，⑦ 写明一处**刻意留着的缺口**。
 *
 * ⚠️ **本守卫不禁止什么**（写清楚，免得后来者以为它管得比实际宽）：
 * - `Reflect.ownKeys` / `Reflect.apply` / 任何**非元数据**的 `Reflect.*`：允许，而且现在就在用。
 * - `Symbol.metadata`：**允许**。它是**标准** Stage 3 装饰器提案的一部分（`tsc` 的标准装饰器
 *   发射本身就会写它，去 `examples/` 下任一例子的 `dist/` 里就能看到），与「不押
 *   `reflect-metadata`」并不矛盾 —— spec 的决策原文也只点名了那三样加 `design:paramtypes`。
 *   若维护者要连它一起禁，那是**另一个决策**：先改 `docs/spec.md`，再改本文件。
 *
 * 注：上面别写 `examples/` 加 `*` 的 glob 字面量。块注释里出现 `*` 紧跟 `/` 会把注释**提前
 * 闭合**，剩下的片段变成代码 —— 本文件第一版就是这么炸的（`ReferenceError: dist is not defined`）。
 *
 * ## 射程（四个源码根，都是发布面）
 *
 *   · `src/`                      —— 框架本体
 *   · `packages/cli/src/`         —— CLI
 *   · `packages/cli/templates/`   —— `agentia create` 写给**用户工程**的脚手架（随 CLI 一起发布，
 *                                    是「怎么写 agentia 应用」的样板；它要是去够元数据反射，
 *                                    首屏那句声明在用户最先看到的地方就已经假了）
 *   · `packages/trace-view/src/`  —— 渲染层。**它是纯 `.js`**（`main: dist/index.js`，
 *                                    `scripts/build.mjs` 只做文件拷贝），所以走查必须收 `.js`。
 *                                    ⚠️ 第一版只收 `.ts`，把整个包扫成了 0 个文件 —— 是下面
 *                                    `files.length` 那条防真空断言当场抓出来的。
 *
 * ## 防真空 + 阳性对照（本文件最要紧的两条）
 *
 * 「0 处违规」这种断言**天然不可证伪**：走查逻辑一坏（路径写错、扩展名漏了、遮蔽过头），
 * 结果照样是「0 处违规」。所以每个 test 都带计数下限，另外还有一组**合成样本阳性对照**：
 * 证明这套判据**看得见**真违规（否则本文件只是个会绿的装饰品）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './lib/source-scan.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 源码面：四个发布面根（理由见文件头 §射程）。 */
const SRC_ROOTS = [
  'src',
  join('packages', 'cli', 'src'),
  join('packages', 'cli', 'templates'),
  join('packages', 'trace-view', 'src'),
];

/** 走查的扩展名。`.js` 是必需的（trace-view）；`.mjs` 是模板里的 `scripts/`。 */
const SOURCE_EXT = ['.ts', '.js', '.mjs'];

/**
 * legacy 装饰器元数据的开关。开了 `emitDecoratorMetadata`，`tsc` 就会为**每个**被装饰的声明
 * 发射 `design:paramtypes` / `design:type` / `design:returntype` —— 那正是「反射式 DI」的入口，
 * 也是本框架刻意不押的那条路（原生编译器已在考虑移除 legacy 元数据发射）。
 *
 * 走查是**发现式**的（递归找 `tsconfig*.json`），不是写死清单 —— 新包 / 新模板加进来会自动
 * 进射程。⚠️ 特别要盯 `packages/cli/templates/tsconfig.json`：那是 `agentia create` 写给
 * **用户工程**的模板，它一开，所有生成的项目都跟着开。
 */
const LEGACY_FLAGS = ['experimentalDecorators', 'emitDecoratorMetadata'];

/**
 * `reflect-metadata` 提供的元数据反射 API。**出现在代码里**即违规。
 *
 * 判据跑在 `scan()` 遮蔽后的文本上 ⇒ **注释里提到它们不算**。这一条是必需的而不是洁癖：
 * `src/container/container.ts` 的头注正好就写着 `experimentalDecorators` /
 * `emitDecoratorMetadata` / `reflect-metadata` —— 那是「我们不用它」的声明，裸正则会把
 * 声明本身当成用法（实测：裸文本命中 1 个文件、遮蔽后 0 个，见下面的回归钉）。
 *
 * 长的排在前面：`Reflect.getMetadataKeys` 含 `Reflect.getMetadata` 前缀，这样报告时能报准那个。
 *
 * ⚠️ **`design:paramtypes` / `design:returntype` / `design:type` 这三个键刻意不在本清单里**，
 * 尽管 `docs/spec.md` 的决策原文点名了 `design:paramtypes`。理由有三条，都实测过：
 *   1. 它们**永远是字符串字面量**（键就是字符串），而 `scan()` 按设计把字符串遮蔽掉 ——
 *      放进本清单等于放三条**永远匹配不上的死条目**，看着像保护、实则空转（本文件第一版
 *      就是这么写的，是 ④ 号阳性对照当场把它抓出来的）；
 *   2. 搬到**裸文本**上扫会撞上本仓的注释文化：`docs/spec.md` 与 `container.ts` 都写着
 *      「不依赖 `design:paramtypes`」这类**声明**，裸扫会把声明本身判成违规（假阳性）；
 *   3. 而且**不需要**单独判它们 —— 见 ⑦ 号 test 的覆盖论证：要**用**这个键，必须经由
 *      `Reflect.*Metadata`（③ 覆盖）或 `reflect-metadata`（② 覆盖），而键能被**写出来**
 *      的前提是 `emitDecoratorMetadata` 开着（① 覆盖）。
 */
const LEGACY_METADATA_API = [
  'Reflect.getOwnMetadataKeys',
  'Reflect.getMetadataKeys',
  'Reflect.getOwnMetadata',
  'Reflect.hasOwnMetadata',
  'Reflect.defineMetadata',
  'Reflect.deleteMetadata',
  'Reflect.hasMetadata',
  'Reflect.getMetadata',
  'Reflect.metadata',
];

// ─────────────────────────── 语料收集 ───────────────────────────

/** 递归列出 `dir` 下的源码文件（跳过 `node_modules` / `dist` —— 那是产物，不是源码） */
function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

/** 递归列出 `dir` 下所有 `tsconfig*.json`（跳过 `node_modules` / 产物 / 缓存目录） */
function tsconfigs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'coverage') continue;
    if (e.name === '.git' || e.name === '.workbuddy-ai' || e.name === '.wrangler') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) tsconfigs(full, out);
    else if (/^tsconfig.*\.json$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * 读 tsconfig —— 容忍 **JSONC**（`tsc` 接受注释与尾逗号，`JSON.parse` 不接受）。
 *
 * 这不是洁癖：`packages/cli/tsconfig.templates.json` 真的带 6 行头注，第一版直接
 * `JSON.parse` 当场抛 `Expected property name or '}' in JSON at position 4`。
 * 而**解析失败必须炸掉**，不能「跳过这个文件」—— 一个读不懂的 tsconfig 里可能正好藏着
 * 那个开关，「跳过」等于给违规开了一扇静默的门（本仓库最忌讳的失败方式）。
 *
 * 去注释与去尾逗号都在同一趟里做，且**跟踪字符串状态** —— 免得把 `"a,}"` 这种字符串值
 * 当成尾逗号切掉（朴素正则的经典错法）。
 */
function parseTsconfig(raw: string, file: string): Record<string, unknown> {
  let out = '';
  let i = 0;
  const n = raw.length;
  let inString = false;
  while (i < n) {
    const c = raw[i] as string;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += raw[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') {
      while (i < n && raw[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(raw[j] as string)) j += 1;
      if (raw[j] === '}' || raw[j] === ']') {
        i += 1; // 尾逗号：丢掉
        continue;
      }
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${file} 解析失败（已按 JSONC 去注释 / 去尾逗号）：${(err as Error).message}\n` +
        '⚠️ 不要把它从走查里跳过 —— 读不懂的 tsconfig 里可能正藏着 legacy 开关。',
    );
  }
}

/** 扫一遍四个源码根，返回违规站点（供三个 test 与阳性对照共用） */
function scanSources(): { offenders: string[]; scanned: number; specOffenders: string[] } {
  const offenders: string[] = [];
  const specOffenders: string[] = [];
  let scanned = 0;
  for (const root of SRC_ROOTS) {
    const abs = join(repoRoot, root);
    assert.ok(existsSync(abs), `源码根 ${root} 不存在 —— 改名了就要同步改 SRC_ROOTS`);
    const files = sourceFiles(abs);
    assert.ok(
      files.length > 0,
      `源码根 ${root} 下一个源码文件都没扫到 —— 走查逻辑可能坏了（扩展名漏了？见 SOURCE_EXT）`,
    );
    for (const file of files) {
      scanned += 1;
      const raw = readFileSync(file, 'utf8');
      const { masked, specs } = scan(raw);
      const rel = relative(repoRoot, file);
      for (const s of specs) {
        if (s.spec === 'reflect-metadata') specOffenders.push(`${rel}: import '${s.spec}'`);
      }
      // ⚠️ 跑在**遮蔽后**的文本上：注释里写这些名字是「我们不用它」的声明，不是用法
      for (const token of LEGACY_METADATA_API) {
        const at = masked.indexOf(token);
        if (at < 0) continue;
        const line = masked.slice(0, at).split('\n').length;
        offenders.push(`${rel}:${line} 出现 ${token}`);
      }
    }
  }
  return { offenders, scanned, specOffenders };
}

/** 实测水位（2026-09-23）：`src` 89 + `cli/src` 25 + `cli/templates` 20 + `trace-view/src` 4 = 138 */
const MIN_SOURCES = 120;

// ─────────────────────────── ① 开关面 ───────────────────────────

test('没有任何 tsconfig 打开 legacy 装饰器元数据开关（`0 反射` 的开关面）', () => {
  const files = tsconfigs(repoRoot);
  // 防真空：走查逻辑坏掉（比如把整个 `packages/` 跳过了）时，下面那条会「零违规」地假绿
  assert.ok(
    files.length >= 10,
    `只扫到 ${files.length} 个 tsconfig —— 走查逻辑可能坏了（预期 ≥10，含 packages/cli/templates）`,
  );
  const offenders: string[] = [];
  for (const f of files) {
    const rel = relative(repoRoot, f);
    const parsed = parseTsconfig(readFileSync(f, 'utf8'), rel);
    const opts = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
    for (const flag of LEGACY_FLAGS) {
      // `false` 是显式关闭，允许；只有「开了」才违规
      if (opts[flag] !== undefined && opts[flag] !== false) {
        offenders.push(`${rel}: ${flag}=${JSON.stringify(opts[flag])}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '有 tsconfig 打开了 legacy 装饰器元数据开关 —— 官网首屏的「0 反射」与特性卡的' +
      '「不押 reflect-metadata」当场变假，且 `tsc` 会开始发射 `design:paramtypes`。\n' +
      '要真的改这个决策，请先在 `docs/spec.md` 的「已定决策」段记一笔、并删掉 ' +
      '`docs/guards.md` §1 的对应条目，而不是只动 tsconfig。',
  );
});

// ─────────────────────────── ② 依赖面 ───────────────────────────

test('`reflect-metadata` 不作为模块说明符被引入（`0 反射` 的依赖面）', () => {
  const { specOffenders, scanned } = scanSources();
  assert.ok(scanned >= MIN_SOURCES, `只扫到 ${scanned} 个源码文件 —— 走查逻辑可能坏了`);
  assert.deepEqual(
    specOffenders,
    [],
    '源码引入了 reflect-metadata —— 它同时违反两条：本条（`0 反射`）与全仓零运行时依赖铁律' +
      '（`tests/architecture/no-runtime-deps.test.ts`）。两条都该红，别只消掉一条。',
  );
});

// ─────────────────────────── ③ 源码面 ───────────────────────────

test('源码里不出现 reflect-metadata 的元数据 API（`0 反射` 的源码面）', () => {
  const { offenders, scanned } = scanSources();
  assert.ok(scanned >= MIN_SOURCES, `只扫到 ${scanned} 个源码文件 —— 走查逻辑可能坏了`);
  assert.deepEqual(
    offenders,
    [],
    '源码里出现了 legacy 装饰器元数据的读取 —— 「元数据一律显式声明」这条决策被绕过了' +
      '（`docs/spec.md` 的「已定决策」段）。' +
      '注意 `Reflect.ownKeys` / `Reflect.apply` **不在**禁令内（它们是普通反射 API，框架在用）。',
  );
});

// ─────────────────────────── ④ 阳性对照（让「0 处违规」可证伪） ───────────────────────────

test('阳性对照：真违规必须被这套判据看见（否则本文件只是个会绿的装饰品）', () => {
  // 每一条都对应一个真实可能的违规写法。若哪天有人把 LEGACY_METADATA_API 改坏 / 遮蔽过头，
  // 上面两个 test 会「零违规」地继续绿 —— 这条会先红。
  const violations: Array<[string, string, string]> = [
    [
      '按 key 读元数据',
      'const t = Reflect.getMetadata("design:paramtypes", A);\n',
      'Reflect.getMetadata',
    ],
    ['写元数据', 'Reflect.defineMetadata("k", v, target);\n', 'Reflect.defineMetadata'],
    ['删元数据', 'Reflect.deleteMetadata("k", target);\n', 'Reflect.deleteMetadata'],
    ['查元数据', 'if (Reflect.hasMetadata("k", target)) {}\n', 'Reflect.hasMetadata'],
    [
      'legacy 装饰器工厂',
      "@Reflect.metadata('design:type', String)\nprop!: string;\n",
      'Reflect.metadata',
    ],
    ['按 key 读自有元数据', 'Reflect.getOwnMetadata("k", target);\n', 'Reflect.getOwnMetadata'],
  ];
  for (const [label, src, token] of violations) {
    const { masked } = scan(src);
    assert.ok(
      masked.includes(token),
      `${label}：应看见 ${token}，实际遮蔽后文本里没有 —— 判据失效了`,
    );
  }
  // 边界：说明符面要认得出副作用导入（`import 'reflect-metadata';` 是它最可能的引入形态）
  assert.ok(
    scan("import 'reflect-metadata';\n").specs.some((s) => s.spec === 'reflect-metadata'),
    "副作用导入 `import 'reflect-metadata';` 没被解析成说明符",
  );
  // 边界：tsconfig 开关面要认得出开着的样子（JSONC 也要认 —— 注释 + 尾逗号）
  const withFlag = parseTsconfig(
    '{\n  // 注释\n  "compilerOptions": { "emitDecoratorMetadata": true, },\n}\n',
    '夹具',
  );
  assert.equal((withFlag.compilerOptions as Record<string, unknown>).emitDecoratorMetadata, true);
  // 反向边界：显式 `false` 不算违规（关掉是允许的写法）
  const withFalse = parseTsconfig(
    '{ "compilerOptions": { "experimentalDecorators": false } }',
    '夹具',
  );
  assert.equal(
    (withFalse.compilerOptions as Record<string, unknown>).experimentalDecorators,
    false,
  );
});

test('tsconfig 解析器：JSONC（注释 + 尾逗号）要认得出，读不懂必须炸而不是跳过', () => {
  // 前提钉：`packages/cli/tsconfig.templates.json` 真的是 JSONC（第一版直接 JSON.parse 当场炸）
  const jsonc = join(repoRoot, 'packages', 'cli', 'tsconfig.templates.json');
  assert.ok(existsSync(jsonc), '前提变了：该文件不在 —— 那条 JSONC 用例失去现实依据');
  assert.throws(
    () => JSON.parse(readFileSync(jsonc, 'utf8')),
    '前提变了：该文件现在是纯 JSON —— 若如此，JSONC 支持仍是必要的，但这条注释要更新',
  );
  const parsed = parseTsconfig(readFileSync(jsonc, 'utf8'), 'packages/cli/tsconfig.templates.json');
  assert.equal(
    (parsed.compilerOptions as Record<string, unknown>).strict,
    true,
    'JSONC 去注释后应能读到 compilerOptions.strict',
  );
  // 尾逗号：tsc 接受、JSON.parse 不接受
  assert.deepEqual(parseTsconfig('{ "a": [1, 2,], }', '夹具'), { a: [1, 2] });
  // 字符串里的 `,}` 不得被当成尾逗号切掉（朴素正则的经典错法）
  assert.deepEqual(parseTsconfig('{ "a": "x,}" }', '夹具'), { a: 'x,}' });
  // 读不懂 → 必须抛（不能「跳过这个文件」：读不懂的 tsconfig 里可能正藏着开关）
  assert.throws(
    () => parseTsconfig('{ "a": ', '夹具'),
    /解析失败/,
    '解析失败必须抛错 —— 静默跳过等于给违规开一扇门',
  );
});

// ─────────────────────────── ⑤ 真实语料的定点回归钉 ───────────────────────────

test('回归钉：3 处正当的 `Reflect.apply` 与 2 处 `Reflect.ownKeys` 必须判零违规', () => {
  // 这 5 处是「用朴素正则 / 一刀切禁 Reflect.*」时**必然误报**的站点，逐个钉住。
  // 它们正是 §2 那行原猜形状错掉的原因。
  const pins: Array<[string, string]> = [
    [join('src', 'toolkit', 'prompt.ts'), 'Reflect.apply 按动态 key 调方法 + Reflect.ownKeys 收集'],
    [join('src', 'toolkit', 'skill.ts'), 'Reflect.apply 同上'],
    [join('src', 'toolkit', 'tool.ts'), 'Reflect.apply 同上'],
    [join('src', 'toolkit', 'collect.ts'), 'Reflect.ownKeys 收集方法名（含 symbol key）'],
  ];
  for (const [rel, why] of pins) {
    const abs = join(repoRoot, rel);
    assert.ok(existsSync(abs), `${rel} 不存在 —— 回归钉要跟着代码走`);
    const raw = readFileSync(abs, 'utf8');
    assert.ok(
      raw.includes('Reflect.'),
      `${rel}（${why}）现在不用 Reflect 了 —— 这条回归钉失去意义，换样本或删掉它`,
    );
    const { offenders } = scanOne(abs);
    assert.deepEqual(
      offenders,
      [],
      `${rel}（${why}）被判出元数据反射。两种可能，先分清再动手：\n` +
        '  · 有人真在这写了元数据反射 —— 那就是违规，按 ③ 号 test 的提示改回去；\n' +
        '  · 只是判据收得比决策原文宽了（把 `Reflect.apply` 之类普通反射 API 也算进去）\n' +
        `    —— 那是本文件的问题，改判据，别改代码。\n实际命中：${offenders.join(' / ')}`,
    );
  }
});

test('回归钉：注释里写 `reflect-metadata` 不算用法（container.ts 的声明）', () => {
  // src/container/container.ts 的头注写着「不用 experimentalDecorators / emitDecoratorMetadata /
  // reflect-metadata」—— 裸正则会把这条**声明本身**判成违规（实测裸文本命中 1 个文件）。
  const abs = join(repoRoot, 'src', 'container', 'container.ts');
  assert.ok(existsSync(abs), 'src/container/container.ts 不存在 —— 回归钉要跟着代码走');
  const raw = readFileSync(abs, 'utf8');
  assert.ok(
    raw.includes('reflect-metadata'),
    '前提变了：该文件不再在注释里声明「不用 reflect-metadata」—— 这条回归钉失去意义',
  );
  assert.deepEqual(
    scanOne(abs).offenders,
    [],
    '注释里的声明被判成了用法 —— 判据没有跑在遮蔽后的文本上',
  );
});

test('回归钉：`Symbol.metadata` 不在禁令内（标准装饰器发射会写它）', () => {
  // spec 的决策原文只点名了 experimentalDecorators / emitDecoratorMetadata /
  // reflect-metadata / design:paramtypes。`Symbol.metadata` 是**标准**提案的一部分，
  // 与「不押 reflect-metadata」不矛盾 —— 若哪天要禁它，先改 spec 再改本文件。
  const src = 'class A {}\n(A as any)[Symbol.metadata] = { x: 1 };\n';
  assert.deepEqual(scanOne('(inline)', src).offenders, [], 'Symbol.metadata 被误判了');
});

// ─────────────────────────── ⑥ 射程钉（比计数下限更细） ───────────────────────────

test('射程钉：走查必须真的够到 templates 的 tsconfig 与 trace-view 的 .js', () => {
  // 计数下限只保证「扫到了 120 个以上」，不保证**扫到了该扫的那几个** —— 而这一轮踩的
  // 两个射程坑恰好是「数量看着正常、关键的那几个不在里面」。所以按名字钉死。
  const configs = tsconfigs(repoRoot).map((f) => relative(repoRoot, f));
  const mustHaveConfig = [
    'tsconfig.json', // 框架本体
    join('packages', 'cli', 'templates', 'tsconfig.json'), // ⚠️ 最重要：它一开，所有生成项目都跟着开
    join('packages', 'cli', 'tsconfig.templates.json'), // JSONC 那个（解析器的现实依据）
    join('examples', 'complete', 'tsconfig.json'), // examples 也要在射程内
  ];
  for (const rel of mustHaveConfig) {
    assert.ok(
      configs.includes(rel),
      `${rel} 不在 tsconfig 走查结果里 —— 射程漏了它（这正是「0 处违规」的成因之一）`,
    );
  }

  const sources = SRC_ROOTS.flatMap((r) => sourceFiles(join(repoRoot, r))).map((f) =>
    relative(repoRoot, f),
  );
  const mustHaveSource = [
    join('src', 'container', 'container.ts'), // 注释里声明「不用 reflect-metadata」的那个
    join('packages', 'cli', 'src', 'dev.ts'),
    join('packages', 'cli', 'templates', 'src', 'app.ts'), // 生成给用户的代码
    // ⚠️ 纯 `.js` 的那个包：第一版只收 `.ts`，整个包被扫成 0 个文件
    join('packages', 'trace-view', 'src', 'index.js'),
  ];
  for (const rel of mustHaveSource) {
    assert.ok(
      sources.includes(rel),
      `${rel} 不在源码走查结果里 —— SOURCE_EXT 漏了它的扩展名？（trace-view 是纯 .js）`,
    );
  }
});

// ─────────────────────────── ⑦ 已知缺口（刻意留着） ───────────────────────────

test('已知缺口：字符串字面量形式的元数据键看不见 —— 为什么仍然安全', () => {
  // 诚实记一笔：`scan()` 按设计遮蔽字符串，所以 `const k = 'design:paramtypes'` 这类
  // **纯字符串**是看不见的（本文件第一版把 design:* 放进清单，就是三条永远匹配不上的
  // 死条目 —— 被 ④ 号阳性对照抓出来后删掉，改在这里写明）。
  const { masked } = scan('const k = "design:paramtypes";\n');
  assert.ok(
    !masked.includes('design:paramtypes'),
    '前提变了：遮蔽器现在会保留字符串内容 —— 那可以把 design:* 三条加回 LEGACY_METADATA_API',
  );
  // 覆盖论证：这个键**用**起来必须经过别的面，而那些面都在射程内。
  // ① 写它：只有 `emitDecoratorMetadata` 开着，`tsc` 才会发射它 → ① 号 test 管住。
  assert.equal(
    (
      parseTsconfig('{ "compilerOptions": { "emitDecoratorMetadata": true } }', '夹具')
        .compilerOptions as Record<string, unknown>
    ).emitDecoratorMetadata,
    true,
    '① 号面应认得出这个开关',
  );
  // ② 读它：`Reflect.getMetadata` 这套 API 由 reflect-metadata 提供 → ② 号 test 管住说明符，
  assert.ok(
    scan("import 'reflect-metadata';\n").specs.some((s) => s.spec === 'reflect-metadata'),
    '② 号面应认得出这个说明符',
  );
  // ③ 而调用本身是**代码**（不是字符串）→ ③ 号 test 管住。
  assert.ok(
    scan('Reflect.getMetadata(K, A);\n').masked.includes('Reflect.getMetadata'),
    '③ 号面应看得见调用（哪怕 key 是变量）',
  );
  // 反过来说：没有这三样，一个孤零零的字符串键什么也做不了 —— 它既读不到东西，也没有东西可读。
});

/** 扫单个文件（或内联夹具）—— 与 ③ 号 test 同一套判据，供回归钉复用 */
function scanOne(absOrInline: string, inline?: string): { offenders: string[] } {
  const raw = inline ?? readFileSync(absOrInline, 'utf8');
  const { masked } = scan(raw);
  const offenders: string[] = [];
  for (const token of LEGACY_METADATA_API) {
    if (masked.includes(token)) offenders.push(token);
  }
  return { offenders };
}
