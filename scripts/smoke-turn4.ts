// Turn 4 冒烟：长上下文三策略 —— compaction / context editing / 预算护栏。
// 上半场：纯函数断言（trimToolPairs 保留最近对、compactMessages 角色交替合法 + 不拆对）；
// 下半场：端到端预算策略 —— 大 tool_result 把消息顶过小预算 → 触发编辑/压缩 →
// 断言旧结果被折叠成摘要、最近结果仍保留、run 根上打了 context.budget 事件。
// 运行：npm run smoke:turn4（tsx 直接跑源码）
import {
  defaultEstimateTokens,
  estimateMessages,
  trimToolPairs,
  compactMessages,
  createBudgetPolicy,
  runAgent,
  type AgentTool,
} from '../src/index.js';
import type Anthropic from '@anthropic-ai/sdk';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

// 角色交替合法性：相邻两条 role 不能相同（user…user / assistant…assistant 均非法）
const assertAlternating = (msgs: Anthropic.MessageParam[], label: string): void => {
  for (let i = 1; i < msgs.length; i++) {
    assert(msgs[i].role !== msgs[i - 1].role, `${label}: 位置 ${i - 1}/${i} 角色不交替 ${msgs[i - 1].role}→${msgs[i].role}`);
  }
};

// —— 工具消息构造小助手 ——
const assistantTool = (id: string, name: string, input: unknown): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input }],
});
const toolResult = (id: string, content: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content }],
});
const userText = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text });
const assistantText = (text: string): Anthropic.MessageParam => ({ role: 'assistant', content: text });

// ============ 上半场：纯函数 ============

// defaultEstimateTokens 是字符/4 的上取整；estimateMessages 含 role/block 开销
assert(defaultEstimateTokens('abcd') === 1, `4字符→1 token, got=${defaultEstimateTokens('abcd')}`);
assert(defaultEstimateTokens('') === 1, `空串下取 1 token, got=${defaultEstimateTokens('')}`);
{
  // user=ceil(4/4)=1 + 内容'12345678'=2 ; assistant=ceil(9/4)=3 + 内容'x'=1 → 7
  const msgs = [userText('12345678'), assistantText('x')];
  const n = estimateMessages(msgs);
  assert(n === 7, `estimateMessages 应计 role 开销+内容, got=${n}`);
}

// —— trimToolPairs：keepRecent=1 时丢最旧对、保最近对、不拆最近对 ——
{
  const msgs: Anthropic.MessageParam[] = [
    userText('任务开始'),
    assistantTool('tu0', 'emit', { tag: 't0' }),
    toolResult('tu0', 'DATA:t0:0000'),
    assistantTool('tu1', 'emit', { tag: 't1' }),
    toolResult('tu1', 'DATA:t1:1111'),
  ];
  const out = trimToolPairs(msgs, { keepRecent: 1 });
  assert(out !== msgs, '发生裁剪时应返回新数组');
  assert(out.length === 3, `裁剪后应剩 3 条(任务+最近对), got=${out.length}`);
  const s = JSON.stringify(out);
  assert(!s.includes('DATA:t0'), '最旧工具对 t0 应被丢弃');
  assert(s.includes('DATA:t1'), '最近工具对 t1 应保留');
  assert(s.includes('任务开始'), '非工具的用户开场应保留');
  assertAlternating(out, 'trimToolPairs');
}

// —— compactMessages：cut 落在 tool_result 上 → 整对后移，不拆散最近对 ——
{
  const msgs: Anthropic.MessageParam[] = [
    userText('q0'),
    assistantTool('a', 'emit', { tag: 'a' }),
    toolResult('a', 'RA'),
    assistantTool('b', 'emit', { tag: 'b' }),
    toolResult('b', 'RB'),
    assistantText('我快说完了'),
  ];
  // 6 条、keepRecent=2 → cut=4（正好落在 tool_result 'RB' 上）→ 后移一位，
  // 使 [asst b, RB] 整对落入保留段，asst 不与其 tool_result 拆开
  const out = await compactMessages(msgs, {
    keepRecent: 2,
    summarize: async () => '(旧工具对已折叠)',
  });
  const s = JSON.stringify(out);
  assert(s.includes('[此前对话摘要]'), '应含摘要标记');
  assert(s.includes('(旧工具对已折叠)'), '摘要内容应到位');
  assert(!s.includes('RA'), '最旧工具结果 RA 应被折叠进摘要');
  // 最近工具对 b 完整保留且相邻（tool_use 后紧跟其 tool_result）
  const bIdx = out.findIndex((m) => JSON.stringify(m.content).includes('"tag":"b"'));
  assert(bIdx >= 0, '最近工具用 b 应保留');
  assert(bIdx + 1 < out.length && out[bIdx + 1].role === 'user'
    && JSON.stringify(out[bIdx + 1].content).includes('RB'), 'b 的 tool_result 应紧跟其后');
  assert(out[out.length - 1].role === 'assistant', '末条角色应合法');
  assertAlternating(out, 'compactMessages(cut落在tool_result)');
}

