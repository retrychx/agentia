import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncRunner, FileTaskStore, InMemoryTaskStore, executeRun } from '../../src/index.js';
import type { AgentTool, AppCallable, TaskRecord, TaskSink } from '../../src/index.js';
import { TaskApproveError } from '../../src/transport/async.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * HITL（人工审批）宿主侧：submit → 挂起落库 → approve → 恢复 → 终态。
 * 应用侧走**真引擎**（executeRun + mockClient）—— 「宿主测试用假 app」的边界
 * 已经咬过人（spec §10 第五轮 review 的教训），这里的断言都要穿过真循环。
 */

const OBJ = { type: 'object', properties: {} } as const;

interface Spy {
  calls: Array<{ input: unknown; approval: unknown }>;
}

/** 真路径 app：executeRun + mockClient；spy 记录每次工具执行与它的审批决定 */
function hitlApp(script: Array<Record<string, unknown>>, spy: Spy, extraTools: AgentTool[] = []) {
  const { client, seen } = mockClient(script);
  const tools: AgentTool[] = [
    {
      name: 'danger',
      description: '危险操作',
      inputSchema: OBJ,
      approval: 'required',
      run: (input, ctx) => {
        spy.calls.push({ input, approval: ctx?.approval });
        return 'done';
      },
    },
    ...extraTools,
  ];
  const app: AppCallable = {
    name: 'hitl',
    run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
  };
  return { app, seen };
}

