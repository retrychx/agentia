import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Skill,
  TraceRecorder,
  collectSkills,
  currentTraceparent,
  parseTraceparent,
  runAgent,
  skillToTool,
} from '../../src/index.js';
import { formatTraceparent, wireSpanId, wireTraceId } from '../../src/core/trace.js';
import { withCurrentSpan } from '../../src/engine/span-scope.js';
import type {
  AgentTool,
  SkillCapability,
  SkillContext,
  Span,
  ToolRunContext,
} from '../../src/index.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

/**
 * 出站链路传播（spec §9.2）：`currentTraceparent()` —— 入站那半（`parseTraceparent` → run 根 link）
 * 在 `tests/engine/traceLink.test.ts` 里，这里钉**出站**那半。
 *
 * 四件事，每一件都对应一条会静默出错的假设：
 * ① 粒度：工具体里拿到的是**本回合的 llm.turn**（普通工具不建 span，其「当前 span」就是发起它
 *    的那个回合）—— 不是 run 根，否则下游只能关联到「整次 run」；
 * ② 形状：出站串必须被**我们自己的入站解析器**吃下（往返闭环，不靠肉眼比位数）；
 * ③ 作用域是**每次调用**一份：并行链互不干扰、内层不外泄 —— 这正是 spec §9.2 锁定
 *    「span 句柄不放 RunContext」的理由（run 级只存一个值会被并行调用互相覆盖）；
 * ④ 不留残影：run 结束后必须回到 `undefined`。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 唯一 skill 能力（skillToTool 是公共导出，直调即可进入它的 capability 作用域） */
function onlySkill(instance: object): SkillCapability {
  const capabilities = collectSkills(instance);
  assert.equal(capabilities.length, 1);
  return capabilities[0];
}

describe('currentTraceparent（出站链路传播，spec §9.2）', () => {
  it('run 外调用 → undefined（没有 span 可指，不编造）', () => {
    assert.equal(currentTraceparent(), undefined);
  });

  it('工具体内 → 指向本回合的 llm.turn；且能被入站解析器吃下（往返闭环）', async () => {
    const seen: Array<string | undefined> = [];
    const probe: AgentTool = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        seen.push(currentTraceparent());
        return 'ok';
      },
    };
    const { client } = mockClient([toolUseMsg('probe', {}), endTurnMsg('done')]);

    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [probe],
      client: client as never,
    });

    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn') as Span;
    const tp = seen[0];
    assert.ok(tp, 'run 内必须拿得到 traceparent');
    // 往返：出站串 → 入站解析器 === 内部 id 的线缆形态（形状合规是机器证明的）
    assert.deepEqual(parseTraceparent(tp), {
      traceId: wireTraceId(result.trace.traceId),
      spanId: wireSpanId(turn.spanId),
    });
    assert.ok(tp.endsWith('-00'), 'flags 恒 00 —— 本框架不采样，不替下游声明「已采样」');
    // 粒度：是回合，不是 run 根（否则下游只能关联到「整次 run」）
    assert.notEqual(wireSpanId(turn.spanId), wireSpanId(result.trace.rootSpanId));
  });

  it('run 结束后不残留（工具抛错也一样）', async () => {
    const boom: AgentTool = {
      name: 'boom',
      description: 'boom',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        throw new Error('boom');
      },
    };
    const { client } = mockClient([toolUseMsg('boom', {}), endTurnMsg('done')]);

    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [boom],
      client: client as never,
    });

    assert.ok(result.trace.spans.some((s) => s.events.some((e) => e.name === 'tool.output')));
    assert.equal(currentTraceparent(), undefined, 'run 结束后作用域必须已退出');
  });

  it('作用域是每次调用一份：并行链互不干扰、内层不外泄（§9.2 的核心理由）', async () => {
    // 用格式合法的伪 id，断言直接对 `formatTraceparent` 的结果比 —— 不手写字面量位数
    const outer = { traceId: 'a'.repeat(32), spanId: '1'.repeat(16) };
    const inner = { traceId: 'b'.repeat(32), spanId: '2'.repeat(16) };

    await withCurrentSpan(outer, async () => {
      // 内层链（模拟 skill 的 capability 作用域）与旁支链（模拟并行工具）同时推进
      const innerChain = withCurrentSpan(inner, async () => {
        await sleep(20);
        return currentTraceparent();
      });
      const sideChain = (async () => {
        await sleep(5); // 特意在内层**已进入**之后再读
        return currentTraceparent();
      })();

      const [i, s] = await Promise.all([innerChain, sideChain]);
      assert.equal(i, formatTraceparent(inner.traceId, inner.spanId));
      // ⚠️ 这一行是「run 级只存一个值」实现下的必红点：那样旁支会读到内层的 span
      assert.equal(s, formatTraceparent(outer.traceId, outer.spanId));
    });
  });

  it('skill 方法体内 → 指向自己的 capability span（不是发起它的 llm.turn）', async () => {
    class Summarizer {
      @Skill({ description: 'd' })
      async summarize(_input: Record<string, never>, _ctx: SkillContext): Promise<string> {
        return currentTraceparent() ?? 'undefined';
      }
    }

    const recorder = new TraceRecorder();
    const rootId = recorder.begin('run', 'test.run', null);
    const ctx: ToolRunContext = { client: {} as never, recorder, parentSpanId: rootId };
    const tool = skillToTool(onlySkill(new Summarizer()), () => []);

    const out = (await tool.run({}, ctx)) as string;

    const capability = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability') as Span;
    assert.deepEqual(parseTraceparent(out), {
      traceId: wireTraceId(recorder.traceId),
      spanId: wireSpanId(capability.spanId),
    });
    assert.notEqual(wireSpanId(capability.spanId), wireSpanId(rootId), '不是发起它的那个 span');
  });
});