// —— compactMessages：尾段以普通 user 开头 → 摘要并入首条，不新增重复 user ——
{
  const msgs: Anthropic.MessageParam[] = [
    userText('q0'),
    assistantTool('a', 'emit', { tag: 'a' }),
    toolResult('a', 'RA'),
    assistantText('承接'),
    userText('继续追问：细节?'),
    assistantText('答复'),
  ];
  const out = await compactMessages(msgs, { keepRecent: 2, summarize: async () => '摘要S' });
  const s = JSON.stringify(out);
  assert(s.includes('摘要S'), '摘要应并入或前置');
  assert(s.includes('继续追问'), '首条普通 user 原内容应保留（并入）');
  assert(s.includes('答复'), '最近 assistant 应保留');
  assert(out[0].role === 'user' && out[out.length - 1].role === 'assistant', '首尾角色应合法');
  assertAlternating(out, 'compactMessages(并入普通user)');
}

// ============ 下半场：端到端预算策略 ============

const emitTool: AgentTool = {
  name: 'emit',
  description: '返回一块大数据',
  inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false },
  run(input: { tag: string }): string {
    return `DATA:${input.tag}:${'y'.repeat(1600)}`;
  },
};

// scripted mock：S0→emit t0；S1→emit t1；S2→end_turn。usage 每轮一致。
const captured: any[] = [];
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const responses = [
  () => ({ id: 'm0', model: 'claude-opus-5', stop_reason: 'tool_use' as const, usage,
    content: [{ type: 'tool_use', id: 'tu0', name: 'emit', input: { tag: 't0' } }] }),
  () => ({ id: 'm1', model: 'claude-opus-5', stop_reason: 'tool_use' as const, usage,
    content: [{ type: 'tool_use', id: 'tu1', name: 'emit', input: { tag: 't1' } }] }),
  () => ({ id: 'm2', model: 'claude-opus-5', stop_reason: 'end_turn' as const, usage,
    content: [{ type: 'text', text: '完成' }] }),
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

// 预算压到 300 字符：任意一条 1600 字符的 tool_result 都会顶爆预算
const policy = createBudgetPolicy({
  budgetTokens: 300,
  keepRecent: 2,
  estimateTokens: (t: string) => t.length, // 字符当 token，让触发完全确定
  summarize: async () => '(压缩略：旧工具结果已折叠为摘要)', // 摘要固定，不漏旧 tag
});

const result = await runAgent({
  client: client as any,
  messages: [userText('跑两个 emit 再结束')],
  tools: [emitTool],
  contextPolicy: policy,
});

// —— run 收尾 ——
assert(result.stopReason === 'end_turn', `stopReason=${result.stopReason}`);
assert(result.trace.status === 'ok', `trace.status=${result.trace.status}`);
assert(result.iterations === 3, `应有 3 轮请求, got=${result.iterations}`);

// —— 预算事件：run 根上应至少有一次 context.budget ——
const rootSpan = result.trace.spans.find((s) => s.kind === 'run')!;
const budgetEvents = rootSpan.events.filter((e) => e.name === 'context.budget');
assert(budgetEvents.length >= 1, `run 根应记录 context.budget 事件, got=${budgetEvents.length}`);

// —— 末轮请求：已压缩 —— 旧 t0 折叠成摘要、最近 t1 保留 ——
const finalMsgs = captured[captured.length - 1].messages;
const fs = JSON.stringify(finalMsgs);
assert(fs.includes('[此前对话摘要]'), '末轮请求应含摘要标记');
assert(fs.includes('(压缩略'), '摘要内容应到位');
assert(!fs.includes('DATA:t0') && !fs.includes('"tag":"t0"'), '旧工具对 t0 不应再出现在末轮请求');
assert(fs.includes('DATA:t1'), '最近工具结果 t1 应保留');

console.log('SMOKE-TURN4 PASS');
console.log(JSON.stringify({
  pure: { estimate: true, trimKeepsRecent: true, compactAlternating: true, pairNotSplit: true },
  policy: {
    budgetTokens: policy.budgetTokens,
    budgetEvents: budgetEvents.length,
    iterations: result.iterations,
    finalMsgsLength: finalMsgs.length,
    firstCompactAtTurn: budgetEvents.map((e) => (e.body as any).from ?? '—'),
  },
}, null, 2));
