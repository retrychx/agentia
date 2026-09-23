/**
 * 装配税基准（D8 决策支撑探针，**不进 verify-all / CI** —— 与 `bench:trace` / `e2e:live` 同档，要看时才跑）。
 *
 * 要回答的问题（docs/plans/2026-09-22-dev-debug-loop.md §「D8 动工前的探针」①）：
 *   走 `AppOptions.toolSources` 收窄时，「换一次能力选择 = 重建一次 app」的**真实代价**是多少？
 *   它落在「会话级、可接受」还是「每次好几秒、忍不了」？
 *
 * 关键是把「重建」拆成互不相同的几段，因为它们的量级差好几个数量级 ——
 * 文档初稿假设「重建 = discover + **MCP 握手**」是一次性的合并代价，本探针就是在验这个假设：
 *
 * 每一档的**名字就是输出里的那行字**（`emit(...)` 的第一段），改了档位记得同时改这里 ——
 * 这份清单曾经漂过（写着 S3 / S5b 两个**代码里不存在**的档），而漂掉的清单比没有清单更坏：
 * 看数字的人会去找一道量不出来的刻度。
 *
 *   S1  纯装配（providers 已在手）—— DI resolve + collect×4 + 中间件包裹 + 静态校验 + 菜单查重
 *   S2  发现 + 装配（import 缓存热）—— S1 + fs 扫描 + 动态 import()（**常驻 runner 重建的真身**）
 *   S2b 发现 + 装配（toolSources 收窄到 1 个）—— 同上，但装配面更小（面板换选择后的那一档）
 *   S4  MCP 握手冷（新连接器）—— spawn 子进程 + initialize + tools/list
 *   S5  MCP 再取（复用连接器）—— ensureReady 记忆化 ⇒ 只剩一次 tools/list 往返
 *   S6a 整进程启动（node+tsx，**零装配**）—— 单独量「进程启动」这一段
 *   S6b 整进程启动 + 发现 + 装配 —— S6a + 冷模块图 + 装配（dev 环换能力选择时的真形态：
 *        **测的是「重启一个进程要多久」这个刻度**，与谁触发它无关 —— 旧形态由 `tsx watch`
 *        触发，2026-09-22 起由 `dev.ts` 自己 spawn/收编，但被量的那段代价逐字相同）
 *   S6c 整进程启动 + 装配（框架走 dist · 发布形态）—— 需 `BOOT_DIST` 指到框架的 dist 入口
 *        （与 S6a/S6b 是**对照**：差值是「tsx 现场编译」那笔税）
 *
 * 冷 import 那一档**没有**单独的档位：它靠 S6b − S6a 得到（`import()` 的缓存是**进程级**的，
 * 只有真起一个新进程才量得到 —— 同一进程里"冷"是量不出来的）。
 *
 * 零 token、零网络：MCP 侧是本地夹具 `scripts/mcp-fixture-server.py`（stdlib only）；
 * 能力夹具是临时目录里生成的 .ts（由 `discover` 动态 import，与真实工程同一条路径）。
 *
 * 跑法：
 *   node_modules/.bin/tsx scripts/bench-app-assembly.ts
 *   CAPS=40 RUNS=20 node_modules/.bin/tsx scripts/bench-app-assembly.ts
 *   SKIP_MCP=1 RUNS_BOOT=0 ...                      # 只量装配、跳掉 MCP 与整进程启动
 *   BOOT_DIST=dist/index.js ...                    # 加一档「框架走 dist」的发布形态启动（与 S6 对照）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createApp,
  createStdioMcpConnector,
  discoverProviders,
  mcpTools,
  SystemPrompt,
} from '../src/index.js';
import type { CapabilityMiddleware } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SRC_INDEX = pathToFileURL(join(REPO, 'src', 'index.ts')).href;

/** 能力夹具个数（每次装配的菜单规模） */
const CAPS = Number(process.env.CAPS ?? '20');
/** 进程内测量的重复次数 */
const RUNS = Number(process.env.RUNS ?? '15');
/** S6/S6a（整进程启动）重复次数 —— 每次都真起一个 node+tsx 进程，默认少跑几次 */
const RUNS_BOOT = Number(process.env.RUNS_BOOT ?? '5');
const SKIP_MCP = process.env.SKIP_MCP === '1';
const SKIP_BOOT = RUNS_BOOT === 0;

const now = (): number => Number(process.hrtime.bigint()) / 1e6;
async function timeIt(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t0 = now();
  await fn();
  return now() - t0;
}

