import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tool, createApp, defineEval, executeRun, scriptedClient, SystemPrompt } from '../../src/index.js';
import type { AgentRunResult, JsonSchema } from '../../src/index.js';
import { endTurnMsg, toolUseMsg } from '../helpers.js';

const OBJ: JsonSchema = { type: 'object', properties: {} };

describe('scriptedClient（D2）', () => {
  it('按脚本依次返回响应；每个文本块真的经 on("text") 吐出去（SSE/onText 链路在 eval 里也走一遍）', async () => {
    const deltas: string[] = [];
    const client = scriptedClient([
      { ...endTurnMsg(''), content: [{ type: 'text', text: '第一块' }, { type: 'text', text: '第二块' }] },
    ]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      onText: (d) => deltas.push(d),
    });
    assert.deepEqual(deltas, ['第一块', '第二块']);
    assert.equal(result.finalText, '第一块\n第二块');
  });

  it('脚本耗尽 → 抛错指向「第几次调用 / 共几步」（agent 多调一轮立刻可见）', async () => {
    const client = scriptedClient([endTurnMsg('only')]);
    await executeRun({ messages: [{ role: 'user', content: 'a' }], client });
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'b' }],
      client,
      rethrow: false,
    });
    assert.equal(result.stopReason, 'error');
    assert.match(result.error!.message, /scriptedClient 脚本耗尽：第 2 次调用模型，但只给了 1 步/);
  });

  it('函数步骤拿到本次请求参数（可按 model / messages 分支造响应）', async () => {
    let seenModel: unknown;
    const client = scriptedClient([
      (params) => {
        seenModel = (params as { model: string }).model;
        return endTurnMsg('ok');
      },
    ]);
    await executeRun({ messages: [{ role: 'user', content: 'go' }], client, model: 'claude-x' });
    assert.equal(seenModel, 'claude-x');
  });

  it('抛错的步骤不推进游标 → 重试重放同一步（可以用它验重试逻辑）', async () => {
    let calls = 0;
    const client = scriptedClient([
      () => {
        calls++;
        if (calls < 2) throw new Error('429 rate limited');
        return endTurnMsg('第二次成功');
      },
    ]);
    const params = {
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [{ role: 'user' as const, content: 'go' }],
    };
    await assert.rejects(() => client.messages.stream(params).finalMessage(), /429/);
    const msg = await client.messages.stream(params).finalMessage();
    assert.equal(calls, 2, '同一步被重放');
    assert.equal((msg as unknown as { id: string }).id, 'm2');
  });
});

describe('defineEval（D2）', () => {
  class Units {
    @Tool({ name: 'search', description: '搜一下', schema: OBJ })
    search(): string {
      return '命中 3 条';
    }
  }
  const makeApp = () => createApp({ name: 'eval-app', system: new SystemPrompt().add('role', 'r'), providers: [{ provide: 'u', useClass: Units }] });

  it('用例全过 → ok=true，报告里带每个 case 的 stopReason', async () => {
    const ev = defineEval<unknown>({
      name: 'search-flow',
      app: makeApp,
      cases: [
        { name: '会调 search', input: '查一下', client: scriptedClient([toolUseMsg('search', {}), endTurnMsg('好了')]) },
      ],
      expect: (r, { trace }) => {
        assert.equal(r.stopReason, 'end_turn');
        assert.equal(trace.traceId, r.trace.traceId, 'ctx.trace 与 result.trace 是同一份');
        const called = r.trace.spans.flatMap((s) => s.events).some((e) => e.name === 'tool.input');
        assert.ok(called, '应当调用过工具');
      },
    });
    const report = await ev.run();
    assert.equal(report.ok, true);
    assert.deepEqual([report.total, report.passed, report.failed], [1, 1, 0]);
    assert.equal(report.cases[0].stopReason, 'end_turn');
  });

  it('断言失败 → run() 不抛，进报告（失败 case 带 trace，能直接排查回归）', async () => {
    let n = 0;
    const ev = defineEval<unknown>({
      name: 'mixed',
      app: makeApp,
      cases: [
        { name: '过', input: 'a', client: scriptedClient([endTurnMsg('ok')]) },
        { name: '挂', input: 'b', client: scriptedClient([endTurnMsg('ok')]) },
      ],
      expect: (r) => {
        n++;
        assert.equal(r.finalText, 'ok');
        assert.equal(n, 1, '故意失败：第二个用例的断言');
      },
    });
    const report = await ev.run();
    assert.equal(report.ok, false);
    assert.deepEqual([report.total, report.passed, report.failed], [2, 1, 1]);
    const bad = report.cases.find((c) => !c.ok)!;
    assert.equal(bad.name, '挂');
    assert.match(bad.error!, /故意失败/);
    assert.ok(bad.trace, '失败 case 必须带 trace');
    assert.equal(bad.stopReason, 'end_turn', '断言失败也要保留「跑出来长什么样」');
  });

  it('app() 只在整轮 run() 里调用一次（用例间复用装配，避免掩盖装配期状态泄漏）', async () => {
    let built = 0;
    const ev = defineEval<unknown>({
      name: 'reuse',
      app: () => {
        built++;
        return makeApp();
      },
      cases: [
        { input: 'a', client: scriptedClient([endTurnMsg('ok')]) },
        { input: 'b', client: scriptedClient([endTurnMsg('ok')]) },
      ],
      expect: () => {},
    });
    const report = await ev.run();
    assert.equal(built, 1);
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.cases.map((c) => c.name),
      ['case#1', 'case#2'],
      '没给 name 时按序号命名',
    );
  });

  it('用例为空 → ok=true（没有用例就没有回归）', async () => {
    const report = await defineEval<unknown>({ name: 'empty', app: makeApp, cases: [], expect: () => {} }).run();
    assert.deepEqual([report.total, report.ok], [0, true]);
  });

  it('应用建不起来 → 冒泡（那是环境错误，不是回归）', async () => {
    const ev = defineEval<unknown>({
      name: 'bad-app',
      app: () => {
        throw new Error('DI 装配失败');
      },
      cases: [{ input: 'a', client: scriptedClient([endTurnMsg('ok')]) }],
      expect: () => {},
    });
    await assert.rejects(() => ev.run(), /DI 装配失败/);
  });

  it('typed 结果参与断言（resultSchema + scriptedClient 提交 submit_result）', async () => {
    const submitMsg = {
      id: 'm1',
      model: 'claude-opus-5',
      stop_reason: 'tool_use' as const,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'submit_result', input: { ok: true } }],
    };
    const ev = defineEval<{ ok: boolean }>({
      name: 'typed',
      app: makeApp,
      cases: [{ input: 'a', client: scriptedClient([submitMsg]), opts: { resultSchema: OBJ } }],
      expect: (r: AgentRunResult<{ ok: boolean }>) => {
        assert.deepEqual(r.typed, { ok: true });
      },
    });
    const report = await ev.run();
    assert.equal(report.ok, true, report.cases[0].error ?? '');
  });
});
