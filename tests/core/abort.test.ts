import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combineSignals } from '../../src/core/abort.js';

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
});
