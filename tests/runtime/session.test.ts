import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { executeRun, InMemorySessionStore } from '../../src/index.js';
import type { SessionStore } from '../../src/index.js';
import { endTurnMsg } from '../helpers.js';

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text });

/**
 * 记录**发送时刻** messages 快照的 client。
 *
 * 不能用 helpers 的 mockClient：它 push 的是 params **引用**，而主循环会往同一个
 * messages 数组里继续 push（assistant / tool_result）—— 于是 `seen[0].messages`
 * 是「跑完后的最终态」，拿它断言「发出去的是什么」会永远看到多出来的那一轮。
 */
function capturingClient(script: Array<Record<string, unknown>>) {
  const sent: Anthropic.MessageParam[][] = [];
  let i = 0;
  return {
    sent,
    client: {
      messages: {
        stream: (params: { messages: Anthropic.MessageParam[] }) => {
          sent.push(structuredClone(params.messages));
          return {
            on() {},
            finalMessage: async () => {
              const step = script[i++];
              if (!step) throw new Error(`mock 脚本耗尽（第 ${i} 次调用）`);
              return step;
            },
          };
        },
      },
    } as never,
  };
}

/** 记录每次 append 的 spy store（底层用 InMemorySessionStore） */
function spyStore(inner = new InMemorySessionStore()) {
  const appends: Array<{ id: string; messages: Anthropic.MessageParam[] }> = [];
  const store: SessionStore = {
    load: (id) => inner.load(id),
    append: (id, messages) => {
      appends.push({ id, messages });
      return inner.append(id, messages);
    },
  };
  return { store, inner, appends };
}

describe('InMemorySessionStore（C4）', () => {
  it('无历史 → 空数组；append 后可读回', () => {
    const s = new InMemorySessionStore();
    assert.deepEqual(s.load('a'), []);
    s.append('a', [user('hi')]);
    assert.deepEqual(s.load('a'), [user('hi')]);
    assert.deepEqual(s.load('b'), [], '会话之间互不干扰');
  });

  it('append 是追加而非覆盖；load 返回副本（调用方的 push 不得污染 store）', () => {
    const s = new InMemorySessionStore();
    s.append('a', [user('1')]);
    s.append('a', [user('2')]);
    assert.equal(s.load('a').length, 2);
    const got = s.load('a');
    got.push(user('3')); // 调用方拿着它继续 push（run 内部就是这么干的）
    assert.equal(s.load('a').length, 2, 'load 必须给副本，否则历史被 run 悄悄改写');
  });
});

describe('会话持久化接进 executeRun（C4）', () => {
  it('首轮：无历史 → 只发本轮 messages；成功收尾后写回 [本轮, 回复]', async () => {
    const { store, inner, appends } = spyStore();
    const { client, sent } = capturingClient([endTurnMsg('你好呀')]);
    await executeRun({ messages: [user('你好')], client, session: { store, id: 's1' } });
    assert.deepEqual(sent[0], [user('你好')], '首轮不该多出历史');
    assert.equal(appends.length, 1);
    assert.equal(appends[0].id, 's1');
    assert.deepEqual(appends[0].messages, [user('你好'), { role: 'assistant', content: '你好呀' }]);
    assert.deepEqual(inner.load('s1'), appends[0].messages, '历史真的落进 store');
  });

  it('第二轮：历史拼在传入 messages **之前**（顺序是理解上下文的关键）', async () => {
    const { store } = spyStore();
    const c1 = capturingClient([endTurnMsg('第一答')]);
    await executeRun({ messages: [user('第一问')], client: c1.client, session: { store, id: 's1' } });

    const c2 = capturingClient([endTurnMsg('第二答')]);
    await executeRun({ messages: [user('第二问')], client: c2.client, session: { store, id: 's1' } });
    assert.deepEqual(
      c2.sent[0],
      [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ],
      '历史在前、本轮在后，且角色严格交替（否则下一轮会撞 API 校验）',
    );
  });

  it('会话互相隔离：不同 id 不串历史', async () => {
    const { store } = spyStore();
    const c1 = capturingClient([endTurnMsg('A 的答')]);
    await executeRun({ messages: [user('A')], client: c1.client, session: { store, id: 'a' } });
    const c2 = capturingClient([endTurnMsg('B 的答')]);
    await executeRun({ messages: [user('B')], client: c2.client, session: { store, id: 'b' } });
    assert.deepEqual(c2.sent[0], [user('B')], 'b 会话不该看到 a 的历史');
  });

  it('没跑完的轮次**不**回写（否则历史会以 user 结尾，下一轮变连续两条 user）', async () => {
    const { store, appends } = spyStore();
    const { client } = capturingClient([]); // 脚本耗尽 → stopReason='error'
    const { run, result } = await executeRun({
      messages: [user('会失败')],
      client,
      session: { store, id: 's1' },
      rethrow: false,
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(run.status, 'failed');
    assert.equal(appends.length, 0, '没跑完的轮次不进会话历史');
    assert.deepEqual(store.load('s1'), []);
  });

  it('空回复也补一条占位，保住「历史以 assistant 结尾」', async () => {
    const { store, appends } = spyStore();
    const { client } = capturingClient([
      {
        id: 'm',
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [], // 没有任何文本块
      },
    ]);
    const { result } = await executeRun({ messages: [user('q')], client, session: { store, id: 's1' } });
    assert.equal(result.finalText, '');
    assert.equal(appends[0].messages.length, 2);
    assert.equal(appends[0].messages[1].role, 'assistant');
    assert.ok(String((appends[0].messages[1] as { content: string }).content).length > 0);
  });

  it('历史读/写都挂了 → 照样跑完（辅助动作不击穿 run）', async () => {
    const store: SessionStore = {
      load: () => {
        throw new Error('redis down');
      },
      append: () => {
        throw new Error('redis down');
      },
    };
    const { client, sent } = capturingClient([endTurnMsg('照样跑完')]);
    const { run, result } = await executeRun({ messages: [user('q')], client, session: { store, id: 's1' } });
    assert.equal(run.status, 'succeeded');
    assert.equal(result.finalText, '照样跑完');
    assert.deepEqual(sent[0], [user('q')], '读不到历史就当没有，消息照发');
  });

  it('不配 session → 逐字保持旧行为（只发传入的 messages）', async () => {
    const { client, sent } = capturingClient([endTurnMsg('ok')]);
    await executeRun({ messages: [user('q')], client });
    assert.deepEqual(sent[0], [user('q')]);
  });
});
