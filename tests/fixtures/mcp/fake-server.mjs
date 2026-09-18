#!/usr/bin/env node
/**
 * 离线夹具 MCP server（stdio，换行分隔的 JSON-RPC 2.0）—— 只给
 * `tests/integrations/mcpConnector.test.ts` 用。
 *
 * 为什么是一个能真跑的进程而不是 mock：连接器要验的三件事（spawn 的 `'error'` 事件、
 * stdout 分帧、握手顺序）**都只存在于真子进程世界里** —— 用假 client 验等于什么都没验。
 *
 * 行为由 env 决定（一个文件覆盖全部分支，免得为每个场景再开一个进程脚本）：
 *
 *   FAKE_MCP_MODE      normal | split | logline | noinit | die | iserror | badtools | stubborn
 *     normal    正常握手 + tools/list + tools/call
 *     split     tools/list 响应**分两个 chunk** 下发（间隔 15ms）⇒ 验攒包
 *     logline   tools/list 之前先往 stdout 写一行非 JSON 日志 ⇒ 验忽略它
 *     noinit    initialize 不回应 ⇒ 验装配期超时（否则宿主永久挂起）
 *     die       握手后立刻退出且不回应 tools/list ⇒ 验在途请求被拒绝（不挂死）
 *     iserror   tools/call 回 `{ isError: true }` ⇒ 验转成抛错（否则 trace 会把它记成成功）
 *     badtools  tools/list 的 `tools` 不是数组 ⇒ 验响亮失败而不是空菜单
 *     stubborn  **忽略 SIGTERM**（协议面同 normal）⇒ 验 close() 走 SIGKILL 后**仍等真退出**
 *   FAKE_MCP_LOG_FILE 若设，收到的每个 method 追加一行（测试据此断言握手顺序 / 只握手一次）
 *   FAKE_MCP_PID_FILE 若设，启动时写入自己的 pid（测试据此断言 close() 返回时进程真没了）
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const MODE = process.env.FAKE_MCP_MODE ?? 'normal';
const LOG_FILE = process.env.FAKE_MCP_LOG_FILE;
const PID_FILE = process.env.FAKE_MCP_PID_FILE;

if (PID_FILE) writeFileSync(PID_FILE, String(process.pid));
// 挂上监听器即覆盖 Node 的默认 SIGTERM 行为 ⇒ 进程不会因此退出（close() 必须升级到 SIGKILL）
if (MODE === 'stubborn') process.on('SIGTERM', () => {});

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const SERVER_INFO = { name: 'fake-mcp', version: '1.0.0' };

function toolsList() {
  return {
    tools: [
      {
        name: 'get-time',
        description: '取当前时间',
        inputSchema: { type: 'object', properties: { tz: { type: 'string' } } },
      },
      // 带 `.` —— 顺带让上游的归一化路径也走到（`read.file` → `read_file`）
      { name: 'read.file', inputSchema: { type: 'object' } },
    ],
  };
}

function handle(msg) {
  if (LOG_FILE) appendFileSync(LOG_FILE, `${msg.method}\n`);

  if (msg.method === 'initialize') {
    if (MODE === 'noinit') return;
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: SERVER_INFO,
    });
    if (MODE === 'die') setTimeout(() => process.exit(7), 10);
    return;
  }

  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    if (MODE === 'die') return; // 手都不伸：让进程退出把这条在途请求拒掉
    if (MODE === 'logline') process.stdout.write('not json, just a log line\n');
    if (MODE === 'badtools') {
      reply(msg.id, { tools: 'nope, not an array' });
      return;
    }
    if (MODE === 'split') {
      const text = `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: toolsList() })}\n`;
      process.stdout.write(text.slice(0, 20));
      setTimeout(() => process.stdout.write(text.slice(20)), 15);
      return;
    }
    reply(msg.id, toolsList());
    return;
  }

  if (msg.method === 'tools/call') {
    if (MODE === 'iserror') {
      reply(msg.id, { isError: true, content: [{ type: 'text', text: 'boom from server' }] });
      return;
    }
    reply(msg.id, { content: [{ type: 'text', text: `called ${msg.params.name}` }] });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
