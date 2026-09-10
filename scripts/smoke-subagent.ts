// 子 agent 冒烟：@SubAgent —— 主 agent 调 reviewer 子 agent；子 agent 在裁剪上下文里
// 再调 get_weather；断言：unit span 层级、上下文裁剪（主对话不可见）、隔离报告
// （子 agent 中间产物不进主上下文）、usage 跨两级聚合。
// 运行：npm run smoke:subagent（tsx 直接跑源码，走标准装饰器语义）
import {
  Tool,
  SubAgent,
  createApp,
  SystemPrompt,
  RunContext,
} from '../src/index.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

// —— 子 agent 内部可用的普通工具（读 run 上下文） ——
class WeatherTools {
  @Tool({
    description: '查询城市天气',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  })
  get_weather(input: { city: string }): string {
    const token = RunContext.current()?.get<string>('authToken');
    return `city=${input.city};token=${token ?? 'none'}`;
  }
}

// —— 声明一个子 agent 单元：reviewer ——
class PipelineModule {
  @SubAgent({
    name: 'reviewer',
    description: '调用评审子 agent，审查给定文档并输出书面评审意见',
    schema: {
      type: 'object',
      properties: { doc: { type: 'string' } },
      required: ['doc'],
      additionalProperties: false,
    },
    system:
      '你是评审 agent。只负责审查入参里的 doc。可调用天气工具确认审查环境。' +
      '结论必须以“审查通过”或“审查不通过”开头。',
    tools: ['weather'], // 子 agent 自己的工具菜单：weather provider 的 @Tool
  })
  reviewer(_input: { doc: string }): void {
    // 方法体不执行 —— 运行时由框架拉起独立 agent 循环
  }
}

// —— 装配：主 agent 菜单 = weather(get_weather) + pipeline(reviewer) ——
const app = createApp({
  name: 'review-pipeline',
  providers: [
    { provide: 'weather', useClass: WeatherTools },
    { provide: 'pipeline', useClass: PipelineModule },
  ],
  system: new SystemPrompt().add('role', '你是流水线主 agent，需要评审时调用 reviewer。', true),
});
const menuNames = app.tools.map((t) => t.name).sort();
assert(
  JSON.stringify(menuNames) === JSON.stringify(['get_weather', 'reviewer']),
  `菜单应为 [get_weather, reviewer]，实际=${menuNames}`,
);

// —— scripted mock：4 次调用 ——
// c0 主 turn1 → 调 reviewer；c1 子 turn1 → 调 get_weather；c2 子 turn2 → end_turn 报告；c3 主 turn2 → end_turn
const captured: any[] = [];
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 0,
};
const responses = [
  () => ({
    id: 'm0', model: 'claude-opus-5', stop_reason: 'tool_use' as const, usage,
    content: [{ type: 'tool_use', id: 'tu-r', name: 'reviewer', input: { doc: 'DRAFT-001 内容…' } }],
  }),
  () => ({
    id: 'm1', model: 'claude-opus-5', stop_reason: 'tool_use' as const, usage,
    content: [{ type: 'tool_use', id: 'tu-w', name: 'get_weather', input: { city: '上海' } }],
  }),
  () => ({
    id: 'm2', model: 'claude-opus-5', stop_reason: 'end_turn' as const, usage,
    content: [{ type: 'text', text: '审查通过：天气上海良好，建议发布。' }],
  }),
  () => ({
    id: 'm3', model: 'claude-opus-5', stop_reason: 'end_turn' as const, usage,
    content: [{ type: 'text', text: '完成' }],
  }),
];
const client = {
  messages: {
    stream: (params: any) => {
      captured.push(params);
      const r = responses.shift()!();
      return { on() {}, finalMessage: async () => r };
    },
  },
};

const { run, result } = await app.run([{ role: 'user', content: '主agent: 请审阅 DRAFT-001' }], {
  client,
  blackboard: { authToken: 'sk-12345' },
});

// —— run 级 ——
assert(run.status === 'succeeded', `run.status=${run.status}`);
assert(result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);
assert(result.finalText === '完成', `finalText=${result.finalText}`);

// —— trace 树：run → llm.turn(main) → unit(reviewer) → {llm.turn×2} → llm.turn(main) ——
const spans = result.trace.spans;
assert(spans.length === 6, `期望 6 spans，实际=${spans.length}`);
const root = spans.find((s) => s.kind === 'run')!;
const turns = spans.filter((s) => s.kind === 'llm.turn');
const unit = spans.find((s) => s.kind === 'unit')!;
assert(turns.length === 4, `期望 4 llm.turn，实际=${turns.length}`);

const mainTurn = turns.find((s) => s.parentSpanId === root.spanId)!;
assert(unit.kind === 'unit' && unit.parentSpanId === mainTurn.spanId,
  'unit(reviewer) 应挂在主 turn 下');
assert(unit.name === 'reviewer' && unit.attributes?.subagent === 'reviewer', 'unit 元数据');

const subTurns = turns.filter((s) => s.parentSpanId === unit.spanId);
assert(subTurns.length === 2, `子 agent 应有 2 个 llm.turn，实际=${subTurns.length}`);

// —— usage 跨两级聚合 ——
assert(result.trace.totalUsage.cacheReadTokens === 400, `cacheRead 应聚合 4 turn×100=${result.trace.totalUsage.cacheReadTokens}`);

// —— 裁剪：子 agent 只见任务，不见主对话 ——
assert(captured[1] !== undefined && !JSON.stringify(captured[1].messages).includes('主agent:'),
  '子 agent 第一条请求不应含主对话历史（裁剪）');
assert(JSON.stringify(captured[1].messages).includes('DRAFT-001'), '子 agent 应看到任务 doc');

// —— 嵌套普通工具在子上下文里真正执行了 + 读到了 blackboard ——
assert(JSON.stringify(captured[2].messages).includes('city=上海'), '子 agent 内部 get_weather 应已执行');
assert(JSON.stringify(captured[2].messages).includes('sk-12345'), '子工具应在 run 内经 ALS 读到 token');

// —— 隔离：主上下文只回流评审报告，不含子 agent 内部 weather 结果 ——
const mainFinalMsgs = JSON.stringify(captured[3].messages);
assert(mainFinalMsgs.includes('审查通过'), '主 agent 应收到 reviewer 最终报告');
assert(!mainFinalMsgs.includes('city=上海') && !mainFinalMsgs.includes('sk-12345'),
  '子 agent 内部 weather 结果不应泄漏进主上下文（隔离）');

console.log('SMOKE-SUBAGENT PASS');
console.log(JSON.stringify(
  {
    menu: menuNames,
    spanTree: spans.map((s) => ({
      kind: s.kind, name: s.name, parent: s.parentSpanId === root.spanId ? 'root' : s.parentSpanId === mainTurn.spanId ? 'mainTurn' : s.parentSpanId === unit.spanId ? 'unit' : '—',
    })),
    isolation: { subContextIsolated: true, reportOnly: true },
    totalUsage: result.trace.totalUsage,
  },
  null,
  2,
));
