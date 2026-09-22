/**
 * dev 命令：本地 inspector 面板 + **常驻 runner 子进程**。
 *
 * ## 形状（D9(d)：harness 在 CLI 里，用户工程没有 dev 文件）
 *
 * ```
 *   dev.ts（CLI，本文件）                        ← 唯一的进程所有者
 *     ├─ inspector 服务（面板 + POST /run）       ← 面板的读写入口
 *     ├─ fs.watch(src/**) + fs.watch(项目根, 只认 .env)  ← 「代码变了要重启」的**唯一**触发源
 *     └─ 子进程：node <tsx> dist/dev-runner.js     ← 常驻；import 用户的 src/app.ts 并驱动它
 *          └─ 用户代码 → trace 经 sink POST /ingest 回面板
 * ```
 *
 * ⚠️ 子进程是 `node <tsx/cli>`，**不是** `npx tsx` —— 后者会吞掉 IPC 通道，理由见
 * `resolveTsxCli()`（那不是一条风格偏好，是一次实测出来的静默故障）。
 *
 * 与旧实现的三个区别，都记在 docs/plans/2026-09-22-dev-debug-loop.md：
 * 1. **watch 收编进本文件**。旧实现把「文件变 → 重跑」交给 `tsx watch`，而「面板 → 重启」
 *    要归 dev.ts ⇒ 两个触发源就有竞态（保存的瞬间恰好点了运行 = 双双 spawn、端口/SSE 串台）。
 *    现在只有一条路径、一个所有者；顺带解掉「`.md` 不在 tsx 的 import 图里所以不被 watch」。
 * 2. **子进程跑 runner 而不是用户的 main.ts**。四个控件（能力选择 / 多轮 / 工作目录 /
 *    prompt）全是 `createApp` / `app.run` 的选项，而**调用者**能设它们 —— CLI 成了调用者，
 *    于是用户工程里一个 dev 文件都不需要。
 * 3. **trace sink 在 runner 里注册**（不再用 `NODE_OPTIONS=--import` 的 preload）：
 *    CLI 代码本来就在子进程里了，那套注入的存在理由消失了。
 *
 * ## 什么会重启 runner
 *
 * | 变化 | 动作 | 为什么 |
 * |---|---|---|
 * | 能力选择（`toolSources`） | **重启进程** | 它是 `createApp` 的输入；而框架没有 `AgentApp.close()`，进程内反复重建会攒孤儿 MCP 子进程 ⇒ 进程边界是唯一的回收口（D8 第三轮补充） |
 * | 代码 / 文本资产变更 | **重启进程** | Node 的 import 按 URL 缓存，常驻进程收不到源码改动 |
 * | 工作目录 / prompt / 多轮 / 会话 id | **不重启** | 目录是 per-run 输入，runner 内部按目录重建 app（毫秒级）；prompt / 多轮 / 会话 id 本来就是 per-run |
 * | 面板点「中止」 | **先不重启**（优雅 abort） | 框架的 `signal` 是协作式的 ⇒ 中止后 run 以 `stopReason='aborted'` 正常返回、**trace 保得住**；但工具若不读 `signal` 就没人理 ⇒ 5 s 后升级为重启进程兜底（`ABORT_GRACE_MS`），否则 `running` 永远为 true、面板锁死 |
 * | 面板点「清空对话」 | **不重启** | 只是换 sessionId（+ 落盘），下一次 run 换个 id 而已 |
 *
 * 面板是增强项，任何一步失败都只告警、不阻断 dev：inspector 起不来时**降级**成
 * 「首次 run + 改代码自动重启」（不 spawn 面板，但 runner 照起 —— 见 `startPanel`），
 * sink 挂不上 / runner 重启失败之类一律走**响亮**通道（`warning` / `lastError` / 告警条）。
 * ⚠️ 承诺的是「降级 + 说清」，不是「假装没事」：告警文案必须写出**这次少了什么**。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  type Dirent,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, startInspector, type InspectorServer } from './inspector.js';
import { multiTurnDefault, normalizeToolSources } from './panel-logic.js';
import {
  APP_ENTRY_REL,
  DEFAULT_BUDGET,
  DEV_SESSION_ID,
  type DevEvent,
  type DevState,
  type RunAck,
  type RunNote,
  type RunRequest,
  type RunnerMessage,
  SESSION_ID_REL,
  SESSION_REL,
  type SessionMessageLike,
} from './dev-protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'dev-runner.js');

/**
 * 解析 tsx 的 CLI 入口（绝对路径）。
 *
 * ## 为什么不走 `npx tsx`（实测，不是风格偏好）
 *
 * `npx` 是个**包装器**：它自己再 spawn 一层，而**不把 fd 3 的 IPC 通道转发给孙进程**。
 * 后果不是「启动失败」而是**静默**：runner 里 `process.send` 变成 `undefined`，而
 * `send()` 写的是 `process.send?.()`（可选链）—— 于是所有协议消息被无声丢弃：
 * 面板永远等不到 `ready`，`POST /run` 也永远回不来。更坏的是没有 IPC 通道之后事件循环
 * 无事可做，进程会以 **code=0 干净退出**，看起来像「用户代码自己跑完了」。
 *
 * 同一个 hello 脚本的三方对照：
 *
 * | 启动方式 | `typeof process.send` | IPC |
 * |---|---|---|
 * | `node whoami.mjs` | `function` | ✅ 收到 |
 * | `npx tsx whoami.mjs` | `undefined` | ❌ 无（还多出 npx 的 spinner 噪音） |
 * | `node <tsx>/dist/cli.mjs whoami.mjs` | `function` | ✅ 收到 |
 *
 * ## 为什么不 spawn `node_modules/.bin/tsx`
 *
 * Windows 上它是 `.cmd` shim，会绕回 `npm-bin.ts` 专门要避开的那个 CVE-2024-27980 坑。
 * 直接 `node <tsx/dist/cli.mjs>` 跨平台一致，且是**直接子进程** ⇒ IPC 天然可用。
 *
 * 解析顺序：**用户工程优先**（tsx 是脚手架声明的 devDependency，尊重他们的版本 pin），
 * 再退到 CLI 自己的解析位置（monorepo / 全局安装）。两处都没有 ⇒ `null`，调用方响亮报错。
 */
