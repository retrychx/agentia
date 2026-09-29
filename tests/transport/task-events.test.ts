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

describe('非终态流的缓冲配额（nonTerminalBuffers）—— 挂着不动的任务不再各占一份缓冲', () => {
  it('配额内：非终态流的缓冲都在（replay 拿得到）', () => {
    const s = new TaskEventStreams({ nonTerminalBuffers: 2 });
    s.open('a');
    s.open('b');
    s.push('a', ev(1));
    s.push('b', ev(1));
    assert.deepEqual(
      s.replay('a').events.map((e) => e.index),
      [1],
    );
    assert.deepEqual(
      s.replay('b').events.map((e) => e.index),
      [1],
    );
    assert.equal(s.replay('a').droppedBefore, undefined, '配额内不该有任何缺口');
  });

  it('超配额：最旧的那条被回收**缓冲** —— 表项还在、不是「流结束了」、缺口明示', () => {
    const s = new TaskEventStreams({ nonTerminalBuffers: 1 });
    s.open('a');
    s.push('a', ev(1));
    s.open('b');
    s.push('b', ev(1)); // 第 2 条非终态流开始占配额 ⇒ 最旧的 a 被回收缓冲
    const a = s.replay('a');
    assert.deepEqual(a.events, [], '超出配额 ⇒ 最旧的缓冲被回收');
    assert.equal(a.droppedBefore, 2, '缺口必须明示（droppedBefore = 下一条序号）');
    assert.equal(
      s.has('a'),
      true,
      'a 的表项必须还在 —— 删表项会让恢复段重开 nextIndex=1 的流（Last-Event-ID 从此失配）',
    );
    assert.equal(
      a.done,
      false,
      '回收缓冲不是「这条流结束了」（终态要发 task.end，这里什么都不发）',
    );
    assert.equal(s.replay('b').events.length, 1, 'b 的缓冲留着（较新那条是受益者）');
  });

  it('回收之后的序号**接着走**（不从 1 重来）—— Last-Event-ID 续订的人不会静默失联', () => {
    const s = new TaskEventStreams({ nonTerminalBuffers: 1 });
    s.open('a');
    s.push('a', ev(1)); // 序号 1
    s.open('b');
    s.push('b', ev(1)); // 挤掉 a 的缓冲
    assert.equal(s.replay('a').droppedBefore, 2, '前置条件：a 的缓冲已被回收');
    // 订上 a（顺带保住它的缓冲：有订阅者不回收），实时与回放两路一起看序号
    const got: number[] = [];
    s.subscribe('a', (e) => got.push(e.index));
    s.push('a', ev(2));
    assert.deepEqual(got, [2], '**序号接着走**：从 1 重来会让 Last-Event-ID 永远筛不出东西');
    assert.deepEqual(
      s.replay('a').events.map((e) => e.index),
      [2],
      '缓冲重新积累，起点是 2（历史那段由 droppedBefore 明示）',
    );
    assert.equal(s.replay('a').droppedBefore, 2, '缺口标记不因后续 push 而移动');
  });

  it('终态流不归这个配额管：markDone 之后缓冲留到 LRU 淘汰', () => {
    const s = new TaskEventStreams({ nonTerminalBuffers: 1, retainTerminal: 8 });
    s.open('t');
    s.push('t', ev(1));
    s.markDone('t'); // 已终态 ⇒ 不再计入配额
    s.open('t2');
    s.push('t2', ev(1));
    s.open('t3');
    s.push('t3', ev(1)); // 计数 2 > 配额 1 ⇒ 触发回收
    assert.deepEqual(
      s.replay('t').events.map((e) => e.index),
      [1],
      '终态流的缓冲由 retainTerminal 管：配额回收必须跳过它（「刚跑完就连上来也能重放」是承诺）',
    );
    assert.deepEqual(s.replay('t2').events, [], '被牺牲的是非终态的那条');
    assert.equal(s.replay('t2').droppedBefore, 2);
  });

  it('有订阅者的不回收 ⇒ 被实时读的流多时配额会被突破（取舍，不是漏洞）', () => {
    const s = new TaskEventStreams({ nonTerminalBuffers: 1 });
    s.open('a');
    s.subscribe('a', () => {});
    s.open('b');
    s.subscribe('b', () => {});
    s.push('a', ev(1));
    s.push('b', ev(1));
    assert.equal(s.replay('a').events.length, 1, '正在被读的流不该被抽走数据');
    assert.equal(s.replay('b').events.length, 1, '同上（两条都被读 ⇒ 配额 1 挡不住）');
  });

  it('0 = 不为**没人读的**非终态流留回放缓冲：只做实时，表项与序号都还在', () => {
    const s = new TaskEventStreams({ nonTerminalBuffers: 0 });
    s.open('t');
    s.push('t', ev(1)); // 此刻没人读 ⇒ 缓冲立刻被回收
    const r = s.replay('t');
    assert.deepEqual(r.events, [], '0 ⇒ 没人读的流不留回放缓冲');
    assert.equal(r.droppedBefore, 2, '缺口明示（下一条序号）');
    assert.equal(s.has('t'), true, '表项留着（任务仍在本进程）');
    // 0 **不是**「关掉流」：订上之后照样实时收
    const got: number[] = [];
    s.subscribe('t', (e) => got.push(e.index));
    s.push('t', ev(2));
    assert.deepEqual(got, [2], '实时通道照常');
    // 有订阅者 ⇒ 不抽走正在读的数据，配额 0 也保不住它（这是「不打扰读者」的代价）
    assert.equal(s.replay('t').events.length, 1, '有订阅者时缓冲留着');
  });

  it('坏值构造期抛 TypeError（NaN 会让配额判定恒假 ⇒ 每条缓冲被立刻回收）', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new TaskEventStreams({ nonTerminalBuffers: bad }),
        TypeError,
        `nonTerminalBuffers: ${String(bad)} 必须抛 TypeError`,
      );
    }
    // 0 是合法值（disabled），别把它一起拒了
    assert.doesNotThrow(() => new TaskEventStreams({ nonTerminalBuffers: 0 }));
  });
});
