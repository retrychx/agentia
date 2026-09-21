import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpHandler } from '../../src/transport/http.js';
import { AsyncRunner } from '../../src/transport/async.js';
import { InMemoryTaskStore } from '../../src/store/store.js';
import { createApp, SystemPrompt, scriptedClient } from '../../src/index.js';

/**
 * `GET /tasks/:id/stream`（增量 trace 出口的传输层那一半）。
 *
 * 这一层要守的语义与纯件（`task-events.test.ts`）不同：纯件守**缓冲与序号**，
 * 这里守**连上时的行为** —— 从头重放、`Last-Event-ID` 续订、终态收口、未知任务 404、
 * 跨进程不假装实时、**背压/断开不把任务拖下水**。
 *
 * 订阅者清理（断开后从表里摘掉）在 `task-events.test.ts` 里对着纯件验（那里能直接数），
 * 这里验的是**行为后果**：客户端跑了，任务照常跑完。
 */

interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

/** 开一条 SSE 连接，边读边攒帧；`close()` 主动断开（模拟客户端跑了） */
async function openSse(base: string, path: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: ac.signal });
  const frames: SseFrame[] = [];
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    const reader = res.body!.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut = buf.indexOf('\n\n');
        while (cut >= 0) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (!raw.startsWith(':')) {
            const f: SseFrame = { event: '', data: undefined };
            for (const line of raw.split('\n')) {
              const i = line.indexOf(':');
              const k = line.slice(0, i);
              const v = line.slice(i + 1).replace(/^ /, '');
              if (k === 'id') f.id = v;
              else if (k === 'event') f.event = v;
              else if (k === 'data') f.data = JSON.parse(v);
            }
            frames.push(f);
          }
          cut = buf.indexOf('\n\n');
        }
      }
    } catch {
      /* 主动断开：body 读取会 reject，属预期 */
    }
  })();
  return { frames, pump, res, close: () => ac.abort() };
}

async function until(cond: () => boolean, ms = 3000, what = '条件'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 关服务器。⚠️ 必须先 `closeAllConnections()`：SSE 是长连，响应结束后 socket 仍留在
 * keep-alive 池里 ⇒ 只 `close()` 会让 `server.close()` 的回调**永远等不到**（用例全绿但
 * 进程不退出，表现为「跑测试的命令挂着不动」）。
 */
const closeServer = (s: Server): Promise<void> =>
  new Promise((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });

/** 一个可控模型：`finalMessage` 卡在闸门上，于是「运行中」这个状态是确定性的（不靠 sleep 猜） */
function gatedClient(gate: Promise<void>) {
  return scriptedClient([
    async () => {
      await gate;
      return {
        id: 'm1',
        model: 'claude-opus-5',
        stop_reason: 'end_turn' as const,
        usage: { input_tokens: 3, output_tokens: 2 },
        content: [{ type: 'text', text: '完成' }],
      };
    },
  ] as never);
}

async function setup(gate: Promise<void>) {
  const app = await createApp({
    name: 'task-stream',
    system: new SystemPrompt().add('role', '助手。', true),
  });
  const store = new InMemoryTaskStore();
  const runner = new AsyncRunner(app, { store, client: gatedClient(gate) });
  const server = createServer(createHttpHandler(app, { runner }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server, store, runner };
}

async function submit(base: string): Promise<string> {
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: '跑一次' }),
  });
  assert.equal(res.status, 202, '提交任务应回 202');
  return ((await res.json()) as { taskId: string }).taskId;
}

