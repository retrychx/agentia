import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Skill, collectSkills, skillToTool, TraceRecorder } from '../../src/index.js';
import type { SkillContext, SkillUnit, ToolRunContext } from '../../src/index.js';
import { mockClient, endTurnMsg, U } from '../helpers.js';

/** 自造 stop_reason：让受限子运行以「未识别的 stop_reason」失败（loop.error 由 engine 挂） */
function rawMsg(stop_reason: string, text = 'part'): Record<string, unknown> {
  return {
    id: 'm-raw',
    model: 'claude-opus-5',
    stop_reason,
    usage: U,
    content: [{ type: 'text', text }],
  };
}

/** 模拟主 agent 运行中的调用现场（engine 注入的 ToolRunContext） */
function makeCtx(client: ToolRunContext['client']) {
  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', 'test.run', null);
  const ctx: ToolRunContext = { client, recorder, parentSpanId: rootId };
  return { ctx, recorder };
}

/** 取容器实例上的唯一 skill 单元 */
function onlySkill(instance: object): SkillUnit {
  const units = collectSkills(instance);
  assert.equal(units.length, 1);
  return units[0];
}

describe('Skill 单元（ctx.llm 受限子运行）', () => {
  it('方法体调 ctx.llm 拿到文本；unit span 正常收尾且 llm.turn 递归其下', async () => {
    class Summarizer {
      @Skill({ description: 'd' })
      async summarize(input: { text: string }, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: `总结：${input.text}` });
        return `[${out.stopReason}] ${out.text}`;
      }
    }
    const { client } = mockClient([endTurnMsg('摘要内容')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Summarizer()), () => []);

    const out = await tool.run({ text: 't' }, ctx);
    assert.equal(out, '[end_turn] 摘要内容');

    const trace = recorder.snapshot('ok');
    const unit = trace.spans.find((s) => s.kind === 'unit')!;
    assert.equal(unit.status, 'ok');
    // 受限子运行的回合挂在 unit 下（不双开 run 根）
    const turn = trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(turn.parentSpanId, unit.spanId);
  });

  it('受限子运行失败：unit span 挂的是 engine 的丰富 error（type/retryable），不是新造的 Error', async () => {
    class Fragile {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const { client } = mockClient([rawMsg('model_context_window_exceeded', '半截')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Fragile()), () => []);

    // 对主 agent 仍是 is_error 语义（抛错 → engine 包成 tool_result）
    await assert.rejects(async () => tool.run({}, ctx), /unknown_stop_reason/);

    const unit = recorder.snapshot('error').spans.find((s) => s.kind === 'unit')!;
    assert.equal(unit.status, 'error');
    // loop.error 是 { type:'agent_error', retryable:false }（engine 判定的语义）；
    // 若走外层 catch 的 classifyError(new Error(report)) 会退化成 type:'unknown'，
    // 「不可重试的模型侧异常」这个信息就丢了
    assert.equal(unit.error?.type, 'agent_error');
    assert.equal(unit.error?.retryable, false);
    assert.match(unit.error?.message ?? '', /model_context_window_exceeded/);
  });
});
