import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, createApp, SystemPrompt, scriptedClient, Tool } from '../../src/index.js';
// 模块级件（不进公共导出面，与 transport/task-events 同款）：用例直接引模块
import { resolveTraceLimits } from '../../src/engine/tracer.js';

/**
 * 记账的数量闸（`traceLimits.maxEvents`，spec §9.4 的答案里「让少记了数据可数」那一半）。
 *
 * 守两件事：**上限真的生效**（不是设了没用），且**少记的部分可数**（不是静默丢）。
 * 坏值那条守的是「设了但没生效」这个具体事故形态（NaN 会让 `>=` 恒假 ⇒ 闸门形同不存在）。
 */

/** 直接对 recorder 造事件：本文件关心的是闸门与计数，不关心事件语义 */
function fill(r: TraceRecorder, n: number): void {
  const root = r.begin('run', 'app', null);
  for (let i = 0; i < n; i++) r.event(root, 'x', i);
}

describe('traceLimits.maxEvents（事件总量闸）', () => {
  it('缺省（不设）= 不限：全量记账（本框架的承诺）', () => {
    const r = new TraceRecorder();
    fill(r, 50);
    const trace = r.snapshot('ok');
    const events = trace.spans[0]!.events;
    assert.equal(events.length, 50);
    assert.equal(
      events.some((e) => e.name === 'trace.truncated'),
      false,
      '没超限却写了截断摘要 —— 会让人以为数据不全',
    );
  });

  it('超限即停止记账，并写一笔带计数的 trace.truncated（不静默）', () => {
    const r = new TraceRecorder({ maxEvents: 3 });
    fill(r, 10);
    const trace = r.snapshot('ok');
    const events = trace.spans[0]!.events;
    const trunc = events.find((e) => e.name === 'trace.truncated');
    assert.ok(trunc, '超限了却没有截断摘要 —— 使用者会以为 trace 是完整的');
    assert.deepEqual(trunc.body, { droppedEvents: 7, limit: 3 }, '计数与实际丢弃数对不上');
    assert.equal(events.filter((e) => e.name === 'x').length, 3, '上限没生效');
  });

  it('maxEvents: 0 = 一条都不记，但计数是全部（0 是有意义的值）', () => {
    const r = new TraceRecorder({ maxEvents: 0 });
    fill(r, 4);
    const trace = r.snapshot('ok');
    const events = trace.spans[0]!.events;
    assert.equal(events.filter((e) => e.name === 'x').length, 0);
    assert.deepEqual(events.find((e) => e.name === 'trace.truncated')?.body, { droppedEvents: 4, limit: 0 });
  });

  it('闸门只影响事件，不影响 span 与 usage 记账（token 计量走 span 字段）', () => {
    const r = new TraceRecorder({ maxEvents: 0 });
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'm', root);
    r.event(turn, 'tool.output', 'x'.repeat(9999));
    r.end(turn, {
      usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    r.end(root, { status: 'ok' });
    const trace = r.snapshot('ok');
    assert.equal(trace.spans.length, 2, 'span 记账被闸门影响了');
    assert.equal(trace.totalUsage.inputTokens, 7, 'usage 记账被闸门影响了');
  });

  it('坏值在 run 入口抛 TypeError（NaN 会让 `>=` 恒假 ⇒ 闸门形同不存在）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '3', null]) {
      assert.throws(
        () => resolveTraceLimits({ maxEvents: bad }, 'agentia'),
        TypeError,
        `坏值没拦住：${String(bad)}`,
      );
    }
    assert.throws(() => resolveTraceLimits('nope', 'agentia'), TypeError);
    assert.equal(resolveTraceLimits(undefined, 'agentia'), undefined, '不传 = 不限');
    assert.deepEqual(resolveTraceLimits({}, 'agentia'), {}, '空对象 = 不限');
    assert.deepEqual(resolveTraceLimits({ maxEvents: 0 }, 'agentia'), { maxEvents: 0 });
  });

  it('端到端：app.run 的 traceLimits 生效（走 createApp 的选项链）', async () => {
    const obj = { type: 'object', properties: {}, additionalProperties: false } as const;
    class T {
      @Tool({ description: '甲', schema: obj })
      alpha(): string {
        return 'a';
      }
    }
    const app = await createApp({
      name: 'limits-e2e',
      system: new SystemPrompt().add('role', '助手。', true),
      providers: [{ provide: 't', useClass: T }],
      toolSources: ['t'],
      traceLimits: { maxEvents: 1 },
    });
    const { result } = await app.run([{ role: 'user', content: '跑' }], {
      client: scriptedClient([
        {
          id: 's1',
          model: 'claude-opus-5',
          stop_reason: 'tool_use' as const,
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tu1', name: 'alpha', input: {} }],
        },
        {
          id: 's2',
          model: 'claude-opus-5',
          stop_reason: 'end_turn' as const,
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: '完' }],
        },
      ] as never),
    });
    assert.equal(result.stopReason, 'end_turn');
    const all = result.trace!.spans.flatMap((s) => s.events);
    const trunc = all.find((e) => e.name === 'trace.truncated');
    assert.ok(trunc, '应用级 traceLimits 没生效（事件一个都没被挡住）');
    assert.ok(
      (trunc.body as { droppedEvents: number }).droppedEvents > 0,
      '丢弃计数为 0 —— 计数与实际不符',
    );
  });
});
