// Turn 5 冒烟：触发传输 + run 存储 —— 三类触发共用同一份入参契约（spec §6.3）。
// A) AsyncRunner 真实 app：submit 即回记录、后台到 succeeded、runId==traceId；
//    同 idempotencyKey 重复 submit 去重（不重复跑，客户端调用数不变）。
// B) 失败捕获：app.run 抛错 → rethrow:false 落 failed 记录（不冒泡）；同 key 失败后可重提新任务。
// C) runSync / createSyncHandler：字符串/{text}/messages 统一归一；非法入参抛错。
// D) Scheduler：at 恰好触发一次、cancel 不触发；every 窗口幂等键 + stop 停表。
// 运行：npm run smoke:turn5（tsx 直接跑源码）
import {
  createApp,
  SystemPrompt,
  AsyncRunner,
  Scheduler,
  runSync,
  createSyncHandler,
} from '../src/index.js';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ============ A) 异步状态机 + 幂等去重（真实 AgentApp + scripted mock） ============
const app = createApp({
  name: 'async-demo',
  providers: [],
  system: new SystemPrompt().add('role', '你是异步流水线 agent。', true),
});

const captured: any[] = [];
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const endTurn = (text: string) => ({
  id: `m${captured.length}`, model: 'claude-opus-5', stop_reason: 'end_turn' as const, usage,
  content: [{ type: 'text', text }],
});
const mock = {
  messages: {
    stream: (params: any) => {
      captured.push(params);
      return { on() {}, finalMessage: async () => endTurn('ok') };
    },
  },
};

const runner = new AsyncRunner(app, { client: mock as any });
const rec1 = runner.submit({ prompt: '第一单' }, { idempotencyKey: 'k1', source: 'manual' });
assert(rec1.taskId.startsWith('task_'), `taskId 应有前缀 task_, got=${rec1.taskId}`);
assert(rec1.status === 'queued' || rec1.status === 'running', `submit 即回且已在推进, got=${rec1.status}`);

const done1 = await runner.awaitTask(rec1.taskId, { timeoutMs: 3000 });
assert(done1.status === 'succeeded', `awaitTask 应到 succeeded, got=${done1.status}`);
assert(done1.runId && done1.runId === done1.result!.trace.traceId, 'runId 应等于 traceId');
assert(done1.result!.finalText === 'ok' && done1.result!.stopReason === 'end_turn', '结果内容应到位');
assert(captured.length === 1, `应恰好执行 1 次 run, got=${captured.length}`);

// 幂等去重：同 key 重复提交 → 返回既有记录，不重复执行
const dup = runner.submit({ prompt: '第一单' }, { idempotencyKey: 'k1' });
assert(dup.taskId === rec1.taskId, '同 key 重复提交应返回原记录');
assert(runner.list().length === 1, '去重后不应新建任务');
assert(captured.length === 1, '去重不应触发新的模型调用');

// 第二个不同 key → 正常新任务
const rec2 = runner.submit({ text: '第二单' }, { idempotencyKey: 'k2' });
const done2 = await runner.awaitTask(rec2.taskId, { timeoutMs: 3000 });
assert(done2.status === 'succeeded' && runner.list().length === 2, '不同 key 应执行新任务');
assert(captured.length === 2, `两次独立 run 应各调一次模型, got=${captured.length}`);

// ============ B) 失败捕获（fake 抛错 app，直击 AsyncRunner#execute 的 catch 路径） ============
const boomCalls: string[] = [];
const boomApp = {
  name: 'boom-app',
  async run(messages: unknown[]) {
    boomCalls.push(JSON.stringify(messages));
    throw new Error('kaboom'); // 硬失败：AsyncRunner 以 rethrow:false 接住
  },
};
const runner2 = new AsyncRunner(boomApp as any);
const fr = runner2.submit('这次会炸', { idempotencyKey: 'kb' });
const fDone = await runner2.awaitTask(fr.taskId, { timeoutMs: 3000 });
assert(fDone.status === 'failed', `抛错 run 应落 failed, got=${fDone.status}`);
assert(fDone.error && fDone.error.message.includes('kaboom'), `错误信息应保留, got=${fDone.error?.message}`);
assert(fDone.runId === undefined, '失败前未拿到 runId 应为空');
assert(boomCalls.length === 1, '失败 run 也应执行一次');

