import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from '../../src/index.js';
import type { AgentTool } from '../../src/index.js';
import { RunContext } from '../../src/index.js';
import { InMemoryMemoryStore } from '../../src/run/memory.js';
import type { MemoryStore } from '../../src/run/memory.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const SCHEMA = { type: 'object', properties: {} };

/** 读 blackboard 指定 key 并返回的工具 */
function readTool(key: string): AgentTool {
  return {
    name: 'read_key',
    description: 'd',
    inputSchema: SCHEMA,
    run: () => String(RunContext.current()?.get(key) ?? 'none'),
  };
}

/** 写 blackboard 指定 key 的工具 */
function writeTool(key: string, value: unknown): AgentTool {
  return {
    name: 'write_key',
    description: 'd',
    inputSchema: SCHEMA,
    run: () => {
      RunContext.current()!.set(key, value);
      return 'written';
    },
  };
}

describe('MemoryStore 跨 run 记忆', () => {
  it('run 开始水合进 blackboard：工具内 RunContext.current().get 可读', async () => {
    const store = new InMemoryMemoryStore();
    store.save({ city: '北京' });

    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    const { run } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('city')],
      client,
      memory: { store, keys: ['city'] },
    });

    assert.equal(run.status, 'succeeded');
    assert.ok(JSON.stringify(seen[1]).includes('北京'), '工具读到了水合的记忆值');
  });

  it('run 结束回写：blackboard 当前值 save 回 store，下一次 run 可读到', async () => {
    const store = new InMemoryMemoryStore();

    // 第一次 run：工具写入 count=41
    const first = mockClient([toolUseMsg('write_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool('count', 41)],
      client: first.client,
      memory: { store, keys: ['count'] },
    });
    assert.deepEqual(store.load(['count']), { count: 41 });

    // 第二次 run（同 store）：水合进 blackboard，工具读到上次的值
    const second = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('count')],
      client: second.client,
      memory: { store, keys: ['count'] },
    });
    assert.ok(JSON.stringify(second.seen[1]).includes('41'), '跨 run 读到了上次回写的值');
  });

  it('contextInit 优先于 memory：不覆盖用户种子', async () => {
    const store = new InMemoryMemoryStore();
    store.save({ k: 'fromStore' });

    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('k')],
      client,
      contextInit: (ctx) => ctx.set('k', 'seed'),
      memory: { store, keys: ['k'] },
    });

    assert.ok(JSON.stringify(seen[1]).includes('seed'), 'blackboard 保留 contextInit 种子');
    assert.ok(!JSON.stringify(seen[1]).includes('fromStore'), 'memory 未覆盖同名 key');
    // 回写的是 blackboard 当前值（即种子）
    assert.deepEqual(store.load(['k']), { k: 'seed' });
  });

  it('失败 run 也回写', async () => {
    const store = new InMemoryMemoryStore();
    // 第一回合工具写值，第二回合 client 抛错 → run 失败
    const failing = {
      messages: {
        stream: (() => {
          let n = 0;
          return () => {
            n++;
            return {
              on() {},
              finalMessage: async () => {
                if (n === 1) return toolUseMsg('write_key', {});
                throw new Error('api boom');
              },
            };
          };
        })(),
      },
    };

    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [writeTool('progress', 'half')],
      client: failing as never,
      memory: { store, keys: ['progress'] },
      rethrow: false,
    });

    assert.equal(run.status, 'failed');
    assert.match(result.error?.message ?? '', /api boom/);
    assert.deepEqual(store.load(['progress']), { progress: 'half' });
  });

  it('异步 store（Promise 形态 load/save）同样接线', async () => {
    const data = new Map<string, unknown>([['k', 'async-v']]);
    const saved: Record<string, unknown>[] = [];
    const store: MemoryStore = {
      load: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
      save: async (entries) => {
        saved.push(entries);
        Object.assign(data, entries);
      },
    };

    const { client, seen } = mockClient([toolUseMsg('read_key', {}), endTurnMsg('ok')]);
    await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [readTool('k')],
      client,
      memory: { store, keys: ['k'] },
    });

    assert.ok(JSON.stringify(seen[1]).includes('async-v'));
    assert.deepEqual(saved, [{ k: 'async-v' }]);
  });
});
