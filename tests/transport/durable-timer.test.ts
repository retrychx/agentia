import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncRunner, InMemoryTaskStore, executeRun } from '../../src/index.js';
import type { AgentTool, AppCallable, TaskRecord } from '../../src/index.js';
import { createHttpHandler } from '../../src/transport/http.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

/**
 * 时间挂起（durable timer）**宿主侧**：submit → 睡到某时刻 → 到期唤醒 → 重跑那一批。
 *
 * 三件事是本文件存在的理由（都是「不写用例就永远不知道它成立」的那类）：
 * ① 到期唤醒与审批超时是**两条互斥的闸**（原因不同）—— 互相不许越界；
 * ② `drain()` 之后不许唤醒（配套 5）：停机窗口等一条天级 run = 部署卡死；
 * ③ `/healthz` 的挂起读数（配套 6）与它的**口径**（本进程；按原因分组；空给 null 不给 0）。
 *
 * 应用侧走**真引擎**（executeRun + mockClient），与 approval.test.ts 同一条纪律：
 * 宿主测试用假 app 会漏掉「引擎与宿主的交界」，那边已经咬过人。
 */

const OBJ = { type: 'object', properties: {} } as const;

/** 等时刻的工具开关（`at === null` = 时刻到了，本次不再请求延后） */
interface Gate {
  at: number | null;
}

function timerApp(
  script: Array<Record<string, unknown>>,
  spy: { calls: number },
  gate: Gate,
): { app: AppCallable } {
  const { client } = mockClient(script);
  const tools: AgentTool[] = [
    {
      name: 'wait_for_batch',
      description: '等批处理作业',
      inputSchema: OBJ,
      run: (_input, ctx) => {
        spy.calls++;
        if (gate.at !== null) {
          ctx!.deferUntil!(gate.at);
          return 'deferred';
        }
        return 'ready';
      },
    },
  ];
  return {
    app: {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
    },
  };
}