export function resolveTsxCli(root: string, fromCli: string): string | null {
  for (const base of [join(root, 'package.json'), fromCli]) {
    try {
      return createRequire(base).resolve('tsx/cli');
    } catch {
      /* 试下一个解析位置 */
    }
  }
  return null;
}

/** 子进程就绪的等待上限：装配正常是毫秒级，MCP 重的工程也要不了这么久 */
const READY_TIMEOUT_MS = 60_000;
/** 子进程优雅退出的等待上限，超时补 SIGKILL（kill 必须连整棵树 —— 见 killTree） */
const KILL_GRACE_MS = 3_000;
/** 文件事件去抖：编辑器保存常常连发好几个事件（写临时文件 + rename） */
const WATCH_DEBOUNCE_MS = 150;
/**
 * 「中止」发出后等它优雅收尾的宽限：超时就重启进程兜底（见 `abortRun`）。
 * 取 5s —— 优雅路径要在**回合边界**才生效（在飞的模型请求先被取消），
 * 给足一个回合；再长就等于按钮按了没反应。
 */
const ABORT_GRACE_MS = 5_000;
/**
 * 收尾的**硬上限**：超过它就硬退。
 *
 * 必须 > `KILL_GRACE_MS`（3 s）—— 上限的本意是兜「面板还有连接没关掉」这类卡死，
 * 而不是替 SIGKILL 兜底计时器的班（那个兜底只在宽限期到点时才会发出来）。
 */
const SHUTDOWN_DEADLINE_MS = KILL_GRACE_MS + 2_000;

/**
 * 会触发重启的文件类型（**允许清单**，不是排除清单）。
 *
 * 用允许清单而不是「除了 node_modules 都算」：`.DS_Store` / 编辑器 swap / 日志会
 * 让常驻进程反复重启，而那种重启看起来像「agent 自己在抖」。
 * `.md` **必须在**里面 —— 文本资产（`@Prompt` 拉的 `.md`、子 agent 的 `system.md`）
 * 不在 tsx 的 import 图里，旧实现因此对它们**静默无感**（D4 的 G3b）。
 */
const WATCH_EXT = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md']);
/**
 * 按文件名（而非扩展名）命中的环境变量文件。
 *
 * ⚠️ 它们**不在** `watchTree` 的根（`src/`）下 ⇒ 由 `watchRootEnvFiles` 单独盯。
 * 早先只有 `shouldWatch` 认识这两个名字、却没有任何一个 watch 够得着它们，
 * 于是「改 `.env` 会重启」是一句**没人执行**的承诺（真跑抓出来的，见 `watchRootEnvFiles`）。
 */
const WATCH_NAMES = new Set(['.env', '.env.local']);
/**
 * 不看的目录：产物、依赖、VCS、dev 自己的状态。
 *
 * ⚠️ 这道闸是**第二层**。第一层是**监视根**：`devServer` 只 `watchTree(<projectRoot>/src)`
 * —— `.agentia/`（会话历史 + 当前会话 id）与 `dist/` 都在项目根，**根本不在范围内**。
 * 两层都要有：只靠根的话，哪天把根改成项目根（一个很自然的想法），`.agentia/session.json`
 * 就会立刻变成「每次多轮 run 重启一次子进程」的自噬循环。
 */
const WATCH_SKIP = new Set(['node_modules', 'dist', '.git', '.agentia', 'coverage']);

/**
 * 这个文件该不该触发重启？**导出是为了单测** —— 它是「改 `.md` 会不会重启」这条
 * 承诺的唯一判据，而那条承诺正是旧实现静默失效的地方（G3b）。
 */
export function shouldWatch(abs: string): boolean {
  const base = abs.slice(abs.lastIndexOf(sep) + 1);
  if (WATCH_NAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot > 0 && WATCH_EXT.has(base.slice(dot));
}

/**
 * 杀掉**整棵树**。
 *
 * `npx tsx` 自己还会 spawn 子进程，只 kill 直接子进程会留下孤儿（照搬 v0.7.0
 * 「`close()` 保证子进程已终止」的纪律）。POSIX 下靠 `detached: true` 把子进程
 * 变成进程组组长，再对**负 pid** 发信号；win32 没有进程组，用 `taskkill /T`。
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* 已经退出了 */
    }
    return;
  }
  try {
    process.kill(-pid, signal); // 负 pid = 整个进程组
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已经退出了 */
    }
  }
}

/**
 * 这个**目录**要不要进 watch 范围？
 *
 * ⚠️ 判据必须由 `addDir` 自己执行，不能只留在「初始递归」那一个调用点 ——
 * 动态新增目录（watcher 回调里发现新目录时调 `addDir`）走的是**另一条路**，
 * 只在一处判就等于「启动时就存在的 `dist/` 不看、启动后才出现的 `dist/` 看」。
 *
 * 真实影响面由**监视根**兜着（`devServer` 只看 `<projectRoot>/src`，见 `WATCH_SKIP`），
 * 所以它今天多半打不到 `.agentia` —— 但那是「碰巧打不到」，不是「判据成立」。
 *
 * 判据只看**目录名**（不看路径段）：项目根本身叫 `dist` / `node_modules` 是合法的
 * （见 `shouldWatch` 的同一条教训），所以 root 由调用方显式豁免。
 */
function shouldDescend(dir: string): boolean {
  const name = dir.slice(dir.lastIndexOf(sep) + 1);
  return !WATCH_SKIP.has(name) && !name.startsWith('.');
}

/**
 * 文件事件去抖通知器：同一批事件只回调**第一条**。
 *
 * 为什么抽出来共用：**两个** watch（递归目录树 `watchTree` / 项目根的 env 文件
 * `watchRootEnvFiles`）都要同一套去抖与关闭语义。各写一份就会漂 —— 比如只有一处清理
 * `timer`，关闭后仍会回调一次；而那种漂的后果是「停机时又重启了一次子进程」。
 */
