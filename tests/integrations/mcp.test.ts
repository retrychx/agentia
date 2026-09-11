import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpTools } from '../../src/integrations/mcp.js';
import type { McpClientLike, McpToolInfo } from '../../src/integrations/mcp.js';
import { createApp, runAgent, Tool } from '../../src/index.js';
import type { UnitMiddleware } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/** 记录调用、可脚本化响应的假 MCP client（真连接器在 @migor/mcp，这里只验桥） */
function fakeMcp(
  tools: McpToolInfo[],
  call: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
): { client: McpClientLike; calls: Array<{ name: string; args: Record<string, unknown> }>; listed: () => number } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let listed = 0;
  const client: McpClientLike = {
    async listTools() {
      listed++;
      return tools;
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return call(name, args);
    },
  };
  return { client, calls, listed: () => listed };
}

const OBJ = { type: 'object', properties: { tz: { type: 'string' } } } as const;

describe('mcpTools —— MCP 桥（D1）', () => {
  it('把 tools/list 映射成 AgentTool[]：前缀 + 归一化名，schema 原样透传', async () => {
    const mcp = fakeMcp([
      { name: 'get-time', description: '取当前时间', inputSchema: OBJ },
      { name: 'read.file', inputSchema: { type: 'object' } },
    ]);
    const tools = await mcpTools(mcp.client, { server: 'time' });

    assert.equal(tools.length, 2);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp_time_get_time', 'mcp_time_read_file'],
      '`-` / `.` 一律归一化成 `_`（LLM API 对工具名不友好）',
    );
    assert.equal(tools[0].description, '取当前时间');
    assert.deepEqual(tools[0].inputSchema, OBJ, 'MCP 的 inputSchema 已是 JSON Schema，原样当 input_schema');
    assert.equal(tools[1].description, 'MCP 工具 read.file', '没描述时给一个可读兜底');
  });

  it('prefix / server / prefix:"" 三种前缀形态', async () => {
    const one: McpToolInfo[] = [{ name: 'ping', inputSchema: OBJ }];
    assert.equal((await mcpTools(fakeMcp(one).client)).at(0)!.name, 'mcp_ping');
    assert.equal((await mcpTools(fakeMcp(one).client, { server: 'fs' })).at(0)!.name, 'mcp_fs_ping');
    assert.equal((await mcpTools(fakeMcp(one).client, { prefix: 'x-' })).at(0)!.name, 'x-ping');
    assert.equal(
      (await mcpTools(fakeMcp(one).client, { server: 'fs', prefix: '' })).at(0)!.name,
      'ping',
      'prefix:"" = 不加前缀',
    );
  });

  it('inputSchema 缺失/非对象 → 回落 { type: "object" }（否则 engine 的校验器无从校验）', async () => {
    const tools = await mcpTools(fakeMcp([{ name: 'a' }, { name: 'b', inputSchema: 'nope' as never }]).client);
    assert.deepEqual(tools[0].inputSchema, { type: 'object' });
    assert.deepEqual(tools[1].inputSchema, { type: 'object' });
  });

  it('归一化后撞名 → 装配期直接抛错（不静默留两条同名工具）', async () => {
    const tools = [{ name: 'a-b', inputSchema: OBJ }, { name: 'a.b', inputSchema: OBJ }];
    await assert.rejects(
      () => mcpTools(fakeMcp(tools).client, { server: 's' }),
      /撞名/,
    );
  });

  it('归一化后为空名 / 超长 → 抛错，不静默改名', async () => {
    await assert.rejects(() => mcpTools(fakeMcp([{ name: '  ' }]).client), /空工具名/);
    await assert.rejects(
      () => mcpTools(fakeMcp([{ name: 'x'.repeat(80) }]).client, { server: 'srv' }),
      /不满足 \^\[A-Za-z0-9_-\]\{1,64\}\$/,
    );
  });

  it('listTools 抛错 → 冒泡（装配期就该炸，不拖到运行时）', async () => {
    await assert.rejects(
      () =>
        mcpTools({
          listTools: async () => {
            throw new Error('server 挂了');
          },
          callTool: async () => null,
        }),
      /server 挂了/,
    );
  });
});

