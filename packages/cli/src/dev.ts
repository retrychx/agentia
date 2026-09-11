/**
 * dev 命令：热重载开发模式（tsx watch src/main.ts）+ 本地 inspector 面板。
 *
 * inspector 的 trace 从哪来 —— dev 起的是【子进程】，而框架的 trace sink 必须是
 * 进程内注册（registerDefaultTraceSink 是进程级注册表）。所以：
 *   dev 侧起 inspector 服务 → 用 NODE_OPTIONS=--import 把 inspector-preload 注入子进程 →
 *   preload 从【用户项目】解析 @migor/agentia 并注册 dev sink（POST /ingest）。
 * 框架侧完全不感知 dev：不读 env、不含 dev 逻辑（决策见 spec §10）。
 *
 * 面板是增强项，任何一步失败都只告警、不阻断 dev。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startInspector, type InspectorServer } from './inspector.js';

/** --import 可用性：Node ≥20.6（≥18.19 已回移植） */
function supportsImport(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20) return true;
  if (major === 20) return minor >= 6;
  if (major === 18) return minor >= 19;
  return false;
}

export function devServer(): number {
  const cwd = process.cwd();
  const entry = join(cwd, 'src', 'main.ts');
  if (!existsSync(entry)) {
    console.error('错误：当前目录下未找到 src/main.ts，请先用 agentia create <name> 创建项目（或 cd 到项目根目录）');
    process.exitCode = 1;
    return 1;
  }

  let child: ChildProcess | null = null;
  let inspector: InspectorServer | null = null;
  let closing = false;

  const forward = (sig: NodeJS.Signals) => () => {
    if (child && !child.killed) child.kill(sig);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  const startChild = (env: NodeJS.ProcessEnv): void => {
    child = spawn('npx', ['tsx', 'watch', 'src/main.ts'], { cwd, stdio: 'inherit', env });
    child.on('error', (err) => {
      console.error(`错误：启动 dev 失败：${err.message}`);
      process.exitCode = 1;
    });
    child.on('exit', (code, sig) => {
      // 子进程退出后同步退出码；被信号杀死视为正常（用户 Ctrl+C）
      process.exitCode = sig ? 0 : (code ?? 0);
      if (inspector && !closing) {
        closing = true;
        void inspector.close();
      }
    });
  };

  if (!supportsImport()) {
    console.warn(
      `[agentia] Node ${process.versions.node} 不支持 --import（需 ≥20.6 或 ≥18.19），inspector 面板不可用，dev 照常`,
    );
    startChild(process.env);
    return 0;
  }

  startInspector()
    .then((srv) => {
      inspector = srv;
      const here = dirname(fileURLToPath(import.meta.url));
      const preload = pathToFileURL(join(here, 'inspector-preload.js')).href;
      const merged = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--import "${preload}"`;
      console.log(`Inspector: http://127.0.0.1:${srv.port}  （看每次 run 的调用树与单元执行）`);
      startChild({ ...process.env, NODE_OPTIONS: merged, AGENTIA_INSPECT_PORT: String(srv.port) });
    })
    .catch((err: Error) => {
      console.warn(`[agentia] inspector 起不来（${err.message}），dev 照常运行`);
      startChild(process.env);
    });

  return 0;
}
