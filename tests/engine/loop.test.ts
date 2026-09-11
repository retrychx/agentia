import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from '../../src/index.js';
import type { JsonSchema, Span } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;

/** 自造 stop_reason 的响应：helpers 的 mock 只覆盖 end_turn / tool_use 两个常用形态 */
function rawMsg(stop_reason: string, text = 'part'): Record<string, unknown> {
  return {
    id: 'm-raw',
    model: 'claude-opus-5',
    stop_reason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: 'text', text }],
  };
}

const turnOf = (spans: Span[]): Span => spans.find((s) => s.kind === 'llm.turn')!;

describe('agentLoop 边界与失败路径', () => {
  it('stop_sequence：视为正常收尾（ok），文本保留', async () => {
    const { client } = mockClient([rawMsg('stop_sequence', '命中停止序列前的文本')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
    });
    assert.equal(result.stopReason, 'stop_sequence');
    assert.equal(result.finalText, '命中停止序列前的文本');
    assert.equal(run.status, 'succeeded', 'stop_sequence 不是失败');
    assert.equal(result.error, undefined);
    assert.equal(result.trace.status, 'ok');
  });

  it('未识别的 stop_reason：保留文本但按失败收尾，并给出可诊断的 error', async () => {
    const { client } = mockClient([rawMsg('model_context_window_exceeded', '半截输出')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
    });
    assert.equal(result.stopReason, 'unknown_stop_reason');
    assert.equal(result.finalText, '半截输出', '已产出的文本不该丢');
    assert.equal(run.status, 'failed');
    assert.match(result.error?.message ?? '', /model_context_window_exceeded/);
    assert.equal(result.trace.status, 'error');
  });

  it('stop_reason=tool_use 但无可执行块：tool_use_no_blocks + 保留文本', async () => {
    const { client } = mockClient([
      { ...rawMsg('tool_use', '想调工具但块是空的'), content: [{ type: 'text', text: '想调工具但块是空的' }] },
    ]);
    const { result } = await executeRun({ messages: [{ role: 'user', content: 'go' }], client });
    assert.equal(result.stopReason, 'tool_use_no_blocks');
    assert.equal(result.finalText, '想调工具但块是空的');
  });

  it('畸形 inputSchema：只废掉该工具调用（is_error 回模型），run 不因此失败', async () => {
    let ran = 0;
    // validateJsonSchema 对 required 非可迭代值会抛 TypeError —— 必须在 try 内被收成 is_error，
    // 否则整次 run 会以 error 收场（模型连自我修正的机会都没有）
    const { client, seen } = mockClient([toolUseMsg('broken', {}), endTurnMsg('ok')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'broken',
          description: 'd',
          inputSchema: { type: 'object', required: 5 } as unknown as JsonSchema,
          run: () => {
            ran++;
            return 'never';
          },
        },
      ],
      client,
    });
    assert.equal(ran, 0, 'schema 异常不该进方法体');
    assert.equal(run.status, 'succeeded');
    assert.equal(result.stopReason, 'end_turn');
    const toolResult = JSON.stringify(seen[1]);
    assert.match(toolResult, /"is_error":true/);
    assert.match(toolResult, /error\(/);
  });

  it('请求失败时的 iterations 报实际已发生的回合数（不被硬写成 0）', async () => {
    // 脚本只有一轮：第二回合 finalMessage 抛错 → run 失败在第 2 回合
    const { client } = mockClient([toolUseMsg('noop', {})]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'noop',
          description: 'd',
          inputSchema: OBJ,
          run: () => 'ok',
        },
      ],
      client,
      rethrow: false,
    });
    assert.equal(run.status, 'failed');
    assert.equal(result.stopReason, 'error');
    assert.equal(result.iterations, 1, '已发生的 1 次模型往返必须如实报出');
  });

  it('trace 的 tool.input/tool.output 事件带 tool_use_id（重放按 id 配对的前提）', async () => {
    const { client } = mockClient([toolUseMsg('echo', { a: 1 }, 'tu_xyz'), endTurnMsg('ok')]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'd', inputSchema: OBJ, run: () => 'echoed' }],
      client,
    });
    const turn = turnOf(result.trace.spans);
    const input = turn.events.find((e) => e.name === 'tool.input')!;
    const output = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((input.body as { tool_use_id?: string }).tool_use_id, 'tu_xyz');
    assert.equal((output.body as { tool_use_id?: string }).tool_use_id, 'tu_xyz');
  });
});