describe('mcpTools 接进主循环（D1 e2e 单进程版）', () => {
  it('模型调归一化名 → 桥回调用**原名** → 结果回模型，且原名落进 turn attribute', async () => {
    const mcp = fakeMcp([{ name: 'get-time', description: '取当前时间', inputSchema: OBJ }], async (name, args) => {
      assert.equal(name, 'get-time', '回调 server 必须用原名（归一化名 server 不认识）');
      assert.deepEqual(args, { tz: 'Asia/Shanghai' });
      return { content: [{ type: 'text', text: '2026-09-12T07:30+08:00' }] };
    });
    const tools = await mcpTools(mcp.client, { server: 'time' });

    const { client, seen } = mockClient([
      toolUseMsg('mcp_time_get_time', { tz: 'Asia/Shanghai' }),
      endTurnMsg('现在是 07:30'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: '几点？' }],
      tools,
      client,
    });

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(mcp.calls.length, 1);

    // tool_result 真的带着 MCP 的返回内容回到模型
    // （注意：mockClient 的 seen 存的是 params **引用**，而主循环全程复用同一个
    //  messages 数组 —— 所以收尾后它含全部 4 条，不能取 at(-1)，要按类型找。）
    const second = seen[1] as { messages: Array<{ role: string; content: unknown }> };
    const carrier = second.messages.find(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>)[0]?.type === 'tool_result',
    )!;
    const toolResult = carrier.content as Array<{ content: string; is_error: boolean }>;
    assert.match(toolResult[0].content, /2026-09-12T07:30\+08:00/);
    assert.equal(toolResult[0].is_error, false);

    // 原名落进发起调用的 turn attribute（审计 / 回放靠它还原成 server 认识的名字）
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(turn.attributes['mcp.tool'], 'get-time');
  });

  it('MCP 调用抛错 → tool_result 记 is_error，run 继续（与本地工具抛错同语义）', async () => {
    const mcp = fakeMcp([{ name: 'boom', inputSchema: OBJ }], async () => {
      throw new Error('server 内部错误');
    });
    const tools = await mcpTools(mcp.client, { server: 's' });
    const { client } = mockClient([toolUseMsg('mcp_s_boom', {}), endTurnMsg('换路')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });

    assert.equal(result.stopReason, 'end_turn', 'MCP 失败不该杀 run');
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false);
    assert.match(String((out.body as { content: string }).content), /server 内部错误/);
  });

  it('桥自带超时（timeoutMs）→ 该条 is_error 且消息可诊断，不杀 run', async () => {
    const mcp = fakeMcp([{ name: 'hang', inputSchema: OBJ }], () => new Promise(() => {}));
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 20 });
    const { client } = mockClient([toolUseMsg('mcp_s_hang', {}), endTurnMsg('放弃')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });

    assert.equal(result.stopReason, 'end_turn');
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false);
    assert.match(String((out.body as { content: string }).content), /调用超时（超过 20ms）/);
  });

  it('timeoutMs 非正数 = 不限（旧行为）', async () => {
    const mcp = fakeMcp([{ name: 'slow', inputSchema: OBJ }], async () => ({ ok: true }));
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 0 });
    const { client } = mockClient([toolUseMsg('mcp_s_slow', {}), endTurnMsg('done')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });
    assert.equal(result.stopReason, 'end_turn');
  });

  it('MCP 工具与 @Tool 同处一个命名空间：撞名由装配期查重拦下（同一套规则，不另立机制）', async () => {
    const mcp = fakeMcp([{ name: 'echo', inputSchema: OBJ }], async () => 'mcp');
    const tools = await mcpTools(mcp.client, { prefix: '' }); // 不加前缀 → 与本地 echo 撞名

    class Local {
      @Tool({ name: 'echo', description: '本地的 echo', schema: OBJ })
      echo(): string {
        return 'local';
      }
    }
    const providers = [{ provide: 'local', useClass: Local }];
    assert.equal(createApp({ system: 'x', providers }).tools.length, 1, '单独装配正常');

    assert.throws(
      () => createApp({ system: 'x', providers, tools }),
      /菜单单元重名.*echo/,
      'MCP 工具与本地 @Tool 同名 → 装配期就炸，不留歧义菜单',
    );
  });

  it('AppOptions.tools 走同一套中间件链（裸工具不是旁路）', async () => {
    const mcp = fakeMcp([{ name: 'ping', inputSchema: OBJ }], async () => 'pong');
    const tools = await mcpTools(mcp.client, { server: 's' });
    const seen: string[] = [];
    const spy: UnitMiddleware = async (call, next) => {
      seen.push(call.unit.name);
      return next();
    };
    const app = createApp({ system: 'x', tools, middleware: [spy] });

    const out = await app.tools[0].run({});
    assert.deepEqual(seen, ['mcp_s_ping'], '中间件必须看到 MCP 工具');
    assert.equal(out, 'pong');
  });

  it('裸工具与 provider 单元同池后，重名查重也管它们（两方向都拦）', async () => {
    const mcp = fakeMcp([{ name: 'dup', inputSchema: OBJ }], async () => 1);
    const tools = await mcpTools(mcp.client, { prefix: '' });
    class P {
      @Tool({ name: 'dup', description: 'd', schema: OBJ })
      dup(): number {
        return 2;
      }
    }
    assert.throws(() => createApp({ system: 'x', providers: [{ provide: 'p', useClass: P }], tools }), /重名/);
  });
});
