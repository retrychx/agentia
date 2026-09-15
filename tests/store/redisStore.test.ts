import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RedisTaskStore } from '../../src/store/redisStore.js';
import type { RedisLike } from '../../src/store/redisStore.js';
import type { TaskRecord, TaskStore } from '../../src/store/store.js';
import { AsyncRunner } from '../../src/transport/async.js';
import type { AppCallable } from '../../src/transport/async.js';
import type { AgentRunResult } from '../../src/engine/types.js';

/** 内存版 RedisLike：Map 实现 get/set/del/keys/scanIterator，驱动全部用例 */
class InMemoryRedisFake implements RedisLike {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async set(key: string, value: string): Promise<string> {
    this.map.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.map.delete(key) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.map.keys()].filter((k) => re.test(k));
  }
  async *scanIterator(opts?: { MATCH?: string }): AsyncIterable<string> {
    for (const k of await this.keys(opts?.MATCH ?? '*')) yield k;
  }
}

/** redis glob（只用 *）→ RegExp */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`));
  return new RegExp(`^${escaped}$`);
}

let n = 0;
function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${++n}`,
    status: 'queued',
    spec: { messages: [{ role: 'user', content: 'a' }] },
    createdAt: 1000 + n,
    ...over,
  };
}

describe('RedisTaskStore（InMemoryRedisFake 驱动）', () => {
  it('save/get/byIdempotency/list/clear 全语义（默认走 scanIterator）', async () => {
    const store = new RedisTaskStore(new InMemoryRedisFake());
    assert.equal(await store.get('nope'), undefined);
    assert.equal(await store.byIdempotency('k'), undefined);
    assert.deepEqual(await store.list(), []);

    // 含嵌套 result/trace 的整行记录 JSON 往返
    const a = rec({
      idempotencyKey: 'k',
      result: {
        stopReason: 'end_turn',
        finalText: 'done',
        iterations: 1,
        trace: { spans: [] },
      } as never,
    });
    const b = rec();
    await store.save(a);
    await store.save(b);
    assert.deepEqual(await store.get(a.taskId), a);
    assert.deepEqual(await store.byIdempotency('k'), a);
    assert.equal((await store.list()).length, 2);

    // save 覆写（last-wins）：同 taskId 推进状态
    const a2 = { ...a, status: 'succeeded' as const };
    await store.save(a2);
    assert.equal((await store.get(a.taskId))?.status, 'succeeded');
    assert.equal((await store.list()).length, 2);

    await store.clear();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get(a.taskId), undefined);
    assert.equal(await store.byIdempotency('k'), undefined);
  });

  it('byIdempotency last-wins：失败重提的新任务覆盖旧记录', async () => {
    const store = new RedisTaskStore(new InMemoryRedisFake());
    const failed = rec({ idempotencyKey: 'k', status: 'failed' });
    await store.save(failed);
    const retried = rec({ idempotencyKey: 'k' });
    await store.save(retried);
    assert.equal((await store.byIdempotency('k'))?.taskId, retried.taskId);
  });

  it('list 序：按 createdAt（同刻按 taskId）稳定排序', async () => {
    const store = new RedisTaskStore(new InMemoryRedisFake());
    const late = rec({ createdAt: 3000 });
    const early = rec({ createdAt: 1000 });
    const sameA = rec({ taskId: 'task_a', createdAt: 2000 });
    const sameB = rec({ taskId: 'task_b', createdAt: 2000 });
    for (const r of [late, early, sameB, sameA]) await store.save(r); // 乱序写入
    assert.deepEqual(
      (await store.list()).map((r) => r.taskId),
      [early.taskId, 'task_a', 'task_b', late.taskId],
    );
  });

  it('keys 兜底：client 无 scanIterator 时 list/clear 走 keys(pattern)', async () => {
    const fake = new InMemoryRedisFake();
    const keysOnly: RedisLike = {
      get: fake.get.bind(fake),
      set: fake.set.bind(fake),
      del: fake.del.bind(fake),
      keys: fake.keys.bind(fake),
    };
    const store = new RedisTaskStore(keysOnly);
    await store.save(rec({ idempotencyKey: 'k' }));
    await store.save(rec());
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.byIdempotency('k'))?.idempotencyKey, 'k');
    await store.clear();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.byIdempotency('k'), undefined);
  });

  it('prefix 隔离：同库两个 store 互不可见；clear 只清本前缀', async () => {
    const fake = new InMemoryRedisFake();
    const s1 = new RedisTaskStore(fake, { prefix: 'app1:' });
    const s2 = new RedisTaskStore(fake, { prefix: 'app2:' });
    const r1 = rec({ idempotencyKey: 'k' });
    const r2 = rec({ idempotencyKey: 'k' });
    await s1.save(r1);
    await s2.save(r2);

    assert.equal((await s1.get(r1.taskId))?.taskId, r1.taskId);
    assert.equal(await s1.get(r2.taskId), undefined);
    assert.equal((await s1.byIdempotency('k'))?.taskId, r1.taskId);
    assert.equal((await s2.byIdempotency('k'))?.taskId, r2.taskId);

    await s1.clear();
    assert.deepEqual(await s1.list(), []);
    assert.equal((await s2.list()).length, 1); // app2: 不受影响
  });

  it('损坏记录按缺失处理（不整库崩）；无 scanIterator/keys 构造抛错', async () => {
    const fake = new InMemoryRedisFake();
    const store = new RedisTaskStore(fake);
    const good = rec();
    await store.save(good);
    fake.map.set('agentia:task:broken', '{not json');
    assert.equal(await store.get('broken'), undefined);
    assert.deepEqual(
      (await store.list()).map((r) => r.taskId),
      [good.taskId],
    );

    const noEnum: RedisLike = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 0,
    };
    assert.throws(() => new RedisTaskStore(noEnum), /scanIterator 或 keys/);
    // 空前缀 = 无命名空间，clear 的 `${prefix}*` 会清掉整个库
    assert.throws(() => new RedisTaskStore(fake, { prefix: '' }), /prefix 不能为空/);
  });

  it('ttlSeconds：记录与幂等索引都经 expire 施加 TTL；缺省不设；负数 / 无 expire 抛错', async () => {
    const inner = new InMemoryRedisFake();
    const calls: string[][] = [];
    const spy: RedisLike = {
      get: (k) => inner.get(k),
      // 只两参：SET 的尾参形状两家相反，TTL **不走这里**（见 RedisTaskStore.write 注释）
      set: async (key, value) => {
        calls.push(['SET', key, value]);
        return inner.set(key, value);
      },
      expire: async (key, seconds) => {
        calls.push(['EXPIRE', key, String(seconds)]);
        return 1;
      },
      del: (k) => inner.del(k),
      keys: (p) => inner.keys(p),
    };

    const ttlStore = new RedisTaskStore(spy, { ttlSeconds: 60 });
    const a = rec({ idempotencyKey: 'k' });
    await ttlStore.save(a);
    // 逐条钉死 argv：node-redis 的 SET 会丢掉位置参数，TTL 只能在 EXPIRE 上
    assert.deepEqual(calls, [
      ['SET', `agentia:task:${a.taskId}`, JSON.stringify(a)],
      ['EXPIRE', `agentia:task:${a.taskId}`, '60'],
      ['SET', 'agentia:idem:k', a.taskId],
      ['EXPIRE', 'agentia:idem:k', '60'],
    ]);

    // 缺省不设 TTL（老行为：记录永不过期）—— 只 SET，一条 EXPIRE 都不发
    calls.length = 0;
    await new RedisTaskStore(spy).save(rec());
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['SET'],
    );

    // 0 也视为不设（便于用 0 明确关闭）
    calls.length = 0;
    await new RedisTaskStore(spy, { ttlSeconds: 0 }).save(rec());
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['SET'],
    );

    assert.throws(() => new RedisTaskStore(spy, { ttlSeconds: -1 }), /ttlSeconds/);
  });

  it('满足 TaskStore 接口（MaybePromise）：await 化后与同步 store 用法一致', async () => {
    const store: TaskStore = new RedisTaskStore(new InMemoryRedisFake());
    const a = rec({ idempotencyKey: 'k' });
    await store.save(a);
    assert.deepEqual(await store.get(a.taskId), a);
    assert.equal((await store.byIdempotency('k'))?.taskId, a.taskId);
    assert.equal((await store.list()).length, 1);
    await store.clear();
    assert.deepEqual(await store.list(), []);
  });

  it('prefix 含 glob 元字符：MATCH 模式里的前缀被转义（否则 list/clear 查错 key）', async () => {
    const fake = new InMemoryRedisFake();
    const patterns: string[] = [];
    const spy: RedisLike = {
      get: (k) => fake.get(k),
      set: (k, v) => fake.set(k, v),
      del: (k) => fake.del(k),
      keys: (p) => {
        patterns.push(p);
        return fake.keys(p);
      },
    };
    const store = new RedisTaskStore(spy, { prefix: 'app[1]:' });
    await store.save(rec({ idempotencyKey: 'k' }));
    await store.list();
    await store.clear();
    assert.ok(
      patterns.every((p) => p.startsWith('app\\[1\\]:')),
      `前缀必须转义，实际模式: ${patterns.join(' | ')}`,
    );
    assert.ok(
      patterns.some((p) => p === 'app\\[1\\]:task:*'),
      'list 的模式应为 转义前缀 + task:*',
    );
  });

  it('接入 AsyncRunner：异步 store 全链路执行 + 执行前去重（采纳 succeeded 结果）', async () => {
    const app: AppCallable & { calls: number } = {
      name: 'fake',
      calls: 0,
      async run() {
        app.calls++;
        return {
          run: { runId: `r-${app.calls}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, { store: new RedisTaskStore(new InMemoryRedisFake()) });

    // submit 同步门面返回新建任务快照；后台经异步 store 推进到终态
    const t1 = runner.submit('a', { idempotencyKey: 'k' });
    assert.equal(t1.status, 'queued');
    const done1 = await runner.awaitTask(t1.taskId);
    assert.equal(done1.status, 'succeeded');
    assert.equal(done1.runId, 'r-1');

    // 同键重提：submit 无法即时去重（Promise），新建任务在执行前采纳上一 succeeded 结果
    const t2 = runner.submit('a', { idempotencyKey: 'k' });
    assert.notEqual(t2.taskId, t1.taskId); // 与同步 store 的即时去重（返回同 taskId）形态不同
    const done2 = await runner.awaitTask(t2.taskId);
    assert.equal(done2.status, 'succeeded');
    assert.equal(done2.runId, 'r-1'); // 采纳既有结果
    assert.equal(app.calls, 1); // 未重复执行

    // poll/list 在异步 store 下返回 Promise，调用方 await
    assert.equal((await runner.poll(t1.taskId))?.status, 'succeeded');
    assert.equal((await runner.list()).length, 2);
    assert.equal(await runner.resumePending(), 0); // 无 queued/running 残留
  });

  it('ttlSeconds: NaN → 抛错（原 `ttl < 0` 放过 NaN，会静默关闭 TTL）', () => {
    assert.throws(
      () => new RedisTaskStore(new InMemoryRedisFake(), { ttlSeconds: Number.NaN }),
      /ttlSeconds/,
    );
  });
});

/**
 * 忠实模拟 ioredis 的参数序列化：变参逐个位置发给服务端。
 * - 对象参数被 String() 成 "[object Object]" → 服务端语法错（真实行为，2026-09 实测
 *   ioredis 6 把 `set(k, v, { EX: 60 })` 发成 `SET k v "[object Object]"`）；
 * - 显式 undefined 尾参被序列化成空串参数 → 语法错；
 * - 合法形态：两参，或 ('EX', 正整数秒)。
 * store 若回退到对象形态，这个 fake 必挂 —— 它就是兼容性的护栏。
 */
class IORedisFake implements RedisLike {
  readonly map = new Map<string, { value: string; ex?: number }>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key)?.value ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]): Promise<string> {
    for (const a of args) {
      if (a === undefined || typeof a === 'object') throw new Error('ERR syntax error');
    }
    if (args.length === 0) {
      this.map.set(key, { value });
    } else if (args.length === 2 && args[0] === 'EX' && Number.isInteger(args[1])) {
      this.map.set(key, { value, ex: args[1] as number });
    } else {
      throw new Error('ERR syntax error');
    }
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.map.delete(key) ? 1 : 0;
  }
  /** ioredis 的 `expire(key, seconds)`：与 node-redis 同名同形，是两家的公共面 */
  async expire(key: string, seconds: number): Promise<number> {
    const cur = this.map.get(key);
    if (!cur) return 0;
    this.map.set(key, { value: cur.value, ex: seconds });
    return 1;
  }
  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.map.keys()].filter((k) => re.test(k));
  }
}

/**
 * 忠实模拟 **node-redis** 的命令序列化 —— 口径来自**实跑它自己的命令定义**，不是推断：
 *
 * ```js
 * // node-redis v4.7.1: @redis/client/dist/lib/commands/SET.js 的 transformArguments
 * // node-redis v6.2.1: 同文件的 parseCommand（v6 更名）
 * transformArguments('k', 'v', { EX: 60 }) → ['SET','k','v','EX','60']   ✅ TTL 生效
 * transformArguments('k', 'v', 'EX', 60)   → ['SET','k','v']             ❌ TTL 被丢
 * ```
 *
 * 根因：SET 的命令定义只声明 `(key, value, options)` **三个形参**，多出来的位置参数被
 * JS 直接丢弃 —— **不报错、不警告**。v4 与 v6 一致。
 *
 * ⚠️ 本 fake 上一版把「对象选项与 legacy 变参**都**接受」写了进去 —— 那是**把假设写成
 * 事实**：store 于是把「位置参数」当成两种客户端的交集，而它在 node-redis 上让 TTL
 * **静默失效**，测试却一直全绿。教训：fake 只能模拟**实测过**的形态，并注明出处与版本。
 */
class NodeRedisFake implements RedisLike {
  readonly map = new Map<string, { value: string; ex?: number }>();
  /** 逐条记录发给服务端的 argv（断言「到底发了什么」用） */
  readonly argv: string[][] = [];

  async get(key: string): Promise<string | null> {
    this.argv.push(['GET', key]);
    return this.map.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<string> {
    this.argv.push(['SET', key, value, ...args.map((a) => String(a))]);
    // 只有 options 对象形态认得 EX；位置参数按真实行为丢弃
    const opts = args[0];
    const ex = typeof opts === 'object' && opts !== null ? (opts as { EX?: number }).EX : undefined;
    this.map.set(key, ex !== undefined ? { value, ex } : { value });
    return 'OK';
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.argv.push(['EXPIRE', key, String(seconds)]);
    const cur = this.map.get(key);
    if (!cur) return 0;
    this.map.set(key, { value: cur.value, ex: seconds });
    return 1;
  }

  async del(key: string): Promise<number> {
    this.argv.push(['DEL', key]);
    return this.map.delete(key) ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.map.keys()].filter((k) => re.test(k));
  }
}

describe('node-redis 的 SET 只认 options 对象 —— TTL 必须走 expire（实测口径 2026-09-15）', () => {
  it('ttlSeconds > 0：TTL 落到记录与幂等索引上；SET 只许两参（位置参数 TTL 会被静默丢弃）', async () => {
    const client = new NodeRedisFake();
    const store = new RedisTaskStore(client, { prefix: 'nr:', ttlSeconds: 60 });
    const a = rec({ idempotencyKey: 'k' });
    await store.save(a);

    assert.equal(client.map.get(`nr:task:${a.taskId}`)?.ex, 60, 'task 记录必须带 TTL');
    assert.equal(client.map.get('nr:idem:k')?.ex, 60, '幂等索引必须带 TTL');

    // 反向断言：TTL 不得借 SET 的位置参数表达 —— node-redis 会整段丢掉而不报错
    const sets = client.argv.filter((c) => c[0] === 'SET');
    assert.ok(
      sets.every((c) => c.length === 3),
      `SET 只能收 (key, value) 两参，实际发了：${JSON.stringify(sets)}`,
    );
    assert.deepEqual(
      client.argv.filter((c) => c[0] === 'EXPIRE'),
      [
        ['EXPIRE', `nr:task:${a.taskId}`, '60'],
        ['EXPIRE', 'nr:idem:k', '60'],
      ],
      'TTL 必须经 EXPIRE 逐键施加',
    );
  });

  it('无 ttlSeconds：一条 EXPIRE 都不发（记录永不过期，保持既有缺省）', async () => {
    const client = new NodeRedisFake();
    await new RedisTaskStore(client, { prefix: 'nr:' }).save(rec());
    assert.equal(client.argv.filter((c) => c[0] === 'EXPIRE').length, 0);
  });

  it('ttlSeconds > 0 但客户端没有 expire：构造期抛错（不许静默把 TTL 关掉）', () => {
    const noExpire: RedisLike = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 0,
      keys: async () => [],
    };
    assert.throws(
      () => new RedisTaskStore(noExpire, { ttlSeconds: 60 }),
      /expire/,
      '没有 expire 就设 TTL 会静默失效 —— 必须启动期响亮失败',
    );
    // 不设 TTL 时不需要 expire
    assert.doesNotThrow(() => new RedisTaskStore(noExpire));
  });
});

describe('RedisTaskStore 客户端形态兼容（ioredis / node-redis 真实参数形态）', () => {
  for (const [name, make] of [
    ['ioredis', () => new IORedisFake()],
    ['node-redis', () => new NodeRedisFake()],
  ] as const) {
    it(`${name}：无 TTL（只 SET 两参）与带 TTL（SET + EXPIRE）全链路`, async () => {
      const client = make();
      // 无 TTL：只传两参（显式 undefined 会被 ioredis 序列化成空串 → 语法错）
      const plain = new RedisTaskStore(client, { prefix: `${name}:` });
      const a = rec({ idempotencyKey: 'k' });
      await plain.save(a);
      assert.deepEqual(await plain.get(a.taskId), a, `${name}: 无 TTL 读写`);
      assert.equal((await plain.byIdempotency('k'))?.taskId, a.taskId);
      assert.equal((await plain.list()).length, 1);

      // 带 TTL：SET + EXPIRE 在两家客户端上都真的生效；记录与幂等索引都带 TTL
      const ttlStore = new RedisTaskStore(client, { prefix: `${name}:`, ttlSeconds: 60 });
      const b = rec({ idempotencyKey: 'k2' });
      await ttlStore.save(b);
      assert.deepEqual(await ttlStore.get(b.taskId), b, `${name}: 带 TTL 读写`);
      assert.equal(client.map.get(`${name}:task:${b.taskId}`)?.ex, 60);
      assert.equal(client.map.get(`${name}:idem:k2`)?.ex, 60);
    });
  }

  it('ioredis 形态 + TTL 接入 AsyncRunner：任务跑到终态（原对象形态 SET 全挂、任务全 failed、store 零记录）', async () => {
    const app: AppCallable & { calls: number } = {
      name: 'fake',
      calls: 0,
      async run() {
        app.calls++;
        return {
          run: { runId: `r-${app.calls}`, status: 'succeeded' as const },
          result: {} as AgentRunResult,
        };
      },
    };
    const runner = new AsyncRunner(app, {
      store: new RedisTaskStore(new IORedisFake(), { ttlSeconds: 300 }),
    });
    const t = runner.submit('a', { idempotencyKey: 'k' });
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.runId, 'r-1');
    assert.equal((await runner.list()).length, 1, '记录必须真实落进 store');
  });
});
