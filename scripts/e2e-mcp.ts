/**
 * D1 真端到端证明：**真 MCP server** → stdio JSON-RPC 连接器 → `mcpTools()` →
 * `createApp` 菜单 → 真跑一轮 run（模型经 MCP 工具拿到真实时区时间）。
 *
 * 为什么单独一个脚本（不并进 `npm run e2e`）：它优先接**第三方 server**
 * （`uvx mcp-server-time`，需要网络/uv），离线机器会自动回落到本地夹具
 * `scripts/mcp-fixture-server.py`（同一套协议面）。分开跑，CI 的 8 步链不受影响。
 *
 * 顺带把 D2（scriptedClient）与 D3（metricsSink）在最真实的场景里用一遍。
 *
 * 跑法：npm run e2e:mcp        （可用 MCP_SERVER_CMD="python3 scripts/mcp-fixture-server.py" 指定 server）
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, mcpTools, metricsSink, scriptedClient, SystemPrompt } from '../src/index.js';
import type { McpClientLike, McpToolInfo, ScriptedStep } from '../src/index.js';

const metrics = metricsSink();
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// ───────────────────────────── stdio 连接器 ─────────────────────────────
// 真连接器属于独立可选包 @migor/mcp（框架零依赖）；这段是「最小可用的那一份」，
// 保留在仓库里作为端到端证明 —— 也顺便说明连接器到底要做什么。
function stdioMcpClient(cmd: string[]): { client: McpClientLike; close(): void; proc: ChildProcess } {
  const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // server 的日志行（非 JSON）忽略
      }
      if (typeof msg.id !== 'number') continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  });

  const raw = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const notify = (method: string, params: unknown): void => {
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  // 握手：initialize → notifications/initialized（后续请求都等它完成）
  const ready = raw('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agentia-e2e', version: '0.0.0' },
  }).then(() => notify('notifications/initialized', {}));

  const request = async (method: string, params: unknown): Promise<unknown> => {
    await ready;
    return raw(method, params);
  };

  return {
    proc,
    close: () => proc.kill(),
    client: {
      async listTools(): Promise<McpToolInfo[]> {
        const r = (await request('tools/list', {})) as { tools?: McpToolInfo[] };
        return r.tools ?? [];
      },
      async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const r = (await request('tools/call', { name, arguments: args })) as {
          isError?: boolean;
          content?: unknown;
        };
        // 约定：协议层 isError 由连接器转成抛错（否则模型看不到失败）
        if (r?.isError) {
          throw new Error(`MCP 工具 ${name} 返回 isError: ${JSON.stringify(r.content).slice(0, 200)}`);
        }
        return r;
      },
    },
  };
}

async function pickServer(): Promise<{ cmd: string[]; label: string }> {
  const fromEnv = process.env.MCP_SERVER_CMD;
  if (fromEnv) return { cmd: fromEnv.split(' '), label: `${fromEnv}（来自 MCP_SERVER_CMD）` };

  const uvx = ['uvx', 'mcp-server-time'];
  try {
    const probe = stdioMcpClient(uvx);
    const tools = await probe.client.listTools();
    probe.close();
    if (tools.length > 0) {
      return { cmd: uvx, label: `${uvx.join(' ')}（第三方 server，${tools.length} 个工具）` };
    }
  } catch (e) {
    console.log(`  ! uvx mcp-server-time 不可用（${e instanceof Error ? e.message : String(e)}），回落夹具 server`);
  }
  return { cmd: ['python3', 'scripts/mcp-fixture-server.py'], label: '本地夹具 MCP server（离线兜底）' };
}

// ───────────────────── 从 tool_result 里抠出 MCP 的真实回答 ─────────────────────
/** 主循环把 MCP 返回对象 stringify 进 tool_result.content（见 engine/loop.ts 的 limit/stringifySafe 链路） */
function mcpTextFrom(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const carrier = messages.find(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>)[0]?.type === 'tool_result',
  );
  if (!carrier) return undefined;
  const block = (carrier.content as Array<{ content: string; is_error: boolean }>)[0];
  if (block.is_error) throw new Error(`MCP 工具调用被记为 is_error：${block.content}`);
  // tool_result.content 本身是 JSON 字符串 → 解析回 MCP 的 result 对象
  const outer = JSON.parse(block.content) as { content?: Array<{ text?: string }> };
  return outer.content?.[0]?.text;
}

