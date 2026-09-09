// 真机示例：npm run build && node examples/live.mjs
// 认证：ANTHROPIC_API_KEY **或** ANTHROPIC_AUTH_TOKEN 任一即可（SDK 显式传最稳）；
// 可走网关/兼容端点：ANTHROPIC_BASE_URL 已设则自动用（如 DeepSeek 的 Anthropic 兼容端点）。
// 模型：AGENTIA_MODEL > ANTHROPIC_DEFAULT_OPUS_MODEL > claude-opus-5。
// 在你的会话里：`! export ANTHROPIC_AUTH_TOKEN=sk-...` 或直接依赖已配好的 shell 环境。
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../dist/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!apiKey && !authToken) {
  console.log('未检测到 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN。用 `! export ANTHROPIC_AUTH_TOKEN=sk-...` 设置后重跑。');
  process.exit(0);
}
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  ...(apiKey ? { apiKey } : { authToken }),
});
const model =
  process.env.AGENTIA_MODEL ||
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
  'claude-opus-5';

const res = await runAgent({
  client,
  model,
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
