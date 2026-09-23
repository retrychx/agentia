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
 * 杀掉**整棵树**。
 *
 * `npx tsx` 自己还会 spawn 子进程，只 kill 直接子进程会留下孤儿（照搬 v0.7.0
 * 「`close()` 保证子进程已终止」的纪律）。POSIX 下靠 `detached: true` 把子进程
 * 变成进程组组长，再对**负 pid** 发信号；win32 没有进程组，用 `taskkill /T`。
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
