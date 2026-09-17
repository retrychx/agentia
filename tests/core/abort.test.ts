import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { combineSignals, releaseCombinedSignal } from '../../src/core/abort.js';

describe('combineSignals（中断源合成）', () => {
  it('单源中止 → 合成中止', () => {
    const a = new AbortController();
    const c = combineSignals(a.signal);
    assert.equal(c.aborted, false);
    a.abort();
    assert.equal(c.aborted, true);
  });

  it('已中止的源 → 立即中止（不等后续事件）', () => {
    const a = new AbortController();
    a.abort();
    const c = combineSignals(new AbortController().signal, a.signal);
    assert.equal(c.aborted, true);
  });

  it('全 undefined → 永不中止（可用作占位）', () => {
    const c = combineSignals(undefined, undefined);
    assert.equal(c.aborted, false);
  });

  it('多源任一触发即中止', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = combineSignals(a.signal, b.signal);
    b.abort();
    assert.equal(c.aborted, true);
  });

  it('undefined 混入不影响真源', () => {
    const a = new AbortController();
    const c = combineSignals(undefined, a.signal, undefined);
    assert.equal(c.aborted, false);
    a.abort();
    assert.equal(c.aborted, true);
  });

  it('合成中止后：其余源上的监听器立刻摘除（长寿源不累积监听器/闭包）', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = combineSignals(a.signal, b.signal);
    assert.equal(getEventListeners(a.signal, 'abort').length, 1);
    assert.equal(getEventListeners(b.signal, 'abort').length, 1);
    a.abort();
    assert.equal(c.aborted, true);
    assert.equal(
      getEventListeners(b.signal, 'abort').length,
      0,
      'b 上的监听器必须摘掉 —— 否则宿主级共享 signal 每条 run 多挂一个（MaxListenersExceededWarning）',
    );
  });

  it('releaseCombinedSignal：run 正常收尾（没有任何源中止）时主动摘除全部源监听器', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = combineSignals(a.signal, b.signal);
    releaseCombinedSignal(c);
    assert.equal(getEventListeners(a.signal, 'abort').length, 0);
    assert.equal(getEventListeners(b.signal, 'abort').length, 0);
    // 摘除后源中止不再传播（合成 signal 已随 run 结束退役）
    a.abort();
    assert.equal(c.aborted, false);
  });

  it('releaseCombinedSignal 幂等；对非合成 signal 是空操作', () => {
    const a = new AbortController();
    const c = combineSignals(a.signal, new AbortController().signal);
    releaseCombinedSignal(c);
    releaseCombinedSignal(c); // 第二次不抛
    releaseCombinedSignal(new AbortController().signal); // 非合成产物也不抛
    a.abort();
    assert.equal(c.aborted, false);
  });

  it('长寿源复用 12 次：正常收尾 + release 后监听器不累积（修复前会到 12 个）', () => {
    const host = new AbortController();
    for (let i = 0; i < 12; i++) {
      const perRun = new AbortController();
      const c = combineSignals(host.signal, perRun.signal);
      assert.equal(c.aborted, false);
      releaseCombinedSignal(c); // run 正常结束
    }
    assert.equal(getEventListeners(host.signal, 'abort').length, 0);
  });
});

describe('combineSignals 的监听器生命周期', () => {
  it('同一个源传两次 → 只挂一个监听，摘除后不残留', () => {
    // 残留会让宿主级长寿 signal 上按任务数累积监听器（闭包一起滞留）——
    // 正是这段代码声称要防的 MaxListenersExceededWarning。
    const a = new AbortController();
    const b = new AbortController();
    // 同源混在多源里：去重后 a 只挂一个监听；不去重则挂两个，而摘除表按源建（后者覆盖前者）
    // ⇒ 触发后残留一个监听（闭包一起滞留），正是这段代码要防的累积。
    const c = combineSignals(a.signal, a.signal, b.signal);
    assert.equal(getEventListeners(a.signal, 'abort').length, 1, '同源应去重成一个监听');
    a.abort();
    assert.equal(c.aborted, true);
    assert.equal(getEventListeners(a.signal, 'abort').length, 0, '触发并摘除后不得残留');
    assert.equal(getEventListeners(b.signal, 'abort').length, 0, '其余源上的监听也应摘干净');

    // 纯同源两个参数 → 退化成单源快路径（直接复用，不在源上挂任何监听）
    const d = combineSignals(a.signal, a.signal);
    assert.equal(d, a.signal);
  });
});
