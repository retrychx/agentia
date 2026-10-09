/**
 * Terminal-Bench 的执行面：一个**有状态**的 bash 会话。
 *
 * 为什么不是每条命令 `execFile` 一次：Terminal-Bench 的任务是连续操作
 * （`cd src && make` / `export PATH=...` / 起一个服务再 curl），工作目录与环境变量
 * 必须跨调用保留。一次性子进程每跑一条就丢状态，模型得靠「每次都写绝对路径」来绕，
 * 那是把框架的能力缺口转嫁给 prompt。
 *
 * 因此这里起一个长驻 `bash`，靠哨兵行判断命令结束：
 *   写 `<命令>\nprintf '\n%s:%s\n' <哨兵> "$?"`（前导 `\n` 保证哨兵**独占一行**，
 *   即使命令输出不带尾换行）
 *   读 stdout 直到出现**独占一行**的哨兵 ⇒ 哨兵之前是输出、之后是退出码。
 *   锚定整行匹配是为了抗 `set -x`：xtrace 合流进 stdout 后会把 printf 命令本身
 *   （含哨兵字面量）打出来，子串匹配会提前命中它（见 `exec` 里的注释）。
 *
 * 已知边界（改之前先读，别当成 bug 修）：
 * 1. **交互式命令会挂**（`vim` / `less` / 等待 stdin 的脚本）⇒ 由超时兜底：
 *    超时后 SIGKILL 掉整个会话，并**重建**会话（因此 cwd 会丢，这一步如实回给模型，
 *    让它自己重新 `cd`）。
 * 2. stderr 用 `exec 2>&1` 合进 stdout —— 模型要看到报错，分开记只会让它以为命令成功。
 * 3. 不做沙箱：容器本身就是沙箱。别在宿主机上直接跑这个工具。
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Tool } from '@migor/agentia';

/**
 * 缺省工作目录：任务容器里是 `/app`；在宿主机做自检时 `/app` 不存在，
 * 回落到当前目录（否则 spawn 直接 ENOENT，且要等满超时才暴露）。
 */
function defaultCwd(): string {
  const configured = process.env.AGENTIA_TB_CWD;
  if (configured) return configured;
  return existsSync('/app') ? '/app' : process.cwd();
}

export interface ShellResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * 所有活着的会话。
 *
 * ⚠️ 为什么需要这个全局表：长驻 `bash` 会让 node 的事件循环**永不空**
 * ⇒ 任务跑完了进程也不退出，Terminal-Bench 侧的表现是「agent 一直挂着直到超时」，
 * 而命令其实早已执行完。这是长驻会话这种形态自带的坑，不是框架的毛病 ——
 * 但必须显式收尾，所以入口（run.ts / selftest.ts）在写完 ATIF 后调 `closeShellSessions()`。
 *
 * ⚠️ **但「收了会话」还不等于「进程会退」**：agent 用 `&` 起的后台进程是 bash 的
 * **孙进程**，inherits 同一组管道 ⇒ `SIGKILL` 掉 bash 之后我们这端依旧读不到 EOF。
 * `close()` 里已经连管道一起收；入口那两个还必须各自**硬退**，理由见 `run.ts` 末尾。
 */
const LIVE_SESSIONS: ShellSession[] = [];

export async function closeShellSessions(): Promise<void> {
  const sessions = LIVE_SESSIONS.splice(0);
  await Promise.all(sessions.map((s) => s.close()));
}

export class ShellSession {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #seq = 0;
  #cwd: string;
  #env: NodeJS.ProcessEnv;
  #timeoutMs: number;

