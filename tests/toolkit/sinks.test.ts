import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerDefaultTraceSink, SystemPrompt } from '../../src/index.js';
import type { Trace, TraceSink } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

const sys = () => new SystemPrompt().add('role', 'r', true);

/** 收集型 sink：记录收到的 trace */
function collector(): { sink: TraceSink; traces: Trace[] } {
  const traces: Trace[] = [];
  return {
    traces,
    sink: {
      export(t) {
        traces.push(t);
      },
    },
  };
}

describe('registerDefaultTraceSink · 全局默认 sink', () => {
  it('构造前注册 → 该 app 的 run 投递给默认 sink；应用级 sink 与默认 sink 都收到', async () => {
    const def = collector();
    const appLevel = collector();
    registerDefaultTraceSink(def.sink);

    const app = createApp({
      providers: [],
      system: sys(),
      sinks: [appLevel.sink],
    });
    const { client } = mockClient([endTurnMsg('ok')]);
    await app.run([{ role: 'user', content: 'hi' }], { client });

    assert.equal(def.traces.length, 1, '默认 sink 收到 trace');
    assert.equal(appLevel.traces.length, 1, '应用级 sink 收到 trace');
    assert.equal(def.traces[0].traceId, appLevel.traces[0].traceId, '同一次 run');
  });

  it('构造后再注册的默认 sink 不影响已建 app（构造期快照语义）', async () => {
    const before = collector();
    registerDefaultTraceSink(before.sink);

    const app = createApp({ providers: [], system: sys() });

    const after = collector();
    registerDefaultTraceSink(after.sink);

    const { client } = mockClient([endTurnMsg('ok')]);
    await app.run([{ role: 'user', content: 'hi' }], { client });

    assert.equal(before.traces.length, 1, '构造前注册的默认 sink 生效');
    assert.equal(after.traces.length, 0, '构造后注册的默认 sink 不回溯到已建 app');
  });
});
