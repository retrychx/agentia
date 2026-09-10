/** dev 命令：在项目根目录启动 tsx watch src/main.ts（热重载开发模式） */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function devServer(): number {
  const cwd = process.cwd();
  const entry = join(cwd, 'src', 'main.ts');
  if (!existsSync(entry)) {
    console.error('错误：当前目录下未找到 src/main.ts，请先用 agentia create <name> 创建项目（或 cd 到项目根目录）');
    process.exitCode = 1;
    return 1;
  }

  const child = spawn('npx', ['tsx', 'watch', 'src/main.ts'], { cwd, stdio: 'inherit' });

  // 把终端信号转发给子进程（tsx watch 需要收到 SIGINT 才能干净退出）
  const forward = (sig: NodeJS.Signals) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('error', (err) => {
    console.error(`错误：启动 dev 失败：${err.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, sig) => {
    // 子进程退出后同步退出码；被信号杀死视为正常（用户 Ctrl+C）
    process.exitCode = sig ? 0 : (code ?? 0);
  });
  return 0;
}