// 同 key 且上一任务 failed → 允许产生新任务（失败可重试）
const fr2 = runner2.submit('再次会炸', { idempotencyKey: 'kb' });
assert(fr2.taskId !== fr.taskId, 'failed 后同 key 重提应产生新任务');
const fDone2 = await runner2.awaitTask(fr2.taskId, { timeoutMs: 3000 });
assert(fDone2.status === 'failed', `重试仍失败应落 failed, got=${fDone2.status}`);
assert(boomCalls.length === 2, `失败重试应再次执行, got=${boomCalls.length}`);
assert(runner2.list().length === 2, '两条失败记录都应保留');

// ============ C) 同步 RPC：runSync / createSyncHandler 入参归一 ============
let saw: any;
const capApp = {
  name: 'cap-app',
  async run(messages: unknown[]) {
    saw = messages;
    return { run: { runId: 'r1', status: 'succeeded' }, result: { finalText: '', stopReason: 'end_turn', iterations: 0, trace: null } };
  },
};
await runSync(capApp as any, '你好');
assert(saw.length === 1 && saw[0].role === 'user' && saw[0].content === '你好', '字符串应包成单条 user');
await runSync(capApp as any, { text: '世界' });
assert(saw[0].content === '世界', '{text} 应归一成 user');
await runSync(capApp as any, [{ role: 'user', content: '直传' }]);
assert(saw[0].content === '直传', 'messages 应原样直传');
let threw = false;
try { await runSync(capApp as any, {}); } catch { threw = true; }
assert(threw, '空对象入参应抛错');

const handler = createSyncHandler(capApp as any);
assert(typeof handler === 'function', 'createSyncHandler 应返回函数');
await handler('走 handler');
assert(saw[0].content === '走 handler', 'handler 应等价 runSync');

// ============ D) Scheduler：at / every / cancel / stop ============
const submitted: Array<{ input: unknown; opts: any }> = [];
const spyRunner = {
  submit(input: unknown, opts: any = {}) {
    submitted.push({ input, opts });
    return { taskId: `t${submitted.length}`, status: 'queued' };
  },
};
const sched = new Scheduler(spyRunner as any);

// at：cancel 掉的不触发；保留的恰好触发一次
const canceledAt = sched.at(new Date(Date.now() + 40), { prompt: '不该来' });
canceledAt.cancel();
const liveAt = sched.at(new Date(Date.now() + 80), { prompt: '该来一次' });
assert(liveAt.id && typeof liveAt.cancel === 'function', 'ScheduleHandle 应带 id/cancel');
assert(sched.active === 1, `cancel 后应只剩 1 个活动 job, got=${sched.active}`);

await sleep(70);
assert(submitted.length === 0, `cancel 的 at 不应触发, got=${submitted.length}`);
await sleep(130); // 累计 ~200ms > 80ms
assert(submitted.length === 1, `at 应恰好触发 1 次, got=${submitted.length}`);
assert(submitted[0].opts.source?.startsWith('schedule:'), `source 应带 schedule 前缀, got=${submitted[0].opts.source}`);

// every：窗口幂等键；stop 后不再触发
const beforeEvery = submitted.length;
const ev = sched.every(50, { prompt: '周期' }, { idempotencyPrefix: 'cycle' });
await sleep(240);
assert(submitted.length >= beforeEvery + 2, `every 应多次触发, got=${submitted.length - beforeEvery}`);
for (const s of submitted.slice(beforeEvery)) {
  assert(typeof s.opts.idempotencyKey === 'string' && s.opts.idempotencyKey.startsWith('cycle:'),
    `周期任务应带窗口幂等键, got=${s.opts.idempotencyKey}`);
}
sched.stop();
const afterStop = submitted.length;
await sleep(130);
assert(submitted.length === afterStop, 'stop 后不应再触发');

console.log('SMOKE-TURN5 PASS');
console.log(JSON.stringify({
  async: { firstRunId: done1.runId, dedupHit: true, listCount: runner.list().length, modelCalls: captured.length },
  failure: { status: fDone.status, error: fDone.error?.message, retryableAfterFail: true },
  sync: { normalizedToUser: true, invalidThrows: true },
  schedule: { atFiredOnce: true, everyFiredTimes: submitted.length - beforeEvery, activeAfterStop: sched.active },
}, null, 2));