interface Stats {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
}
function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return {
    n: s.length,
    min: Math.round(s[0]! * 10) / 10,
    median: Math.round(at(0.5)! * 10) / 10,
    p90: Math.round(at(0.9)! * 10) / 10,
    max: Math.round(s[s.length - 1]! * 10) / 10,
  };
}
const fmt = (s: Stats): string =>
  `${s.median} ms（n=${s.n}，min ${s.min} / p90 ${s.p90} / max ${s.max}）`;

/**
 * 生成 CAPS 个能力夹具目录。
 *
 * `mix=false`：每个能力只有一个 `@Tool`（最轻的形态）。
 * `mix=true`：照**真实工程**的形态循环造四类能力 —— 这才挡得住「你的夹具太轻」这句反驳：
 *   @Tool / @Prompt（含真读一个 .md 资产）/ @Skill（含 `tools` 引用解析）/ @SubAgent
 *   （含 `asset(system.md)` + `tools` 引用解析）。引用指向上一个能力，必然存在。
 * 装配期成本里「引用静态校验」「prompt 版本表汇总」「资产路径归一化」都在这条路上。
 */
function makeFixture(root: string, caps: number, mix: boolean, entry = SRC_INDEX): string {
  const dir = join(root, 'capabilities');
  const S = JSON.stringify(entry);
  const SCHEMA = "const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };";
  for (let i = 0; i < caps; i++) {
    const name = `cap-${String(i).padStart(3, '0')}`;
    const cls = name.replace(/-/g, '_');
    const ref = `cap-${String((i + 1) % caps).padStart(3, '0')}`;
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });

    if (!mix) {
      writeFileSync(
        join(folder, 'index.ts'),
        [
          `import { Tool } from ${S};`,
          SCHEMA,
          `export default class ${cls} {`,
          `  @Tool({ description: '夹具能力 ${i}', schema: SCHEMA })`,
          `  work_${i}(): string { return 'ok'; }`,
          '}',
          '',
        ].join('\n'),
      );
      continue;
    }

    const kind = i % 4;
    let body: string[];
    if (kind === 0) {
      body = [
        `import { Tool } from ${S};`,
        SCHEMA,
        `export default class ${cls} {`,
        `  @Tool({ description: '夹具工具 ${i}', schema: SCHEMA, strict: true })`,
        `  work_${i}(): string { return 'ok'; }`,
        '}',
      ];
    } else if (kind === 1) {
      writeFileSync(join(folder, 'asset.md'), `# 夹具资产 ${i}\n\n${'正文段落。'.repeat(40)}\n`);
      body = [
        `import { Prompt, asset } from ${S};`,
        `export default class ${cls} {`,
        `  @Prompt({ description: '夹具提示资产 ${i}', version: 'v1' })`,
        `  style_${i}(): string { return asset(import.meta.url, './asset.md'); }`,
        '}',
      ];
    } else if (kind === 2) {
      body = [
        `import { Skill } from ${S};`,
        `import type { SkillContext } from ${S};`,
        SCHEMA,
        `export default class ${cls} {`,
        `  @Skill({ description: '夹具技能 ${i}', schema: SCHEMA, tools: [${JSON.stringify(ref)}] })`,
        `  async skill_${i}(_input: unknown, ctx: SkillContext): Promise<string> {`,
        `    const r = await ctx.llm({ prompt: '夹具 ${i}' });`,
        '    return r.text;',
        '  }',
        '}',
      ];
    } else {
      writeFileSync(join(folder, 'system.md'), `你是夹具子 agent ${i}。\n`);
      body = [
        `import { SubAgent, asset } from ${S};`,
        SCHEMA,
        `export default class ${cls} {`,
        `  @SubAgent({`,
        `    description: '夹具子 agent ${i}',`,
        '    schema: SCHEMA,',
        `    system: asset(import.meta.url, './system.md'),`,
        `    tools: [${JSON.stringify(ref)}],`,
        '  })',
        `  sub_${i}(_input: unknown): void {}`,
        '}',
      ];
    }
    writeFileSync(join(folder, 'index.ts'), `${body.join('\n')}\n`);
  }
  return dir;
}

/**
 * 装配期那条中间件链（`mix` 模式下挂两条直通中间件）—— 洋葱包裹发生在装配期，
 * 菜单里每条能力都会被再包一层，所以它是「重建 app」成本的一部分。
 */
const MIX = process.env.MIX === '1';
const MIDDLEWARE: CapabilityMiddleware[] = MIX
  ? [(_call, next) => next(), (_call, next) => next()]
  : [];

