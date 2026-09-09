// Turn 2 冒烟：@Tool 装饰器 → collectTools → DI → createApp → executeRun，
// 并验证 RunContext 经 AsyncLocalStorage 透入工具执行体。
// 运行：npm run smoke:turn2（tsx 直接跑源码，走标准装饰器语义）
import {
  Tool,
  collectTools,
  createApp,
  SystemPrompt,
  Container,
  RunContext,
  executeRun,
} from '../src/index.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

// —— 一个会读 run 上下文的工具类 ——
class WeatherTools {
  // 工具名缺省取方法名 —— 建议 snake_case，模型侧最稳
  @Tool({
    description: '查询城市天气',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
  })
  get_weather(input: { city: string }): string {
    // 不接收 ctx 参数——直接从 ALS 取当前 run
    const token = RunContext.current()?.get<string>('authToken');
    return `city=${input.city};token=${token ?? 'none'}`;
  }

  @Tool({
    name: 'ping',
    description: '连通性自检，返回 pong',
    schema: { type: 'object', properties: {}, additionalProperties: false },
  })
  async ping(): Promise<string> {
    return 'pong';
  }
}

// —— 装饰器 → AgentTool ——
const instance = new WeatherTools();
const toolList = collectTools(instance);
const names = toolList.map((t) => t.name).sort();
assert(JSON.stringify(names) === JSON.stringify(['get_weather', 'ping']), `工具菜单=${names}`);

// —— 直接调用的 run 绑定了 this + schema ——
const gw = toolList.find((t) => t.name === 'get_weather')!;
assert(gw.description.includes('城市'), 'description 透传');
assert(gw.inputSchema.type === 'object' && gw.inputSchema.strict === undefined, 'schema 透传');
const out = await gw.run({ city: 'Paris' });
assert(typeof out === 'string' && out.includes('city=Paris'), `run 出参=${out}`);
assert(out.includes('token=none'), 'run 外调用时 RunContext.current() 应为 undefined');
assert(RunContext.current() === undefined, 'run 外 current() 应为 undefined');

// —— DI 容器：value / class / factory ——
const di = new Container().register(
  { provide: 'who', useValue: 'agent' },
  { provide: 'greeting', useFactory: (w: string) => `hi ${w}`, deps: ['who'] },
  { provide: 'weather', useClass: WeatherTools },
);
assert(di.resolve<string>('greeting') === 'hi agent', 'factory + deps 解析');
assert(di.resolve('weather') === di.resolve('weather'), 'class 单例缓存');
try {
  di.resolve('missing');
  assert(false, '未注册 token 应抛错');
} catch {
  /* 预期 */
}

// —— createApp：装配工具菜单 ——
const app = createApp({
  name: 'weather-app',
  providers: [
    { provide: 'weather', useClass: WeatherTools },
    { provide: 'key', useValue: { auth: 'cfg' } }, // 无 @Tool 的 provider 不产出工具
  ],
  system: new SystemPrompt().add('role', '你是天气助手，只能查询天气。', true),
});
assert(app.tools.length === 2, `app.tools=${app.tools.map((t) => t.name)}`);
assert(app.container.resolve('key').auth === 'cfg', '容器实例可经 app.container 取');

// —— mock 模型：第 1 次要求调 get_weather，第 2 次 end_turn ——
let secondParams: unknown = null;
let i = 0;
const script = [
  () => ({
    id: 'm1',
    model: 'claude-opus-5',
    stop_reason: 'tool_use' as const,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    content: [{ type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: '上海' } }],
  }),
  (params: unknown) => {
    secondParams = params;
    return {
      id: 'm2',
      model: 'claude-opus-5',
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: '上海 72°F sunny.' }],
    };
  },
];
const client = {
  messages: {
    stream: (params: unknown) => ({ on() {}, finalMessage: async () => script[i++](params) }),
  },
};

const { run, result } = await app.run([{ role: 'user', content: '上海天气如何?' }], {
  client,
  blackboard: { authToken: 'sk-12345' },
});

// —— 断言 ——
assert(run.status === 'succeeded', `run.status=${run.status}`);
assert(result.finalText.includes('上海'), `finalText=${result.finalText}`);
assert(result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);

// 第二次发给模型的 messages 里应含 tool_result —— 证明容器实例真的执行了方法，
// 且工具在 run 内通过 RunContext.current() 读到了 blackboard 种子。
const s = JSON.stringify(secondParams);
assert(s.includes('tool_result'), '第二次请求应带 tool_result');
assert(s.includes('sk-12345'), `工具应读到 blackboard token；secondParams=${s}`);
assert(s.includes('city=上海') || s.includes('上海'), 'tool_result 内容应含模型入参城市');

assert(RunContext.current() === undefined, 'run 结束后 current() 应回落 undefined');

console.log('SMOKE-TURN2 PASS');
console.log(JSON.stringify(
  {
    tools: app.tools.map((t) => ({ name: t.name, strict: t.strict ?? false })),
    run: { status: run.status, runId: run.runId },
    toolResultReachedModel: s.includes('sk-12345'),
    totalUsage: result.trace.totalUsage,
  },
  null,
  2,
));
