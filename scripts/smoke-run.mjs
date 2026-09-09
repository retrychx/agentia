// Turn 1 冒烟：SystemPrompt 缓存布局 + executeRun 生命周期（mock，不联网）。
import { SystemPrompt, executeRun } from '../dist/index.js';

const assert = (cond, msg) => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

// —— SystemPrompt 缓存布局 ——
const sp = new SystemPrompt()
  .add('role', '你是图片流水线主 agent。', true)
  .add('skills', '可调度 regenerate-logo 等。', true)
  .add('clock', '当前时间: {now}', false); // volatile，每次不同

const plain = sp.build({ cache: false });
assert(typeof plain === 'string' && plain.includes('当前时间'), 'plain build 应为拼接文本');

const cached = sp.build({ cache: true });
assert(Array.isArray(cached) && cached.length === 2, 'cache 布局: 稳定块 + volatile 块');
const [stable, volatile] = cached;
assert(stable.type === 'text' && stable.cache_control?.type === 'ephemeral', '稳定块应有 ephemeral breakpoint');
assert(stable.text.includes('主 agent') && !stable.text.includes('当前时间'), '稳定块不含 volatile');
assert(volatile.type === 'text' && !volatile.cache_control && volatile.text.includes('当前时间'), 'volatile 在 breakpoint 后、无标记');

// —— executeRun：捕获真实传给 SDK 的 system ——
let captured = null;
const client = {
  messages: {
    stream: (params) => {
      captured = params;
      return {
        on() {},
        finalMessage: async () => ({
          id: 'm1',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 512 },
          content: [{ type: 'text', text: '完成' }],
        }),
      };
    },
  },
};

const { run, result } = await executeRun({
  system: cached, // 同一引用，验证引擎原样透传
  messages: [{ role: 'user', content: '生成 logo' }],
  client,
});

assert(run.status === 'succeeded', `run.status=${run.status}`);
assert(run.runId === run.recorder.traceId, 'runId == recorder.traceId');
assert(result.trace.traceId === run.runId, 'traceId == runId');
if (captured.system !== cached) {
  console.log('DEBUG captured.system =', JSON.stringify(captured.system));
  console.log('DEBUG cached           =', JSON.stringify(cached));
  console.log('DEBUG same-by-json     =', JSON.stringify(captured.system) === JSON.stringify(cached));
  throw new Error(`SMOKE FAIL: engine system 不是同一引用`);
}
assert(result.finalText === '完成', 'finalText');
assert(run.result?.trace.totalUsage.cacheCreationTokens === 512, 'cache creation 已记账');

console.log('SMOKE-RUN PASS');
console.log(JSON.stringify(
  {
    run: { status: run.status, runId: run.runId },
    cacheLayout: { stableTextLen: stable.text.length, volatileAfterBreakpoint: !volatile.cache_control },
    totalUsage: result.trace.totalUsage,
  },
  null,
  2,
));
