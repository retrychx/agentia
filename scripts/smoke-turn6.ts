// Turn 6 冒烟：@Skill + @Prompt 单元 / 菜单重名静态校验 / 文件宿主耐久 + 重启续跑 / AGENTIA_MODEL。
// A) @Skill：scripted client 下 app.run 触发 compose_tagline —— 方法体执行（读到 blackboard token）+ 内部
//    ctx.llm() 开一个受限子运行（unit 下 llm.turn 子孙）→ 产物以 tool_result 回流主上下文。
// B) @Prompt：方法版（volatile 实例绑定）+ static 版都进菜单；直接调 prompt tool.run 返回文本。
// C) 静态校验：tool 与 skill 同名 → createApp 抛「菜单单元重名」（跨类型共用命名空间）。
// D) FileTaskStore：写 tmp JSONL → 新实例读回（换宿主还原）→ AsyncRunner.resumePending() 续跑 queued 到 succeeded。
// E) resolveDefaultModel：AGENTIA_MODEL 优先、缺省 claude-opus-5、显式入参优先。
// 运行：npm run smoke:turn6（tsx 直接跑源码）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Skill,
  Prompt,
  Tool,
  createApp,
  SystemPrompt,
  RunContext,
  FileTaskStore,
  AsyncRunner,
  resolveDefaultModel,
  type SkillContext,
} from '../src/index.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

// ============ A) @Skill 端到端：主 agent 调 skill → 方法体 + ctx.llm() 受限子运行 ============
const ROLE = new SystemPrompt().add('role', '你是流水线主 agent。需要文案时调用 compose_tagline。', true);

class ContentStage {
  @Skill({
    name: 'compose_tagline',
    description: '两步文案：脚本控制流程，先用 ctx.llm 想一句再加工成产物',
    schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      additionalProperties: false,
    },
  })
  async compose_tagline(input: { topic: string }, ctx: SkillContext): Promise<string> {
    // 方法体是确定性脚本：读 run 上下文 + 一次受限模型调用，中间结果不外泄，只回产物
    const token = RunContext.current()?.get<string>('authToken') ?? 'none';
    const step = await ctx.llm({ prompt: `给「${input.topic}」一句话卖点` });
    return `COMPOSED[${input.topic}] => ${step.text} (token=${token})`;
  }
}

const skillApp = createApp({
  name: 'skill-e2e',
  providers: [{ provide: 'content', useClass: ContentStage }],
  system: ROLE,
});
assert(
  JSON.stringify(skillApp.tools.map((t) => t.name)) === JSON.stringify(['compose_tagline']),
  `skill 菜单应为 [compose_tagline]，实际=${skillApp.tools.map((t) => t.name)}`,
);

const captured: any[] = [];
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const responses = [
  () => ({
    id: 's0', model: 'claude-opus-5', stop_reason: 'tool_use' as const, usage,
    content: [{ type: 'tool_use', id: 'tu-s', name: 'compose_tagline', input: { topic: 'T' } }],
  }),
  () => ({
    id: 's1', model: 'claude-opus-5', stop_reason: 'end_turn' as const, usage,
    content: [{ type: 'text', text: '卖点句' }],
  }),
  () => ({
    id: 's2', model: 'claude-opus-5', stop_reason: 'end_turn' as const, usage,
    content: [{ type: 'text', text: '完成' }],
  }),
];
const skillClient = {
  messages: {
    stream: (params: any) => {
      captured.push(params);
      const r = responses.shift()!();
      return { on() {}, finalMessage: async () => r };
    },
  },
};

const { run, result } = await skillApp.run([{ role: 'user', content: '给 T 出个卖点' }], {
  client: skillClient as any,
  blackboard: { authToken: 'tok-9' },
});
assert(run.status === 'succeeded', `run.status=${run.status}`);
assert(result.finalText === '完成' && result.stopReason === 'end_turn', '主 agent 应正常收尾');
assert(captured.length === 3, `应 3 次模型调用（主2+内1），实际=${captured.length}`);

