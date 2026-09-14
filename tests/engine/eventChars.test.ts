import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, TraceRecorder, subagentToTool } from '../../src/index.js';
import type {
  AgentTool,
  JsonSchema,
  SubAgentCapability,
  ToolRunContext,
  Trace,
} from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * `maxEventChars` —— trace 事件正文的截断口径。
 *
 * 背景：`tool.input` / `tool.output` 的事件体原先**硬编码** 2000/2000/1000 字符，
 * 而 `core/trace.ts` 与 `docs/spec.md` §9.1 早就写着「完整内容 opt-in」——
 * 承诺存在、开关不存在。本套件守的就是这个开关，三件事：
 *
 *   1. **缺省一字不变**（2000 / 成功 2000 / 失败 1000）—— 老 trace 的体积口径不能被动漂移；
 *   2. 数字 = 三类统一，`false` = **不截断**（完整正文进 trace，供面板展开）；
 *   3. **透传给嵌套能力** —— 否则「开没开」在同一棵调用树上会出现两种口径。
 *
 * 注：截断只发生在**记账**时。回给模型的 tool_result 永远是完整的
 * （`stringifySafe(content)`，不过 `limit`），所以本开关不会悄悄改变 agent 的行为。
 */

const SCHEMA: AgentTool['inputSchema'] = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

/** 截断标记的规范形态（core/json.ts 的 truncateWithMark） */
const expectCut = (raw: string, n: number) => `${raw.slice(0, n)}…(+${raw.length - n})`;

/** 造一段「比任何上限都长」的正文 */
const LONG_INPUT = { text: 'x'.repeat(5000) };
const RAW_INPUT = JSON.stringify(LONG_INPUT);
const LONG_OUTPUT = 'y'.repeat(5000);

function eventsOf(trace: Trace, name: string): Record<string, unknown>[] {
  return trace.spans
    .flatMap((s) => s.events)
    .filter((e) => e.name === name)
    .map((e) => e.body as Record<string, unknown>);
}

function bodyOf(trace: Trace, name: string): Record<string, unknown> {
  const [first] = eventsOf(trace, name);
  if (!first) throw new Error(`trace 里没有 ${name} 事件`);
  return first;
}

/** 长入参 + 长出参的成功工具 */
const bigTool: AgentTool = {
  name: 'echo',
  description: 'echo',
  inputSchema: SCHEMA,
  run: () => LONG_OUTPUT,
};

/** 抛一条长错误消息的工具（走「失败出参」那一档） */
const boomTool: AgentTool = {
  name: 'echo',
  description: 'boom',
  inputSchema: SCHEMA,
  run: () => {
    throw new Error('e'.repeat(3000));
  },
};

/** runAgent 的最小现场；`opts` 直接透传，用例只关心截断口径 */
async function runWith(tool: AgentTool, maxEventChars?: number | false) {
  const { client } = mockClient([toolUseMsg('echo', LONG_INPUT), endTurnMsg('done')]);
  return runAgent({
    messages: [{ role: 'user', content: 'go' }],
    tools: [tool],
    client: client as never,
    ...(maxEventChars === undefined ? {} : { maxEventChars }),
  });
}

/**
 * 失败出参的原始正文：`error(<classifyError 的 type>): <message>`（engine/loop.ts 的收尾拼法）。
 * 普通 `Error` 经 `classifyError` 归为 `unknown`（errors.ts 的兜底分支）—— 这里如实写死，
 * 免得断言随错误分类表漂移。
 */
function rawErrorBody(message: string) {
  return `error(unknown): ${message}`;
}

