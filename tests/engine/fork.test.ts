import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { TraceRecorder, forkMessages, traceToMessages } from '../../src/index.js';
import type { Trace } from '../../src/index.js';

/**
 * 主循环 3 回合（第 1 回合含 tool 往返）+ 第 2 回合内嵌一个子 agent 回合：
 * run
 * ├─ llm.turn#1（主，model-a）：search 一次 tool 往返
 * ├─ llm.turn#2（主，model-a）
 * │  └─ capability「helper」（子 agent）
 * │     └─ llm.turn（子，model-b）
 * └─ llm.turn#3（主，model-a）：纯文本收尾
 */
function buildTrace(): Trace {
  const r = new TraceRecorder();
  const root = r.begin('run', 'app', null);

  const t1 = r.begin('llm.turn', 'model-a', root);
  r.event(t1, 'tool.input', { tool: 'search', input: JSON.stringify({ q: 'x' }) });
  r.event(t1, 'tool.output', { tool: 'search', ok: true, content: '搜索结果' });
  r.end(t1);

  const t2 = r.begin('llm.turn', 'model-a', root);
  const capability = r.begin('capability', 'helper', t2);
  const tc = r.begin('llm.turn', 'model-b', capability);
  r.end(tc);
  r.end(capability);
  r.end(t2);

  const t3 = r.begin('llm.turn', 'model-a', root);
  r.end(t3);

  r.end(root);
  return r.snapshot('ok');
}

type Block = { type: string; text?: string; name?: string };

function blocks(m: Anthropic.MessageParam): Block[] {
  return (Array.isArray(m.content) ? m.content : []) as Block[];
}

/** 全部消息里的 `[replay turn …]` 回合标注 */
function turnNotes(msgs: Anthropic.MessageParam[]): string[] {
  return msgs
    .flatMap((m) => blocks(m))
    .filter((b) => b.type === 'text' && b.text?.includes('[replay turn'))
    .map((b) => b.text!);
}

describe('forkMessages（分叉重放）', () => {
  it('atTurn=1：只剩第 1 回合（含其 tool 往返），第 2/3 回合与子 agent 回合消失', () => {
    const trace = buildTrace();
    const msgs = forkMessages(trace, {
      atTurn: 1,
      append: [{ role: 'user', content: '改写后的新问题' }],
    });

    // fork 头（user）+ 第 1 回合 assistant（标注 + tool_use）+ user（tool_result 与 append 合并）
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );

    // 首条是 fork 头：带溯源信息（traceId + atTurn + 总回合数）
    const head = String(blocks(msgs[0])[0].text);
    assert.ok(head.includes('[fork]'));
    assert.ok(head.includes(trace.traceId));
    assert.ok(head.includes('前 1/3 回合'));

    // 只有第 1 回合被展开；第 2/3 回合与子 agent 回合（model-b）不出现
    const notes = turnNotes(msgs);
    assert.equal(notes.length, 1);
    assert.ok(notes[0].includes('turn 1/1'));
    assert.ok(!notes.some((n) => n.includes('model-b')));

    // tool 往返保留：assistant 带 tool_use，紧随的 user 带 tool_result
    assert.equal(blocks(msgs[1]).filter((b) => b.type === 'tool_use').length, 1);
    assert.equal(blocks(msgs[2]).filter((b) => b.type === 'tool_result').length, 1);

    // append 拼在分叉点之后：末条就是它（与 tool_result 同属末尾 user）
    assert.equal(msgs[msgs.length - 1].role, 'user');
    assert.ok(blocks(msgs[2]).some((b) => b.type === 'text' && b.text === '改写后的新问题'));
  });

  it('atTurn=0：没有任何回合，消息 = fork 头 + append', () => {
    const trace = buildTrace();
    const msgs = forkMessages(trace, {
      atTurn: 0,
      append: [{ role: 'user', content: '从头换说法' }],
    });

    // fork 头与 append 都是 user，规整合并为一条
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user'],
    );
    const texts = blocks(msgs[0]).map((b) => b.text);
    assert.ok(texts[0]!.includes('[fork]'));
    assert.ok(texts[0]!.includes('前 0/3 回合'));
    assert.equal(texts[1], '从头换说法');
    assert.equal(turnNotes(msgs).length, 0);
  });

  it('atTurn=0 且不追加：只剩 fork 头一条 user', () => {
    const msgs = forkMessages(buildTrace(), { atTurn: 0 });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.ok(String(blocks(msgs[0])[0].text).includes('[fork]'));
  });

  it('atTurn=2：截断点之前的子 agent 嵌套回合保留（是历史的一部分）', () => {
    const msgs = forkMessages(buildTrace(), { atTurn: 2 });
    const notes = turnNotes(msgs);
    // 展开的是 t1、t2 与 t2 内嵌的子 agent 回合（tc）；t3 消失
    assert.equal(notes.length, 3);
    assert.ok(notes[2].includes('model=model-b'));
    assert.ok(notes[2].includes('capability=helper'));
    // 末条非 user（t2 无 tool 对、无 append）→ 补一条 fork 收尾 user（合成消息 content 为 string）
    assert.equal(msgs[msgs.length - 1].role, 'user');
    assert.ok(String(msgs[msgs.length - 1].content).includes('请继续'));
  });

  it('越界 atTurn 抛可读错误（带回合总数）：≥ 回合数 / 负数 / 非整数', () => {
    const trace = buildTrace();
    assert.throws(() => forkMessages(trace, { atTurn: 3 }), /主循环共 3 回合/);
    assert.throws(() => forkMessages(trace, { atTurn: -1 }), /主循环共 3 回合/);
    assert.throws(() => forkMessages(trace, { atTurn: 1.5 }), /主循环共 3 回合/);
  });

  it('无主循环回合的 trace：任何 atTurn 都抛错', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    r.end(root);
    assert.throws(() => forkMessages(r.snapshot('ok'), { atTurn: 0 }), /主循环共 0 回合/);
  });

  it('traceToMessages 行为不受 fork 影响（同一 trace 两种入口并存）', () => {
    const trace = buildTrace();
    // traceToMessages 仍展开全部 4 个 llm.turn（3 主 + 1 嵌套）
    const all = traceToMessages(trace);
    assert.equal(turnNotes(all).length, 4);
    assert.ok(String(all[0].content).includes('[replay]'));
    // fork 与 replay 互不干扰：fork 之后再 replay 结果不变
    forkMessages(trace, { atTurn: 1 });
    assert.deepEqual(traceToMessages(trace), all);
  });
});