  constructor(opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) {
    this.#cwd = opts.cwd;
    this.#env = opts.env ?? process.env;
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** 会话是懒起的：第一次执行命令才 spawn（起不来就报错，别让工具静默变成空操作） */
  #ensure(): ChildProcessWithoutNullStreams {
    if (this.#proc) return this.#proc;
    const proc = spawn('bash', [], {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.on('exit', () => {
      if (this.#proc === proc) this.#proc = null;
    });
    // spawn 不起来（cwd 不存在 / bash 不在 PATH）要立刻暴露，别等到超时
    proc.on('error', () => {
      if (this.#proc === proc) this.#proc = null;
    });
    proc.stdin.write('exec 2>&1\n'); // stderr 合流，见文件头第 2 条
    this.#proc = proc;
    return proc;
  }

  async exec(command: string): Promise<ShellResult> {
    const proc = this.#ensure();
    // marker 只有 [a-z0-9_] 字符（base36 + 下划线）—— xtrace 展开与正则都不需转义。
    const marker = `__agentia_exit_${++this.#seq}_${Math.random().toString(36).slice(2)}__`;
    /**
     * 哨兵必须**独占一行**（行首 = marker、紧跟 `:exitcode`、行尾 \n），不能子串匹配：
     * 模型执行过 `set -x` 后，bash 的 xtrace 会合流进 stdout（我们 `exec 2>&1`），
     * printf 那行的展开形态（`+ printf '%s:%s\n' '__agentia_exit_…__' '0'`）里
     * **也含哨兵字面量、且先于真实哨兵出现** —— `indexOf(marker)` 会提前命中它，
     * 于是 exitCode 恒为 -1，此后每条命令都如此（实测病例）。
     * 尾随 `\n` 也必须要求：退出码可能被 chunk 边界劈开（`:2` 是 `:25` 的前缀），
     * 而 printf 永远以 `\n` 收尾，等它到了再判。
     */
    const sentinelRe = new RegExp(`(?:^|\\n)${marker}:(-?\\d+)\\r?\\n`);
    const startedAt = Date.now();

    return new Promise<ShellResult>((resolve) => {
      let out = '';
      let settled = false;

      const finish = (idx: number, exitCode: number, timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.off('error', onError);
        const durationMs = Date.now() - startedAt;

        if (timedOut) {
          proc.kill('SIGKILL');
          this.#proc = null; // 下次重建；cwd 会丢，如实回给模型
          resolve({ stdout: out, exitCode: -1, timedOut: true, durationMs });
          return;
        }

        resolve({
          stdout: out.slice(0, idx),
          exitCode,
          timedOut: false,
          durationMs,
        });
      };

      const onData = (chunk: Buffer): void => {
        out += chunk.toString();
        const m = sentinelRe.exec(out);
        // 切在匹配起点：哨兵前的 `\n` 是我们自己 printf 打的（见下方 stdin 写入行），
        // 不还给模型 —— 否则命令自带尾换行时输出会多一个空行。
        if (m) finish(m.index, Number(m[1]), false);
      };

      const onError = (err: Error): void => {
        out += `\n[shell 起不来: ${err.message}]`;
        finish(out.length, -1, false);
      };

      const timer = setTimeout(() => finish(-1, -1, true), this.#timeoutMs);
      proc.on('error', onError);
      proc.stdout.on('data', onData);
      // 哨兵前**先补一个 `\n`**：命令输出可能不带尾换行（`printf abc`），
      // 没有它哨兵就不独占一行，上面的锚定正则会永远等不到（退化成超时）。
      proc.stdin.write(`${command}\nprintf '\\n%s:%s\\n' '${marker}' "$?"\n`);
    });
  }

  async close(): Promise<void> {
    const proc = this.#proc;
    this.#proc = null;
    if (!proc) return;
    proc.kill('SIGKILL');
    /**
     * ⚠️ `SIGKILL` 掉 bash **不等于**管道会关。
     *
     * agent 在任务里用 `&` 起的后台进程（实测是 `qemu-system`）是 bash 的**孙进程**，
     * 同样继承着这组管道 ⇒ 我们这端的 `stdout` 永远读不到 EOF ⇒ `ChildProcess` 句柄
     * 一直「活着」⇒ 事件循环不空 ⇒ node 不退出。
     * 实测代价：`qemu-startup` 那轮 agent 第 35 步就交了收尾总结、ATIF 也写完了，
     * 进程却空了 47 分钟，最后被 Harbor 判成 `AgentTimeoutError` ——
     * **一次做成的任务被记成超时**。
     *
     * 只 kill 不收管道是这个坑的另一半，这里补上：收掉我们这端 + `unref`。
     */
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
    proc.unref();
  }
}

/**
 * 给主 agent 的 shell 工具面。
 *
 * 只给一条 `run_command` —— Terminal-Bench 比的就是「会不会用终端」，
 * 再拆 `read_file` / `write_file` 反而把能力面撑大、让模型多一轮选择。
 */
export class ShellTools {
  #session: ShellSession;

  constructor(cwd?: string, timeoutMs?: number) {
    // `exactOptionalPropertyTypes` 下不能把 `timeoutMs: undefined` 塞进可选属性，
    // 只能整个键不出现 —— 缺省值由 ShellSession 自己兜底。
    this.#session = new ShellSession({
      cwd: cwd ?? defaultCwd(),
      ...(timeoutMs != null ? { timeoutMs } : {}),
    });
    LIVE_SESSIONS.push(this.#session);
  }

  /** 收尾钩子：跑完关掉长驻 bash，别让容器里留僵尸进程 */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#session.close();
  }

  @Tool({
    description:
      '在任务环境里执行一条 shell 命令。会话是保持的：cd / export / 后台起的服务在多次调用之间都有效。' +
      '返回 stdout（含 stderr）与退出码。不要用交互式命令（vim/less 等）。',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令，如 "ls -la" 或 "cd src && make"',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    strict: true,
  })
  async run_command(input: { command: string }): Promise<string> {
    const r = await this.#session.exec(input.command);
    const head = `$ ${input.command}`;
    const tail = r.timedOut
      ? `[超时 ${r.durationMs}ms，会话已重建：工作目录回到初始位置，需要请重新 cd]`
      : `[exit=${r.exitCode}]`;
    // 输出可能有界：超长命令输出由 shell 自己截断，这里不二次截断（评测要的就是原始输出）
    return `${head}\n${r.stdout}${tail}`;
  }
}
