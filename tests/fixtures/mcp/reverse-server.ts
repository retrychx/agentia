/**
 * 反向桥夹具 server（stdio）—— `tests/engine/mcp-server.test.ts` 的 stdio 用例与
 * `scripts/e2e-mcp-server.ts` 共用同一个子进程入口。
 *
 * 刻意走 `createApp` + `@Tool` 真装配（不是手拼 `{ tools }`）：`createMcpServer` 的 app
 * 入参是鸭子类型，「真 AgentApp 满足它」这条只有这么写才真验到（菜单 = 装配后、
 * 过中间件的那份）。
 *
 * stdout 只走协议报文（一行一个 JSON-RPC）；trace 证据经 `jsonlTraceSink` 落盘
 * （`MCP_REVERSE_TRACE_FILE` 给了才写）。
 */
import {
  createApp,
  createMcpServer,
  jsonlTraceSink,
  SystemPrompt,
  Tool,
} from '../../../src/index.js';

class Greeter {
  @Tool({
    description: '向某人打招呼',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  })
  say_hello(input: { name: string }): string {
    return `你好，${input.name}`;
  }

  @Tool({ description: '回显一个对象（验非 string 结果的映射）', schema: { type: 'object' } })
  echo_object(input: { n?: number }): { ok: boolean; n: number } {
    return { ok: true, n: input.n ?? 0 };
  }

  @Tool({ description: '总是失败（验 isError 映射）', schema: { type: 'object' } })
  fail_tool(): string {
    throw new Error('夹具工具炸了');
  }
}

const app = createApp({
  name: 'mcp-reverse-fixture',
  system: new SystemPrompt().add('role', '夹具', true),
  providers: [{ provide: 'greeter', useClass: Greeter }],
});

const traceFile = process.env.MCP_REVERSE_TRACE_FILE;
createMcpServer(app, {
  transport: 'stdio',
  name: 'reverse-fixture',
  ...(traceFile ? { sinks: [jsonlTraceSink({ path: traceFile })] } : {}),
});