async function main(): Promise<void> {
  // ⚠️ 夹具与生成的入口脚本必须落在**仓内**：仓外目录没有 package.json 的 "type": "module"，
  // tsx 会按 CJS 解析 .ts，顶层 await 直接报错（第一版就踩了这个坑）。用完在 finally 里删净。
  const root = mkdtempSync(join(REPO, '.probe-assembly-'));
  const dir = makeFixture(root, CAPS, MIX);
  const system = new SystemPrompt().add('role', '你是助手。', true);
  const rows: Array<[string, string]> = [];

  /** 量一段就立刻打一行 —— 后段（尤其是真起进程的 S6）失败时不至于把前面的数字一起丢掉 */
  const emit = (label: string, value: string): void => {
    rows.push([label, value]);
    console.log(`  ${label.padEnd(46)} ${value}`);
  };

  try {
    console.log(
      `\n== 装配税基准 ==  能力夹具 ${CAPS} 个 · 进程内 n=${RUNS} · 整进程 n=${RUNS_BOOT}\n`,
    );

    // ── 健全性自检：夹具必须真的进了菜单（防「菜单其实是空的」真空变绿）────────────
    const providers = await discoverProviders(dir);
    {
      const full = await createApp({
        name: 'probe',
        system,
        discover: [dir],
        middleware: MIDDLEWARE,
      });
      const narrowed = await createApp({
        name: 'probe',
        system,
        discover: [dir],
        toolSources: ['cap-000'],
        middleware: MIDDLEWARE,
      });
      console.log(
        `  夹具自检：providers ${providers.length} · 全量菜单 ${full.tools.length} 条 · ` +
          `收窄到 cap-000 后 ${narrowed.tools.length} 条 · 前几个：${full.tools
            .slice(0, 4)
            .map((t) => t.name)
            .join(', ')}`,
      );
      if (full.tools.length === 0 || narrowed.tools.length === 0) {
        throw new Error('夹具菜单为空 —— 探针量的不是装配（真空变绿）');
      }
    }

    // ── S1 纯装配：providers 已在手（把 discover 的 import 摊到计时之外）────────────
    {
      const xs: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        xs.push(
          await timeIt(() =>
            createApp({ name: 'probe', system, providers, middleware: MIDDLEWARE }),
          ),
        );
      }
      emit('S1 纯装配（providers 在手，无 discover）', fmt(stats(xs)));
    }

    // ── S2 发现 + 装配（import 缓存热）= 常驻 runner 重建 app 的真身 ──────────────
    {
      const xs: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        xs.push(
          await timeIt(() =>
            createApp({ name: 'probe', system, discover: [dir], middleware: MIDDLEWARE }),
          ),
        );
      }
      emit('S2 发现 + 装配（import 缓存热）', fmt(stats(xs)));
    }

    // ── S2b 收窄：只取 1 个 token（toolSources 的典型调试形态）───────────────────
    {
      const xs: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        xs.push(
          await timeIt(() =>
            createApp({
              name: 'probe',
              system,
              discover: [dir],
              toolSources: ['cap-000'],
              middleware: MIDDLEWARE,
            }),
          ),
        );
      }
      emit('S2b 发现 + 装配（toolSources 收窄到 1 个）', fmt(stats(xs)));
    }

    // ── S4/S5 MCP 握手冷 vs 复用连接器 ────────────────────────────────────────
    let mcpCold: Stats | undefined;
    let mcpWarm: Stats | undefined;
    if (!SKIP_MCP) {
      const cmd = ['python3', join(REPO, 'scripts', 'mcp-fixture-server.py')];
      const connector = createStdioMcpConnector(cmd);
      try {
        const cold: number[] = [];
        const warm: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          if (i === 0) {
            // 第一个连接器：spawn + initialize + tools/list 全付
            cold.push(await timeIt(() => mcpTools(connector, { server: 'time' })));
          } else {
            // 同一连接器再取：ensureReady 记忆化 ⇒ 只剩一次 tools/list 往返
            warm.push(await timeIt(() => mcpTools(connector, { server: 'time' })));
          }
        }
        // 冷启动次数太少（只有 1 次），补足到 5 次新连接器 —— 每次都是真 spawn
        for (let i = 1; i < Math.min(5, RUNS); i++) {
          const fresh = createStdioMcpConnector(cmd);
          cold.push(await timeIt(() => mcpTools(fresh, { server: 'time' })));
          await fresh.close();
        }
        mcpCold = stats(cold);
        mcpWarm = stats(warm);
        emit('S4 MCP 冷（新连接器：spawn + initialize + list）', fmt(mcpCold));
        emit('S5 MCP 热（复用连接器：仅 tools/list 往返）', fmt(mcpWarm));
      } catch (e) {
        console.log(`  ! MCP 段跳过（${e instanceof Error ? e.message : String(e)}）`);
      } finally {
        await connector.close().catch(() => {});
      }
    }

    // ── S6 / S6a / S6b 整进程重启（**当前** dev 形态 = dev.ts 自己 spawn runner 子进程；
    //     2026-09-22 之前的旧形态是 tsx watch 重启用户的 main.ts。被量的那段代价逐字相同）──
    if (!SKIP_BOOT) {
      const bootOnly = join(root, 'boot-only.ts');
      writeFileSync(bootOnly, 'console.log("BOOT_OK");\n');
      const bootApp = join(root, 'boot-app.ts');
      writeFileSync(
        bootApp,
        [
          `import { createApp, SystemPrompt } from ${JSON.stringify(SRC_INDEX)};`,
          'const app = await createApp({',
          "  name: 'probe-boot',",
          "  system: new SystemPrompt().add('role', '你是助手。', true),",
          `  discover: [${JSON.stringify(dir)}],`,
          '});',
          'console.log("BOOT_OK", app.name);',
          '',
        ].join('\n'),
      );
      const tsxBin = join(REPO, 'node_modules', '.bin', 'tsx');
      const runEntry = (entry: string): number => {
        const t0 = now();
        execFileSync(tsxBin, [entry], { cwd: REPO, stdio: 'pipe' });
        return now() - t0;
      };
      runEntry(bootOnly); // 预热（磁盘缓存 / tsx 自身的编译产物）
      const bootXs: number[] = [];
      for (let i = 0; i < RUNS_BOOT; i++) bootXs.push(runEntry(bootOnly));
      const appXs: number[] = [];
      for (let i = 0; i < RUNS_BOOT; i++) appXs.push(runEntry(bootApp));
      const b = stats(bootXs);
      const a = stats(appXs);
      emit('S6a 整进程启动（node+tsx，零装配）', fmt(b));
      emit('S6b 整进程启动 + 发现 + 装配', fmt(a));
      emit('   ⇒ 其中「冷装配」= S6b − S6a', `≈ ${Math.round((a.median - b.median) * 10) / 10} ms`);

      // ── S6c「发布形态」：框架走**已构建的 dist**（真工程里 `@migor/agentia` 解析到 dist），
      // tsx 只转译用户工程那点代码 —— 上一档用框架 TS 源码跑，把整个 src 的转译也计进去了。
      // ⚠️ 夹具与入口都 import dist（同一份模块实例，别和 src 混），仅在**独立进程**里跑。
      const distEntry = process.env.BOOT_DIST;
      if (distEntry && existsSync(distEntry)) {
        const distUrl = pathToFileURL(distEntry).href;
        const distDir = makeFixture(join(root, 'dist-fixture'), CAPS, MIX, distUrl);
        const boot = join(root, 'boot-dist.ts');
        writeFileSync(
          boot,
          [
            `import { createApp, SystemPrompt } from ${JSON.stringify(distUrl)};`,
            'const app = await createApp({',
            "  name: 'probe-dist',",
            "  system: new SystemPrompt().add('role', '你是助手。', true),",
            `  discover: [${JSON.stringify(distDir)}],`,
            '});',
            'console.log("BOOT_OK", app.tools.length);',
            '',
          ].join('\n'),
        );
        runEntry(boot);
        const xs: number[] = [];
        for (let i = 0; i < RUNS_BOOT; i++) xs.push(runEntry(boot));
        emit('S6c 整进程启动 + 装配（框架走 dist · 发布形态）', fmt(stats(xs)));
      } else if (process.env.BOOT_DIST) {
        console.log(`  ! BOOT_DIST 指向的路径不存在，跳过 S6c：${distEntry}`);
      }
    }

    // ── 结论：重建一次 app 到底付了什么 ────────────────────────────────────────
    console.log('\n== 读法 ==');
    console.log(
      '  ① 「换一次能力选择」在常驻 runner 里 = S2（或收窄时的 S2b），**不需要** S6 的整进程重启。',
    );
    console.log('  ② MCP 只有「重建连接器」才付 S4；复用连接器只付 S5（一个 JSON-RPC 往返）。');
    console.log('     ⇒ 「重建 app 含 MCP 握手」这个说法成不成立，取决于连接器跟谁同寿。');
    console.log('  ③ S2 vs S6b：两者之差就是「合并形态躲掉的那笔税」。');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
