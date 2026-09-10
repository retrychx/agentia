import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { TraceRecorder } from '../../src/index.js';
import type { Trace } from '../../src/index.js';
import { traceToMessages } from '../../src/engine/replay.js';

/**
 * 构造一条带 tool 往返 + 子 agent 嵌套的 trace：
 * run
 * ├─ llm.turn#1（主 agent，model-a）：并行调 search/fetch（输出完成序与发起序相反）
 * ├─ unit「researcher」（子 agent）
 * │  └─ llm.turn#2（子 agent，model-b）：submit_result 一回合并
 * └─ llm.turn#3（主 agent，model-a）：纯文本收尾（无工具事件）
 */
function buildTrace(): Trace {
  const r = new TraceRecorder();
  const root = r.begin('run', 'app', null);

  const t1 = r.begin('llm.turn', 'model-a', root);
  r.event(t1, 'tool.input', { tool: 'search', input: JSON.stringify({ q: 'x' }) });
  r.event(t1, 'tool.input', { tool: 'fetch', input: JSON.stringify({ url: 'u'.repeat(5000) }) });
  // 并行工具：输出事件按完成序记录（fetch 先完成），与发起序相反
  r.event(t1, 'tool.output', { tool: 'fetch', ok: true, content: 'F'.repeat(5000) });
  r.event(t1, 'tool.output', { tool: 'search', ok: true, content: '搜索结果' });
  r.end(t1);

  const unit = r.begin('unit', 'researcher', t1);
  r.setAttribute(unit, 'subagent', 'researcher');
  const t2 = r.begin('llm.turn', 'model-b', unit);
  r.event(t2, 'tool.input', { tool: 'submit_result', input: JSON.stringify({ answer: '42' }) });
  r.event(t2, 'tool.output', { tool: 'submit_result', ok: true, content: 'submitted' });
  r.end(t2);
  r.end(unit);

  const t3 = r.begin('llm.turn', 'model-a', root);
  r.end(t3);

  r.end(root);
  return r.snapshot('ok');
}

type Block = { type: string; id?: string; tool_use_id?: string; name?: string; text?: string; content?: unknown; is_error?: boolean; input?: unknown };

function blocks(m: Anthropic.MessageParam): Block[] {
  return (Array.isArray(m.content) ? m.content : []) as Block[];
}

describe('traceToMessages（trace 重放基底）', () => {
  it('role 交替合法、tool_use/tool_result 配对完整、同名优先配对', () => {
    const msgs = traceToMessages(buildTrace());

    // 首条为合成 user（API 硬要求）；随后时序线性化：t1 + tool_result + t2 子 agent + tool_result + t3
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
    );
    assert.ok(String(msgs[0].content).includes('[replay]'));

    // t1：两个 tool_use 按发起序（input 事件序）
    const a1 = blocks(msgs[1]);
    const uses = a1.filter((b) => b.type === 'tool_use');
    assert.deepEqual(uses.map((b) => b.name), ['search', 'fetch']);

    // 每条 tool_use 紧跟的 user 消息里有同 id 的 tool_result（id 全局唯一）
    const u1 = blocks(msgs[2]);
    const results = u1.filter((b) => b.type === 'tool_result');
    assert.deepEqual(
      results.map((b) => b.tool_use_id),
      uses.map((b) => b.id),
    );
    assert.equal(new Set(uses.map((b) => b.id)).size, uses.length);

    // 同名优先配对：输出事件完成序相反，search 仍配对到「搜索结果」
    assert.equal(results[0].content, '搜索结果');
    assert.equal(results[0].is_error, false);
    assert.equal((results[1].content as string).startsWith('F'.repeat(100)), true);
    assert.equal((results[1].content as string).length, 2000 + '…(+3000)'.length); // 缺省 2000 截断

    // 入参 JSON.parse 还原为对象
    assert.deepEqual(uses[0].input, { q: 'x' });

    // t3 纯文本收尾回合：只有标注文本，不跟 user 消息
    assert.deepEqual(blocks(msgs[5]).map((b) => b.type), ['text']);
  });

  it('嵌套 llm.turn 被线性化并标注来源 unit；主 agent 回合标注 run', () => {
    const msgs = traceToMessages(buildTrace());
    const note = (m: Anthropic.MessageParam) => blocks(m).find((b) => b.type === 'text')!.text!;

    assert.ok(note(msgs[1]).includes('model=model-a'));
    assert.ok(note(msgs[1]).includes('unit=(主 agent run)'));
    // 子 agent 回合线性化进同一序列（位置在主 agent 两回合之间），标注来自 researcher
    assert.ok(note(msgs[3]).includes('model=model-b'));
    assert.ok(note(msgs[3]).includes('unit=researcher'));
    assert.ok(note(msgs[5]).includes('turn 3/3'));
  });

  it('maxEventChars 截断生效（入参与出参都截）', () => {
    const msgs = traceToMessages(buildTrace(), { maxEventChars: 100 });
    const uses = blocks(msgs[1]).filter((b) => b.type === 'tool_use');
    // fetch 的 url 入参 5000+ 字符 → 截断后 JSON 不完整，包 {_raw}（tool_use.input 必须是 object）
    const fetchInput = uses[1].input as { _raw: string };
    assert.equal(typeof fetchInput, 'object');
    assert.ok(fetchInput._raw.endsWith('…(+' + (JSON.stringify({ url: 'u'.repeat(5000) }).length - 100) + ')'));

    const results = blocks(msgs[2]).filter((b) => b.type === 'tool_result');
    const fetchOut = results[1].content as string;
    assert.equal(fetchOut, `${'F'.repeat(100)}…(+4900)`);
  });

  it('includeToolIO: false —— 只留标注文本；连续 assistant 合并、首条补 user', () => {
    const msgs = traceToMessages(buildTrace(), { includeToolIO: false });
    // 三个纯文本回合合并为一条 assistant，前置合成 user
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
    assert.deepEqual(
      blocks(msgs[1]).map((b) => b.type),
      ['text', 'text', 'text'],
    );
  });

  it('缺失 tool.output 的 tool_use 补 is_error 占位，配对仍合法', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const t = r.begin('llm.turn', 'model-a', root);
    r.event(t, 'tool.input', { tool: 'search', input: '{}' });
    r.event(t, 'tool.input', { tool: 'explode', input: '{}' });
    r.event(t, 'tool.output', { tool: 'search', ok: true, content: 'ok' }); // explode 无输出（崩溃中断）
    r.end(t);
    r.end(root);

    const msgs = traceToMessages(r.snapshot('ok'));
    const results = blocks(msgs[2]).filter((b) => b.type === 'tool_result');
    assert.equal(results.length, 2);
    assert.equal(results[0].is_error, false);
    assert.equal(results[1].is_error, true);
    assert.ok((results[1].content as string).includes('缺失'));
  });

  it('空 trace（无 llm.turn）→ 空消息序列', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    r.end(root);
    assert.deepEqual(traceToMessages(r.snapshot('ok')), []);
  });
});
