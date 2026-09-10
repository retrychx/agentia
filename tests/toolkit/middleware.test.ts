import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SystemPrompt, Tool } from '../../src/index.js';
import type { UnitMiddleware } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;
const sys = () => new SystemPrompt().add('role', 'r', true);

class Echo {
  @Tool({ description: 'd', schema: OBJ })
  echo(input: unknown): string {
    return `echo:${JSON.stringify(input)}`;
  }
}

describe('单元调用中间件（R1）', () => {
  it('洋葱模型：链序 = 注册顺序，next 前后都能切面', async () => {
    const log: string[] = [];
    const m1: UnitMiddleware = async (call, next) => {
      log.push(`m1-before:${call.unit.name}`);
      const out = await next();
      log.push('m1-after');
      return out;
    };
    const m2: UnitMiddleware = async (call, next) => {
      log.push('m2-before');
      const out = await next();
      log.push('m2-after');
      return out;
    };
    const app = createApp({
      providers: [{ provide: 'e', useClass: Echo }],
      system: sys(),
      middleware: [m1, m2],
    });
    const { client } = mockClient([toolUseMsg('echo', { a: 1 }), endTurnMsg('ok')]);
    await app.run([{ role: 'user', content: 'go' }], { client });
    assert.deepEqual(log, ['m1-before:echo', 'm2-before', 'm2-after', 'm1-after']);
  });

  it('next(newInput) 改写入参；不调 next 短路（结果缓存）', async () => {
    const rewrite: UnitMiddleware = (call, next) => next({ replaced: true });
    const app = createApp({
      providers: [{ provide: 'e', useClass: Echo }],
      system: sys(),
      middleware: [rewrite],
    });
    const { client, seen } = mockClient([toolUseMsg('echo', { a: 1 }), endTurnMsg('ok')]);
    await app.run([{ role: 'user', content: 'go' }], { client });
    assert.ok(JSON.stringify(seen[1]).includes('replaced'), '单元应收到改写后的入参');

    let calls = 0;
    class Count {
      @Tool({ description: 'd', schema: OBJ })
      probe(): string {
        calls++;
        return 'real';
      }
    }
    const cache: UnitMiddleware = () => 'cached!';
    const app2 = createApp({
      providers: [{ provide: 'c', useClass: Count }],
      system: sys(),
      middleware: [cache],
    });
    const m2 = mockClient([toolUseMsg('probe', {}), endTurnMsg('ok')]);
    const { result } = await app2.run([{ role: 'user', content: 'go' }], { client: m2.client });
    assert.equal(calls, 0, '短路时单元执行体不被调用');
    assert.ok(JSON.stringify(m2.seen[1]).includes('cached!'), '短路结果应回给模型');
    void result;
  });

  it('中间件抛错按单元失败处理（is_error 回模型，run 不中断）', async () => {
    const guard: UnitMiddleware = () => {
      throw new Error('forbidden');
    };
    const app = createApp({
      providers: [{ provide: 'e', useClass: Echo }],
      system: sys(),
      middleware: [guard],
    });
    const { client, seen } = mockClient([toolUseMsg('echo', {}), endTurnMsg('ok')]);
    const { run } = await app.run([{ role: 'user', content: 'go' }], { client });
    assert.equal(run.status, 'succeeded');
    assert.ok(JSON.stringify(seen[1]).includes('forbidden'));
    assert.ok(JSON.stringify(seen[1]).includes('is_error'));
  });

  it('孤儿单元告警：toolSources 收窄时被排除 provider 的单元不可达', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      class Idle {
        @Tool({ description: 'd', schema: OBJ })
        idle(): string {
          return 'x';
        }
      }
      createApp({
        providers: [
          { provide: 'e', useClass: Echo },
          { provide: 'idle', useClass: Idle },
        ],
        toolSources: ['e'],
        system: sys(),
      });
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /孤儿单元.*idle/);
  });
});