describe('maxEventChars —— 事件正文截断口径', () => {
  it('缺省：入参 2000 / 成功出参 2000 / 失败出参 1000（与旧行为逐字一致）', async () => {
    const ok = await runWith(bigTool);
    const input = bodyOf(ok.trace, 'tool.input').input as string;
    const output = bodyOf(ok.trace, 'tool.output').content as string;
    assert.equal(input, expectCut(RAW_INPUT, 2000));
    assert.equal(output, expectCut(LONG_OUTPUT, 2000));

    const boom = await runWith(boomTool);
    const errOut = bodyOf(boom.trace, 'tool.output').content as string;
    assert.equal(errOut, expectCut(rawErrorBody('e'.repeat(3000)), 1000));
  });

  it('传数字：入参 / 成功出参 / 失败出参三类统一用该上限', async () => {
    const ok = await runWith(bigTool, 7);
    assert.equal(bodyOf(ok.trace, 'tool.input').input, expectCut(RAW_INPUT, 7));
    assert.equal(bodyOf(ok.trace, 'tool.output').content, expectCut(LONG_OUTPUT, 7));

    const boom = await runWith(boomTool, 7);
    assert.equal(
      bodyOf(boom.trace, 'tool.output').content,
      expectCut(rawErrorBody('e'.repeat(3000)), 7),
    );
  });

  it('false：三类都不截断，正文原样（完整工具结果进 trace）', async () => {
    const ok = await runWith(bigTool, false);
    assert.equal(bodyOf(ok.trace, 'tool.input').input, RAW_INPUT);
    assert.equal(bodyOf(ok.trace, 'tool.output').content, LONG_OUTPUT);
    // 不截断 ⇒ 正文里不该出现截断标记
    assert.doesNotMatch(bodyOf(ok.trace, 'tool.output').content as string, /…\(\+\d+\)$/);

    const boom = await runWith(boomTool, false);
    assert.equal(bodyOf(boom.trace, 'tool.output').content, rawErrorBody('e'.repeat(3000)));
  });

  it('回给模型的 tool_result 不受截断影响（截断只在记账侧）', async () => {
    // 这条是「本开关不会悄悄改变 agent 行为」的门禁：把 content 截成 7 字符，
    // 模型收到的那条 tool_result 仍必须是完整的 5000 字符。
    //
    // ⚠️ 必须在**发起请求时**快照 params：engine 是 `messages.push(toolResults)` **原地**装配
    // 下一次请求的，mock 的 `seen[1]` 与 engine 最终持有的是**同一个数组** —— 跑完再读
    // `seen[1].messages.at(-1)` 拿到的是终态（最后一条 assistant），不是当初发出去的那份。
    type CapturedParams = { messages: Array<{ role: string; content: unknown }> };
    let second: CapturedParams | null = null;
    const { client } = mockClient([
      toolUseMsg('echo', LONG_INPUT),
      {
        message: endTurnMsg('done'),
        onParams: (params) => {
          // 显式 `as CapturedParams`：`as typeof second` 会被 TS 收窄成 `null`
          // （闭包创建处 second 仍是 null）→ 后面 assert.ok 再收窄成 never
          second = structuredClone(params) as CapturedParams;
        },
      },
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ ...bigTool, run: () => LONG_OUTPUT }],
      client: client as never,
      maxEventChars: 7,
    });
    assert.equal(bodyOf(result.trace, 'tool.output').content, expectCut(LONG_OUTPUT, 7));
    const captured = second as CapturedParams | null;
    assert.ok(captured, '没抓到第二次请求的 params');
    const blocks = captured.messages.at(-1)?.content as Array<{ content: string }>;
    assert.equal(blocks[0].content, LONG_OUTPUT, '回模型的 tool_result 必须完整');
  });

  it('生效值记进 run 根 `config.maxEventChars`（false 记成 off）', async () => {
    const set = await runWith(bigTool, 1234);
    assert.equal(
      set.trace.spans.find((s) => s.kind === 'run')?.attributes['config.maxEventChars'],
      1234,
    );

    const off = await runWith(bigTool, false);
    assert.equal(
      off.trace.spans.find((s) => s.kind === 'run')?.attributes['config.maxEventChars'],
      'off',
      'false 在日志/看板里会被读成「上限为 0」，必须落到可读的 off',
    );

    // 没配 ⇒ 不记该属性（与"配了缺省值"区分）
    const none = await runWith(bigTool);
    assert.equal(
      'config.maxEventChars' in (none.trace.spans.find((s) => s.kind === 'run')?.attributes ?? {}),
      false,
    );
  });

  it('透传给嵌套能力：子 agent 里的工具事件同样按同一口径', async () => {
    // ctx.maxEventChars 就是 @SubAgent / @Skill 从 ToolRunContext 读走的那个值
    // （toolkit/subagent.ts、toolkit/skill.ts 原样传给 runAgentScoped）。
    const cap: SubAgentCapability = {
      name: 'researcher',
      description: '调研子 agent',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } } as JsonSchema,
      spec: {
        description: '调研子 agent',
        schema: { type: 'object', properties: { task: { type: 'string' } } } as JsonSchema,
        system: '你是调研员。',
        // 子 agent 的菜单来自 resolveTools()，但**只有 spec.tools 非空时才会调用它**
        // （toolkit/subagent.ts: `spec.tools?.length ? resolveTools() : []`）——
        // 漏了这一行，子循环的工具列表就是空的，模型要 'inner' 只会拿到 unknown tool。
        tools: ['inner'],
      },
    };
    const inner: AgentTool = {
      name: 'inner',
      description: 'inner',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } as JsonSchema,
      run: () => LONG_OUTPUT,
    };
    const tool = subagentToTool(cap, () => [inner]);

    const runChild = async (ctxOver: Partial<ToolRunContext>) => {
      const recorder = new TraceRecorder();
      const rootId = recorder.begin('run', 'test.run', null);
      const { client } = mockClient([
        toolUseMsg('inner', {}) as never,
        endTurnMsg('完成') as never,
      ]);
      const ctx: ToolRunContext = {
        client: client as never,
        recorder,
        parentSpanId: rootId,
        ...ctxOver,
      };
      await tool.run({ task: 'go' }, ctx);
      return recorder.snapshot('ok');
    };

    // 对照组：不传 ⇒ 子循环用缺省，正文被截断
    const dflt = await runChild({});
    assert.equal(bodyOf(dflt, 'tool.output').content, expectCut(LONG_OUTPUT, 2000));

    // 传 false ⇒ 子 agent 里的工具结果也完整（同一条 trace 上口径一致）
    const full = await runChild({ maxEventChars: false });
    assert.equal(bodyOf(full, 'tool.output').content, LONG_OUTPUT);
  });
});
