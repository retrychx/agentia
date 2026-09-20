import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  DEFAULT_CLIENT_INFO,
  DEFAULT_PROTOCOL_VERSION,
  MCP_DEFAULT_TIMEOUT_MS,
  brief,
  isJsonRpcResponse,
  unwrap,
  withDeadline,
} from './mcp.js';
import type { Guard, McpConnector, McpToolInfo } from './mcp.js';

/**
 * MCP **stdio 连接器**（内置默认件之一）：spawn 子进程、换行分隔 JSON-RPC。
 * 桥与共享 helper 在 `mcp.ts`；本文件只含 stdio 传输。module 级 export，
 * 公共面仍由 `mcp.ts` re-export（`src/index.ts` 不变）。
 */

/** `close()` 里 SIGTERM → SIGKILL 的宽限期（毫秒） */
export const MCP_CLOSE_GRACE_MS = 2_000;

export interface StdioMcpConnectorOptions {
  /** 追加 / 覆盖的环境变量（缺省继承 `process.env`） */
  env?: Record<string, string>;
  /** 子进程工作目录 */
  cwd?: string;
  /** 子进程 stderr 去向：`'inherit'`（缺省，server 日志直通终端）| `'ignore'` */
  stderr?: 'inherit' | 'ignore';
  /** 见 {@link DEFAULT_CLIENT_INFO} */
  clientInfo?: { name: string; version: string };
  /** 请求的协议版本，缺省 `'2024-11-05'` */
  protocolVersion?: string;
  /**
   * 装配期超时（毫秒）—— 只作用于**握手 + `tools/list`**，缺省
   * {@link MCP_DEFAULT_TIMEOUT_MS}；非正数 = 不限。语义见 {@link Guard}。
   *
   * 超时同样只是一类账（`code='timeout'`）：**不终止子进程**，与仓库其余「等待的终点」
   * 一致（超时 = 放弃等待）。
   */
  timeoutMs?: number;
}

/**
 * **stdio 连接器**：spawn 一个 MCP server 子进程，走换行分隔的 JSON-RPC 2.0
 * （`initialize` → `notifications/initialized` → `tools/list` / `tools/call`）。
 *
 * 进程与握手都是**惰性**的 —— 构造不产生副作用，第一次 `listTools` / `callTool` 才 spawn；
 * 握手只做一次（并发调用共享同一次握手）。
 *
 * 三处非显然的坑，这里都兜住了（此前 `scripts/e2e-mcp.ts` 内联的那 94 行踩过）：
 * 1. spawn **失败**（命令不存在 → `ENOENT`）是异步的 `'error'` 事件，不是抛出 ——
 *    没有监听器就是未捕获异常、直接把宿主进程带崩，所以必须接住并拒绝在途请求；
 * 2. 分帧：一条报文可能跨多个 chunk，必须自己攒 buffer 按 `\n` 切；
 * 3. **协议层 `isError: true` 必须转成抛错** —— 否则模型收到一条「成功」的结果，
 *    trace 也把它记成成功的调用（`McpClientLike` 的约定，见其注释）。
 */
