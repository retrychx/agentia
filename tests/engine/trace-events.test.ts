import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp,
  SystemPrompt,
  TraceRecorder,
  type Span,
  type SpanStatus,
  type Trace,
  type TraceRecordEvent,
  Tool,
  scriptedClient,
} from '../../src/index.js';

/**
 * 增量记账出口（`docs/plans/2026-09-21-incremental-trace-export-and-sampling.md`）。
 *
 * 本文件的核心是**折叠不变量**：把一次 run 的全部 `TraceRecordEvent` 按 `seq` 升序折回
 * 一条 trace，必须**逐字等于**收尾时 `snapshot()` 的那条。它一次钉住四件事 ——
 * 不丢、不重、顺序正确、增量与终态同源。任一处记账点被改成「绕开派发」，这里就红。
 */

/** 按 `core/trace.ts` 的折叠规则把增量事件折回一条 trace（**只读**事件，不碰 recorder 内部） */
function fold(events: TraceRecordEvent[], status: SpanStatus): Trace {
  const byId = new Map<string, Span>();
  const order: string[] = [];
  let rootSpanId = '';
  let traceId = '';
  for (const e of events) {
    if (e.type === 'span.begin') {
      // 与 recorder 的 span 形状一致：begin 快照里的 attributes/events 是空的，之后靠增量事件补
      byId.set(e.span.spanId, { ...e.span, attributes: {}, events: [] });
      order.push(e.span.spanId);
      if (e.span.kind === 'run') rootSpanId = e.span.spanId;
      traceId = e.span.traceId;
      continue;
    }
    const span = byId.get(e.spanId);
    assert.ok(span, `事件指向未知 span：${e.type} → ${e.spanId}`);
    if (e.type === 'span.end') {
      span.endedAt = e.endedAt;
      span.status = e.status;
      if (e.error) span.error = e.error;
      if (e.usage) span.usage = e.usage;
    } else if (e.type === 'span.event') {
      span.events.push(e.event);
    } else if (e.type === 'span.attribute') {
      span.attributes[e.key] = e.value;
    } else {
      // links 是「有才在」的键：只有真的收到 span.link 才创建（与 core/trace.ts 的缺席=空语义一致）
      span.links = [...(span.links ?? []), e.link];
    }
  }
  // totalUsage 的口径 = 各 llm.turn 的自身计量求和（capability 的 usage 是子孙聚合，不重复计入）
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } as {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costEstimate?: number;
  };
  for (const s of byId.values()) {
    if (!s.usage || s.kind !== 'llm.turn') continue;
    total.inputTokens += s.usage.inputTokens;
    total.outputTokens += s.usage.outputTokens;
    total.cacheReadTokens += s.usage.cacheReadTokens;
    total.cacheCreationTokens += s.usage.cacheCreationTokens;
    if (s.usage.costEstimate != null)
      total.costEstimate = (total.costEstimate ?? 0) + s.usage.costEstimate;
  }
  if (total.costEstimate != null) total.costEstimate = Math.round(total.costEstimate * 1e6) / 1e6;
  return {
    traceId,
    rootSpanId,
    spans: order.map((id) => byId.get(id)!),
    status,
    totalUsage: total,
  };
}

const U = { input_tokens: 11, output_tokens: 5 };
const obj = { type: 'object', properties: {}, additionalProperties: false } as const;

class Tools {
  @Tool({ description: '甲', schema: obj })
  alpha(): string {
    return 'a'.repeat(3000); // 越过缺省截断，顺带覆盖「截断后的正文也要进增量流」
  }
  @Tool({ description: '乙', schema: obj })
  beta(): string {
    return 'b';
  }
}

const endTurn = (i: number) => ({
  id: `e${i}`,
  model: 'claude-opus-5',
  stop_reason: 'end_turn' as const,
  usage: U,
  content: [{ type: 'text', text: `第 ${i} 轮` }],
});

async function runWithEvents(opts: { parallel?: boolean; traceContext?: boolean } = {}) {
  const events: TraceRecordEvent[] = [];
  const app = await createApp({
    name: 'trace-events',
    system: new SystemPrompt().add('role', '助手。', true),
    providers: [{ provide: 'tools', useClass: Tools }],
    toolSources: ['tools'],
    onTraceEvent: (e) => events.push(e),
  });
  const { result } = await app.run([{ role: 'user', content: '跑' }], {
    client: scriptedClient([
      // 同一回合两个工具 ⇒ 覆盖并行路径（父子关系与事件交错）
      {
        id: 'p0',
        model: 'claude-opus-5',
        stop_reason: 'tool_use' as const,
        usage: U,
        content: [
          { type: 'tool_use', id: 'tu0', name: 'alpha', input: {} },
          { type: 'tool_use', id: 'tu1', name: 'beta', input: {} },
        ],
      },
      endTurn(0),
    ] as never),
    ...(opts.parallel ? { maxToolConcurrency: 2 } : {}),
    ...(opts.traceContext
      ? { traceContext: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) } }
      : {}),
  });
  return { events, trace: result.trace! };
}

