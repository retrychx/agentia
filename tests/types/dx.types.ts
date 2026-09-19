/*
 * DX 类型测试（**只做类型检查，不运行** —— 文件名不是 *.test.ts，node:test 不会收）。
 *
 * 由 `npm run typecheck:tests` 校验。断言方式：`@ts-expect-error` 标在「应当报错」的
 * 下一行 —— 若哪天不再报错，tsc 会以 2578（未使用的 @ts-expect-error）把测试判失败。
 * 这样「补全/校验生效」与「将来不静默失效」两头都被钉住。
 */
import {
  createApp,
  createBudgetGuard,
  createStdioMcpConnector,
  createStreamableHttpMcpConnector,
  defineEval,
  executeRun,
  fromZod,
  mcpTools,
  metricsSink,
  RunContext,
  scriptedClient,
  SystemPrompt,
  Tool,
} from '../../dist/index.js';
import type {
  AgentTool,
  BlackboardKey,
  EvalReport,
  JsonSchema,
  McpClientLike,
  McpConnector,
  MetricsSink,
  MetricsSnapshot,
  Provider,
  Trace,
  TraceSink,
  Usage,
} from '../../dist/index.js';

/* ================= ④a：Blackboard 声明合并 → 键补全 + 拼写检查 + 值类型 ================= */

declare module '../../dist/index.js' {
  interface Blackboard {
    profile: { name: string; vip: boolean };
    turnCount: number;
  }
}

function blackboardChecks(): void {
  const ctx = RunContext.current()!;

  // 字面量键 → 值类型自动推导
  const p: { name: string; vip: boolean } | undefined = ctx.get('profile');
  const n: number | undefined = ctx.get('turnCount');
  ctx.set('turnCount', 1);
  ctx.set('profile', { name: 'a', vip: true });
  // keys() 是键联合数组（字面量有补全）
  const keys: ('profile' | 'turnCount')[] = ctx.keys();
  void [p, n, keys];

  // @ts-expect-error 键不存在 → 编译期报错（拼写检查）
  ctx.get('profil');
  // @ts-expect-error 值类型不符 → 编译期报错
  ctx.set('turnCount', 'one');
  // @ts-expect-error 值类型不符（缺 vip 字段）→ 编译期报错
  ctx.set('profile', { name: 'a' });

  // 动态键：按文档断言 BlackboardKey（逃生口，不报错）
  const dynamicKey: string = 'profile';
  ctx.get(dynamicKey as BlackboardKey);
}

async function blackboardSeedChecks(): Promise<void> {
  const app = createApp({ system: new SystemPrompt().add('role', 'r', true) });
  const msgs = [{ role: 'user' as const, content: 'q' }];
  await app.run(msgs, { blackboard: { turnCount: 1 } });
  await app.run(msgs, { blackboard: { profile: { name: 'a', vip: true }, turnCount: 2 } });
  // @ts-expect-error 种子键不存在 → 编译期报错
  await app.run(msgs, { blackboard: { nope: 1 } });
}

/* ================= ④b：resultSchema 推导 result.typed ================= */

const WEATHER: JsonSchema = { type: 'object', properties: { city: { type: 'string' } } };

async function typedResultChecks(): Promise<void> {
  const schema = fromZod<{ city: string }>(WEATHER, { safeParse: () => ({ success: true }) });
  const msgs = [{ role: 'user' as const, content: 'q' }];

  // executeRun：typed 推导为 { city: string } | undefined
  const r = await executeRun({ messages: msgs, resultSchema: schema });
  const city: { city: string } | undefined = r.result.typed;
  void city;
  // @ts-expect-error typed 是 { city: string }，不是 string
  const wrong: string | undefined = r.result.typed;
  void wrong;

  // app.run：同款推导
  const app = createApp({ system: new SystemPrompt().add('role', 'r', true) });
  const out = await app.run(msgs, { resultSchema: schema });
  const city2: { city: string } | undefined = out.result.typed;
  void city2;

  // fromZod 不带泛型 → typed 回落 unknown（旧行为）
  const loose = await executeRun({ messages: msgs, resultSchema: fromZod(WEATHER, {}) });
  const u: unknown = loose.result.typed;
  void u;

  // 裸 JsonSchema（旧写法）→ 同样回落 unknown
  const raw = await executeRun({ messages: msgs, resultSchema: WEATHER });
  const u2: unknown = raw.result.typed;
  void u2;
}

/* ================= ④c：schema 驱动 @Tool 方法签名校验 ================= */

class TypedTools {
  // fromZod<T> 明确了 T → 方法签名与之一致即通过
  @Tool({ description: 'd', schema: fromZod<{ city: string }>(WEATHER, {}) })
  get_city(input: { city: string }): string {
    return input.city;
  }
}
void TypedTools;

class MismatchedTools {
  // @ts-expect-error 方法入参与 fromZod<T> 的 T 不一致 → 编译期报错（不用手写泛型）
  @Tool({ description: 'd', schema: fromZod<{ city: string }>(WEATHER, {}) })
  get_city(input: { city: number }): string {
    return String(input.city);
  }
}
void MismatchedTools;

class LooseTools {
  // 裸 JsonSchema → 入参回落 any，不校验（旧行为，保持兼容）
  @Tool({ description: 'd', schema: WEATHER })
  anything(input: { whatever_at_all: boolean }): void {}
}
void LooseTools;

class UntypedFromZodTools {
  // fromZod 未给 <T> → 同样不校验（回落 any，保持兼容）
  @Tool({ description: 'd', schema: fromZod(WEATHER, {}) })
  anything(input: { still_whatever: boolean }): void {}
}
void UntypedFromZodTools;

/* ================= 附带：Provider 工厂的形参逆变修正 ================= */

