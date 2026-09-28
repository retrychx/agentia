import type { McpCore, McpServer } from './mcp-server.js';

/**
 * Agentia —— MCP 反向桥的 **stdio 传输**（2026-09-28 自 `mcp-server.ts` 切出，
 * 与正向桥 `integrations/mcp-stdio.ts` 同款排布：桥居中、传输各居其文件）。
 *
 * 形状：stdin/stdout **换行分隔 JSON-RPC**（每行一个完整报文）；日志只去 stderr
 * —— stdout 是协议面，往里写一个字节都会污染报文流。
 *
 * **依赖方向（单向，运行期无环）**：本文件从 `mcp-server.js` 只取**类型**
 * （`McpCore` / `McpServer`，编译期擦除），协议与执行**由 `core` 注入**。
 * ⚠️ 与正向桥的差别（那边的 `mcp.ts ↔ mcp-stdio.ts` 是一条**真实的值环**：桥 re-export
 * 连接器、连接器反向 import 桥的共享 helper，靠 ESM 的函数提升与调用时机侥幸无恙）——
 * 这里刻意做成注入式：无环是**构造性**的，不靠运气。
 */
export function startStdioTransport(core: McpCore): McpServer {
  // stdout 的 error **必须吞**：宿主先关读端、stdin 仍开着时，下一次应答写入就是异步
  // `write EPIPE` —— 未捕获会把 server 打成栈回溯 + exit 1（2026-09-27 ⑩），而它只是
  // 「对端没了」的次生现象，不是根因。正向连接器对子进程 stdin 是同一处置
  // （`integrations/mcp-stdio.ts` 的 `p.stdin?.on('error', () => {})`），方向对称。
  // 吞掉 ≠ 静默：真该知道的人（宿主）已经从自己的管道拿到 EOF 了。
  process.stdout.on('error', () => {
    /* EPIPE：对端已走 */
  });
  let buf = '';
  let closed = false;
  const onData = (chunk: string): void => {
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
        // 坏报文由**协议侧**定义形状：传输层不该知道 JSON-RPC 的错误码（见 McpCore.rpcError）
        process.stdout.write(`${JSON.stringify(core.rpcError(null, -32700, '行不是合法 JSON'))}\n`);
        continue;
      }
      const ac = new AbortController();
      const signal = core.trackCall(ac);
      void core
        .dispatch(msg, signal)
        .then((resp) => {
          if (resp !== null && !closed) {
            process.stdout.write(`${JSON.stringify(resp)}\n`);
          }
        })
        .catch(() => {
          /* 分派自身不该抛（callTool 内部已兜住）；真抛了也不许把 server 带崩 */
        })
        .finally(() => core.untrackCall(ac));
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  return {
    url: undefined,
    ready: Promise.resolve(),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      core.abortAll();
      process.stdin.off('data', onData);
      process.stdin.pause(); // 摘掉读端，宿主进程的事件循环不再被我们吊住
      return Promise.resolve();
    },
  };
}