function makeNotifier(onFile: (abs: string) => void): {
  note: (abs: string) => void;
  dispose: () => void;
} {
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();

  const flush = (): void => {
    timer = null;
    if (closed || pending.size === 0) return;
    const first = [...pending][0] as string;
    pending.clear();
    onFile(first);
  };

  return {
    note: (abs: string): void => {
      if (closed) return;
      pending.add(abs);
      if (timer === null) timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
    },
    dispose: (): void => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * 递归 watch 一个目录树（`fs.watch` 的 recursive 在 Linux 上到 Node 20 才稳，
 * 这里自己递归 + 新目录动态加入，跨平台同一条代码路径）。
 *
 * 跳过目录（`WATCH_SKIP` / 点开头）的判据由 `addDir` **内部**执行 —— 初始递归与
 * 动态新增两条路共用它，见 `shouldDescend`。
 *
 * ⚠️ 它只看**一棵**树：`.env` / `.env.local` 在项目根、不在 `src/` 下，所以那两份由
 * `watchRootEnvFiles` 单独盯（见它的说明）。
 *
 * **导出是为了单测**：它是「改文本资产不用重启」那条承诺的落点。
 */
export function watchTree(root: string, onFile: (abs: string) => void): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  const notifier = makeNotifier(onFile);

  const note = (abs: string): void => {
    if (closed || !shouldWatch(abs)) return;
    notifier.note(abs);
  };

  /** @param isRoot 项目根自己 —— 它可能就叫 `dist` / `.foo`，但必须看（唯一豁免处） */
  const addDir = (dir: string, isRoot = false): void => {
    if (closed || watchers.has(dir)) return;
    // 跳过目录的判据在**这里**（唯一一处），不在调用点 —— 见 shouldDescend 的说明
    if (!isRoot && !shouldDescend(dir)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录刚被删掉
    }
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: true }, (_event, name) => {
        if (name === null) return;
        const abs = join(dir, String(name));
        note(abs);
        // 新目录要加进 watch 范围（否则新加的能力目录永远不触发重启）。
        // 跳过判据由 addDir 内部执行 ⇒ 这里**不要**再判一次（两处判就会漂）。
        try {
          if (statSync(abs).isDirectory()) addDir(abs);
        } catch {
          /* 被删了 */
        }
      });
    } catch {
      return; // 权限 / 已被删
    }
    w.on('error', () => {});
    watchers.set(dir, w);
    for (const e of entries) {
      if (e.isDirectory()) addDir(join(dir, e.name));
    }
  };

  addDir(root, true);
  return () => {
    closed = true;
    notifier.dispose();
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

/**
 * 只盯**项目根**下按文件名命中的那几份文件（`.env` / `.env.local`）。
 *
 * **为什么单开一个、而不是把 `watchTree` 的根抬到项目根**：`.env` 在项目根，而**其他**
 * 该看的东西都在 `src/` —— 抬根会把 `README.md` / `docs/` / `examples/` 全收进来，
 * 「改代码要重启」就变成「改任何文档也重启」。所以这里刻意**不递归**，且**只认名字**
 * （不认扩展名：项目根的 `package.json` 同样不该由这里管）。
 *
 * ⚠️ 它存在的理由：`WATCH_NAMES` 曾经是一条**够不着**的判据 —— 允许清单里有 `.env`、
 * `usage-guide` 也承诺「看 `.env`」，但 `watchTree` 的根是 `<projectRoot>/src`，
 * 而 `.env` 在项目根 ⇒ 改 `.env` **静默无感**（与 G3b 同类：文档承诺了、代码够不着）。
 * **这条只有真跑能守**：根是**调用点**决定的，`watchTree` 自己无从知道该看哪儿
 * （`scripts/e2e-dev.ts` 第 9-bis 步钉着它）。
 */
export function watchRootEnvFiles(root: string, onFile: (abs: string) => void): () => void {
  const notifier = makeNotifier(onFile);
  let w: FSWatcher;
  try {
    w = watch(root, { persistent: true }, (_event, name) => {
      if (name === null) return;
      const base = String(name);
      if (!WATCH_NAMES.has(base)) return;
      notifier.note(join(root, base));
    });
  } catch {
    return () => {}; // 项目根不可 watch（权限）—— 静默降级成「只看 src/」，与旧行为一致
  }
  w.on('error', () => {});
  return () => {
    w.close();
    notifier.dispose();
  };
}

/**
 * 「清空对话」换到的下一个 id：`dev` → `dev-2` → `dev-3` …（导出是为了单测，同 `shouldWatch`）。
 *
 * 为什么是**换 id** 而不是删会话文件：`session.json` 是 `SessionStore` 的账，面板对它
 * **只读**（写它会造出「面板显示的对话」与「模型真正看到的对话」不一致，见 `readSession`）。
 * 而「当前用哪个 id」是 dev 环的界面状态 ⇒ 换 id 就够，且**不动别人的账**
 * （旧对话还在盘上，run 列表里那些 run 也都还指得到）。
 *
 * 认不出的形状（用户手工改了 id 文件）⇒ 回到 `-2`，不抛：一个怪 id 不该让面板坏掉。
 */
export function nextSessionId(current: string, base: string = DEV_SESSION_ID): string {
  // base 是**参数**（导出为单测用）⇒ 进正则前先转义。现在只有默认值走得到，
  // 但「一个参数迟早被传脏值」这类坑不值得留着（`.x` 会变成「任意字符 + x」）
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${esc}(?:-(\\d+))?$`).exec(current);
  if (m === null) return `${base}-2`;
  const n = m[1] === undefined ? 1 : Number(m[1]);
  return `${base}-${n + 1}`;
}

interface ChildHandle {
  child: ChildProcess;
  capabilities: string[];
  multiTurn: string[];
  defaultWorkdir: string;
  /**
   * **生效的**预算护栏（`DEFAULT_BUDGET` ⊕ `dev.config.ts` 的 `budget`）。
   *
   * 为什么由 runner 报上来而不是父进程自己算：解析 `dev.config.ts` 的那份代码在 runner
   * 里（只有跑在用户工程里的进程读得动那份 TS，理由见 `dev-protocol` 的 `ready`）。
   * 父进程自己再算一遍就是「同一个事实两个写法」，而这里漂开的后果正是面板显示
   * 一份**与实际生效不符**的预算（D9 评审补充的那条承诺就成了谎）。
   */
  budget: { maxCostUsd: number; maxTotalTokens: number };
  warning: string | null;
  /** 该进程启动时用的能力选择（null = 全量）—— 变了就要重启 */
  toolSources: string[] | null;
}

/**
 * @param argv 透传给 dev 环的参数：`agentia dev -- "问题"` 时 argv[0] 是**首次 run 的 prompt**。
 *   脚手架把 `npm run dev` 指到本命令，而工程 README 文档化的用法正是
 *   `npm run dev -- "你的问题"` —— 不能把参数吃掉。
 *   （与旧实现一致；区别是不给参数时**不再**自动跑一次默认 prompt —— 面板就是输入口。）
 */
export function devServer(argv: string[] = []): number {
  const projectRoot = process.cwd();
  const entry = join(projectRoot, APP_ENTRY_REL);

  if (!existsSync(entry)) {
    // 破坏性模板变更的**响亮**失败点：老工程的 main.ts 里有 createApp，但没有 app.ts。
    // 静默降级成「面板能用但什么都驱动不了」是最糟的形状，所以这里直接不启动。
    const legacy = join(projectRoot, 'src', 'main.ts');
    if (existsSync(legacy)) {
      console.error(
        `错误：当前工程的 src/main.ts 存在，但没有 ${APP_ENTRY_REL}。\n` +
          'dev 环需要 app.ts 导出一个接受选项的工厂（装配与启动分离），这样 CLI 才能替你设\n' +
          '「能力选择 / 工作目录 / 多轮 / prompt」这四个控件。\n' +
          '迁移是机械的：把 main.ts 里 createApp(...) 那一段整体搬进 src/app.ts 并包成\n' +
          'export function createAgentApp(opts) { … }，main.ts 只留「读 .env → 调工厂 → 处理 result.error」。\n' +
          '见 CHANGELOG 的迁移小节，或直接照新模板（agentia create 生成的那份）改。',
      );
      process.exitCode = 1;
      return 1;
    }
    console.error(
      '错误：当前目录下未找到 src/app.ts，请先用 agentia create <name> 创建项目（或 cd 到项目根目录）',
    );
    process.exitCode = 1;
    return 1;
  }

  let child: ChildHandle | null = null;
  let inspector: InspectorServer | null = null;
  let stopWatch: (() => void) | null = null;
  /** 项目根那份 `.env` / `.env.local` 的 watch —— 与 `stopWatch` 是**两个**，两者都要收 */
  let stopEnvWatch: (() => void) | null = null;
  let closing = false;
  let running = false;
  /**
   * 「已经受理、但 run 还没发出去」的窄窗口标志（`submitRun` 里换能力选择要 `await restart`）。
   *
   * 为什么必须有它：`running` 只能在 run **真的发进通道之后**置位（它是「runner 里有个
   * run 在飞」的口径，面板据此禁用按钮、`abortRun` 据此判「有没有可中止的东西」）。
   * 而受理到发出之间有一次 await ⇒ 只看 `running` 的闸在「改了能力选择 ⇒ 双击运行」
   * 这条路径上会**放两个请求进来**（两个 `runOnce` 并发、`currentAbort` 被覆盖、
   * `pendingNote` 挂到别人的 traceId 上）。§6 待定 5 承诺的是**默认拒绝**。
   *
   * 刻意**不**并进 `running`（那会让面板在还没 run 时就把「中止」按钮点亮，而
   * `abortRun` 此时只能回 409 —— 一个自相矛盾的面板）。
   */
  let launching = false;
  let lastError: string | null = null;
  /** 在飞 run 期间来的文件变更：等 run 收尾再重启（不在飞的 run 不该被掐掉） */
  let pendingRestart: string | null = null;
  let pendingNote: RunNote | null = null;
  /** 重启串行化：两次重启不能交叠（否则会留下没人管的子进程） */
  let chain: Promise<void> = Promise.resolve();
  /** dev token（D0）：每个 dev 会话一个，进程退出即失效 */
  const token = randomBytes(16).toString('hex');

  // ---------- 会话 id（面板的「清空对话」） ----------

  /**
   * 当前会话 id。从 `.agentia/dev-session-id` 读，读不到就用 `DEV_SESSION_ID`。
   *
   * 为什么要落盘：只放内存的话，用户「清空对话」之后重启 `npm run dev`，
   * 刚清掉的那段对话会**自己回来** —— 静默不一致。
   * 为什么另存一个文件而不是写进 `session.json`：后者是 `SessionStore` 的账，
   * 面板对它是只读的（见 `readSession` 的注释）。
   */
  const readSessionId = (): string => {
    try {
      const raw = readFileSync(join(projectRoot, SESSION_ID_REL), 'utf8').trim();
      return raw.length > 0 ? raw : DEV_SESSION_ID;
    } catch {
      // 文件不存在 = 从没用过「清空」⇒ 初始 id。这里**不该**告警（首次运行是常态）
      return DEV_SESSION_ID;
    }
  };
  let sessionId = readSessionId();

  const writeSessionId = (id: string): void => {
    try {
      mkdirSync(join(projectRoot, '.agentia'), { recursive: true });
      writeFileSync(join(projectRoot, SESSION_ID_REL), `${id}\n`);
    } catch (e) {
      // 写不下去 ⇒ 换 id 只在本次进程有效（重启会退回旧 id）。响亮说清，不静默降级。
      console.warn(
        `[agentia] 会话 id 落盘失败（${(e as Error).message}）：本次「清空对话」在重启 dev 后会失效`,
      );
    }
  };

  /** 中止在飞 run 的兜底计时器：signal 是**协作式**的，卡死的工具不会理它（见 abortRun） */
  let abortTimer: NodeJS.Timeout | null = null;
  const clearAbortTimer = (): void => {
    if (abortTimer !== null) {
      clearTimeout(abortTimer);
      abortTimer = null;
    }
  };

  // ---------- 子进程 ----------

  const spawnChild = (toolSources: string[] | null): Promise<ChildHandle> => {
    // 每次 spawn 都重解析一次：tsx 是启动期才知道存不存在的东西（用户可能刚 `npm i -D tsx`），
    // 缓存住会让「装好了但还报找不到」这种话变成一句谎。
    const tsxCli = resolveTsxCli(projectRoot, import.meta.url);
    if (tsxCli === null) {
      return Promise.reject(
        new Error(
          '找不到 tsx —— dev 环要用它跑 TypeScript 源码（runner 会 import 你的 src/app.ts）。\n' +
            '装一个即可：npm i -D tsx（脚手架生成的工程已经声明了它；手写工程把它加进 devDependencies）',
        ),
      );
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // ⚠️ cwd 必须仍是**项目根**：loadEnvFile() 按 cwd 找 .env、discover 的相对路径也按 cwd。
      // 把 cwd 设成「agent 工作目录」会让 .env 静默读错 —— 工作目录走 DI 注入，不走 chdir。
      AGENTIA_DEV_ROOT: projectRoot,
      AGENTIA_INSPECT_PORT: String(inspector ? inspector.port : 0),
      AGENTIA_INSPECT_TOKEN: token,
      ...(toolSources === null ? {} : { AGENTIA_DEV_TOOL_SOURCES: JSON.stringify(toolSources) }),
    };
    // `process.execPath` + tsx 的 CLI 入口，而不是 `npx tsx`（理由见 resolveTsxCli）：
    // 直接子进程 ⇒ fd 3 的 IPC 通道可用；也顺带丢掉 npx 那一层启动开销与 spinner 噪音。
    const proc = spawn(process.execPath, [tsxCli, RUNNER], {
      cwd: projectRoot,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      // 进程组：killTree 要能一次收编整棵树（tsx 自己还会 spawn）
      detached: process.platform !== 'win32',
      env,
    });
    const handle: ChildHandle = {
      child: proc,
      capabilities: [],
      multiTurn: [],
      defaultWorkdir: projectRoot,
      // 就绪前只能给缺省值（真正生效的那份由 `ready` 消息报上来）
      budget: { ...DEFAULT_BUDGET },
      warning: null,
      toolSources,
    };
    // 立刻挂上（不是等到 ready）：ready 之前崩掉的进程也得能被 stopChild 收掉，
    // 否则每失败一次就留一个孤儿 npx/tsx 进程树。
    child = handle;

    return new Promise<ChildHandle>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        killTree(proc, 'SIGKILL');
        fail(`dev runner 启动超时（${READY_TIMEOUT_MS} ms 内没有就绪信号）`);
      }, READY_TIMEOUT_MS);

      /**
       * 启动失败 ⇒ **把 child 摘掉**，不能把一个死 handle 留在那儿。
       *
       * 为什么这是硬要求：`restart` 的失败路径靠 `if (!child)` 判「起不来」（⇒ 回 500、
       * `running` 不置位），而 spawn 出来的进程如果只发了 `'error'`（ENOENT / EACCES 那类），
       * 它**不会**再发 `'exit'`、`exitCode` 恒为 `null` ⇒ 留着的话下一次 `POST /run` 会
       * 往一条已断的通道 `send()`（抛 `ERR_IPC_CHANNEL_CLOSED`），且 `running` 卡在 `true`
       * ⇒ 面板之后每次运行都 409。摘掉它，`if (!child)` 就能正确报「runner 起不来」。
       */
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child?.child === proc) child = null;
        reject(new Error(message));
      };

      proc.on('error', (err) => {
        lastError = `启动 dev runner 失败：${err.message}`;
        fail(lastError);
      });

      proc.on('message', (raw: unknown) => {
        // 归属判定用**进程身份**而不是代号：迟到的消息只可能来自已经不在台上的那个进程
        if (child?.child !== proc) return;
        const msg = raw as RunnerMessage;
        if (msg.type === 'ready') {
          handle.capabilities = msg.capabilities;
          handle.multiTurn = msg.multiTurn;
          handle.defaultWorkdir = msg.defaultWorkdir;
          handle.budget = msg.budget;
          handle.warning = msg.warning;
          if (msg.warning) console.warn(`[agentia] ${msg.warning}`);
          // 广播「就绪」：面板加载时那次 /api/dev 拿到的还是初值（capabilities 为空），
          // 没有这一条它就一直空着 —— 详见 dev-protocol 的 DevEvent 注释。
          emit({ kind: 'runner-ready' });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(handle);
          }
          return;
        }
        if (msg.type === 'run-start') {
          running = true;
          return;
        }
        if (msg.type === 'run-done') {
          running = false;
          clearAbortTimer();
          if (msg.traceId !== null && pendingNote !== null) {
            inspector?.noteRun(msg.traceId, pendingNote);
          }
          pendingNote = null;
          // 中止的 run 也带 error（`abortedResult()` 刻意如此）⇒ `ok` 是 false。
          // 但它**不是**「环坏了」，不该在告警条上留一条永远不消的红字（判别只看 stopReason）。
          if (!msg.ok && msg.stopReason !== 'aborted') lastError = msg.error;
          emit({
            kind: 'run-done',
            traceId: msg.traceId,
            ok: msg.ok,
            stopReason: msg.stopReason,
            error: msg.error,
            finalText: msg.finalText,
          });
          void afterRun();
          return;
        }
        if (msg.type === 'run-error') {
          running = false;
          clearAbortTimer();
          pendingNote = null;
          lastError = msg.message;
          emit({ kind: 'runner-error', message: msg.message });
          void afterRun();
        }
      });

      proc.on('exit', (code, sig) => {
        const isCurrent = child?.child === proc;
        if (isCurrent) child = null;
        const how = `code=${code ?? 'null'}${sig ? `, signal=${sig}` : ''}`;
        if (!settled) {
          // 没等到 ready 就退了 ⇒ 这是**启动失败**，不是「跑着跑着意外退出」。
          // ⚠️ 必须先把原因写进 lastError 再往下走：下面的 emit 是同步执行的，而
          // fail() 的 reject 要等到下一个微任务才被调用方的 catch 接住 —— 先 reject
          // 会让面板收到一句更笼统的「意外退出」，把真正的原因挤成只出现在终端里。
          lastError = `dev runner 退出（${how}）—— 多半是用户代码 import 期就抛了，看上面的输出`;
          fail(lastError);
        }
        if (!isCurrent || closing) return;
        running = false;
        clearAbortTimer();
        lastError = lastError ?? `dev runner 意外退出（${how}）`;
        emit({ kind: 'runner-error', message: lastError });
      });
    });
  };

  const stopChild = async (): Promise<void> => {
    const handle = child;
    child = null;
    if (!handle) return;
    // ⚠️ 子进程要没了 ⇒ **不可能再有在飞 run**，必须把 running 落下来。
    // 为什么这是硬要求：`proc.on('exit')` 的归属判定（`child?.child === proc`）此刻已经
    // 为假（上一行刚把 child 置 null），所以 exit 处理器会**早退**、不会帮忙清 running。
    // 少了这一行，「中止超时 ⇒ 重启兜底」之后 running 永远是 true ⇒ 之后每次 POST /run
    // 都 409 —— 面板**照样锁死**，只是从「卡在 run 上」变成「卡在 running 标志上」。
    // （唯一会在 run 在飞时杀子进程的路径就是这条兜底：文件变更那条走 pendingRestart 延后。）
    running = false;
    clearAbortTimer();
    const proc = handle.child;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        killTree(proc, 'SIGKILL');
        done();
      }, KILL_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      killTree(proc, 'SIGTERM');
    });
  };

  /** 重启 = 停旧的 + 起新的；串行化，且把「重启」这件事广播给面板（不静默） */
  const restart = (reason: string, toolSources: string[] | null): Promise<void> => {
    chain = chain.then(async () => {
      if (closing) return;
      emit({ kind: 'runner-restart', reason });
      await stopChild();
      try {
        await spawnChild(toolSources);
      } catch (e) {
        lastError = (e as Error).message;
        emit({ kind: 'runner-error', message: lastError });
      }
    });
    return chain;
  };

  /** run 收尾后处理「在飞期间攒下的重启请求」 */
  const afterRun = (): Promise<void> => {
    if (pendingRestart === null || closing) return Promise.resolve();
    const reason = pendingRestart;
    pendingRestart = null;
    return restart(reason, child?.toolSources ?? null);
  };

  // ---------- 面板侧 ----------

  const emit = (ev: DevEvent): void => inspector?.emitDev(ev);

  const devState = (): DevState => ({
    available: true,
    projectRoot,
    home: process.env.HOME ?? '',
    capabilities: child?.capabilities ?? [],
    multiTurn: child?.multiTurn ?? [],
    warning: child?.warning ?? null,
    defaultWorkdir: child?.defaultWorkdir ?? projectRoot,
    // 生效值由 runner 报（就绪前是缺省值）—— 面板显示与实际生效必须是同一份
    budget: child?.budget ?? { ...DEFAULT_BUDGET },
    sessionId,
    running,
    lastError,
  });

  const submitRun = async (req: RunRequest): Promise<RunAck> => {
    // ⚠️ 闸必须**同时**看 `launching`：受理到 run 真正发出去之间有 `await restart(...)`，
    //    只判 `running` 的话「改了能力选择 ⇒ 双击运行」的两个请求会双双通过 ⇒
    //    runner 里两个 `runOnce` 并发、`currentAbort` 被覆盖、`pendingNote` 挂错 traceId。
    //    §6 待定 5 承诺的是**默认拒绝**，而这条正是当初漏掉的路径。
    if (running || launching) {
      throw new HttpError(
        409,
        '上一次 run 还在跑。等它结束，或先「中止」它再发新的（并发语义见计划 §6 待定 5）',
      );
    }
    // 上一轮中止留下的兜底计时器不该跨到这一轮来（否则会掐掉一次正常的 run）
    clearAbortTimer();
    const caps = child?.capabilities ?? [];
    const selected = req.toolSources ?? caps;
    const toolSources = normalizeToolSources(selected, caps);
    const workdir = req.workdir && req.workdir.length > 0 ? req.workdir : devState().defaultWorkdir;
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
      // 响亮失败：目录写错时**不能**退回项目根 —— 那会让 agent 对着错的目录乱写（D5）
      throw new HttpError(400, `工作目录不存在或不是文件夹：${workdir}`);
    }
    const defaults = multiTurnDefault(toolSources ?? caps, child?.multiTurn ?? []);
    const multiTurn = req.multiTurn ?? defaults.value;

    let restarted = false;
    const prev = child?.toolSources ?? null;
    const same =
      (prev === null && toolSources === undefined) ||
      (prev !== null &&
        toolSources !== undefined &&
        prev.join('\u0000') === toolSources.join('\u0000'));
    // 占位：从这里到「run 发出」之间不能让第二个请求通过上面的闸（见 launching 的说明）。
    // 校验已经做完（工作目录在上一行之前判过）⇒ 占位期间不会有 400 把标志留在 true 上。
    launching = true;
    try {
      if (!child || !same) {
        // 换能力选择 ⇒ 重启进程（D8：理由是回收口，不是成本）。不重启的话旧 app 的
        // MCP 子进程没人收编 —— 框架没有 AgentApp.close()。
        restarted = true;
        await restart('能力选择变化（toolSources）', toolSources ?? null);
        if (!child) throw new HttpError(500, lastError ?? 'runner 起不来');
      }

      pendingNote = {
        prompt: req.prompt,
        workdir,
        toolSources: toolSources ?? null,
        multiTurn,
      };
      running = true; // 乐观置位：连点两次在 runner ack 之前就该被拒
      // 会话 id 由**父进程**给：它是面板级状态（「清空对话」换的就是它），
      // 且必须跨 runner 重启稳定 —— 改代码会重启 runner，但不该丢掉会话。
      // （面板**不能**指定它，见 `RunRequest` 里那条说明。）
      let sent = false;
      try {
        sent = (child as ChildHandle).child.send({
          type: 'run',
          request: {
            prompt: req.prompt,
            workdir,
            multiTurn,
            sessionId,
            toolSources: toolSources ?? null,
          },
        });
      } catch (e) {
        // 通道刚断开时 `send()` **会抛**（`ERR_IPC_CHANNEL_CLOSED`），不只是返回 false。
        // 抛的那条会跳过下面所有复位 ⇒ `running` 永久留成 true ⇒ 面板之后每次
        // `POST /run` 都 409（「面板锁死」换了个地方复现）。统一翻译成 500。
        throw new HttpError(500, `runner 通道已断（${(e as Error).message}），稍后再试`);
      }
      if (!sent) throw new HttpError(500, 'runner 通道已断（进程可能刚退出），稍后再试');
      emit({
        kind: 'run-start',
        prompt: req.prompt,
        workdir,
        toolSources: toolSources ?? null,
        multiTurn,
      });
      return { accepted: true, restarted };
    } catch (e) {
      // 任何一步失败都必须把两处状态复位：留下的 `running = true` 会让面板**永久** 409，
      // 而留下的 `pendingNote` 会挂到下一轮 run 的 traceId 上（张冠李戴）。
      running = false;
      pendingNote = null;
      throw e;
    } finally {
      launching = false;
    }
  };

  /**
   * 中止在飞 run（§6 待定 5 的「显式 kill 按钮」）。
   *
   * 两条路，按顺序：
   * 1. **优雅**：给 runner 发 `run-abort`，它 abort 掉 `app.run` 的 `signal` ⇒ 引擎在回合边界
   *    以 `stopReason='aborted'` **正常返回** ⇒ **trace 照常落盘**（框架契约：不抛异常）。
   * 2. **兜底**：`signal` 是**协作式**的 —— 工具若不读 `ToolRunContext.signal`（本仓已知
   *    「MCP 在途中止 ⇒ Promise 永不 settle」那类），abort 就没人理。那就重启进程收编它
   *    （代价是这次 run 的 trace 丢掉，但**面板不至于永久锁死**：`running` 一直是 true 的话，
   *    之后每次 `POST /run` 都 409 —— 那才是真正没法用的状态）。
   */
  const abortRun = async (): Promise<{ accepted: boolean; escalated: boolean }> => {
    if (!running || !child) throw new HttpError(409, '当前没有在飞的 run');
    // 幂等：中止已发出、升级计时器还挂着时再点一次，**不该再挂一个计时器** ——
    // 两个计时器到点会触发两次 restart，第二次打在一个刚重启好的 runner 上
    // （那会把用户刚跑起来的 run 又掐掉一次）。
    if (abortTimer !== null) return { accepted: true, escalated: false };
    const proc = child.child;
    const sent = proc.send({ type: 'run-abort' });
    if (!sent) throw new HttpError(500, 'runner 通道已断（进程可能刚退出），稍后再试');
    const escalated = await new Promise<boolean>((resolve) => {
      let tick: NodeJS.Timeout | null = null;
      abortTimer = setTimeout(() => {
        abortTimer = null;
        if (tick !== null) clearInterval(tick);
        // 还在跑 ⇒ signal 没人理。这时**必须**升级，否则面板锁死。
        // 也记进 lastError：被掐掉的 run 是个「发生过的事」，不该只闪一下就没了
        // （面板的通知会被下一次操作覆盖，刷新页面就再也看不到）。
        lastError = '中止超时（工具不响应 signal）⇒ 已重启 runner 兜底：这次 run 的 trace 丢了';
        void restart('中止超时：run 不响应 signal（工具可能不可取消）', child?.toolSources ?? null);
        resolve(true);
      }, ABORT_GRACE_MS);
      // 正常收尾（run-done / run-error）会把计时器清掉并让这里 resolve(false)
      tick = setInterval(() => {
        if (!running) {
          if (tick !== null) clearInterval(tick);
          clearAbortTimer();
          resolve(false);
        }
      }, 50);
      tick.unref();
    });
    return { accepted: true, escalated };
  };

  /**
   * 清空对话 = **换一个 sessionId**（§6 待定 3）。
   *
   * 不删 `session.json` 里的东西：那是 `SessionStore` 的账，面板对它是只读的
   * （见 `readSession`）。旧对话留在盘上，run 列表里那些 run 也还指得到它 ——
   * 而新的 run 用新 id ⇒ 模型看到的上下文是空的。
   */
  const clearSession = async (): Promise<{ sessionId: string }> => {
    if (running) {
      throw new HttpError(409, '有 run 在飞时不能清空对话（它会写回当前会话）。先中止或等它结束');
    }
    sessionId = nextSessionId(sessionId);
    writeSessionId(sessionId);
    return { sessionId };
  };

  const readSession = async (): Promise<{ messages: SessionMessageLike[] } | null> => {
    // 面板**只读**会话文件：它记的是「我发了什么」，而模型看到的是「store 里有什么」，
    // 两者一旦漂开（历史被裁剪、run 失败没回写、手工改了文件），面板就会显示一份
    // **不存在的对话** —— 正是本仓一直在猎的那类静默不一致。
    // 路径取 dev-protocol 的常量，不在这里就地写字符串 —— 就地写一份就是
    // 「同一个事实两个写法」，而这两处漂开的后果是**面板显示一份不存在的对话**。
    // ⚠️ 这条耦合是**约定**而非机制：`SESSION_REL` 必须与用户工程 `src/app.ts` 的
    // `SESSION_FILE` 一致（模板里两者是一致的）。要根治得让 runner 把真实路径报回来。
    const file = join(projectRoot, SESSION_REL);
    if (!existsSync(file)) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(file, 'utf8')) as {
        sessions?: Record<string, SessionMessageLike[]>;
      };
      // 读**当前** id（不是常量）：清空对话之后面板必须立刻显示空，而不是旧对话
      const messages = parsed.sessions?.[sessionId];
      return { messages: Array.isArray(messages) ? messages : [] };
    } catch (e) {
      throw new HttpError(500, `读会话文件失败：${(e as Error).message}`);
    }
  };

  // ---------- 收尾 ----------

  /**
   * 收尾：停 watch、收**整棵**子进程树、关面板。
   *
   * 返回 Promise 而不是 fire-and-forget：信号处理器要等它真的做完才 `exit` —— 理由见
   * `shutdownAndExit`（这是个实测出来的坑，不是风格）。
   */
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    stopWatch?.();
    stopEnvWatch?.();
    try {
      await stopChild();
    } finally {
      if (inspector) await inspector.close();
    }
  };

  let shuttingDown = false;
  /**
   * 收尾后退出（SIGINT / SIGTERM 共用同一条出口）。
   *
   * ## 为什么不能沿用「固定 50 ms 后 `process.exit(0)`」（实测，不是风格偏好）
   *
   * `stopChild()` 给子进程的宽限期是 `KILL_GRACE_MS`（3 s）—— 它 SIGTERM 之后等 3 s
   * 才补 SIGKILL。而固定 50 ms 就 exit 会让父进程在这 3 s 之前消失：
   * - 那段宽限连同 **SIGKILL 兜底**一起没了（计时器随父进程消失）；
   * - `process.on('exit')` 那条兜底此刻也是空操作 —— `stopChild` 第一行就把 `child`
   *   置成了 null，而它的归属判定是 `child?.child === proc`。
   * ⇒ 一个**不响应 SIGTERM** 的 runner（连同它自己 spawn 的 MCP 子进程）活成孤儿。
   * SIGTERM 路径没有这个问题（它不主动退出、等事件循环自然空），两条路径口径必须一致。
   *
   * 上限仍然要有：面板若还有挂着的连接，收尾可能卡住 ⇒ `SHUTDOWN_DEADLINE_MS` 到点硬退；
   * 再按一次 Ctrl+C 立即硬退（不让用户面对一个按不动的 Ctrl+C）。
   */
  const shutdownAndExit = (code: number): void => {
    if (shuttingDown) {
      process.exit(code);
    }
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(code), SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    void shutdown().finally(() => {
      clearTimeout(deadline);
      process.exit(code);
    });
  };

  process.on('SIGINT', () => shutdownAndExit(0));
  process.on('SIGTERM', () => shutdownAndExit(0));
  // 最后一道兜底：任何路径走到进程退出都不该留下子进程树（含上面那条硬退路径）
  process.on('exit', () => {
    if (child) killTree(child.child, 'SIGKILL');
  });

  // ---------- 启动 ----------

  /**
   * 起面板。失败**不阻断** dev（文件头那条「面板是增强项」的承诺）—— 但要响亮说清
   * 「这一次没有面板」，而不是含糊的「dev 照常运行」。
   *
   * 为什么要真的降级而不是退出：`agentia dev -- "问题"` 这条**文档化的用法**不需要面板
   * （首次 run 由 argv 给，改代码照样重启），而且「面板起不来 ⇒ 连 runner 都不 spawn、
   * 进程随即以 code=1 退出」正是那句旧文案在说谎的地方（它说照常运行，事实是 dev 根本没起来）。
   */
  const startPanel = async (): Promise<void> => {
    try {
      inspector = await startInspector({
        token,
        dev: {
          state: devState,
          run: submitRun,
          session: readSession,
          abort: abortRun,
          clearSession,
        },
      });
      console.log(
        `Inspector: http://127.0.0.1:${inspector.port}/?t=${token}\n` +
          '  （带 token 的完整 URL —— 打开一次就会种进 cookie，之后刷新不用再带）',
      );
    } catch (err) {
      inspector = null;
      console.warn(
        `[agentia] inspector 起不来（${(err as Error).message}）⇒ 这一次**没有面板**：\n` +
          '  trace / 对话视图 / 「中止」都不可用；dev 只保留「首次 run（`npm run dev -- "问题"`）」\n' +
          '  与「改代码自动重启」两条路，run 的正文与失败原因打在终端上。',
      );
    }
  };

  void (async () => {
    await startPanel();
    try {
      await spawnChild(null);
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`[agentia] ${lastError}`);
    }
    // 「文件变了 ⇒ 重启」的**唯一**出口：两处 watch 都走它，理由文案因此只有一种写法。
    const onFileChange = (abs: string): void => {
      const rel = relative(projectRoot, abs);
      if (running) {
        pendingRestart = `文件变更：${rel}`;
        return;
      }
      void restart(`文件变更：${rel}`, child?.toolSources ?? null);
    };
    // 代码与文本资产都在 `src/` 下（`.md` 必须在允许清单里 —— 见 WATCH_EXT）
    stopWatch = watchTree(join(projectRoot, 'src'), onFileChange);
    // `.env` / `.env.local` 在**项目根**、不在 `src/` 下 ⇒ 单独盯。
    // 少了这一句，「改 .env 会重启」就是一句没人执行的承诺（真跑抓出来的）。
    stopEnvWatch = watchRootEnvFiles(projectRoot, onFileChange);
    // `agentia dev -- "问题"` / `npm run dev -- "问题"`：文档化的用法，首次 run 用这个 prompt。
    // ⚠️ 必须把分隔符 `--` 自己挑掉：`npm run dev -- "问题"` 里 npm 会吃掉那个 `--`
    // （CLI 收到的是 `dev "问题"`），但**裸 CLI** 那条（cli.ts 的 usage 就写着
    // `agentia dev [-- "问题"]`）会把 `--` 原样放进 rest ⇒ 取第一个非空参数时
    // 拿到的是 `"--"`：首次 run 的 prompt 变成两个连字符，而模型照样会回话
    // （所以它**不会**报错，只是问了另一件事 —— 静默错到底）。
    const initial = argv.filter((a) => a !== '--').find((a) => a.trim().length > 0);
    if (initial !== undefined) {
      try {
        await submitRun({ prompt: initial });
      } catch (e) {
        console.error(`[agentia] 首次 run 没起来：${(e as Error).message}`);
      }
    }
  })();

  return 0;
}