const providerChecks: Provider[] = [
  { provide: 'cfg', useValue: { v: 1 } },
  // 修复前 useFactory 声明为 (...deps: unknown[]) 会拒掉这个带类型形参的工厂
  { provide: 'svc', useFactory: (cfg: { v: number }) => ({ cfg }), deps: ['cfg'] },
];
void providerChecks;

/* 让上面的函数/类都被引用，避免 noUnusedLocals 类告警（当前未开，留个兜底） */
void [blackboardChecks, blackboardSeedChecks, typedResultChecks];

/* ============ ⑤ D 期：MCP 桥 / evals / 指标 / 提示词版本 ============ */

async function dPhaseTypeChecks(): Promise<void> {
  const msgs = [{ role: 'user' as const, content: 'q' }];

  /* D1：duck-typed 结构面 —— 任何带 listTools/callTool 的对象都能当 MCP client（零 SDK 依赖） */
  const okClient: McpClientLike = {
    listTools: async () => [{ name: 'x', description: 'd' }],
    callTool: async (_n: string, _a: Record<string, unknown>) => ({ content: [] }),
  };
  // @ts-expect-error 少了 callTool → 不满足结构面
  const badClient: McpClientLike = { listTools: async () => [] };
  void badClient;

  /* D1：mcpTools 的产物直接进 AppOptions.tools（裸工具缝，与 @Tool 能力同池） */
  const tools: AgentTool[] = await mcpTools(okClient, { server: 'time', timeoutMs: 1000 });
  createApp({ system: new SystemPrompt().add('role', 'r', true), tools });
  // @ts-expect-error tools 要的是 AgentTool[]（name/description/inputSchema/run 一个不能少）
  createApp({ system: new SystemPrompt().add('role', 'r', true), tools: [{ name: 'x' }] });

  /* ⑨ 内置连接器：两者都返回 McpConnector（= McpClientLike + close()），可直接喂 mcpTools */
  const stdioConn: McpConnector = createStdioMcpConnector(['uvx', 'mcp-server-time'], {
    stderr: 'ignore',
    timeoutMs: 5_000,
  });
  const httpConn: McpConnector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
    headers: { authorization: 'Bearer t' },
  });
  const connTools: AgentTool[] = await mcpTools(stdioConn, { server: 'time' });
  void [connTools, httpConn];
  // @ts-expect-error 只有 listTools/callTool（= McpClientLike）不算 McpConnector —— 还缺 close()
  const missingClose: McpConnector = okClient;
  void missingClose;
  // @ts-expect-error cmd 必须是字符串数组
  createStdioMcpConnector('uvx');
  // @ts-expect-error url 必须是字符串
  createStreamableHttpMcpConnector({ url: 'x' });

  /* D2：scriptedClient 满足 ModelClient；defineEval 的 expect 拿到推导后的 typed */
  const evalReport: Promise<EvalReport> = defineEval<{ ok: boolean }>({
    name: 'e',
    app: () => createApp({ system: new SystemPrompt().add('role', 'r', true) }),
    cases: [{ name: 'c', input: 'a', client: scriptedClient([{ id: 'm', content: [] }]) }],
    expect: (r, ctx) => {
      const typed: { ok: boolean } | undefined = r.typed;
      const trace = ctx.trace;
      void [typed, trace];
      // @ts-expect-error typed 是 { ok: boolean } | undefined，不是 string
      const bad: string | undefined = r.typed;
      void bad;
    },
  }).run();
  void evalReport;

  /* D3：metricsSink 天然满足 TraceSink（能力零新出口），并额外给出 snapshot/render */
  const asSink: TraceSink = metricsSink();
  const metrics: MetricsSink = metricsSink({ windowSize: 8, prefix: 'myapp_' });
  const snap: MetricsSnapshot = metrics.snapshot();
  const text: string = metrics.render();
  void [asSink, snap, text];
  // @ts-expect-error export 只认 'prometheus' | 'otlp'
  metricsSink({ export: 'statsd' });

  /* D4：提示词版本 —— SystemPrompt({ version })，引擎级选项 systemVersion */
  const sp = new SystemPrompt({ version: 'v1' });
  const v: string | undefined = sp.version;
  void v;
  // @ts-expect-error version 只读
  sp.version = 'v2';
  // @ts-expect-error version 必须是 string
  void new SystemPrompt({ version: 1 });
  await executeRun({ messages: msgs, systemVersion: 'v1' });
  // @ts-expect-error systemVersion 必须是 string
  await executeRun({ messages: msgs, systemVersion: 1 });
}

/* ================= 成本护栏：check 入参收窄**不破坏既有调用方** ================= */

function budgetGuardTypeChecks(): void {
  const g = createBudgetGuard({ maxTotalTokens: 10 });
  const totalUsage: Usage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const trace: Trace = { traceId: 't', rootSpanId: 'r', spans: [], status: 'ok', totalUsage };

  // ① 廉价视图：只给 totalUsage —— 引擎侧走的就是这个形态（不拷 spans）
  g.check({ totalUsage });

  // ② **兼容性**：整份 Trace 结构上满足入参 ⇒ 既有调用方（传整份 trace）不受影响。
  //    这条是「收窄不是破坏性变更」的**全部依据**，所以在这里钉住它。
  g.check(trace);

  // ③ 反向：入参里没有 totalUsage 必须报错（否则收窄就白收了）
  // @ts-expect-error 入参必须有 totalUsage
  g.check({});
  // ④ 反向：`spans` 不在入参里 —— 护栏**在类型上就读不到**它
  //    （「check 只看 totalUsage」这条口径从注释变成了结构约束）
  // @ts-expect-error 对象字面量多出 spans
  g.check({ spans: [], totalUsage });
}
void budgetGuardTypeChecks;

void dPhaseTypeChecks;