async function waitStatus(
  runner: AsyncRunner,
  taskId: string,
  status: string,
): Promise<TaskRecord> {
  // ⚠️ helpers 的 waitFor 只收**同步**条件（传 async 函数会让 Promise 恒 truthy、立即放行）
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = await runner.poll(taskId);
    if (rec?.status === status) return rec;
    if (Date.now() > deadline) {
      throw new Error(`等任务 ${taskId} 进入 ${status} 超时（当前 ${rec?.status}）`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 把记录的目标时刻**倒填**到过去 = 确定性地模拟「时间到了」。
 * 不睡墙钟：这类用例要验的是「到点这条判据成不成立」，不是「时钟走得多准」——
 * 真睡 30ms 会把「调度慢」误判成「唤醒坏了」（CI 满载下最难查的那类红）。
 */
async function backdate(runner: AsyncRunner, taskId: string, deltaMs = 1): Promise<void> {
  const rec = await runner.store.get(taskId);
  assert.ok(rec, `任务应存在：${taskId}`);
  rec.wakeAt = Date.now() - deltaMs;
  await runner.store.save(rec);
}

async function listen(
  app: AppCallable,
  opts: { runner: AsyncRunner },
): Promise<{ server: Server; base: string }> {
  const server = createServer(createHttpHandler(app, { runner: opts.runner }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

// biome-ignore lint/suspicious/noExplicitAny: 端点回的是运行时数据，逐字段断言时不必先窄化 unknown
const readJson = (res: Response): Promise<any> => res.json();

describe('AsyncRunner 时间挂起（durable timer）', () => {
  it('submit → 睡下：原因/目标时刻/在等的那条 tool_use 落库，不占在飞，读数进位', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const sinkCalls: string[] = [];
    // concurrency=1：挂起若占槽位，第二个任务永远排不到
    const runner = new AsyncRunner(app, {
      concurrency: 1,
      // 块体（不是表达式体）：`push` 返回 number，表达式体会让返回类型不合 TaskSink 的 `void | Promise<void>`
      taskSinks: [
        {
          onFinished: (rec) => {
            sinkCalls.push(rec.status);
          },
        },
      ],
    });

    const t1 = runner.submit('睡到明天');
    const rec = await waitStatus(runner, t1.taskId, 'suspended');
    assert.equal(rec.suspendedReason, 'timer', '挂起原因是「等一个时刻」');
    assert.equal(rec.wakeAt, gate.at, '目标时刻随记录落库（它要活得比进程久）');
    assert.deepEqual(rec.pendingApprovals, ['tu1'], '在等的是这条 tool_use');
    assert.equal(typeof rec.suspendedSince, 'number', '挂起时刻照旧落库（两条闸都用得上）');
    assert.equal(rec.finishedAt, undefined, '挂起不是终态：finishedAt 不置');
    assert.equal(runner.inFlight, 0, '挂起不占在飞计数（槽位已释放）');
    assert.deepEqual(sinkCalls, [], '挂起不触发 onFinished（它不是终态）');
    assert.deepEqual(runner.suspendedSummary, {
      approval: 0,
      timer: 1,
      nextWakeAt: gate.at,
    });

    // 槽位真空出来了：第二件事在 concurrency=1 下照常跑完
    const t2 = runner.submit('另一件');
    assert.equal((await runner.awaitTask(t2.taskId)).status, 'succeeded');
    assert.deepEqual(sinkCalls, ['succeeded'], '只有 t2 开火；t1 还在睡');
  });

  it('未到点不捡；到点唤醒并**重跑那一批**，收尾清掉挂起痕迹与读数', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const runner = new AsyncRunner(app);
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    assert.equal(runner.resumePending(), 0, '还没到点：扫描不捡它（它是「在等」，不是孤儿）');
    assert.equal((await runner.poll(t.taskId))!.status, 'suspended', '惰性路径同样不叫醒');

    await backdate(runner, t.taskId); // 时间到了
    gate.at = null; // 条件也成熟了（gate 是「批处理作业跑完了没」的替身）
    assert.equal(runner.resumePending(), 1, '到点：这一次扫描唤醒并重派');
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls, 2, '醒来**重跑**了那一批（gate 已放开 ⇒ 拿到真结果接着走）');
    assert.equal(done.wakeAt, undefined, '醒来后目标时刻清掉');
    assert.equal(done.suspendedReason, undefined, '挂起痕迹一并清掉');
    assert.deepEqual(
      runner.suspendedSummary,
      { approval: 0, timer: 0, nextWakeAt: null },
      '读数除名（空队列给 null 不给 0）',
    );
  });

  it('drain 之后不唤醒（配套 5）；换一个进程/新 runner 扫同一份 store 则**必须**唤醒', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const store = new InMemoryTaskStore();
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    assert.equal(await runner.drain({ timeoutMs: 500 }), true, '睡着的任务不挡排空（它不占在飞）');
    await backdate(runner, t.taskId, 1_000);
    assert.equal(runner.resumePending(), 0, '停机窗口里到点也不叫醒 —— 部署不该卡在天级 run 上');
    assert.equal((await runner.poll(t.taskId))!.status, 'suspended', '惰性路径也守这道闸');
    assert.equal(spy.calls, 1, '工具没有被叫起来第二遍');

    // 阳性对照（否则上面那三句可能是靠「这任务本来就醒不了」蒙对的）：
    // 新 runner + 同一个 store = 重启后新进程的首次扫描，它必须唤醒并续跑
    gate.at = null; // 条件成熟（模拟那条批处理作业终于跑完）
    const revived = new AsyncRunner(app, { store });
    assert.equal(revived.resumePending(), 1, '新进程照常唤醒（停机窗口早过去了）');
    const done = await revived.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls, 2, '重跑那一批');
  });

  it('审批超时不误伤时间挂起（runner 级：不重派、工具不再执行）；对照：换成 approval 原因就会被兜底', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    // approvalTimeoutMs=1ms：任何「等人工」的挂起都会立刻被判超时
    const runner = new AsyncRunner(app, { approvalTimeoutMs: 1 });
    const t = runner.submit('睡到明天');
    const rec = await waitStatus(runner, t.taskId, 'suspended');
    await runner.store.save({ ...rec, suspendedSince: Date.now() - 3_600_000 }); // 挂了一小时

    const after = await runner.poll(t.taskId);
    assert.equal(after!.status, 'suspended', '配了审批超时也不许提前叫醒它');
    assert.equal(after!.wakeAt, gate.at, '目标时刻没被动过');
    assert.equal(spy.calls, 1, '没有被重派（工具不会再跑一遍）');

    // 对照：同一条记录只把**原因**换成 approval ⇒ 同一把闸立刻生效（补 deny + 重派）
    await runner.store.save({ ...after!, suspendedReason: 'approval' });
    const expired = await runner.poll(t.taskId);
    assert.notEqual(expired!.status, 'suspended', '等人工的挂起照旧被判超时、恢复执行');
    assert.equal(expired!.approvals?.tu1?.approved, false, '框架兜底的拒绝（人没来）');
    assert.equal(spy.calls, 1, '被拒的调用不执行工具体（denied 走 is_error 的 tool_result）');
  });

  it('/healthz 的 suspended 段：空载给 null；按原因分组；读数由扫描按 store 对齐', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('到位了')],
      spy,
      gate,
    );
    const store = new InMemoryTaskStore();
    const runner = new AsyncRunner(app, { store });
    const { server, base } = await listen(app, { runner });
    try {
      const empty = await readJson(await fetch(`${base}/healthz`));
      assert.deepEqual(
        empty.suspended,
        { approval: 0, timer: 0, nextWakeAt: null },
        '空队列：三个位都在，nextWakeAt 是 null（**不是 0**）',
      );
      assert.equal(empty.inFlight, 0);

      const t = runner.submit('睡到明天');
      await waitStatus(runner, t.taskId, 'suspended');
      const one = await readJson(await fetch(`${base}/healthz`));
      assert.equal(one.suspended.timer, 1);
      assert.equal(one.suspended.approval, 0);
      assert.equal(one.suspended.nextWakeAt, gate.at, '/healthz 报得出「最早什么时候醒」');
      assert.equal(one.inFlight, 0, '在飞与在等是两个数（挂起不占在飞）');

      // 直接往 store 塞一条**等人工**的挂起（本用例测的是读数，不是审批路径）：
      // 读数只按本进程经手的挂起 + 每次扫描按 store 对齐 —— 所以扫描之前它**不**计入。
      store.save({
        taskId: 'task_seeded',
        status: 'suspended',
        suspendedReason: 'approval',
        pendingApprovals: ['tu-x'],
        spec: { messages: [], options: {}, source: 'async' },
        createdAt: Date.now(),
      } as unknown as TaskRecord);
      assert.equal(
        runner.suspendedSummary.approval,
        0,
        '扫描之前：读数还没对齐（口径写在 suspendedSummary）',
      );
      runner.resumePending();
      const two = await readJson(await fetch(`${base}/healthz`));
      assert.equal(
        two.suspended.approval,
        1,
        '扫描按 store 重建 ⇒ 他进程/上一世留下的挂起也进读数',
      );
      assert.equal(two.suspended.timer, 1);
      assert.equal(two.suspended.nextWakeAt, gate.at, '等审批的不参与 nextWakeAt（它没有时刻）');
    } finally {
      await runner.drain({ timeoutMs: 500 });
      await close(server);
    }
  });

  it('与候选 3 的交界：**睡着的这段时间**里工具被删掉 ⇒ 醒来时漂移信号照出（复用同一条判据）', async () => {
    const spy = { calls: 0 };
    const gate: Gate = { at: Date.now() + 3_600_000 };
    const { app } = timerApp(
      [toolUseMsg('wait_for_batch', {}, 'tu1'), endTurnMsg('醒来后收尾')],
      spy,
      gate,
    );
    const store = new InMemoryTaskStore();
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('睡到明天');
    await waitStatus(runner, t.taskId, 'suspended');

    // 睡着的这段时间里发了一次版：那个工具没了（新 runner 用空菜单 + 同一个 store）
    // 脚本给一步：重跑那一批会拿到 unknown tool 的 tool_result，模型据此收尾（第二回合）
    const { client } = mockClient([endTurnMsg('醒来后收尾')]);
    const deployed: AppCallable = {
      name: 'timer',
      run: (messages, opts) => executeRun({ messages, client, tools: [], ...opts }),
    };
    await backdate(runner, t.taskId);
    const next = new AsyncRunner(deployed, { store });
    assert.equal(next.resumePending(), 1, '到点照常唤醒');
    const done = await next.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded', '菜单漂移不改 run 的成败（既有取舍，见 spec §10 ⑧）');

    // 三处信号里的两处可机读（第三处是 console.warn，见 menu-drift.test.ts）。
    // 本用例钉的是**复用**：醒来走的是同一条续跑入口 ⇒ 同一套漂移判据自动生效，不另起一套。
    const trace = done.result!.trace;
    const drift = trace.spans.flatMap((s) => s.events.filter((e) => e.name === 'menu.drift'));
    assert.equal(drift.length, 1, '恰好一条 menu.drift 事件');
    assert.deepEqual((drift[0]!.body as { missing: string[] }).missing, ['wait_for_batch']);
    const root = trace.spans.find((s) => s.kind === 'run')!;
    assert.equal(root.attributes['menu.drift'], 'missing:wait_for_batch', 'run 根属性也在');
    assert.equal(spy.calls, 1, '工具已不在菜单里 ⇒ 一次都没再执行（unknown tool 回给模型）');
  });
});
