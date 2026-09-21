import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskEventStreams } from '../../src/transport/task-events.js';
import type { TraceRecordEvent } from '../../src/index.js';

/** 造一条最简记账事件（本模块只关心「序号与缓冲」，不关心载荷语义） */
const ev = (n: number): TraceRecordEvent => ({
  type: 'span.attribute',
  seq: n,
  spanId: 's',
  key: 'k',
  value: n,
});

describe('TaskEventStreams（每任务事件缓冲 + 订阅表）', () => {
  it('序号从 1 起、单调；replay 给全量；订阅者实时收到', () => {
    const s = new TaskEventStreams();
    s.open('t1');
    const got: number[] = [];
    const off = s.subscribe('t1', (e) => got.push(e.index));
    s.push('t1', ev(1));
    s.push('t1', ev(2));
    assert.deepEqual(got, [1, 2], '订阅者没收到实时事件');
    assert.deepEqual(
      s.replay('t1').events.map((e) => e.index),
      [1, 2],
    );
    off();
    s.push('t1', ev(3));
    assert.deepEqual(got, [1, 2], '退订后还在收');
  });

  it('超上限丢最旧，并把 droppedBefore 告诉订阅方（不静默）', () => {
    const s = new TaskEventStreams({ maxEvents: 3 });
    s.open('t1');
    for (let i = 1; i <= 5; i++) s.push('t1', ev(i));
    const r = s.replay('t1');
    assert.deepEqual(
      r.events.map((e) => e.index),
      [3, 4, 5],
      '丢最旧的语义变了',
    );
    assert.equal(r.droppedBefore, 3, '丢掉的那段没有明示（下游会以为流是完整的）');
    // 从未丢弃时不带这个字段（缺席 = 没截断，与 core/trace.ts 的 links 同一条「缺席不是空」的规则）
    const fresh = new TaskEventStreams();
    fresh.open('t2');
    fresh.push('t2', ev(1));
    assert.equal(fresh.replay('t2').droppedBefore, undefined);
  });

  it('replay(from) 只给该序号之后的（SSE 的 Last-Event-ID / ?from= 语义）', () => {
    const s = new TaskEventStreams();
    s.open('t1');
    for (let i = 1; i <= 4; i++) s.push('t1', ev(i));
    assert.deepEqual(
      s.replay('t1', 2).events.map((e) => e.index),
      [3, 4],
    );
    assert.deepEqual(s.replay('t1', 4).events, []);
    // 畸形 from 当作「从头」（连接方给了个 NaN 不该把流弄空）
    assert.equal(s.replay('t1', Number.NaN).events.length, 4);
  });

  it('markDone 之后：done=true、后续 push 被忽略（流不能「结束之后还有事件」）', () => {
    const s = new TaskEventStreams();
    s.open('t1');
    s.push('t1', ev(1));
    s.markDone('t1');
    s.push('t1', ev(2));
    const r = s.replay('t1');
    assert.equal(r.done, true);
    assert.deepEqual(
      r.events.map((e) => e.index),
      [1],
      '终态后的事件进了流 —— 下游会看到「task.end 之后还有事件」',
    );
  });

  it('open() 复用同一条流（HITL 恢复 / 崩溃重投是同一任务，序号必须接着走）', () => {
    const s = new TaskEventStreams();
    s.open('t1');
    s.push('t1', ev(1));
    s.markDone('t1');
    s.open('t1'); // 恢复段
    s.push('t1', ev(2));
    const r = s.replay('t1');
    assert.equal(r.done, false, '恢复后应重新是「进行中」');
    assert.deepEqual(
      r.events.map((e) => e.index),
      [1, 2],
      '恢复段重开了流（序号从头来）—— 下游的 Last-Event-ID 会错位',
    );
  });

  it('终态流按 LRU 保留最近的 N 条；还挂着订阅者的不丢', () => {
    const s = new TaskEventStreams({ retainTerminal: 2 });
    s.open('a');
    s.markDone('a');
    s.open('b');
    s.markDone('b');
    s.open('c');
    // c 是老任务，先挂一个订阅者（没读完的流不该被丢掉）
    s.subscribe('c', () => {});
    s.markDone('c');
    assert.equal(s.has('a'), false, '最旧的终态流该被丢掉（否则内存被没人看的历史占着）');
    assert.equal(s.has('b'), true);
    assert.equal(s.has('c'), true, '有订阅者的终态流被丢了 —— 下游会莫名断在半路');
  });

  it('订阅者抛错不影响其它订阅者，也不影响记账', () => {
    const s = new TaskEventStreams();
    s.open('t1');
    const ok: number[] = [];
    s.subscribe('t1', () => {
      throw new Error('boom');
    });
    s.subscribe('t1', (e) => ok.push(e.index));
    s.push('t1', ev(1));
    assert.deepEqual(ok, [1]);
    assert.equal(s.replay('t1').events.length, 1);
  });

  it('没开流就 push / 未知任务 replay：不抛、不造流', () => {
    const s = new TaskEventStreams();
    assert.doesNotThrow(() => s.push('nope', ev(1)));
    assert.deepEqual(s.replay('nope'), { events: [], done: false });
    assert.equal(s.subscriberCount('nope'), 0);
  });
});
