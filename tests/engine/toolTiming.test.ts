import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import type { AgentTool, Span, Trace } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * E1 —— 普通工具的耗时/成败必须可从 trace 读到。
 *
 * 背景：普通工具**不建 span**（既定决策，为控 trace 体积），只在 turn 上记
 * `tool.input` / `tool.output` 事件。补时序之前，占多数的普通工具其耗时**完全不可观测**。
 */

const SCHEMA: AgentTool['inputSchema'] = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

function toolOutputEvent(trace: Trace): Record<string, unknown> {
  for (const s of trace.spans) {
    for (const e of s.events) if (e.name === 'tool.output') return e.body as Record<string, unknown>;
  }
  throw new Error('trace 里没有 tool.output 事件');
}

function toolSpanWith(trace: Trace): Span {
  const s = trace.spans.find((x) => x.kind === 'llm.turn');
  if (!s) throw new Error('没有 llm.turn span');
  return s;
}

async function runWith(tool: AgentTool, toolTimeoutMs?: number) {
  const { client } = mockClient([toolUseMsg('echo', { text: 'hi' }), endTurnMsg('done')]);
  return runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: [tool],
    client: client as never,
    ...(toolTimeoutMs != null ? { toolTimeoutMs } : {}),
  });
}

describe('E1 工具级时序（tool.output 事件带 durationMs / ok / errorKind）', () => {
  it('成功：durationMs ≥ 0，ok=true，无 errorKind', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'ok';
      },
    };
    const result = await runWith(tool);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.tool, 'echo');
    assert.equal(body.ok, true);
    assert.equal('errorKind' in body, false, '成功路径不带 errorKind');
    assert.equal(typeof body.durationMs, 'number');
    assert.ok((body.durationMs as number) >= 5, `durationMs 应覆盖工具内部 5ms 等待，实际 ${body.durationMs}`);
  });

  it('工具抛错：ok=false + errorKind=threw，且 run 不失败（is_error 回模型）', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: () => {
        throw new Error('boom');
      },
    };
    const result = await runWith(tool);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'threw');
    assert.equal(result.stopReason, 'end_turn', '工具抛错不应中断 run');
    assert.equal(result.error, undefined);
  });

  it('入参不合 schema：ok=false + errorKind=invalid_input（方法体不执行）', async () => {
    let called = false;
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: () => {
        called = true;
        return 'x';
      },
    };
    // 模型给的 input 缺 required 的 text
    const { client } = mockClient([toolUseMsg('echo', {}, 'tu1'), endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      client: client as never,
    });
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'invalid_input');
    assert.equal(called, false, 'schema 不过时方法体不得执行');
  });

  it('工具超时：ok=false + errorKind=timeout，durationMs ≥ 超时阈值（且 run 不失败）', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'slow',
      inputSchema: SCHEMA,
      run: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return 'late';
      },
    };
    const result = await runWith(tool, 20);
    const body = toolOutputEvent(result.trace);
    assert.equal(body.ok, false);
    assert.equal(body.errorKind, 'timeout');
    assert.ok((body.durationMs as number) >= 20, `超时路径也要记耗时，实际 ${body.durationMs}`);
    assert.equal(result.stopReason, 'end_turn');
  });

  it('每个工具各记一条 tool.output（并行工具不串）', async () => {
    const mk = (name: string): AgentTool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => name,
    });
    const { client } = mockClient([
      {
        ...toolUseMsg('a', {}, 'tu_a'),
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'a', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'b', input: {} },
        ],
      },
      endTurnMsg('done'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [mk('a'), mk('b')],
      client: client as never,
    });
    const bodies = result.trace.spans
      .flatMap((s) => s.events)
      .filter((e) => e.name === 'tool.output')
      .map((e) => e.body as Record<string, unknown>);
    assert.equal(bodies.length, 2);
    assert.deepEqual(
      bodies.map((b) => b.tool_use_id).sort(),
      ['tu_a', 'tu_b'],
      'tool_use_id 保证同名/并行工具的事件可正确配对',
    );
    for (const b of bodies) assert.equal(typeof b.durationMs, 'number');
  });

  it('tool.input 事件不带时序（时序只在 output 上，避免同一事实两处记）', async () => {
    const tool: AgentTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: SCHEMA,
      run: () => 'ok',
    };
    const result = await runWith(tool);
    const inputEvent = toolSpanWith(result.trace).events.find((e) => e.name === 'tool.input')!;
    assert.equal('durationMs' in (inputEvent.body as object), false);
  });
});