/** 归一化的期望值（与 integrations/mcp.ts 的规则一致：非 [A-Za-z0-9_] → '_'） */
function expectExposed(raw: string): string {
  return `mcp_time_${raw.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/** doctor 只做静态体检（不 import 用户代码）—— 造一个登记了 MCP 单元的项目，看它认不认 */
function doctorDemo(): void {
  const cli = join(process.cwd(), 'packages', 'cli', 'dist', 'cli.js');
  if (!existsSync(cli)) {
    console.log('  ! 跳过 doctor 演示（先 npm run build:cli）');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'agentia-mcp-'));
  mkdirSync(join(dir, 'units', 'mcp-time'), { recursive: true });
  writeFileSync(
    join(dir, 'units', 'mcp-time', 'index.ts'),
    [
      "import { mcpTools } from '@migor/agentia';",
      "import type { AgentTool, McpClientLike } from '@migor/agentia';",
      '',
      '/** MCP server 的工具经 mcpTools() 映射成框架的 AgentTool[]（装配时塞进 AppOptions.tools） */',
      'export class McpTimeUnit {',
      '  private readonly client: McpClientLike;',
      '  constructor(client: McpClientLike) {',
      '    this.client = client;',
      '  }',
      '  async tools(): Promise<AgentTool[]> {',
      "    return mcpTools(this.client, { server: 'time' });",
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'units.ts'),
    [
      "import { McpTimeUnit } from './units/mcp-time/index.js';",
      '',
      'export const providers = [{ provide: \'mcp-time\', useClass: McpTimeUnit }];',
      '',
    ].join('\n'),
  );
  let out = '';
  try {
    out = execFileSync(process.execPath, [cli, 'doctor'], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  console.log('  ── agentia doctor（临时项目）──');
  for (const line of out.trim().split('\n')) console.log(`    ${line}`);
  check('doctor 认到 MCP 单元已登记且入口齐全', /mcp-time：已登记且入口齐全/.test(out));
}

// ───────────────────────────── 主流程 ─────────────────────────────
async function main(): Promise<void> {
  console.log('\n== 1. 起真 MCP server（stdio JSON-RPC）==');
  const { cmd, label } = await pickServer();
  console.log(`  server: ${label}`);
  const mcp = stdioMcpClient(cmd);

  const listed = await mcp.client.listTools();
  check('tools/list 有工具', listed.length > 0, listed.map((t) => t.name).join(', '));

  console.log('\n== 2. mcpTools() 把 server 工具映射进框架菜单 ==');
  const tools = await mcpTools(mcp.client, { server: 'time', timeoutMs: 30_000 });
  const target = listed[0];
  check('映射出 AgentTool[]（条数一致）', tools.length === listed.length);
  check(
    '名字 = prefix + 归一化原名',
    tools[0].name === expectExposed(target.name),
    `${JSON.stringify(target.name)} → ${tools[0].name}`,
  );
  check('inputSchema 原样透传', JSON.stringify(tools[0].inputSchema) === JSON.stringify(target.inputSchema));

  const app = createApp({
    name: 'mcp-e2e',
    system: new SystemPrompt({ version: 'e2e-prompt-v1' }).add(
      'role',
      '你是时间助手，工具名形如 mcp_time_*。',
      true,
    ),
    tools,
    sinks: [metrics],
  });

  console.log('\n== 3. 装配后的主菜单（=「工具进了菜单」）==');
  for (const t of app.tools) console.log(`  · ${t.name}`);
  check('菜单里的工具数与 MCP 工具数一致', app.tools.length === tools.length);

  console.log('\n== 4. 真跑一轮：模型调 MCP 工具 → 真实时区时间回模型 ==');
  let observedText: string | undefined;
  const steps: ScriptedStep[] = [
    {
      id: 'm1',
      model: 'e2e',
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu1', name: tools[0].name, input: { timezone: 'Asia/Shanghai' } }],
    },
    (params) => {
      const msgs = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
      observedText = mcpTextFrom(msgs);
      if (!observedText) throw new Error('第二个回合里没看到 MCP 工具的 tool_result');
      const parsed = JSON.parse(observedText) as { timezone?: string; datetime?: string };
      return {
        id: 'm2',
        model: 'e2e',
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: `${parsed.timezone} 现在是 ${parsed.datetime}` }],
      };
    },
  ];

  const { result } = await app.run([{ role: 'user', content: '上海现在几点？' }], {
    client: scriptedClient(steps),
  });

  check('run 正常收尾', result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);
  check(
    'MCP 返回了真实时区时间',
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(observedText ?? ''),
    observedText?.split('\n').join(' '),
  );
  console.log(`  finalText: ${result.finalText}`);
  check('最终答案带上了 MCP 的时间', /Asia\/Shanghai 现在是 /.test(result.finalText));

  const root = result.trace.spans.find((s) => s.spanId === result.trace.rootSpanId)!;
  const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
  check('run 根记了 system.version（D4）', root.attributes['system.version'] === 'e2e-prompt-v1');
  check(
    'turn 上记了 MCP 原名（D1 审计 / 回放要用它回调 server）',
    turn.attributes['mcp.tool'] === target.name,
    `mcp.tool=${String(turn.attributes['mcp.tool'])}`,
  );
  const toolOut = turn.events.find((e) => e.name === 'tool.output')!;
  check('tool.output 事件记账成功', (toolOut.body as { ok: boolean }).ok === true);

  console.log('\n== 5. metricsSink（D3）从这次 run 派生的 Prometheus 文本 ==');
  const metricsText = metrics.render();
  console.log(
    metricsText
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  const snap = metrics.snapshot();
  check('metrics 记到了这次 run', snap.runs === 1 && snap.failed === 0, JSON.stringify(snap));
  check('metrics 记到了 token（20+8+30+12=70）', snap.tokens === 70, `tokens=${snap.tokens}`);
  check('metrics 记到了耗时样本', /agentia_run_duration_ms_count 1/.test(metricsText));

  console.log('\n== 6. agentia doctor 认不认这个 MCP 单元 ==');
  doctorDemo();

  mcp.close();
  console.log(`\n${failures === 0 ? '✅ D1/D2/D3/D4 真端到端证明全绿' : `❌ ${failures} 项失败`}\n`);
  if (failures > 0) process.exitCode = 1;
}

await main();
