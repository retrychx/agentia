// 真机示例：npm run build && node examples/live.mjs
// 需要 ANTHROPIC_API_KEY（或先 `ant auth login`）。
import { runAgent } from '../dist/index.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('未检测到 ANTHROPIC_API_KEY。请在 Claude Code 里用 `! export ANTHROPIC_API_KEY=sk-...` 设置后重跑。');
  process.exit(0);
}

const res = await runAgent({
  system: '你是助手。需要城市信息时用工具。',
  messages: [{ role: 'user', content: '伦敦天气怎么样？' }],
  tools: [
    {
      name: 'get_weather',
      description: '查询某城市天气',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      run: () => '18°C，多云',
    },
  ],
  runName: 'live.demo',
});

console.log('\n=== result ===');
console.log('stopReason :', res.stopReason);
console.log('finalText  :', res.finalText);
console.log('error      :', res.error?.message ?? '(none)');
console.log('\n=== trace ===');
console.log('traceId(=runId):', res.trace.traceId);
console.log('totalUsage     :', JSON.stringify(res.trace.totalUsage));
for (const s of res.trace.spans) {
  const ev = s.events.map((e) => e.name).join(',');
  console.log(`  ${s.kind.padEnd(9)} ${s.name}  ${s.status}  ${(s.endedAt - s.startedAt)}ms  events[${ev}]`);
}