describe('记账事件（增量出口）', () => {
  it('折叠不变量：增量事件折回的 trace 与收尾 snapshot 逐字相同', async () => {
    const { events, trace } = await runWithEvents();
    assert.ok(events.length > 0, '一个事件都没有 —— 订阅没生效');
    assert.deepEqual(fold(events, trace.status), trace);
  });

  it('折叠不变量：并行工具（同回合两个）下同样成立', async () => {
    const { events, trace } = await runWithEvents({ parallel: true });
    assert.deepEqual(fold(events, trace.status), trace);
  });

  it('折叠不变量：入站 traceContext（run 根的 link）也要出现在增量流里', async () => {
    const { events, trace } = await runWithEvents({ traceContext: true });
    assert.ok(
      events.some((e) => e.type === 'span.link'),
      'span.link 事件缺席 —— addLink 漏了派发（折叠就会丢 links）',
    );
    assert.deepEqual(fold(events, trace.status), trace);
  });

  it('seq 严格单调递增，且每次记账动作都占一个号（与订阅时机无关）', async () => {
    const { events } = await runWithEvents();
    let prev = 0;
    for (const e of events) {
      assert.ok(e.seq > prev, `seq 非单调：${prev} → ${e.seq}`);
      prev = e.seq;
    }
    assert.equal(new Set(events.map((e) => e.seq)).size, events.length, 'seq 有重复');
  });

  it('订阅晚的人看到的 seq 与一直订阅的人一致（订阅前那些号不回收）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null); // 若无订阅者也记账 ⇒ 占 seq 1
    r.setAttribute(root, 'k', 'v'); // 占 seq 2
    const seen: TraceRecordEvent[] = [];
    r.subscribe((e) => seen.push(e));
    r.end(root, { status: 'ok' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.seq, 3, '订阅前的记账动作没有占号 ⇒ 重放/去重会错位');
  });

  it('订阅者抛错不影响 run；也不影响其它订阅者（两条订阅者，一条炸）', async () => {
    const got: string[] = [];
    const app = await createApp({
      name: 'trace-events-throw',
      system: new SystemPrompt().add('role', '助手。', true),
      providers: [{ provide: 'tools', useClass: Tools }],
      toolSources: ['tools'],
      onTraceEvent: () => {
        throw new Error('订阅者炸了');
      },
    });
    const { result } = await app.run([{ role: 'user', content: '跑' }], {
      client: scriptedClient([endTurn(0)] as never),
      onTraceEvent: (e) => got.push(e.type),
    });
    assert.equal(result.stopReason, 'end_turn', '订阅者抛错把 run 弄挂了');

    // 两条订阅者、一条抛错：另一条必须照常收全
    const r = new TraceRecorder();
    const root = r.begin('run', 'x', null);
    const seen: string[] = [];
    r.subscribe(() => {
      throw new Error('first listener boom');
    });
    r.subscribe((e) => seen.push(e.type));
    r.setAttribute(root, 'a', 1);
    r.end(root, { status: 'ok' });
    assert.deepEqual(seen, ['span.attribute', 'span.end'], '抛错的订阅者把后面的订阅者带崩了');
  });

  it('应用级与 per-run 的 onTraceEvent 是**叠加**（应用级在前），不是覆盖', async () => {
    const appLevel: string[] = [];
    const runLevel: string[] = [];
    const app = await createApp({
      name: 'trace-events-override',
      system: new SystemPrompt().add('role', '助手。', true),
      providers: [{ provide: 'tools', useClass: Tools }],
      toolSources: ['tools'],
      onTraceEvent: (e) => appLevel.push(e.type),
    });
    const { result } = await app.run([{ role: 'user', content: '跑' }], {
      client: scriptedClient([endTurn(0)] as never),
      onTraceEvent: (e) => runLevel.push(e.type),
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.ok(runLevel.length > 0, 'per-run 回调没生效');
    assert.ok(
      appLevel.length > 0,
      '应用级回调被 per-run 顶掉了 —— 观察者注册不该互相覆盖（那是可观测性的静默回退）',
    );
    assert.deepEqual(runLevel, appLevel, '两条订阅者收到的事件应完全一致');

    // 应用级那条抛错，不该把 per-run 那条带崩（合成后它们在 recorder 眼里是一个订阅者）
    const survivor: string[] = [];
    const fragile = await createApp({
      name: 'trace-events-app-throws',
      system: new SystemPrompt().add('role', '助手。', true),
      providers: [{ provide: 'tools', useClass: Tools }],
      toolSources: ['tools'],
      onTraceEvent: () => {
        throw new Error('应用级炸了');
      },
    });
    const r2 = await fragile.run([{ role: 'user', content: '跑' }], {
      client: scriptedClient([endTurn(1)] as never),
      onTraceEvent: (e) => survivor.push(e.type),
    });
    assert.equal(r2.result.stopReason, 'end_turn', '应用级回调抛错把 run 弄挂了');
    assert.ok(survivor.length > 0, '应用级回调抛错吞掉了 per-run 回调');
  });

  it('退订后不再收到事件', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'x', null);
    const seen: number[] = [];
    const off = r.subscribe((e) => seen.push(e.seq));
    r.setAttribute(root, 'a', 1);
    off();
    r.setAttribute(root, 'b', 2);
    assert.equal(seen.length, 1, '退订后还在收事件');
  });
});
