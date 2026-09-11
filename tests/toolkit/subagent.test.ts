import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, subagentToTool } from '../../src/index.js';
import type { JsonSchema, SubAgentUnit, ToolRunContext } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { task: { type: 'string' } },
  required: ['task'],
};

const RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

function researcherUnit(over: Partial<SubAgentUnit['spec']> = {}): SubAgentUnit {
  const spec: SubAgentUnit['spec'] = {
    description: '调研子 agent',
    schema: TASK_SCHEMA,
    system: '你是调研员，完成后提交结构化结论。',
    ...over,
  };
  return {
    name: 'researcher',
    description: spec.description,
    inputSchema: spec.schema,
    spec,
  };
}

/** 模拟主 agent 运行中的调用现场（engine 注入的 ToolRunContext） */
function makeCtx(client: ToolRunContext['client']) {
  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', 'test.run', null);
  const ctx: ToolRunContext = { client, recorder, parentSpanId: rootId };
  return { ctx, recorder };
}

describe('子 agent typed 结果（SubAgentSpec.resultSchema）', () => {
  it('子 agent 调 submit_result：{ report, result } 结构化 tool_result 交回主 agent', async () => {
    const { seen, client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu1'),
        content: [
          { type: 'text', text: '调研结论：答案是 42' },
          { type: 'tool_use', id: 'tu1', name: 'submit_result', input: { answer: '42', confidence: 0.9 } },
        ],
      },
    ]);
    const { ctx, recorder } = makeCtx(client);
    const tool = subagentToTool(researcherUnit({ resultSchema: RESULT_SCHEMA }), () => []);

    const out = await tool.run({ task: '调研答案' }, ctx);

    // 结构化交回：report = 子 agent 最终报告（可读性优先），result = typed 结果
    assert.deepEqual(out, {
      report: '调研结论：答案是 42',
      result: { answer: '42', confidence: 0.9 },
    });

    // 子 agent 循环拿到了隐藏 submit_result 工具（input_schema = resultSchema）
    const childTools = (seen[0] as { tools: Array<{ name: string; input_schema: unknown }> }).tools;
    assert.deepEqual(childTools.map((t) => t.name), ['submit_result']);
    assert.equal(childTools[0].input_schema, RESULT_SCHEMA);

    // unit span 正常收尾
    const unit = recorder.snapshot('ok').spans.find((s) => s.kind === 'unit')!;
    assert.equal(unit.name, 'researcher');
    assert.equal(unit.status, 'ok');
    assert.equal(unit.attributes.stop_reason, 'end_turn');
  });

  it('resultSchema 已给但子 agent 未提交（纯文本 end_turn）：退化为纯文本报告', async () => {
    const { client } = mockClient([endTurnMsg('只有文字结论')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(researcherUnit({ resultSchema: RESULT_SCHEMA }), () => []);

    const out = await tool.run({ task: 't' }, ctx);
    assert.equal(out, '只有文字结论'); // 保持报告可读性：无 typed 时与不设 resultSchema 同形
  });

  it('未设 resultSchema：交回最终文本（行为与现状一致），子循环无隐藏工具', async () => {
    const { seen, client } = mockClient([endTurnMsg('普通报告')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(researcherUnit(), () => []);

    const out = await tool.run({ task: 't' }, ctx);
    assert.equal(out, '普通报告');
    const params = seen[0] as { tools?: Array<{ name: string }> };
    assert.equal(params.tools, undefined); // 无工具菜单（resolveTools 空 + 无隐藏工具）
  });

  it('子 agent 未正常收尾（max_iterations）：is_error 语义不变（抛错）', async () => {
    const { client } = mockClient([toolUseMsg('echo', { text: 'x' })]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(
      researcherUnit({ resultSchema: RESULT_SCHEMA, maxIterations: 1 }),
      () => [],
    );
    // 子 agent 死循环工具调用、超出 maxIterations → 抛错（engine 包成 is_error 回主 agent）
    await assert.rejects(async () => tool.run({ task: 't' }, ctx), /max_iterations/);
  });
});
