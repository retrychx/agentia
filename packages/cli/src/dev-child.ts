/**
 * dev 环的**子进程原语**（C 阶段自 `dev.ts` 纯搬移，行为未改 ——
 * 方案 docs/plans/2026-09-23-cli-structure.md §3 C）。
 *
 * 这里只收**无状态的原语**：解析 tsx 的 CLI 入口（`resolveTsxCli`）与杀整棵进程树
 * （`killTree`）。spawn / stop / restart 三个**执行器**留在 `dev.ts` —— 它们要读写
 * `DevMachineState`（派发 `child-spawned` / `child-exit` 等事件、判进程身份归属），
 * 是接线层的活，不是原语。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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

/** 子进程优雅退出的等待上限，超时补 SIGKILL（kill 必须连整棵树 —— 见 killTree） */
export const KILL_GRACE_MS = 3_000;

/**
 * 「怎么杀这棵进程树」的**纯判定**（**导出为单测用** —— `platform` 可注入）。
 *
 * 为什么要有它：`killTree` 原本直接读 `process.platform`，于是 win32 那条 `taskkill /T /F`
 * 分支**在任何平台上都跑不到**（CI 是 ubuntu、macOS 走 POSIX 分支，win32 只在用户真跑时
 * 才第一次执行）。同一个包里 `native-pick.ts` 的分派收平台参数、因此有十几条平台用例 ——
 * 差别不在勤奋，在**接口形状**。
 *
 * ⚠️ 计划里存**正 pid**，取负是执行器（`killTree`）的事：这样「计划」是纯数据，
 * 而「负 pid = 进程组」这条 POSIX 语义只在一个地方出现。
 */
export type KillPlan =
  | { kind: 'none' }
  | { kind: 'taskkill'; args: string[] }
  | { kind: 'process-group'; pid: number; signal: NodeJS.Signals };

/** 平台 → 杀树计划（缺省平台由调用方给进程平台） */
export function killPlanFor(
  platform: NodeJS.Platform,
  pid: number | undefined,
  signal: NodeJS.Signals,
): KillPlan {
  if (pid === undefined) return { kind: 'none' };
  if (platform === 'win32') {
    // 不带 /T 就只杀直接子进程，`npx tsx` 的孙进程会留下孤儿 —— 「整棵树」全落在这个开关上
    return { kind: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  }
  return { kind: 'process-group', pid, signal };
}

/**
 * 杀掉**整棵**树（执行器；分派在 `killPlanFor`，行为与抽取前**逐字一致**）。
 *
 * `npx tsx` 自己还会 spawn 子进程，只 kill 直接子进程会留下孤儿（照搬 v0.7.0
 * 「`close()` 保证子进程已终止」的纪律）。POSIX 下靠 `detached: true` 把子进程
 * 变成进程组组长，再对**负 pid** 发信号；win32 没有进程组，用 `taskkill /T`。
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const plan = killPlanFor(process.platform, child.pid, signal);
  if (plan.kind === 'none') return;
  if (plan.kind === 'taskkill') {
    try {
      spawn('taskkill', plan.args, { stdio: 'ignore' });
    } catch {
      /* 已经退出了 */
    }
    return;
  }
  try {
    process.kill(-plan.pid, signal); // 负 pid = 整个进程组
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已经退出了 */
    }
  }
}
