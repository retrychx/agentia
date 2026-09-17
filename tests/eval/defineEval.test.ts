import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Tool,
  createApp,
  defineEval,
  executeRun,
  metricsSink,
  scriptedClient,
  SystemPrompt,
} from '../../src/index.js';
import type {
  AgentApp,
  AgentRunResult,
  JsonSchema,
  MessageParam,
  RunAppOptions,
  Trace,
} from '../../src/index.js';
import { endTurnMsg, toolUseMsg } from '../helpers.js';

const OBJ: JsonSchema = { type: 'object', properties: {} };

describe('scriptedClient（D2）', () => {
  it('按脚本依次返回响应；每个文本块真的经 on("text") 吐出去（SSE/onText 链路在 eval 里也走一遍）', async () => {
    const deltas: string[] = [];
    const client = scriptedClient([
      {
        ...endTurnMsg(''),
        content: [
          { type: 'text', text: '第一块' },
          { type: 'text', text: '第二块' },
        ],
      },
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
  const makeApp = () =>
    createApp({
      name: 'eval-app',
      system: new SystemPrompt().add('role', 'r'),
      providers: [{ provide: 'u', useClass: Units }],
    });

  it('用例全过 → ok=true，报告里带每个 case 的 stopReason', async () => {
    const ev = defineEval<unknown>({
      name: 'search-flow',
      app: makeApp,
      cases: [
        {
          name: '会调 search',
          input: '查一下',
          client: scriptedClient([toolUseMsg('search', {}), endTurnMsg('好了')]),
        },
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
    const report = await defineEval<unknown>({
      name: 'empty',
      app: makeApp,
      cases: [],
      expect: () => {},
    }).run();
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
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
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

describe('defineEval 自动 score（R7 质量闭环）', () => {
  const makeApp = () =>
    createApp({
      name: 'eval-app',
      system: new SystemPrompt().add('role', 'r'),
      providers: [],
    });

  /** 抠出 trace 根 span 上的 score 事件体（attachScore 落点） */
  function scoresOf(trace: Trace) {
    const root = trace.spans.find((s) => s.spanId === trace.rootSpanId)!;
    return root.events.filter((e) => e.name === 'score').map((e) => e.body);
  }

  it('pass / fail 两种用例的根 span 各有正确 score 事件（fail 带 comment）', async () => {
    const ev = defineEval<unknown>({
      name: 'scored-eval',
      app: makeApp,
      cases: [
        { name: '过', input: 'a', client: scriptedClient([endTurnMsg('ok')]) },
        { name: '挂', input: 'b', client: scriptedClient([endTurnMsg('bad')]) },
      ],
      expect: (r) => {
        assert.equal(r.finalText, 'ok');
      },
    });
    const report = await ev.run();
    assert.equal(report.ok, false);

    const pass = report.cases[0];
    assert.equal(pass.ok, true);
    assert.deepEqual(scoresOf(pass.trace!), [{ name: 'eval', value: 1, source: 'scored-eval' }]);

    const fail = report.cases[1];
    assert.equal(fail.ok, false);
    const failScores = scoresOf(fail.trace!);
    assert.equal(failScores.length, 1, '结论只挂一条 score 事件');
    const body = failScores[0] as { name: string; value: number; source: string; comment: string };
    assert.equal(body.name, 'eval');
    assert.equal(body.value, 0);
    assert.equal(body.source, 'scored-eval');
    assert.match(body.comment, /expected/i, '失败原因进 comment');
  });

  it('断言失败的用例同样有 trace 可挂（score 落在失败 case 的 trace 上，下游可聚合通过率）', async () => {
    const ev = defineEval<unknown>({
      name: 'all-pass',
      app: makeApp,
      cases: [
        { input: 'a', client: scriptedClient([endTurnMsg('ok')]) },
        { input: 'b', client: scriptedClient([endTurnMsg('ok')]) },
      ],
      expect: () => {},
    });
    const report = await ev.run();
    assert.equal(report.ok, true);
    for (const c of report.cases) {
      assert.deepEqual(scoresOf(c.trace!), [{ name: 'eval', value: 1, source: 'all-pass' }]);
    }
  });

  it('score 在 sinks 冲刷前落定 → metricsSink 真的聚合得到（下游可算通过率）', async () => {
    // 这一条是本组的存在理由：`flushSinks` 发生在 `executeRun` 内部，结论若在
    // `app.run()` 返回后才挂，`metricsSink` 早在 `export()` 那一刻聚完账 —— 分数
    // 永远进不了指标，而 usage-guide 承诺「eval 的 trace 自带质量结论、可直接聚合通过率」。
    const metrics = metricsSink();
    const app = () =>
      createApp({
        name: 'eval-app',
        system: new SystemPrompt().add('role', 'r'),
        providers: [],
        sinks: [metrics],
      });
    const report = await defineEval<unknown>({
      name: 'metrics-eval',
      app,
      cases: [
        { name: '过', input: 'a', client: scriptedClient([endTurnMsg('ok')]) },
        { name: '挂', input: 'b', client: scriptedClient([endTurnMsg('bad')]) },
      ],
      expect: (r) => {
        assert.equal(r.finalText, 'ok');
      },
    }).run();
    assert.equal(report.ok, false);

    const scores = metrics.snapshot().scores;
    const acc = scores['eval@metrics-eval'];
    assert.ok(acc, `指标里应有 eval 的评分维度，实际只有 ${JSON.stringify(Object.keys(scores))}`);
    assert.equal(acc.count, 2, '两个用例各记一条');
    assert.equal(acc.value, 0, '最近一条是失败的用例');
  });

  it('兜底：自定义 app 漏透传 beforeFlush → 断言照做（不误报「全挂」），只是分数进不了指标', async () => {
    const metrics = metricsSink();
    const real = createApp({
      name: 'eval-app',
      system: new SystemPrompt().add('role', 'r'),
      providers: [],
      sinks: [metrics],
    });
    const ev = defineEval<unknown>({
      name: 'forgetful-eval',
      app: () =>
        ({
          name: 'forgetful',
          // 模拟包装层把不认识的 opts 字段丢掉（宿主转发、自定义 app 都可能）
          run: (m: MessageParam[], o?: RunAppOptions) => {
            const { beforeFlush: _dropped, ...rest } = o ?? {};
            return real.run(m, rest);
          },
        }) as unknown as AgentApp, // 只实现用得到的那部分 —— 鸭子类型
      cases: [{ input: 'a', client: scriptedClient([endTurnMsg('ok')]) }],
      expect: () => {},
    });

    const report = await ev.run();
    // 断言确实跑了（若没有兜底，钩子没被调用 → report 停在初始的 ok:false，
    // 一个「全挂」的报告会让人去查 agent，而问题其实在宿主）
    assert.equal(report.ok, true, report.cases[0]?.error ?? '');
    assert.deepEqual(scoresOf(report.cases[0]!.trace!), [
      { name: 'eval', value: 1, source: 'forgetful-eval' },
    ]);
    assert.deepEqual(
      metrics.snapshot().scores,
      {},
      '晚挂的分数进不了指标（兜底代价，已记在注释里）',
    );
  });
});