describe('GET /tasks/:id/stream（异步任务的增量事件流）', () => {
  it('实时推送 + 从头重放 + 终态以 task.end 收口并关流', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { base, server } = await setup(gate);
    try {
      const taskId = await submit(base);
      // 等 run 真的开跑（run 根 span 已建）再连 —— 这样「重放」才有东西可放
      await until(() => true, 1, 'noop');
      const s = await openSse(base, `/tasks/${taskId}/stream`);
      await until(() => s.frames.length >= 2, 3000, '重放帧');
      assert.equal(s.frames[0]!.event, 'trace.event', '第一帧应是记账事件');
      assert.ok(s.frames[0]!.id, 'trace.event 帧必须带 id（SSE 续订锚点）');
      const begins = s.frames.filter(
        (f) => f.event === 'trace.event' && (f.data as { type: string }).type === 'span.begin',
      );
      assert.ok(begins.length >= 1, '重放里没有 run 根 span.begin —— 连晚了就丢前缀');
      assert.deepEqual(
        (begins[0]!.data as { span: { kind: string } }).span.kind,
        'run',
        '第一条 span.begin 应是 run 根',
      );

      release();
      await until(() => s.frames.some((f) => f.event === 'task.end'), 3000, 'task.end');
      const last = s.frames[s.frames.length - 1]!;
      assert.equal(last.event, 'task.end');
      assert.equal((last.data as { status: string }).status, 'succeeded');
      // 帧序号严格递增（重放 + 实时拼成一条连续的流）
      const ids = s.frames.filter((f) => f.id).map((f) => Number(f.id));
      assert.deepEqual(
        ids,
        [...ids].sort((a, b) => a - b),
        '流序号必须单调',
      );
      assert.equal(new Set(ids).size, ids.length, '流序号不得重复');
      // 终态收口：连接被服务端关掉（pump 自然结束）
      await Promise.race([
        s.pump,
        new Promise((_, rej) => setTimeout(() => rej(new Error('流没关')), 3000)),
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it('Last-Event-ID 续订：只补它之后的事件（断了重连不会从头再来）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { base, server } = await setup(gate);
    try {
      const taskId = await submit(base);
      const first = await openSse(base, `/tasks/${taskId}/stream`);
      await until(() => first.frames.length >= 3, 3000, '至少 3 帧');
      const seenIds = first.frames.filter((f) => f.id).map((f) => Number(f.id));
      const anchor = seenIds[0]!;

      const second = await openSse(base, `/tasks/${taskId}/stream`, {
        'last-event-id': String(anchor),
      });
      await until(() => second.frames.filter((f) => f.id).length >= 1, 3000, '续订后的帧');
      const resumedIds = second.frames.filter((f) => f.id).map((f) => Number(f.id));
      assert.ok(
        resumedIds.every((i) => i > anchor),
        `续订应只给 > ${anchor} 的事件，实际给了 ${JSON.stringify(resumedIds)}`,
      );
      assert.ok(!resumedIds.includes(anchor), '续订把锚点那条又发了一遍 —— 客户端会看到重复事件');
      first.close();
      second.close();
      release();
    } finally {
      await closeServer(server);
    }
  });

  it('任务不存在 → 404（不是一条永远挂着 200 的空流）', async () => {
    const { base, server } = await setup(Promise.resolve());
    try {
      const res = await fetch(`${base}/tasks/nope/stream`);
      assert.equal(res.status, 404);
      await res.body?.cancel();
    } finally {
      await closeServer(server);
    }
  });

  it('POST /tasks/:id/stream → 405（方法不对，与既有路由口径一致）', async () => {
    const { base, server } = await setup(Promise.resolve());
    try {
      const res = await fetch(`${base}/tasks/x/stream`, { method: 'POST' });
      assert.equal(res.status, 405);
      await res.body?.cancel();
    } finally {
      await closeServer(server);
    }
  });

  it('跨进程（同一 store、另一 runner）：stream.unavailable + task.end，不假装实时', async () => {
    const { base, server, store } = await setup(Promise.resolve());
    try {
      const taskId = await submit(base);
      // 等任务跑完（终态）
      await until(() => true, 1, 'noop');
      await new Promise((r) => setTimeout(r, 50));

      // 模拟「另一个进程」：同一个 store、另一台 runner（它的内存里没有这条任务的流）
      const app2 = await createApp({
        name: 'task-stream-2',
        system: new SystemPrompt().add('role', '助手。', true),
      });
      const runner2 = new AsyncRunner(app2, { store });
      const server2 = createServer(createHttpHandler(app2, { runner: runner2 }));
      await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
      const { port } = server2.address() as AddressInfo;
      const s = await openSse(`http://127.0.0.1:${port}`, `/tasks/${taskId}/stream`);
      await until(() => s.frames.some((f) => f.event === 'task.end'), 3000, 'task.end');
      const names = s.frames.map((f) => f.event);
      assert.ok(
        names.includes('stream.unavailable'),
        '别的进程没有这条流时必须明说 —— 静默给一条空流会被读成「任务什么都没干」',
      );
      assert.equal(
        s.frames.filter((f) => f.event === 'trace.event').length,
        0,
        '跨进程时不该凭空造出记账事件',
      );
      await closeServer(server2);
      s.close();
    } finally {
      await closeServer(server);
    }
  });

  it('跨进程 + 非终态：unavailable 后立即收口（stream.closed + 关连接），不留心跳鬼流', async () => {
    // 反向验证：摘掉 async.ts 跨进程分支的 `closed` 补帧 ⇒ 这条 SSE 只剩心跳永远挂着，
    // 下面「pump 读到流尾」的断言超时变红。
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 任务卡在闸门上 ⇒ 稳定在 running（非终态），不靠 sleep 猜
    const { base, server, store } = await setup(gate);
    try {
      const taskId = await submit(base);

      // 模拟「另一个进程」：同一个 store、另一台 runner（它的内存里没有这条任务的流）
      const app2 = await createApp({
        name: 'task-stream-live-2',
        system: new SystemPrompt().add('role', '助手。', true),
      });
      const runner2 = new AsyncRunner(app2, { store });
      const server2 = createServer(createHttpHandler(app2, { runner: runner2 }));
      await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
      const { port } = server2.address() as AddressInfo;
      try {
        const s = await openSse(`http://127.0.0.1:${port}`, `/tasks/${taskId}/stream`);
        await until(() => s.frames.some((f) => f.event === 'stream.closed'), 3000, 'stream.closed');
        const names = s.frames.map((f) => f.event);
        assert.ok(
          names.includes('stream.unavailable'),
          '别的进程没有这条流时必须明说 —— 静默给一条空流会被读成「任务什么都没干」',
        );
        assert.ok(
          names.indexOf('stream.unavailable') < names.indexOf('stream.closed'),
          '必须先交代 unavailable（为什么没有实时流）再收口',
        );
        assert.ok(
          !names.includes('task.end'),
          '任务还在跑（非终态）—— 发 task.end 是伪造终态，客户端会以为它跑完了',
        );
        // 收口的核心证据：服务端关连接，客户端读到流尾（只剩心跳的旧行为会在这里超时）
        await Promise.race([
          s.pump,
          new Promise((_, rej) => setTimeout(() => rej(new Error('流没关')), 3000)),
        ]);
      } finally {
        await closeServer(server2);
      }
    } finally {
      release(); // 放掉卡住的任务，让 runner 干净收尾
      await closeServer(server);
    }
  });

  it('客户端中途断开：任务照常跑完（旁观者不该把任务拖下水）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { base, server, runner } = await setup(gate);
    try {
      const taskId = await submit(base);
      const s = await openSse(base, `/tasks/${taskId}/stream`);
      await until(() => s.frames.length >= 1, 3000, '第一帧');
      s.close(); // 看的人跑了
      await new Promise((r) => setTimeout(r, 30));
      release();
      // 任务必须照常收尾（对照 /run 的 SSE：那里背压/断开是 abort run —— 因为流的读者
      // 就是 run 的所有者；这里的读者是旁观者，语义不同）
      await until(() => runner.inFlight === 0, 3000, '任务跑完');
      const res = await fetch(`${base}/tasks/${taskId}`);
      assert.equal(
        ((await res.json()) as { status: string }).status,
        'succeeded',
        '任务被断开的观众拖挂了',
      );
    } finally {
      await closeServer(server);
    }
  });

  it('同步 POST /run 的 SSE 也带记账事件（既有三帧逐字不变）', async () => {
    const app = await createApp({
      name: 'run-sse',
      system: new SystemPrompt().add('role', '助手。', true),
    });
    const server = createServer(createHttpHandler(app));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      });
      const text = await res.text();
      const names = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]!);
      assert.ok(names.includes('trace.event'), '新增的记账帧没下发');
      assert.ok(names.includes('run.end'), '既有帧 run.end 丢了（向后兼容破了）');
      assert.ok(
        text.includes('"type":"span.begin"'),
        'trace.event 的 body 应是 TraceRecordEvent（含 type）',
      );
    } finally {
      await closeServer(server);
    }
  });
});