// —— trace：run → llm.turn(main) → unit(skill) → llm.turn(ctx.llm 受限子运行) → llm.turn(main) ——
const spans = result.trace.spans;
const root = spans.find((s) => s.kind === 'run')!;
const turns = spans.filter((s) => s.kind === 'llm.turn');
const unit = spans.find((s) => s.kind === 'unit')!;
assert(turns.length === 3, `期望 3 llm.turn，实际=${turns.length}`);
const mainTurn = turns.find((s) => s.parentSpanId === root.spanId)!;
assert(unit.name === 'compose_tagline' && unit.attributes?.skill === 'compose_tagline',
  `unit 应带 skill 属性，实际=${JSON.stringify(unit.attributes)}`);
assert(unit.parentSpanId === mainTurn.spanId, 'skill unit 应挂在主 turn 下');
const inner = turns.filter((s) => s.parentSpanId === unit.spanId);
assert(inner.length === 1, `ctx.llm() 应恰好开 1 个受限子运行（unit 下 llm.turn），实际=${inner.length}`);

// —— 产物回流：方法体返回值以 tool_result 进主上下文（含 blackboard 经 ALS 可见的证明） ——
const mainFinal = JSON.stringify(captured[2].messages);
assert(mainFinal.includes('COMPOSED[T]') && mainFinal.includes('卖点句'),
  'skill 产物应以 tool_result 回流主 agent');
assert(mainFinal.includes('token=tok-9'), 'skill 方法体应在 run 内经 ALS 读到 blackboard token');

// ============ B) @Prompt：方法版（volatile 绑定实例）+ static 版 ============
class BrandPrompts {
  private ver = 'v1';

  @Prompt({ description: '一份本地写作的使用指南（每次调用现算 → 新鲜）' })
  writing_guide(_input?: unknown): string {
    return `writing-guide(${this.ver})`;
  }

  @Prompt({ description: '品牌基调资产（静态常量）' })
  static brand_style(_input?: unknown): string {
    return '扁平 + 水彩渐变';
  }
}
const promptApp = createApp({
  name: 'prompt-demo',
  providers: [{ provide: 'brand', useClass: BrandPrompts }],
  system: ROLE,
});
const promptNames = promptApp.tools.map((t) => t.name).sort();
assert(
  JSON.stringify(promptNames) === JSON.stringify(['brand_style', 'writing_guide']),
  `prompt 菜单应为 [brand_style, writing_guide]，实际=${promptNames}`,
);
const guide = promptApp.tools.find((t) => t.name === 'writing_guide')!;
const brand = promptApp.tools.find((t) => t.name === 'brand_style')!;
assert((await guide.run({})) === 'writing-guide(v1)', '方法版 prompt 应绑定实例现算（volatile）');
assert((await brand.run({})) === '扁平 + 水彩渐变', 'static 版 prompt 应返回常量文本');

// ============ C) 菜单重名静态校验（tool 与 skill 共用命名空间） ============
class TWeather {
  @Tool({
    description: '查询天气',
    schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  })
  get_weather(_input: { city: string }): string {
    return '18°C';
  }
}
class SkStage {
  @Skill({ description: '一个跟工具撞名的 skill' })
  async get_weather(): Promise<void> { /* 不执行 */ }
}
let dupMsg = '';
try {
  createApp({
    name: 'dup-app',
    providers: [
      { provide: 'wx', useClass: TWeather },
      { provide: 'stage', useClass: SkStage },
    ],
    system: ROLE,
  });
} catch (e) {
  dupMsg = (e as Error).message;
}
assert(dupMsg.includes('菜单单元重名') && dupMsg.includes('get_weather'),
  `重名应抛「菜单单元重名…get_weather」，实际=${dupMsg}`);

