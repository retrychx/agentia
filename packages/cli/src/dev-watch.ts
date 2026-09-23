/**
 * dev 环的**文件监视件**（C 阶段自 `dev.ts` 纯搬移，行为未改 ——
 * 方案 docs/plans/2026-09-23-cli-structure.md §3 C）。
 *
 * 收编「代码变了要重启」的全部判据与原语：
 * - `shouldWatch` / `shouldDescend`：哪些文件 / 目录进 watch 范围（允许清单，不是排除清单）；
 * - `makeNotifier`：两个 watch 共用的去抖通知器；
 * - `watchTree`：递归 watch `src/` 目录树；
 * - `watchRootEnvFiles`：单独盯项目根的 `.env` / `.env.local`。
 *
 * 本文件**不读机器状态**（`DevMachineState`）：它只产出「哪个文件变了」这个事实，
 * 「变了之后该不该重启」是 `dev-machine.ts` 的迁移规则，`dev.ts` 接线层负责把两边接上。
 *
 * 出口形状：`shouldWatch` / `watchTree` / `watchRootEnvFiles` 经 `dev.ts` re-export ——
 * `packages/cli/test/panel-logic.test.mjs` 从 `dist/dev.js` 取它们，出口不能断。
 */
import { type Dirent, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { join, sep } from 'node:path';

/** 文件事件去抖：编辑器保存常常连发好几个事件（写临时文件 + rename） */
const WATCH_DEBOUNCE_MS = 150;

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
    // 空监听防爆是必要的（没有 error 监听的 FSWatcher 出错会抛穿进程），
    // 但不能**静默** —— watcher 坏了 = 「改代码会重启」悄悄失效，必须留一行可诊断的话。
    w.on('error', (err) => {
      console.warn(
        `[agentia] 监视目录出错（${dir}）：${err.message} —— 这之后的文件变更可能不再触发重启`,
      );
    });
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
  // 同 watchTree：监听要留（防爆），但错误要响亮（静默 = 「改 .env 会重启」悄悄失效）
  w.on('error', (err) => {
    console.warn(
      `[agentia] 监视项目根出错（${root}）：${err.message} —— 这之后改 .env 可能不再触发重启`,
    );
  });
  return () => {
    w.close();
    notifier.dispose();
  };
}