export function createStdioMcpConnector(
  cmd: readonly string[],
  opts: StdioMcpConnectorOptions = {},
): McpConnector {
  const bin = cmd[0];
  if (typeof bin !== 'string' || bin === '') {
    throw new Error('createStdioMcpConnector：cmd 不能为空（需要可执行文件 + 参数）');
  }
  const rest = cmd.slice(1);
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;
  const protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  let proc: ChildProcess | null = null;
  let fatal: Error | null = null;
  let closed = false;
  let exited = false;
  let buf = '';
  let nextId = 1;
  let ready: Promise<void> | null = null;
  let resolveExit: (() => void) | null = null;
  const exitPromise = new Promise<void>((r) => {
    resolveExit = r;
  });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const markExited = (): void => {
    exited = true;
    resolveExit?.();
  };

  /** 进程已死 / 已 close 时一次性拒绝全部在途请求 —— 不留永久挂起的 promise */
  const fail = (err: Error): void => {
    fatal = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const guard: Guard = (p, label) => withDeadline(p, timeoutMs, label);

  const ensureProc = (): ChildProcess => {
    if (closed) throw new Error('MCP 连接器已 close —— 请重新创建一个');
    if (fatal) throw fatal;
    if (proc) return proc;

    const spawnOpts: SpawnOptions = {
      stdio: ['pipe', 'pipe', opts.stderr ?? 'inherit'],
      // exactOptionalPropertyTypes：可选字段不能赋 undefined，只能条件展开
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    const p = spawn(bin, rest, spawnOpts);
    proc = p;

    p.on('error', (err: unknown) => {
      // 见函数头第 1 条：这个监听器不是可选的
      fail(err instanceof Error ? err : new Error(String(err)));
      markExited();
    });
    p.on('exit', (code, signal) => {
      if (!closed) {
        fail(
          new Error(`MCP server 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`),
        );
      }
      markExited();
    });
    // 'exit' 在 spawn 失败时可能不触发，'close' 一定会 —— close() 靠它才不会白等
    p.on('close', markExited);
    // 进程已死时写 stdin 会异步报 EPIPE；真实原因由上面的 'error' / 'exit' 给出
    p.stdin?.on('error', () => {
      /* 吞掉：EPIPE 是「进程没了」的次生现象，不是根因 */
    });

    p.stdout?.setEncoding('utf8');
    p.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // MCP 规定 stdout 只走协议，但 server 混日志进来是常事
        }
        if (!isJsonRpcResponse(msg)) continue; // 通知（无 id）不配对
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        pending.delete(msg.id);
        try {
          waiter.resolve(unwrap(msg, 'response'));
        } catch (e) {
          waiter.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    return p;
  };

  const write = (payload: unknown): void => {
    const p = ensureProc();
    p.stdin?.write(`${JSON.stringify(payload)}\n`);
  };

  const send = (method: string, params: unknown, abandoned?: AbortSignal): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('MCP 连接器已 close —— 请重新创建一个'));
    if (fatal) return Promise.reject(fatal);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      try {
        ensureProc();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      pending.set(id, { resolve, reject });
      // 裁判放弃等待 ≠ 条目自动回收：超时的调用（引擎 toolTimeoutMs 或桥兜底）只是
      // 不再 await，pending 里的 {resolve,reject} 会留到「server 终于回包 / 进程死 /
      // close」—— 对「活着但不回包」的 server 就是无界泄漏。裁判表过态就删条目：
      // 之后回包到了也没人等（:441 的 pending.get 落空即忽略，语义安全）。
      if (abandoned !== undefined) {
        const drop = (): void => {
          pending.delete(id);
        };
        if (abandoned.aborted) drop();
        else abandoned.addEventListener('abort', drop, { once: true });
      }
      write({ jsonrpc: '2.0', id, method, params });
    });
  };

  /** 握手只做一次；失败是**粘性**的（连接器已不可用 → 重建，而不是半初始化态） */
  const ensureReady = (): Promise<void> => {
    if (ready) return ready;
    ready = (async () => {
      const init = await guard(
        send('initialize', { protocolVersion, capabilities: {}, clientInfo }),
        'initialize',
      );
      // 协商结果以 server 回的那个为准（协议允许 server 降级或选自己的版本）
      void init;
      write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    })();
    return ready;
  };

  const request = async (
    method: string,
    params: unknown,
    abandoned?: AbortSignal,
  ): Promise<unknown> => {
    await ensureReady();
    return send(method, params, abandoned);
  };

  const listTools = async (): Promise<McpToolInfo[]> => {
    const r = await guard(request('tools/list', {}), 'tools/list');
    if (typeof r !== 'object' || r === null) {
      throw new Error(`MCP tools/list 返回了非对象：${brief(r)}`);
    }
    const listed = (r as { tools?: unknown }).tools;
    if (listed === undefined) return [];
    if (!Array.isArray(listed)) {
      // 响亮失败：把协议不符吞成空菜单，用户看到的是「一个工具都没有」而不是「server 坏了」
      throw new Error(`MCP tools/list 的 tools 不是数组：${brief(listed)}`);
    }
    return listed as McpToolInfo[];
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    callOpts?: { abandoned?: AbortSignal },
  ): Promise<unknown> => {
    const r = await request('tools/call', { name, arguments: args }, callOpts?.abandoned);
    // 承重：协议层 isError 只有连接器看得见（见函数头第 3 条）
    if (typeof r === 'object' && r !== null && (r as { isError?: unknown }).isError) {
      throw new Error(
        `MCP 工具 ${name} 返回 isError: ${brief((r as { content?: unknown }).content)}`,
      );
    }
    return r;
  };

  return {
    listTools,
    callTool,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      fail(new Error('MCP 连接器已 close —— 请重新创建一个'));
      const p = proc;
      proc = null;
      if (!p) return;
      p.kill('SIGTERM');
      if (exited) return;
      const killTimer = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* 已经死了 */
        }
        // ⚠️ 这里**不** resolve：SIGKILL 不可被捕获，'exit'/'close' 必达 —— 继续等真的退出。
        // 到点即返回是 2026-09-18 之前的行为：调用方以为进程没了，实际还留着一个孤儿。
      }, MCP_CLOSE_GRACE_MS);
      try {
        await exitPromise;
      } finally {
        clearTimeout(killTimer);
      }
    },
  };
}