// ============ D) FileTaskStore：换宿主还原 + resumePending 重启续跑 ============
const dir = mkdtempSync(join(tmpdir(), 'agentia-'));
const file = join(dir, 'tasks.jsonl');
const calls: string[][] = [];
const fakeApp = {
  name: 'fs-app',
  async run(messages: any[]) {
    calls.push(messages);
    return {
      run: { runId: 'r-resume', status: 'succeeded' as const },
      result: { finalText: 'ok', stopReason: 'end_turn' as const, iterations: 1, trace: { traceId: 'r-resume', spans: [], totalUsage: {} } },
    };
  },
};
let finalStatus = 'unset';
try {
  // 宿主 A：submit 后进程“崩溃” —— 只留下一条 queued 记录在磁盘（手动 save 模拟 crash 前一刻）
  const storeA = new FileTaskStore(file);
  storeA.save({
    taskId: 'task_resume',
    status: 'queued',
    idempotencyKey: 'ik-resume',
    spec: { messages: [{ role: 'user', content: '持久续跑' }], source: 'manual' },
    createdAt: Date.now(),
  });

  // 宿主 B（新进程等价物）：new FileTaskStore 从同一文件还原记录
  const storeB = new FileTaskStore(file);
  assert(storeB.get('task_resume')?.status === 'queued', '新实例应从 JSONL 还原 queued 记录');
  assert(storeB.byIdempotency('ik-resume')?.taskId === 'task_resume', '幂等键映射也应还原');

  // resumePending 把 queued 续跑到终态（换宿主不换语义：AsyncRunner 逻辑零改动）
  const runnerB = new AsyncRunner(fakeApp as any, { store: storeB });
  const resumed = runnerB.resumePending();
  assert(resumed === 1, `应续跑 1 个 pending 任务，实际=${resumed}`);
  const done = await runnerB.awaitTask('task_resume', { timeoutMs: 3000 });
  assert(done.status === 'succeeded', `续跑应到 succeeded，got=${done.status}`);
  assert(done.runId === 'r-resume' && done.result?.finalText === 'ok', '续跑结果应落库');
  assert(calls.length === 1 && calls[0][0].content === '持久续跑', '续跑应把原 spec.messages 交给 app');
  finalStatus = runnerB.list()[0].status;
  assert(runnerB.list().length === 1 && finalStatus === 'succeeded', '列表应为单条终态');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ============ E) resolveDefaultModel：AGENTIA_MODEL 优先 → claude-opus-5 缺省 → 显式入参优先 ============
const prevModel = process.env.AGENTIA_MODEL;
process.env.AGENTIA_MODEL = 'deepseek-v4-flash';
assert(resolveDefaultModel() === 'deepseek-v4-flash', 'AGENTIA_MODEL 应优先');
process.env.AGENTIA_MODEL = '';
assert(resolveDefaultModel() === 'claude-opus-5', '无 env 应回落 claude-opus-5');
assert(resolveDefaultModel('given-model') === 'given-model', '显式入参应最优先');
process.env.AGENTIA_MODEL = prevModel;

console.log('SMOKE-TURN6 PASS');
console.log(JSON.stringify(
  {
    skill: {
      menu: skillApp.tools.map((t) => t.name),
      unitAttribute: unit.attributes,
      innerTurnsUnderUnit: inner.length,
      productReturned: true,
      blackboardVisibleInBody: true,
    },
    prompt: { menu: promptNames, instanceBinding: true, staticConstant: true },
    dupCheck: { throwsOnCollision: dupMsg.length > 0, message: dupMsg },
    persistence: { rehydrated: true, resumed: true, finalStatus },
    defaultModel: { envWins: true, fallback: 'claude-opus-5' },
    spanTree: spans.map((s) => ({
      kind: s.kind,
      name: s.name,
      parent: s.parentSpanId === root.spanId ? 'root' : s.parentSpanId === mainTurn.spanId ? 'mainTurn' : s.parentSpanId === unit.spanId ? 'unit' : '—',
    })),
  },
  null,
  2,
));
