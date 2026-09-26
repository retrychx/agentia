import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder } from '../../src/index.js';
import type { Usage } from '../../src/index.js';

describe('TraceRecorder', () => {
  it('begin/end/属性/事件 全链路', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'model-x', root);
    r.setAttribute(turn, 'input_tokens', 10);
    r.event(turn, 'tool.input', { tool: 't' });
    r.end(turn, {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    assert.equal(trace.spans.length, 2);
    assert.equal(trace.spans[1].parentSpanId, root);
    assert.equal(trace.totalUsage.inputTokens, 10);
    assert.equal(trace.rootSpanId, root);
  });

  it('end 幂等：重复 end 不抛错也不覆盖', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    r.end(root, { status: 'ok' });
    r.end(root, { status: 'error' }); // 幂等忽略
    const trace = r.snapshot('ok');
    assert.equal(trace.spans[0].status, 'ok');
  });

  it('end 未知 span 抛错；event/setAttribute 对未知 span 静默（观测不中断业务）', () => {
    const r = new TraceRecorder();
    assert.throws(() => r.end('nope'), /span not found/);
    r.event('nope', 'e', {});
    r.setAttribute('nope', 'k', 'v');
  });

  it('run 根只能开一次；根未开 snapshot 抛错', () => {
    const r = new TraceRecorder();
    assert.throws(() => r.snapshot('ok'), /run root not started/);
    r.begin('run', 'app', null);
    assert.equal(r.rootStarted, true);
    assert.throws(() => r.begin('run', 'again', null), /run root already started/);
  });

  it('totalUsage 只累加 llm.turn：capability 的聚合用量不参与求和（不双算）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const capability = r.begin('capability', 'subagent:reviewer', root);
    const turn = r.begin('llm.turn', 'model-x', capability);
    const u = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 };
    r.end(turn, { usage: u });
    // capability span 写入「子孙聚合」用量（子 agent 展示用）——不得计进 totalUsage
    r.end(capability, { usage: u });
    r.end(root, { status: 'ok' });

    const trace = r.snapshot('ok');
    assert.equal(trace.totalUsage.inputTokens, 100, 'capability 聚合不得与 llm.turn 重复计数');
    assert.equal(trace.totalUsage.outputTokens, 40);
    // 但 capability span 自身的 usage 仍保留在 span 上（供展示）
    assert.equal(trace.spans.find((s) => s.spanId === capability)?.usage?.inputTokens, 100);
  });

  it('totalUsage.costEstimate 按 1e-6 取整（与 capability 聚合同口径，浮点尾差不进 trace）', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    for (const costEstimate of [0.1, 0.2]) {
      const turn = r.begin('llm.turn', 'model-x', root);
      r.end(turn, {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costEstimate,
        },
      });
    }
    r.end(root, { status: 'ok' });
    // 0.1 + 0.2 = 0.30000000000000004（IEEE754）—— 取整口径必须一致收成 0.3
    assert.equal(r.snapshot('ok').totalUsage.costEstimate, 0.3);
  });

  it('usage() 与 snapshot().totalUsage 逐字同口径（预算护栏走 usage()，两条路不得漂移）', () => {
    // 为什么单拎一条：`snapshot()` 会**拷**全部 span 的 attributes/events/links，而预算护栏
    // 每回合要判两次 ⇒ 引擎侧改走 `usage()`（不拷）。两条路一旦漂移，护栏就会拿错数——
    // 所以这里钉「deepEqual」而不是各字段分别断言。
    //
    // ⚠️ **2026-09-26 §1 逐行审计订正：本用例最后那句 deepEqual 是「潜在守卫」，今天咬不动任何东西。**
    // `snapshot()` 的实现就是 `totalUsage: this.usage()`（`src/engine/tracer.ts:339`）——
    // 同一对象同一个值，**恒等，永远绿**。实测：把 `usage()` 改成双算 capability 的聚合
    // （值错成 2 倍）⇒ 变红的是下面 `inputTokens === 100` 那条（`200 !== 100`），
    // **deepEqual 照旧绿**。所以「两条路同口径」今天是**结构保证（委托）**，
    // 不是被这句断言出来的；它真正长出牙齿的时刻是「有人把 snapshot 改成自己另算一遍」。
    // ⇒ 那件事改由下面那条「委托本身要被钉住」的用例守（不靠时机的巧合）。
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const capability = r.begin('capability', 'subagent:reviewer', root);
    const turn = r.begin('llm.turn', 'model-x', capability);
    r.end(turn, {
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheCreationTokens: 1,
        costEstimate: 0.1,
      },
    });
    const turn2 = r.begin('llm.turn', 'model-x', capability);
    r.end(turn2, {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate: 0.2,
      },
    });
    r.end(capability); // 未显式给 usage ⇒ 就地聚合子孙 —— 不得影响总量（与 snapshot 同规则）
    r.event(root, 'noise', { big: 'x'.repeat(500) });
    r.end(root, { status: 'ok' });

    assert.deepEqual(r.usage(), r.snapshot('ok').totalUsage, '两条路必须逐字相等');
    assert.equal(r.usage().inputTokens, 100);
    assert.equal(r.usage().outputTokens, 40);
    assert.equal(r.usage().costEstimate, 0.3, '取整口径也要一致（0.1 + 0.2 → 0.3）');
  });

  it('snapshot().totalUsage 必须**真的**来自 usage()（委托本身要被钉住）', () => {
    // 上一条的 deepEqual 之所以永远绿，是因为 `snapshot()` 委托给了 `usage()`。
    // 那么真正该守的就是**委托**：谁把 `snapshot()` 改成自己另扫一遍 spans，
    // 两条路就从「同一份真源」变成「两份实现」，而那时 deepEqual 恰好又变成潜在守卫
    // —— 这个交接点必须有人盯着，否则「不得漂移」只是一句注释。
    // 手法：子类数 `usage()` 的调用次数（父类方法可覆写）。故意不依赖返回值 ——
    // 返回值相等是结构保证的，**调用次数**才证明委托还在。
    class SpyRecorder extends TraceRecorder {
      usageCalls = 0;
      override usage(): Usage {
        this.usageCalls++;
        return super.usage();
      }
    }
    const r = new SpyRecorder();
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'model-x', root);
    r.end(turn, {
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    r.end(root, { status: 'ok' });

    const before = r.usageCalls; // 建 span 期间不得顺手调它（否则计数失去意义）
    const snap = r.snapshot('ok');
    assert.equal(
      r.usageCalls,
      before + 1,
      `snapshot() 必须恰好调一次 usage() —— 委托没了，两条路就会各算一遍（实测 ${before} → ${r.usageCalls}）`,
    );
    assert.equal(snap.totalUsage.inputTokens, 7, '顺带钉住交付值本身');
  });

  it('snapshot 的 events/attributes 是拷贝：交付后迟到的记账不变异已交付的 trace', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'model-x', root);
    r.end(turn, {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const delivered = r.snapshot('ok');
    const snapTurn = delivered.spans.find((s) => s.spanId === turn)!;
    assert.equal(snapTurn.events.length, 0);

    // 模拟「超时工具的后台残尾」：trace 已交付，recorder 仍在向同一 span 记账
    r.event(turn, 'tool.output', { tool: 'slow' });
    r.setAttribute(turn, 'late_write', true);

    assert.equal(snapTurn.events.length, 0, '已交付的 snapshot 不得被事后变异');
    assert.equal(snapTurn.attributes.late_write, undefined);
    // recorder 的内部视角不受影响：下一次 snapshot 能看到迟到的事件
    const later = r.snapshot('ok');
    assert.equal(later.spans.find((s) => s.spanId === turn)!.events.length, 1);
  });
  it('addLink：只落指定 span；未知 span 静默；无 link 的 span 不带该字段', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    const turn = r.begin('llm.turn', 'model-x', root);
    r.addLink('nope', { traceId: 'ignored' }); // 未知 span 静默（观测不击穿业务）
    r.addLink(root, { traceId: 'up-stream-trace', spanId: 'up-stream-span' });
    r.end(turn, {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    r.end(root);

    const trace = r.snapshot('ok');
    const rootSpan = trace.spans.find((s) => s.spanId === root)!;
    assert.deepEqual(rootSpan.links, [{ traceId: 'up-stream-trace', spanId: 'up-stream-span' }]);
    // 没记 link 的 span：字段缺席（不是空数组 —— 见 core/trace.ts 的注释）
    assert.equal('links' in trace.spans.find((s) => s.spanId === turn)!, false);
  });

  it('snapshot 的 links 是拷贝：交付后追加 link 不变异已交付的 trace', () => {
    const r = new TraceRecorder();
    const root = r.begin('run', 'app', null);
    r.addLink(root, { traceId: 'first' });
    const delivered = r.snapshot('ok');

    r.addLink(root, { traceId: 'late' });

    assert.equal(delivered.spans[0].links?.length, 1, '已交付的 snapshot 不得被事后变异');
    assert.equal(r.snapshot('ok').spans[0].links?.length, 2, 'recorder 视角要看到迟到的那条');
  });
});
