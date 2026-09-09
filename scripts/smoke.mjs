// Turn 0 冒烟：不联网，用 scripted mock client 验证 manual loop + trace 记账。
// 运行：npm run build && node scripts/smoke.mjs
import { runAgent } from '../dist/index.js';

// —— scripted mock：第 1 次调用要求调 get_weather，第 2 次 end_turn ——
function makeClient(script) {
  let i = 0;
  return {
    messages: {
      stream: () => ({
        on() {},
        finalMessage: async () => script[i++](),
      }),
    },
  };
}

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 0,
};

const client = makeClient([
  () => ({
    id: 'm1',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    usage,
    content: [{ type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'Paris' } }],
  }),
  () => ({
    id: 'm2',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage,
    content: [{ type: 'text', text: 'Paris: 72°F sunny.' }],
  }),
]);

const res = await runAgent({
  system: 'You are a weather bot. Use the tool.',
  messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      run: (input) => `72°F sunny in ${input.city}`,
    },
  ],
  client,
});

// —— 断言 ——
const assert = (cond, msg) => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};
assert(res.stopReason === 'end_turn', `stopReason=${res.stopReason}`);
assert(res.finalText.includes('sunny'), `finalText=${res.finalText}`);
assert(res.trace.totalUsage.cacheReadTokens === 200, 'cache read tokens should sum over 2 turns');
assert(res.trace.spans.length === 3, `expected 3 spans (run+2 turns), got ${res.trace.spans.length}`);

// 工具调用过 + 事件被记录
const turnWithTool = res.trace.spans.find((s) =>
  s.events.some((e) => e.name === 'tool.input' && e.body.tool === 'get_weather'),
);
assert(turnWithTool, 'tool.input event missing');

console.log('SMOKE PASS');
console.log(JSON.stringify(
  {
    stopReason: res.stopReason,
    finalText: res.finalText,
    totalUsage: res.trace.totalUsage,
    spans: res.trace.spans.map((s) => ({
      kind: s.kind,
      status: s.status,
      usage: s.usage,
      events: s.events.map((e) => e.name),
    })),
  },
  null,
  2,
));
