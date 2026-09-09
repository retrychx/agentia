// 真机 skill 示例：npx tsx examples/live-skill.ts（走源码，支持 @Skill 标准装饰器）
// 认证：ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN 任一；ANTHROPIC_BASE_URL 已设则走兼容端点。
// 模型：AGENTIA_MODEL > ANTHROPIC_DEFAULT_OPUS_MODEL > claude-opus-5。
// 演示：@Skill = 代码控制流程 —— 方法体里显式调两次 ctx.llm()（受限子运行，各开 llm.turn），
// 拿中间结果加工后返回结构化产物。为确定性，这里直接注入 ToolRunContext 调 skill 工具
// （等价于主 agent 在 dispatch 里调用它）。
import Anthropic from '@anthropic-ai/sdk';
import {
  Skill,
  SystemPrompt,
  createApp,
  TraceRecorder,
  type SkillContext,
} from '../src/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!apiKey && !authToken) {
  console.log('未检测到 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN，先 export 再跑。');
  process.exit(0);
}
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  ...(apiKey ? { apiKey } : { authToken }),
});
// 演示文案流程不需要重推理模型 —— 优先 flash/sonnet 别名，避免 reasoner 烧满 budget 无 text 收尾
const model =
  process.env.AGENTIA_MODEL ||
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
  'claude-opus-5';

class ContentStage {
  @Skill({
    name: 'compose_tagline',
    description: '为一个产品话题做「中文一句话卖点 + 英文标语」两步文案',
    schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      additionalProperties: false,
    },
    model, // 从 env 解析：让 ctx.llm() 也走同一兼容端点（不回落 claude-opus-5）
    maxTokens: 1600,
  })
  async compose_tagline(input: { topic: string }, ctx: SkillContext): Promise<unknown> {
    // 受限子运行 1：先提炼卖点
    const first = await ctx.llm({
      prompt: `一句话点出「${input.topic}」最打动目标用户的点，限 40 字内。`,
    });
    // 受限子运行 2：拿着上一步结果再改写（代码控制流程 —— 中间结果不外泄，只回产物）
    const second = await ctx.llm({
      prompt: `把下面这句话改写成一句英文标语，轻快幽默：\n${first.text}`,
    });
    return { zh: first.text, en: second.text };
  }
}

const app = createApp({
  name: 'skill-live',
  providers: [{ provide: 'content', useClass: ContentStage }],
  system: new SystemPrompt().add('role', '你是文案流水线。', true),
});

const tool = app.tools.find((t) => t.name === 'compose_tagline');
if (!tool) {
  console.log('菜单里没找到 compose_tagline');
  process.exit(1);
}

// 等价于主 agent dispatch：开 run 根 → 以 ToolRunContext 调 skill
const recorder = new TraceRecorder();
const rootId = recorder.begin('run', 'live.skill', null);
recorder.setAttribute(rootId, 'model', model);
let out: unknown;
let err: unknown;
try {
  out = await tool.run({ topic: '一支给独立开发者的本地笔记工具' }, {
    client,
    recorder,
    parentSpanId: rootId,
  });
  recorder.end(rootId, { status: 'ok' });
} catch (e) {
  err = e;
  recorder.end(rootId, { status: 'error' });
}

console.log('\n=== skill 产物 ===');
console.log(err ? `error: ${(err as Error)?.message}` : JSON.stringify(out, null, 2));

const trace = recorder.snapshot('ok');
console.log('\n=== trace ===');
console.log('traceId(=runId):', trace.traceId);
console.log('totalUsage     :', JSON.stringify(trace.totalUsage));
for (const s of trace.spans) {
  const ev = s.events.map((e) => e.name).join(',');
  console.log(`  ${s.kind.padEnd(9)} ${s.name}  ${s.status}  ${(s.endedAt - s.startedAt)}ms  events[${ev}]`);
}