async function waitStatus(
  runner: AsyncRunner,
  taskId: string,
  status: string,
): Promise<TaskRecord> {
  // ⚠️ helpers 的 waitFor 只收**同步**条件（传 async 函数会让 Promise 恒 truthy、
  // 立即放行）—— 这里要 await store，所以自己写循环（预算同 waitFor 的 10s）。
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

describe('AsyncRunner HITL（审批挂起/恢复）', () => {
  it('submit → 挂起落库：状态/待决清单/扩展历史落库，槽位释放（不占并发），onFinished 不开火', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp(
      [toolUseMsg('danger', {}, 'tu1'), endTurnMsg('t2 ok'), endTurnMsg('t1 done')],
      spy,
    );
    const sinkCalls: string[] = [];
    const sink: TaskSink = {
      onFinished: (rec) => {
        sinkCalls.push(`${rec.taskId}:${rec.status}`);
      },
    };
    // concurrency=1：挂起若占槽位，第二个任务永远排不到
    const runner = new AsyncRunner(app, { concurrency: 1, taskSinks: [sink] });
    const t1 = runner.submit('任务1');
    const t1Suspended = await waitStatus(runner, t1.taskId, 'awaiting_approval');

    assert.equal(spy.calls.length, 0, '未决审批 ⇒ 工具一次都没执行');
    assert.deepEqual(t1Suspended.pendingApprovals, ['tu1'], '待决清单落库');
    assert.equal(t1Suspended.finishedAt, undefined, '挂起不是终态：finishedAt 不置');
    assert.equal(
      typeof t1Suspended.approvalPendingSince,
      'number',
      '挂起时刻落库（超时/审计的基准）',
    );
    const tail = t1Suspended.spec.messages[t1Suspended.spec.messages.length - 1];
    assert.equal(tail.role, 'assistant', '扩展历史以含未决 tool_use 的 assistant 结尾');
    assert.ok(Array.isArray(tail.content));
    assert.equal(runner.inFlight, 0, '挂起不占在飞计数（槽位已释放）');
    assert.deepEqual(sinkCalls, [], '挂起不触发 onFinished（它不是终态）');

    // 槽位真的空出来了：第二个任务在 concurrency=1 下照常跑完
    const t2 = runner.submit('任务2');
    const t2Done = await runner.awaitTask(t2.taskId);
    assert.equal(t2Done.status, 'succeeded');
    assert.deepEqual(sinkCalls, [`${t2.taskId}:succeeded`], 't2 终态正常回调；t1 挂起仍没开火');

    // 收尾：批了 t1，它恢复并跑完；onFinished 恰好这时才对它开火
    await runner.approve(t1.taskId, { tu1: { approved: true } });
    const t1Done = await runner.awaitTask(t1.taskId);
    assert.equal(t1Done.status, 'succeeded');
    assert.deepEqual(sinkCalls, [`${t2.taskId}:succeeded`, `${t1.taskId}:succeeded`]);
  });

  it('approve → 恢复 → 成功：框架回填 decidedAt/requestedAt；恢复段 trace 经 link 挂到上一段', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('完成')], spy);
    const runner = new AsyncRunner(app);
    const t = runner.submit('活');
    const suspended = await waitStatus(runner, t.taskId, 'awaiting_approval');
    const firstRunId = suspended.runId!;

    const rec = await runner.approve(
      t.taskId,
      { tu1: { approved: true, reason: '确认过' } },
      { decidedBy: 'alice' },
    );
    const decision = rec.approvals!.tu1;
    assert.equal(decision.approved, true);
    assert.equal(decision.decidedBy, 'alice');
    assert.equal(typeof decision.decidedAt, 'number', 'decidedAt 缺省由框架填');
    assert.equal(
      decision.requestedAt,
      suspended.approvalPendingSince,
      'requestedAt 回填为挂起时刻（waitedMs 的基准）',
    );

    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result!.finalText, '完成');
    assert.equal(spy.calls.length, 1);
    assert.equal(
      (spy.calls[0].approval as { decidedBy?: string }).decidedBy,
      'alice',
      '工具体内经 ToolRunContext.approval 读到自己的决定',
    );
    // 恢复段是新树，经 traceContext link 挂到挂起段
    const root = done.result!.trace.spans.find((s) => s.kind === 'run')!;
    assert.notEqual(done.runId, firstRunId, '恢复段是新的 runId（新树）');
    assert.deepEqual(root.links, [{ traceId: firstRunId }], '恢复段 link 上一段 runId');
    // 终态后挂起痕迹清掉，决定保留（审计）
    assert.equal(done.pendingApprovals, undefined);
    assert.equal(done.approvals!.tu1.approved, true);
  });

  it('逐 tool_use_id 幂等：第一次决定赢；决定不齐只落库不恢复', async () => {
    const spy: Spy = { calls: [] };
    const deploy: AgentTool = {
      name: 'deploy',
      description: '部署',
      inputSchema: OBJ,
      approval: 'required',
      run: (input) => {
        spy.calls.push({ input, approval: undefined });
        return 'deployed';
      },
    };
    const twoPending = {
      id: 'm2',
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'tool_use', id: 'tu1', name: 'danger', input: {} },
        { type: 'tool_use', id: 'tu2', name: 'deploy', input: {} },
      ],
    };
    const { app } = hitlApp([twoPending, endTurnMsg('完成')], spy, [deploy]);
    const runner = new AsyncRunner(app);
    const t = runner.submit('活');
    await waitStatus(runner, t.taskId, 'awaiting_approval');

    // 第一批：只批 tu1 —— 决定不齐，不恢复
    const afterFirst = await runner.approve(t.taskId, {
      tu1: { approved: true, reason: '第一次' },
    });
    assert.equal(afterFirst.status, 'awaiting_approval', '决定不齐 ⇒ 继续等');
    assert.equal(spy.calls.length, 0);

    // 第二批：试图推翻 tu1（应被忽略）+ 批 tu2 —— 齐了，恢复
    const afterSecond = await runner.approve(t.taskId, {
      tu1: { approved: false, reason: '反悔' },
      tu2: { approved: true },
    });
    assert.equal(afterSecond.approvals!.tu1.approved, true, '第一次决定赢（逐 id 幂等）');
    assert.equal(afterSecond.approvals!.tu1.reason, '第一次');
    assert.equal(afterSecond.approvals!.tu2.approved, true);
    assert.equal(afterSecond.status, 'running');

    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(spy.calls.length, 2, '两个工具各执行恰好一次');
  });

  it('非 awaiting 状态 approve 抛 409 语义；任务不存在抛 404 语义', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([endTurnMsg('ok')], spy);
    const runner = new AsyncRunner(app);
    const t = runner.submit('活');
    await runner.awaitTask(t.taskId); // succeeded
    await assert.rejects(runner.approve(t.taskId, { tu1: { approved: true } }), (e: unknown) => {
      assert.ok(e instanceof TaskApproveError);
      assert.equal(e.status, 409);
      assert.match(e.message, /succeeded/);
      return true;
    });
    await assert.rejects(runner.approve('task_不存在', {}), (e: unknown) => {
      assert.ok(e instanceof TaskApproveError);
      assert.equal(e.status, 404);
      return true;
    });
  });

  it('approvalTimeoutMs：惰性判定 —— 读到一个已超时的挂起任务 ⇒ 自动全拒并重派', async () => {
    const spy: Spy = { calls: [] };
    let denialSeen = '';
    const script: Array<Record<string, unknown>> = [
      toolUseMsg('danger', {}, 'tu1'),
      {
        onParams: (p: unknown) => {
          const msgs = (p as { messages: Array<{ content: unknown }> }).messages;
          const last = msgs[msgs.length - 1];
          denialSeen = (last.content as Array<{ content: string }>)[0].content;
        },
        message: endTurnMsg('好吧'),
      } as unknown as Record<string, unknown>,
    ];
    const { app } = hitlApp(script, spy);
    const runner = new AsyncRunner(app, { approvalTimeoutMs: 60_000 });
    const t = runner.submit('活');
    await waitStatus(runner, t.taskId, 'awaiting_approval');

    // 把挂起时刻拨到很久以前（InMemory store 返回的是活对象）—— 不起定时器，
    // 超时只在「有人读它」时生效（惰性判定）
    const rec = (await runner.poll(t.taskId))!;
    assert.equal(rec.status, 'awaiting_approval', '没到点不动作');
    rec.approvalPendingSince = 0;

    // 下一次读到（poll） ⇒ 自动全拒 + 重派
    const done = await runner.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.approvals!.tu1.approved, false);
    assert.equal(done.approvals!.tu1.reason, '审批超时');
    assert.equal(done.approvals!.tu1.decidedBy, 'system');
    assert.equal(spy.calls.length, 0, '超时全拒 ⇒ 工具不执行');
    assert.equal(denialSeen, '审批被拒绝：审批超时', '模型看得到超时拒绝的理由');
  });

  it('resumePending 不捡 awaiting（不是孤儿）；配 approvalTimeoutMs 的过期任务被惰性判拒重派', async () => {
    const spy: Spy = { calls: [] };
    const store = new InMemoryTaskStore();
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('好')], spy);
    const runner = new AsyncRunner(app, { store });
    const t = runner.submit('活');
    await waitStatus(runner, t.taskId, 'awaiting_approval');

    // 模拟另一个进程重启：新 runner（不同 ownerId）扫描同一 store
    const spy2: Spy = { calls: [] };
    const { app: app2 } = hitlApp([endTurnMsg('好')], spy2);
    const runner2 = new AsyncRunner(app2, { store });
    const dispatched = await runner2.resumePending();
    assert.equal(dispatched, 0, 'awaiting_approval 不是孤儿，resumePending 不捡');
    assert.equal((await runner2.poll(t.taskId))!.status, 'awaiting_approval');

    // 配了 approvalTimeoutMs 且已过期 ⇒ resumePending 顺手判掉（惰性）并重派
    const rec = (await runner2.poll(t.taskId))!;
    rec.approvalPendingSince = 0;
    const runner3 = new AsyncRunner(app2, { store, approvalTimeoutMs: 1000 });
    const expired = await runner3.resumePending();
    assert.equal(expired, 1, '过期的挂起任务被自动判拒重派（计入重派数）');
    const done = await runner3.awaitTask(t.taskId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.approvals!.tu1.reason, '审批超时');
  });

  it('进程重启（FileTaskStore）：挂起状态/消息历史/决定不丢，新进程 approve 后续跑成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-hitl-'));
    try {
      const file = join(dir, 'tasks.jsonl');
      const spy1: Spy = { calls: [] };
      const { app: app1 } = hitlApp([toolUseMsg('danger', {}, 'tu1')], spy1);
      const runner1 = new AsyncRunner(app1, { store: new FileTaskStore(file) });
      const t = runner1.submit('活');
      await waitStatus(runner1, t.taskId, 'awaiting_approval');

      // 「重启」：新 FileTaskStore（读盘还原）+ 新 runner + 新模型脚本
      const spy2: Spy = { calls: [] };
      const { app: app2 } = hitlApp([endTurnMsg('重启后完成')], spy2);
      const runner2 = new AsyncRunner(app2, { store: new FileTaskStore(file) });
      const loaded = await runner2.poll(t.taskId);
      assert.equal(loaded!.status, 'awaiting_approval', '挂起状态跨进程可见');
      assert.deepEqual(loaded!.pendingApprovals, ['tu1'], '待决清单跨进程不丢');

      const rec = await runner2.approve(t.taskId, { tu1: { approved: true } });
      assert.equal(typeof rec.approvals!.tu1.requestedAt, 'number', '挂起时刻也随记录还原');
      const done = await runner2.awaitTask(t.taskId);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.result!.finalText, '重启后完成');
      assert.equal(spy2.calls.length, 1);

      // 再「重启」一次：决定仍落在盘上
      const store3 = new FileTaskStore(file);
      const persisted = await store3.get(t.taskId);
      assert.equal(persisted!.approvals!.tu1.approved, true, '决定随任务落盘，重启不丢');
      assert.equal(persisted!.status, 'succeeded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('幂等键复用：同键重复 submit 返回等待中的任务（不新起任务）', async () => {
    const spy: Spy = { calls: [] };
    const { app } = hitlApp([toolUseMsg('danger', {}, 'tu1')], spy);
    const runner = new AsyncRunner(app);
    const t1 = runner.submit('活', { idempotencyKey: 'k1' });
    await waitStatus(runner, t1.taskId, 'awaiting_approval');
    const t2 = runner.submit('活', { idempotencyKey: 'k1' });
    assert.equal(t2.taskId, t1.taskId, 'awaiting_approval 同键去重：返回等待中的任务');
    assert.equal((await runner.list()).length, 1);
  });
});
