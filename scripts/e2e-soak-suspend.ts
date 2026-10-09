// soak-suspend：把**挂起链路**放到时间维度下压 —— 补 `e2e-soak` / `e2e-soak-app` 都没造的那一格。
//
// 为什么缺这一格（2026-09-29 深审 §3.3 缺口 4/5）：`.workbuddy/reports` 那份审计的原话是
// 「要保证有人定期真跑两小时」—— 但**跑的是并发，不是挂起**。已有的两条各占一头：
//   · `e2e-soak` 造并发长跑（7M runs 那一档），import 面只有 `runAgent`；
//   · `e2e-soak-app` 起完整装配（AsyncRunner + Scheduler + 猝死续跑），负载里**没有一条会挂起**。
// 而 2026-09-29 刚从 `AsyncRunner`（1554 → 1460 行）里抽出的三簇 —— **审批监督 /
// 信号投递 / 恢复扫描** —— 只在这条链路上跑。它们挂了不会有任何错误码，只会「不收敛」：
// 任务永远停在 `suspended`、事件投了没人接、超时到了没人判。**不收敛没有堆栈**，
// 只能靠长跑 + 逐笔对账抓。本档就是这个「有人」。
//
// —— 四条臂（每条都是一个真实的唤醒源；种子固定 ⇒ 序列可复现）——
//   approve 40%：submit → 挂起（等人工）→ `approve` → 恢复 → 工具执行 → 终态
//   timeout 25%：submit → 挂起 → **不批** → 惰性超时 → 自动全拒（system/'审批超时'）+ 重派 → 终态
//   signal  20%：submit → 挂起 → `signalTask` 投递事件（**同一个 eventId 再投一次必须 409**）
//                → 恢复 → `approve` → 事件注入模型 → 终态
//   timer   15%：submit → 工具里 `ctx.deferUntil(t)` → 挂起（等时刻）→ 到点唤醒 → 终态
//
// ⚠️ 两条判据都是**惰性**的（不起定时器，见 `wake-policy.ts` / `approval-policy.ts`）：
//   超时与到期只在「有人读它」时生效（`approve` / `poll` / `resumePending`）。
//   ⇒ 本档每轮**显式调一次 `runner.resumePending()`** 扮演宿主那个「有人」
//   （真实宿主是 HTTP `poll` / `Scheduler` 的 tick）。没有它，挂起任务不是坏了，是**没人来读**。
//
// —— 断言（每条都是「跑一轮」结构上抓不到的）——
//   ① 不丢不卡：每条任务都在**它自己那一批**里被验过终态（逐批对账数 = 提交数），
//      收尾 `inFlight` = 0 且挂起登记簿除名（空队列给 null）——
//      长跑里挂起链路最典型的病不是崩，是「永远挂着不动」：它没有任何错误码，只有不收敛
//   ② 逐笔对账（**按落地的决定**，不是按臂的标签）：`danger` 执行次数 = 人工批过的决定数
//      （timeout 臂**必须 0 次** —— 全拒了就不该有副作用）；`sleep` 执行次数 = timer 臂数
//      ⚠️ 臂是「我打算怎么推」，决定是「实际发生了什么」—— 两者会分叉（审批窗口是**惰性**判定：
//      我还没批，它已经被兜底判掉了）。分叉必须**数出来**，不能按臂的标签糊过去。
//   ③ 四条臂各自落地 ≥1（防「某条臂静默空转」把 ② 变成恒真 —— 空转的臂是这条链上最容易漏的）
//   ④ 事件恰好一次：重复 eventId ⇒ **恰好一次 409**（注意：要在任务「又挂起」之后重投 ——
//      投递会把状态翻成 running，在 running 上重投撞的是状态闸，走不到幂等闸，见 signal 臂的注释）；
//      投递成功的事件数 ≤ 模型侧看到渲染事件的请求数（事件真的走到模型，不是只落在库里），
//      且单请求里不出现两次
//   ⑤ 非终态记录的字节数**不随时间涨**（前后四分位均值比 ≤ 2）+ 量级闸（≤ 64KB/条）
//   ⑤b DB 字节**只卡斜率**（≤ 64KB/任务；线性口径 —— 记录本来就随任务数长，卡总量是假闸）
//   ⑥ heapUsed 有界（热身后 tail3 − head3 < 48MB；采样不足是**硬失败**，不静默跳过）
//   ⑦ 恢复段 trace 经 `link` 挂到挂起段（挂起/恢复不许把 trace 记账绕过去）
//   ⑧ 干净退出（看门狗：断言完还有句柄吊着 ⇒ 打出来 + exit 1）
//   ⑨ **节奏自检**：状态竞态（读到挂起之后又被惰性判定推走）占比 > 20% ⇒ 大量臂没落地，
//      读数不可信 —— 红在「节奏」上并给出处置，而不是红在「danger 该跑 N 次却跑了 0 次」。
//
// ⚠️ 驱动侧**不许假设「我读到的挂起」还在**（这是本档第一版在 2026-09-30 崩掉的原因：
//   45 分钟档跑到第 4 分钟，一次 `signalTask` 撞上已被兜底判掉并重派的任务 ⇒
//   TaskEventError 409 直接冒到顶层把整轮打死。契约是对的，是驱动的假设太强）。
//   所有会对挂起记录动手的调用（signalTask / approve）都接住 409 并按**记录状态**分类。
//
// ⚠️ 记录存 **SQLite**（`SqliteTaskStore`，同 `e2e-soak-app`），不是内存 Map：这一档要跑
//   几十分钟、几万条记录 —— 放内存里会「合法地」把 heap 撑到几百 MB，⑥ 就变成在测我自己的
//   留存策略。对账也改成**逐批**（循环里当场验），不在收尾全表扫：几万条的全表读会给 ⑥
//   制造与泄漏无关的尖峰。红了会把临时库留在 /tmp（跑绿才清）—— 那是唯一能复盘的东西。
//
// 不并入 verify-all：与另外两条 soak 同档 —— 它是「跑多久」而不是「对不对」的验证。
// 用法：npm run e2e:soak:suspend
// 调参：SOAK_SUSPEND_DURATION_MS=45000 SOAK_SUSPEND_CONCURRENCY=16 npm run e2e:soak:suspend
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncRunner, SqliteTaskStore, createOpenAIClient, executeRun } from '../src/index.js';
import type { AgentTool, AppCallable, TaskEvent, TaskRecord } from '../src/index.js';

const DURATION_MS = Number(process.env.SOAK_SUSPEND_DURATION_MS ?? 60_000);
const CONCURRENCY = Number(process.env.SOAK_SUSPEND_CONCURRENCY ?? 16);
const SEED = Number(process.env.SOAK_SUSPEND_SEED ?? 42);
const APPROVAL_TIMEOUT_MS = Number(process.env.SOAK_SUSPEND_APPROVAL_TIMEOUT_MS ?? 900);
const TIMER_MS = Number(process.env.SOAK_SUSPEND_TIMER_MS ?? 400);
/** 每轮提交量 = 4 × 并发 ⇒ 槽位真的被压住，挂起释放槽位这件事也在被测（挂起不占在飞计数） */
const PER_ROUND = CONCURRENCY * 4;
/** 一批任务从提交到终态的预算；超了就是红（「不收敛」必须响，不能等下一轮） */
const SETTLE_BUDGET_MS = Math.max(20_000, Math.round(DURATION_MS / 3));
/** 每条 signal 臂在驱动循环里顺序做的 waitAll 个数（「信号续跑后再挂起」+「重复投递后再挂起」），
 *  各吃一份 SETTLE 预算 —— 看门狗余量按它派生 */
const SIGNAL_WAITS_PER_ARM = 2;
/** 每臂驱动动作的固定开销上限（poll / approve / trySignal 都是本地 SQLite 读写，给个保守值） */
const PER_ARM_OVERHEAD_MS = 250;
/** 看门狗给收尾段（汇总 + 断言 + 关端）的固定 buffer */
const WATCHDOG_BUFFER_MS = 15_000;
/** main 跑完后看门狗的最后宽限：到点进程还没退 ⇒ 有别的句柄把它吊住了（断言 ⑧ 的那一格） */
const WATCHDOG_FINAL_GRACE_MS = 10_000;

/**
 * 一轮的最坏耗时预算 = 进入挂起 SETTLE + 每臂驱动开销（signal 臂再多 SIGNAL_WAITS_PER_ARM 个
 * SETTLE）+ 宿主 tick + 到达终态 SETTLE + buffer。每一项都指得回循环里一个真实的预算来源
 * （每个会慢的调用都各自带预算、超时自己先红），所以一轮总耗时越过这个派生上限，
 * 只可能是**预算外**的东西把进程吊住了。
 */
const roundBudgetMs = (signalCount: number): number =>
  2 * SETTLE_BUDGET_MS +
  PER_ROUND * PER_ARM_OVERHEAD_MS +
  signalCount * SIGNAL_WAITS_PER_ARM * SETTLE_BUDGET_MS +
  (TIMER_MS + APPROVAL_TIMEOUT_MS + 50) +
  WATCHDOG_BUFFER_MS;

assert.ok(DURATION_MS >= 5_000, 'SOAK_SUSPEND_DURATION_MS 太短得不出任何结论（≥ 5s）');
assert.ok(CONCURRENCY >= 1 && CONCURRENCY <= 64, 'SOAK_SUSPEND_CONCURRENCY 应在 1..64');
assert.ok(APPROVAL_TIMEOUT_MS >= 100, 'SOAK_SUSPEND_APPROVAL_TIMEOUT_MS 太短（≥ 100ms）');
assert.ok(TIMER_MS >= 100, 'SOAK_SUSPEND_TIMER_MS 太短（≥ 100ms）');

type Arm = 'approve' | 'timeout' | 'signal' | 'timer';
const ARMS: Arm[] = ['approve', 'timeout', 'signal', 'timer'];
/** 臂的权重（分母 20）—— approve 是主路径，timer 最少但也必须有 */
const WEIGHT: Record<Arm, number> = { approve: 8, timeout: 5, signal: 4, timer: 3 };

const APPROVAL_ID = 'call_danger_1';
const APPROVER = 'soak-approver';
const EVENT_TYPE = 'soak.kick';
const EVENT_MARK = 'soak.kick';

/** 确定性 RNG（mulberry32）：种子固定 ⇒ 臂序列可复现（同 e2e-soak 的口径） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickArm = (rng: () => number): Arm => {
  const total = ARMS.reduce((n, a) => n + WEIGHT[a], 0);
  let r = rng() * total;
  for (const a of ARMS) {
    r -= WEIGHT[a];
    if (r < 0) return a;
  }
  return 'approve';
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
const isTerminal = (s: TaskRecord['status']): boolean =>
  s === 'succeeded' || s === 'failed' || s === 'cancelled';

// —— 假端点（OpenAI 兼容 SSE）——
// 只替掉模型，绝不替掉被测链路：请求照旧走 `createOpenAIClient` → 真适配器 → 真循环。
// 「回哪条 tool_use」由**提交文本里的臂标记**决定（`arm=xxx`）—— 无状态、可复现，
// 且恢复段（历史末尾是 tool 结果）一律回纯文本收尾，与真端点的自然行为一致。
interface ProviderStats {
  requests: number;
  /** 发出去的第几个 tool_call —— 用来给每条 tool_use 配一个**独一无二**的闸标记 */
  frames: number;
  dangerFrames: number;
  sleepFrames: number;
  plainFrames: number;
  /** 模型侧看到「渲染后的事件」的请求数（事件真的走到模型 —— 不是只落在库里） */
  eventRendered: number;
  /** 单个请求里最多渲染了几次同一个事件（>1 ⇒ 重复注入） */
  eventMaxPerRequest: number;
  noArm: number;
}

interface Provider {
  baseURL: string;
  stats: ProviderStats;
  close: () => Promise<void>;
}

function sseChunks(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 一段 tool_call（arguments 分两片下发，与真端点同形） */
function toolCallFrame(res: ServerResponse, name: string, id: string, args: string): void {
  const cut = Math.max(1, Math.floor(args.length / 2));
  sseChunks(res, [
    {
      id: 'chatcmpl-t',
      model: 'soak-model',
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
          },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, cut) } }] } },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] } },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
  ]);
}

function plainReply(res: ServerResponse): void {
  sseChunks(res, [
    { id: 'chatcmpl-ok', model: 'soak-model', choices: [{ delta: { content: '收尾' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
  ]);
}

async function startProvider(): Promise<Provider> {
  const stats: ProviderStats = {
    requests: 0,
    frames: 0,
    dangerFrames: 0,
    sleepFrames: 0,
    plainFrames: 0,
    eventRendered: 0,
    eventMaxPerRequest: 0,
    noArm: 0,
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      stats.requests++;
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
      const messages = parsed.messages ?? [];

      // 事件渲染计数：同一次请求里出现两次 = 重复注入（事件恰好一次的反面）
      const renders = body.split(EVENT_MARK).length - 1;
      if (renders > 0) {
        stats.eventRendered++;
        stats.eventMaxPerRequest = Math.max(stats.eventMaxPerRequest, renders);
      }

      // 历史里已有 tool 结果 ⇒ 这是恢复段（或工具已执行），回纯文本收尾
      if (messages.some((m) => m.role === 'tool')) {
        stats.plainFrames++;
        plainReply(res);
        return;
      }

      const arm = /arm=(approve|timeout|signal|timer)/.exec(body)?.[1] as Arm | undefined;
      if (arm === undefined) {
        // 标记丢了 ⇒ 服务端只能瞎猜。计数让 ③ 抓出来，不静默装对。
        stats.noArm++;
        plainReply(res);
        return;
      }
      stats.frames++;
      if (arm === 'timer') {
        // ⚠️ 醒来时引擎会**重跑**这条 tool_use（见 durable-timer.test.ts「醒来重跑那一批」，
        // spy.calls === 2）—— 所以工具必须能分辨「第一次（该睡）」与「第二次（该收工）」。
        // 闸标记跟着 tool_use 的入参走：同一条 tool_use 的两次执行拿到**同一个**标记，
        // 不同任务拿到不同标记（`g<序号>`）。
        stats.sleepFrames++;
        toolCallFrame(
          res,
          'sleep',
          `call_sleep_${stats.frames}`,
          JSON.stringify({ gate: `g${stats.frames}` }),
        );
        return;
      }
      stats.dangerFrames++;
      toolCallFrame(res, 'danger', APPROVAL_ID, '{}');
    });
  });

  const baseURL = await new Promise<string>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert.ok(typeof addr === 'object' && addr !== null, '假端点没有拿到端口');
      ready(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { baseURL, stats, close: () => new Promise<void>((done) => server.close(() => done())) };
}

// —— 工具（两个：一个要审批，一个挂到未来时刻）——

interface Runs {
  danger: Array<unknown>;
  /** `sleep` 工具的**执行**次数（挂起一次会被执行两次：睡下去 + 醒来重跑） */
  sleepRuns: number;
  /** 真正**睡下去**的闸数（= timer 臂数；醒来那次执行不许再 defer，否则永远醒不来） */
  sleptTaken: number;
}

function makeTools(runs: Runs): AgentTool[] {
  /** 已经睡过的闸标记 —— 醒来重跑时第二次执行必须**不再** defer */
  const taken = new Set<string>();
  const danger: AgentTool = {
    name: 'danger',
    description: '危险操作（需人工审批）',
    inputSchema: { type: 'object', properties: {} } as unknown as AgentTool['inputSchema'],
    approval: 'required',
    run: (_input, ctx) => {
      runs.danger.push(ctx?.approval);
      return '已执行';
    },
  };
  const timer: AgentTool = {
    name: 'sleep',
    description: '挂起到指定时刻（durable timer）',
    inputSchema: { type: 'object', properties: {} } as unknown as AgentTool['inputSchema'],
    run: (input, ctx) => {
      const gate = String((input as { gate?: string } | undefined)?.gate ?? '');
      // 没闸标记 ⇒ 响亮失败：静默退化会让 timer 臂变成「纯文本臂」而断言仍然绿
      if (gate === '') throw new Error('sleep 工具的入参里没有闸标记 —— 假端点与工具的对账断了');
      runs.sleepRuns++;
      if (taken.has(gate)) return '到点了'; // 醒来重跑：这次不睡了，把结果交回去
      // 拿不到 deferUntil ⇒ 同上，不静默跳过
      if (!ctx?.deferUntil) throw new Error('sleep 工具拿不到 ctx.deferUntil —— 引擎没透传上下文');
      taken.add(gate);
      runs.sleptTaken++;
      ctx.deferUntil(Date.now() + TIMER_MS);
      return '定时器已排定';
    },
  };
  return [danger, timer];
}

// —— 驱动 ——

/** 等到所有给定任务都满足谓词；超预算 ⇒ 抛（把「不收敛」变成一条会响的失败，而不是静默放行） */
async function waitAll(
  runner: AsyncRunner,
  ids: string[],
  ok: (rec: TaskRecord) => boolean,
  budgetMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let pending = 0;
    let sample = '';
    for (const id of ids) {
      const rec = await runner.poll(id);
      if (!rec) {
        pending++;
        sample = `${id} 查不到`;
        continue;
      }
      if (!ok(rec)) {
        pending++;
        sample = `${id} 停在 ${rec.status}${rec.suspendedReason ? `（${rec.suspendedReason}）` : ''}`;
      }
    }
    if (pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `等 ${ids.length} 个任务${what}超时（${budgetMs}ms）—— 还有 ${pending} 个没收敛：${sample}`,
      );
    }
    await sleep(10);
  }
}

/** 投递一条事件，并按**记录状态**把结果分成三类 —— `status` 409 有两种，语义完全不同：
 *   · `delivered` —— 事件真的投进去了；
 *   · `state-race` —— 记录此刻**不是**挂起（被惰性审批超时 / 到期唤醒推走了）⇒ **状态闸**的 409。
 *     契约（「只有挂起的任务能接收事件」）是**对的**，是驱动这一侧假设太强：审批窗口是
 *     **惰性**判定，我读到「挂起」之后它随时可能被兜底判掉并重派。**这一条必须接住** ——
 *     否则整个 soak 会因为一次竞态崩掉（2026-09-30 实测：45 分钟档跑到第 4 分钟就崩）。
 *   · `duplicate` —— 记录仍在挂起、且这个 eventId 已在 `deliveredEventIds` 里 ⇒ **幂等闸**的 409。
 *     这才是「恰好一次」要测的那条路。
 *   非 409 一律照抛（那是真错，不该被分类掩掉）。
 */
async function trySignal(
  runner: AsyncRunner,
  taskId: string,
  event: TaskEvent,
): Promise<'delivered' | 'state-race' | 'duplicate'> {
  try {
    await runner.signalTask(taskId, event);
    return 'delivered';
  } catch (e) {
    if ((e as { status?: number }).status !== 409) throw e;
    const still = await runner.poll(taskId);
    if (
      still?.status === 'suspended' &&
      event.eventId !== undefined &&
      (still.deliveredEventIds ?? []).includes(event.eventId)
    ) {
      return 'duplicate';
    }
    return 'state-race';
  }
}

async function main(): Promise<void> {
  const rng = mulberry32(SEED);
  const runs: Runs = { danger: [], sleepRuns: 0, sleptTaken: 0 };
  const provider = await startProvider();
  const client = createOpenAIClient({ baseURL: provider.baseURL, apiKey: 'soak', maxRetries: 1 });
  const tools = makeTools(runs);
  const app: AppCallable = {
    name: 'suspend-soak',
    run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
  };
  // 记录存 **SQLite**（不是内存 Map）：这一档要跑几十分钟、几万条记录 —— 放内存里会
  // 「合法地」把 heap 撑到几百 MB，那条「heap 有界」的断言就变成在测我自己的留存策略，
  // 而不是框架有没有泄漏。这是 `e2e-soak-app` 的同款取舍（它也用 SqliteTaskStore，
  // 并把「字节/任务」做成**线性**口径）。`:memory:` 不行 —— 那又回到堆上了。
  const dbDir = mkdtempSync(join(tmpdir(), 'agentia-soak-suspend-'));
  const dbFile = join(dbDir, 'tasks.db');
  const store = new SqliteTaskStore(dbFile);
  const runner = new AsyncRunner(app, {
    concurrency: CONCURRENCY,
    store,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    maxQueued: 0,
  });

  // 看门狗（断言 ⑧）：到点还没收尾 ⇒ 打出来再死 —— 「没退出」本身是一条失败。
  // ⚠️ 余量从**真实预算**派生，不再写死 `DURATION_MS + 30s`：循环只在轮首看表，endAt 之后
  //    还会把最后一轮跑完，而一轮的合法收尾可以吃掉「进入挂起 + 每条 signal 臂两个 + 到达终态」
  //    的全部 SETTLE 预算 —— 45 分钟档（SETTLE = 15min）一轮合法但缓慢的收尾就能越过 30s
  //    余量，健康跑被判成「句柄泄漏」，诊断还指错方向。改为每轮按**这一批的真实臂构成**
  //    重上膛（signal 臂数决定本轮 waitAll 预算的个数），每微秒都指得回一个真实预算。
  // ⚠️ unref：看门狗**自己**不许成为吊住进程的那个句柄 —— 这样 main 跑完后也不必撤掉它：
  //    若还有别的句柄把进程吊住，最后那档（WATCHDOG_FINAL_GRACE_MS）到点照样响
  //    （旧实现收尾时 clearTimeout，「断言完还有句柄吊着」这一格其实永远没人报）。
  const reportStuck = (): void => {
    console.error(
      '\n✖ soak-suspend 越过本轮预算仍未收敛 / 结束后进程未退出（预算外挂起，多半是句柄泄漏）。活跃句柄：',
    );
    const handles = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    console.error(`  ${handles?.length ?? '?'} 个`);
    process.exit(1);
  };
  let watchdog: NodeJS.Timeout | undefined;
  /** 重上膛：进入新一轮 / 进入收尾时按该阶段的真实预算重算期限 */
  const armWatchdog = (budgetMs: number): void => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    const t = setTimeout(reportStuck, budgetMs);
    t.unref();
    watchdog = t;
  };
  // 装配与首批建批期间的上膛：臂构成还没数出来，按最坏构成（全 signal）给
  armWatchdog(roundBudgetMs(PER_ROUND));

  // 采样间隔随时长缩放：任何时长都攒够内存断言所需的样本量 ——
  // 「采样不足就跳过断言」= 静默跳过 = 假装验过（第八轮复审抓到的自家病灶）。
  const SAMPLE_INTERVAL_MS = Math.max(500, Math.floor(DURATION_MS / 30));
  const memSamples: Array<{ t: number; heap: number; rss: number }> = [];
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    memSamples.push({ t: Date.now(), heap: m.heapUsed, rss: m.rss });
  }, SAMPLE_INTERVAL_MS);

  /** 每条任务**第一次**被观察到的 runId（= 挂起那段）—— 跨段判定与 trace link 对账的基准 */
  const firstRunIds = new Map<string, string>();
  /** 每条任务**最近两次**观察到的 runId：恢复段根 span 的 link 指向的是**上一段**的 runId
   *  （`async.ts` 续跑时注入 `traceContext: { traceId: rec.runId }`；signal 臂有三段 ⇒
   *  目标不一定是第一段），所以 ⑦ 的指向校验要拿「终态之前最后一次观察到的 runId」对，
   *  不按 first 对。本驱动的每次 dispatch（approve / signalTask / resumePending）都被
   *  poll 夹着，逐段都能被观察到 —— 「漏看一段 ⇒ prev 失准」在本驱动结构下不成立。 */
  const lastRunIds = new Map<string, string>();
  const prevRunIds = new Map<string, string>();
  const noteRunId = (taskId: string, runId: string | undefined): void => {
    if (runId === undefined) return;
    const cur = lastRunIds.get(taskId);
    if (cur === runId) return;
    if (cur !== undefined) prevRunIds.set(taskId, cur);
    lastRunIds.set(taskId, runId);
  };
  /** 每轮的「挂起记录字节数 / 挂起任务数」（记录**逻辑**体积的线性口径） */
  const bytesPerSuspended: number[] = [];
  /** 每轮的 DB 文件字节数 + 当时的累计任务数 ⇒ 「字节/任务」是**线性**口径（长档短档可比） */
  const dbBytes: number[] = [];
  const tasksAtDbSample: number[] = [];
  /** 臂计数与逐笔对账全部走**计数器**（不数组留存记录 —— 几万条记录的数组会污染 heap 读数） */
  const byArm: Record<Arm, number> = { approve: 0, timeout: 0, signal: 0, timer: 0 };
  let submittedCount = 0;
  let reconciled = 0;
  let multiSegment = 0;
  let linked = 0;
  let signalsSent = 0;
  let signalOk = 0;
  /** 状态竞态（契约正确、驱动假设太强）—— 单列出来，**既不静默吞掉也不判红**，见 trySignal 头注 */
  let signalStateRace = 0;
  let approveStateRace = 0;
  /** 还没轮到我就已经被推走的臂（approve/signal）—— 静默 continue 的反面，见驱动循环里的注释 */
  let armSkippedNotSuspended = 0;
  /** 幂等闸的测试：试图重复投递的次数 / 被幂等拒的次数 / 本该测却因「不在挂起」没测成的次数 */
  let dupAttempted = 0;
  let dupCaught = 0;
  let dupMissed = 0;
  let dupStateRace = 0;
  let dupSkippedNotSuspended = 0;
  /** 「第一次投递就被幂等拒」—— 不该发生（每个任务的 eventId 唯一）⇒ 计数并断言为 0 */
  let firstDupUnexpected = 0;
  let approvalsSent = 0;
  /** 逐条对账出来的**实际落地的决定**（人工批 / 兜底判拒），不再是「臂的标签」 */
  let humanApproved = 0;
  let autoDenied = 0;
  let resumedTasks = 0;
  let rounds = 0;
  const endAt = Date.now() + DURATION_MS;

  while (Date.now() < endAt) {
    rounds++;
    const batch: Array<{ taskId: string; arm: Arm }> = [];
    for (let i = 0; i < PER_ROUND; i++) {
      const arm = pickArm(rng);
      const rec = runner.submit(`arm=${arm}`);
      batch.push({ taskId: rec.taskId, arm });
      byArm[arm]++;
      submittedCount++;
    }

    // 看门狗按**这一批**的真实臂构成重上膛（signal 臂数决定本轮 waitAll 预算的个数）
    armWatchdog(roundBudgetMs(batch.reduce((n, b) => n + (b.arm === 'signal' ? 1 : 0), 0)));

    // 1) 等这一批「挂起来」（或已经跑到终态）—— 挂起的判据是落库后的状态，不是内存标记
    await waitAll(
      runner,
      batch.map((b) => b.taskId),
      (rec) => rec.status === 'suspended' || isTerminal(rec.status),
      SETTLE_BUDGET_MS,
      '进入挂起',
    );
    for (const b of batch) {
      const rec = await runner.poll(b.taskId);
      noteRunId(b.taskId, rec?.runId);
      if (rec?.runId !== undefined && !firstRunIds.has(b.taskId))
        firstRunIds.set(b.taskId, rec.runId);
    }

    // 2) 非终态流的体积读数：只抽**本批里当前还挂着**的那几条。
    //    不用全表 `list()`：记录表几十分钟后有几万条，每轮全表读会把 RSS 顶出一个与
    //    「泄漏」无关的尖峰 —— 而那正是 ⑥ 要测的东西，不能自己给它制造噪声。
    let onceBytes = 0;
    let onceSuspended = 0;
    for (const b of batch) {
      const rec = await runner.poll(b.taskId);
      if (rec?.status === 'suspended') {
        onceBytes += JSON.stringify(rec).length;
        onceSuspended++;
      }
    }
    if (onceSuspended > 0) bytesPerSuspended.push(onceBytes / onceSuspended);
    // DB 体积采样（**线性**口径的分子；分母是当时的累计任务数）
    dbBytes.push(statSync(dbFile).size);
    tasksAtDbSample.push(submittedCount);

    // 3) 驱动各臂：approve / signal 当场推，timeout / timer 交给下面的宿主 tick
    //
    // ⚠️ 这一段的每一处「读到的状态」都可能**在下一步之前失效**：审批窗口与到期唤醒都是
    //    **惰性**判定，我这次 poll 读到 suspended，下一次 poll / tick 就可能把它判掉并重派
    //    （status → running）。所以驱动侧**不许假设状态还在**：
    //      · 投递走 `trySignal`（把 409 按记录状态分成「状态竞态」与「幂等拒」两类）；
    //      · `approve` 同样接住 409（它按契约只在「等审批」时可用）。
    //    2026-09-30 实测：不接住它的后果是整个 soak 崩在第 4 分钟（TaskEventError 409
    //    「当前状态为 running」直接冒到顶层）。**契约是对的，是驱动的假设太强。**
    for (const b of batch) {
      const rec = await runner.poll(b.taskId);
      noteRunId(b.taskId, rec?.runId);
      if (rec?.status !== 'suspended') {
        // 我自己还没动手，它就已经被惰性判定推走了（窗口太短 / 驱动太慢）——
        // **数出来**，别静默 continue：这是本档最容易骗自己的地方（臂一次都没落地，
        // 却因为「臂的计数」还在而看着有覆盖）。2026-09-30 的 100ms 放大档就是这个形状。
        if (b.arm === 'approve' || b.arm === 'signal') armSkippedNotSuspended++;
        continue;
      }
      if (b.arm === 'approve') {
        approvalsSent++;
        try {
          await runner.approve(
            b.taskId,
            { [APPROVAL_ID]: { approved: true, reason: 'soak 批了' } },
            { decidedBy: APPROVER },
          );
        } catch (e) {
          if ((e as { status?: number }).status === 409) approveStateRace++;
          else throw e;
        }
      } else if (b.arm === 'signal') {
        const event: TaskEvent = { eventId: `ev-${b.taskId}-1`, type: EVENT_TYPE, payload: 'ping' };
        signalsSent++;
        const first = await trySignal(runner, b.taskId, event);
        if (first === 'delivered') signalOk++;
        else if (first === 'state-race') signalStateRace++;
        // 第一次投递就被幂等拒 = 这个 eventId 早就投过了（不该发生：每个任务 id 唯一）⇒ 计数
        else firstDupUnexpected++;
        // 事件让它续跑；审批还没下来 ⇒ 它会再挂一次（覆盖「事件先到、决定后到」的次序）
        await waitAll(
          runner,
          [b.taskId],
          (r) => r.status === 'suspended' || isTerminal(r.status),
          SETTLE_BUDGET_MS,
          '信号续跑后再挂起',
        );
        // ⚠️ 重复投递**必须在「又挂起」之后**发。投递本身把状态翻成 running，
        //    在 running 上再投一次撞的是**状态闸**（409），根本走不到幂等闸 ——
        //    2026-09-30 反向验证抓到的：把幂等闸关掉，原来那句「重复投递被拒」照样绿，
        //    因为拒它的是状态。**守卫测的东西 ≠ 它想测的东西**，这一档自己先犯了一次。
        //    幂等闸的真身是「重试一条已经投过的事件」（真实场景：客户端重试 / 双写）。
        const beforeDup = await runner.poll(b.taskId);
        noteRunId(b.taskId, beforeDup?.runId);
        if (beforeDup?.status === 'suspended') {
          dupAttempted++;
          const again = await trySignal(runner, b.taskId, event);
          if (again === 'duplicate') dupCaught++;
          else if (again === 'delivered') dupMissed++;
          else dupStateRace++;
        } else {
          // 没挂起就没法测幂等闸（不算失败，但要**看得见**：④ 要求测成的次数够多）
          dupSkippedNotSuspended++;
        }
        // 万一被收下（幂等闸坏了），它会再醒一次 ⇒ 还要再等回挂起，才能批
        await waitAll(
          runner,
          [b.taskId],
          (r) => r.status === 'suspended' || isTerminal(r.status),
          SETTLE_BUDGET_MS,
          '重复投递后再挂起',
        );
        const after = await runner.poll(b.taskId);
        noteRunId(b.taskId, after?.runId);
        if (after?.status === 'suspended') {
          approvalsSent++;
          try {
            await runner.approve(
              b.taskId,
              { [APPROVAL_ID]: { approved: true, reason: 'soak 批了（信号臂）' } },
              { decidedBy: APPROVER },
            );
          } catch (e) {
            if ((e as { status?: number }).status === 409) approveStateRace++;
            else throw e;
          }
        }
      }
    }

    // 4) 宿主 tick：惰性超时 + 到期唤醒都只在这里发生（真实宿主是 poll / Scheduler）
    await sleep(TIMER_MS + APPROVAL_TIMEOUT_MS + 50);
    const woke = await runner.resumePending();
    resumedTasks += typeof woke === 'number' ? woke : 0;

    // 5) 这一批必须全部收敛到终态 —— 并且**当场对账**。
    //    不留到收尾再全表扫：几十分钟后记录表有几万条，一次全表读会把 RSS 顶出一个与
    //    「泄漏」无关的尖峰（而那正是 ⑥ 要测的东西）。当场对账还有个好处：坏掉的那一条
    //    **立刻**带着自己的臂名报出来，而不是收尾时只给一个总数。
    await waitAll(
      runner,
      batch.map((b) => b.taskId),
      (rec) => isTerminal(rec.status),
      SETTLE_BUDGET_MS,
      '到达终态',
    );
    for (const b of batch) {
      const rec = await runner.poll(b.taskId);
      noteRunId(b.taskId, rec?.runId);
      assert.ok(rec, `任务 ${b.taskId}（${b.arm} 臂）提交后再也查不到`);
      assert.ok(isTerminal(rec.status), `任务 ${b.taskId}（${b.arm} 臂）没到终态：${rec.status}`);
      reconciled++;
      // 逐条对账**按落地的决定**，不按臂的标签：臂是「我打算怎么推」，决定是「实际发生了什么」。
      // 两者会分叉（审批窗口是惰性判定：我还没批，它已经被兜底判掉了）—— 分叉必须**数出来**，
      // 不能被臂的标签糊过去。2026-09-30 实测：窗口压到 100ms 时 507 个需要审批的任务里
      // 人工批落地 **0** 次；而旧版按臂对账，把它报成「danger 该跑 507 次却跑了 0 次」——
      // 看着像框架坏了，其实是我的驱动节奏没跟上窗口。
      const decision = rec.approvals?.[APPROVAL_ID];
      if (decision === undefined) {
        // timer 臂不做审批；其余三条臂都以「需审批的工具」起步 ⇒ 必须留下一条决定
        assert.equal(
          b.arm,
          'timer',
          `任务 ${b.taskId}（${b.arm} 臂）到终态了却没有审批决定 —— 决定丢了`,
        );
      } else if (decision.decidedBy === APPROVER && decision.approved === true) {
        humanApproved++;
      } else if (decision.approved === false && decision.reason === '审批超时') {
        autoDenied++;
      } else {
        assert.fail(
          `任务 ${b.taskId} 的决定既不是人工批、也不是兜底判拒：${JSON.stringify(decision)}`,
        );
      }
      // trace 是交付物：run 根 span 必须在；跨段就必须 link 到上一段
      const root = rec.result?.trace.spans.find((sp) => sp.kind === 'run');
      assert.ok(root, `任务 ${b.taskId} 的 trace 里没有 run 根 span —— 记账被绕过了`);
      const first = firstRunIds.get(b.taskId);
      if (first !== undefined && rec.runId !== undefined && rec.runId !== first) {
        multiSegment++;
        // ⑦ 不只要「有 link」，还要**指对**：终态段根 span 的 link 必须指向**上一段**的 runId
        //    （traceId == runId，见 src/core/trace.ts 头注与 async.ts 的 traceContext 注入；
        //    只查 links 非空的话，指向任何错误目标 —— 甚至指向自己 —— 都算过，断链照样绿）。
        const prev = prevRunIds.get(b.taskId);
        if (prev !== undefined && (root.links ?? []).some((l) => l.traceId === prev)) linked++;
      }
    }
  }

  // 收尾：最后一批已在循环里对过账，这里只剩**读数**确认（不再全表扫）。
  clearInterval(sampler);
  armWatchdog(WATCHDOG_BUFFER_MS);
  await provider.close();
  const dbFinal = statSync(dbFile).size;

  // —— 汇总 ——
  console.log('\n—— soak-suspend 结果 ——');
  console.log(
    `轮次：${rounds} 轮 × ${PER_ROUND} 提交 = ${submittedCount} 任务（${CONCURRENCY} 并发，种子 ${SEED}）`,
  );
  console.log(
    `臂：${ARMS.map((a) => `${a}=${byArm[a]}`).join(' ')}；approve 发出 ${approvalsSent}（落地：人工 ${humanApproved} / 兜底 ${autoDenied}），` +
      `事件投递 ${signalsSent}（投进 ${signalOk}）、幂等闸测到 ${dupAttempted} 次（被拒 ${dupCaught} / 漏拒 ${dupMissed}），resumePending 重派 ${resumedTasks}`,
  );
  console.log(
    `节奏：状态竞态 approve=${approveStateRace} signal=${signalStateRace} 重投=${dupStateRace}；没赶上重投 ${dupSkippedNotSuspended}；还没轮到我就被推走 ${armSkippedNotSuspended}`,
  );
  console.log(
    `工具执行：danger=${runs.danger.length}（应为人工批过的决定=${humanApproved}），` +
      `sleep 执行=${runs.sleepRuns} / 真睡下=${runs.sleptTaken}（应为 timer×2 / timer=${byArm.timer * 2} / ${byArm.timer}）`,
  );
  console.log(
    `端点：requests=${provider.stats.requests} danger 帧=${provider.stats.dangerFrames} sleep 帧=${provider.stats.sleepFrames} 纯文本帧=${provider.stats.plainFrames} 无臂标记帧=${provider.stats.noArm}`,
  );
  console.log(
    `收敛：逐批对账 ${reconciled}/${submittedCount}；收尾读数 inFlight=${runner.inFlight}，挂起登记簿=${JSON.stringify(runner.suspendedSummary)}，跨段 ${linked}/${multiSegment} 条挂上了上一段`,
  );
  console.log(
    `挂起记录体积：${bytesPerSuspended.length} 次采样，峰值 ${(Math.max(0, ...bytesPerSuspended) / 1024).toFixed(1)}KB/条`,
  );
  console.log(
    `DB：末值 ${(dbFinal / 1024 / 1024).toFixed(1)}MB / ${submittedCount} 任务（${dbBytes.length} 次采样）`,
  );

  // —— 断言 ——
  // ① 不丢不卡：每条任务都在**它自己那一批**里被验过终态（逐批对账数 = 提交数），
  //    且收尾的两个读数都归零（在飞 = 0、挂起登记簿除名）。用**读数**而不是全表扫的理由
  //    见循环 5) 的注释：几万条记录的全表读会给 ⑥ 制造与泄漏无关的噪声。
  assert.equal(
    reconciled,
    submittedCount,
    `逐批对账只覆盖 ${reconciled}/${submittedCount} —— 有任务从没被验过终态`,
  );
  assert.equal(runner.inFlight, 0, `收尾还有 ${runner.inFlight} 个在飞任务（挂起链路不收敛）`);
  assert.deepEqual(
    runner.suspendedSummary,
    { approval: 0, timer: 0, nextWakeAt: null },
    '收尾时挂起登记簿没除名（空队列给 null 不给 0）—— 读数泄漏在长跑里会越攒越多',
  );

  // ⑨ **节奏自检**：状态竞态（读到挂起之后又被惰性判定推走）占比过高 ⇒ 大量臂没落地，
  //    读数不可信。这条**放在最前面**（紧跟 ①）是有意的：它判的是「这轮实验成不成立」，
  //    而不是「框架对不对」—— 不成立时应该给出可执行的处置，而不是让后面那些断言
  //    红成「danger 该跑 N 次却跑了 0 次」这种看不懂的形状（2026-09-30 实测：审批窗口
  //    压到 100ms 就长这样，507 个需要审批的任务里人工批落地 0 次）。
  const needApproval = byArm.approve + byArm.timeout + byArm.signal;
  const racy =
    approveStateRace +
    signalStateRace +
    dupStateRace +
    dupSkippedNotSuspended +
    armSkippedNotSuspended;
  assert.ok(
    racy <= Math.max(10, needApproval * 0.2),
    `状态竞态 ${racy} 次（含「还没轮到我」就 ${armSkippedNotSuspended} 次）/ 需要审批的任务 ${needApproval}` +
      ' 超过 20% —— 驱动节奏与审批窗口不匹配 ⇒ 臂大量没落地，这轮的覆盖不可信。' +
      '处置：把 SOAK_SUSPEND_APPROVAL_TIMEOUT_MS 调大，或把 SOAK_SUSPEND_CONCURRENCY / 每轮提交量调小',
  );

  // ② 逐笔对账：**按落地的决定**（不是按臂的标签）—— 每个注入恰好落地一次
  assert.equal(
    runs.danger.length,
    humanApproved,
    `danger 执行 ${runs.danger.length} ≠ 人工批过的决定 ${humanApproved}` +
      '（多 ⇒ 重复执行；少 ⇒ 批了却没跑或被静默吞）',
  );
  assert.equal(
    runs.sleptTaken,
    byArm.timer,
    `真正睡下去的 ${runs.sleptTaken} ≠ timer 臂数 ${byArm.timer}（定时挂起没落地或被重复执行）`,
  );
  assert.equal(
    runs.sleepRuns,
    byArm.timer * 2,
    `sleep 执行 ${runs.sleepRuns} ≠ timer 臂 × 2（${byArm.timer * 2}）—— 到期唤醒要求**重跑**那条 tool_use：` +
      '少一次 = 醒来没重跑（那批活被丢了），多一次 = 重复执行',
  );
  // 每条需要审批的任务都必须留下决定：人工批 + 兜底判拒 = 三条臂之和（决定不许丢）
  assert.equal(
    humanApproved + autoDenied,
    byArm.approve + byArm.timeout + byArm.signal,
    `落地的决定 ${humanApproved} 人工 + ${autoDenied} 兜底 = ${humanApproved + autoDenied}` +
      ` ≠ 需要审批的臂数之和 ${byArm.approve + byArm.timeout + byArm.signal}` +
      '（有任务到终态却没留下决定 —— 决定丢了）',
  );
  // timeout 臂**只能**是兜底判拒（没人批它）
  assert.ok(
    autoDenied >= byArm.timeout,
    `兜底判拒 ${autoDenied} < timeout 臂数 ${byArm.timeout} —— 有「不批不管」的任务没被兜底判掉`,
  );

  // ③ 四条臂各自落地 ≥1（空转的臂会让 ② 变成恒真）
  for (const a of ARMS) {
    assert.ok(byArm[a] > 0, `${a} 臂一次都没落地（注入机制空转，② 那条断言在空转）`);
  }
  assert.ok(
    signalOk > 0,
    `信号臂一次都没**投进去**（投递 ${signalsSent} 次全是状态竞态）—— ③ 的 signal 侧在空转`,
  );
  // 与 signalOk 对称的 approve 侧闸：至少一次人工批**落地**（按落地的决定数，不按「发过几次
  // approve」—— 与 ② 的对账口径一致）。没有它，微档（如 5s×1 并发）下 approve 臂全部竞态
  // 推走也能过：竞态上限有 max(10, …) 的地板拦不住，danger=0=humanApproved=0 空转全绿。
  assert.ok(
    humanApproved > 0,
    `人工批一次都没**落地**（approve 发出 ${approvalsSent} 次，全被惰性兜底推走 / 撞状态竞态）—— ` +
      '③ 的 approve 侧在空转，② 的 danger 对账恒真。处置同 ⑨：调大 SOAK_SUSPEND_APPROVAL_TIMEOUT_MS',
  );
  assert.equal(
    provider.stats.noArm,
    0,
    `有 ${provider.stats.noArm} 个请求没带臂标记 —— 假端点只能瞎猜，② 的对账失效`,
  );

  // ④ 事件恰好一次（不重）：重复投递每次都被**幂等闸**拒；且事件真的走到模型
  //    注意「测到几次」和「投递几次」是两件事：如果某条信号臂在「又挂起」之前就跑完了，
  //    那次重投根本没发生（不算失败，但也**不算测过**）—— 所以要分开数、并给下限。
  assert.equal(
    dupAttempted + dupSkippedNotSuspended,
    signalsSent,
    `信号臂的账不平：${dupAttempted} 次测了幂等闸 + ${dupSkippedNotSuspended} 次没测成 ≠ 投递 ${signalsSent}`,
  );
  assert.ok(
    dupAttempted >= Math.ceil(signalsSent / 2),
    `幂等闸只测到 ${dupAttempted}/${signalsSent} 次（不到一半）—— 驱动节奏跟不上审批窗口，` +
      '④ 的可信度不够：把 SOAK_SUSPEND_APPROVAL_TIMEOUT_MS 调大，或把并发/每轮提交量调小',
  );
  assert.equal(dupMissed, 0, `有 ${dupMissed} 次重复投递没被 409 拒掉 —— 「恰好一次」破了`);
  assert.equal(dupCaught, dupAttempted, `被幂等拒 ${dupCaught} ≠ 重投次数 ${dupAttempted}`);
  assert.equal(
    dupStateRace,
    0,
    `有 ${dupStateRace} 次重投撞在非挂起状态 —— 那几次等于没测到幂等闸（幂等闸只在挂起态生效）`,
  );
  assert.equal(
    firstDupUnexpected,
    0,
    `有 ${firstDupUnexpected} 次「第一次投递」就被判成重复 —— 每个任务的 eventId 唯一，这是 id 撞了`,
  );
  assert.ok(
    provider.stats.eventRendered >= signalsSent,
    `模型侧只看到 ${provider.stats.eventRendered} 次事件渲染 < 投递 ${signalsSent} 次 —— 有事件只落在库里没进模型`,
  );
  assert.ok(
    provider.stats.eventMaxPerRequest <= 1,
    `单次请求里出现 ${provider.stats.eventMaxPerRequest} 次同一事件 —— 重复注入`,
  );

  // ⑤ 非终态记录体积**不随时间涨**（前后四分位）+ 量级闸
  assert.ok(
    bytesPerSuspended.length >= 4,
    `挂起体积采样不足（${bytesPerSuspended.length} 次）—— 这是脚本 bug，不是跳过`,
  );
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const q = Math.max(1, Math.floor(bytesPerSuspended.length / 4));
  const headBytes = avg(bytesPerSuspended.slice(0, q));
  const tailBytes = avg(bytesPerSuspended.slice(-q));
  assert.ok(
    Math.max(...bytesPerSuspended) < 64 * 1024,
    `单条挂起记录峰值 ${(Math.max(...bytesPerSuspended) / 1024).toFixed(1)}KB > 64KB —— 有人在记录里攒东西`,
  );
  assert.ok(
    tailBytes <= headBytes * 2,
    `挂起记录字节数随时间涨：前 1/4 均值 ${(headBytes / 1024).toFixed(1)}KB → 后 1/4 ${(tailBytes / 1024).toFixed(1)}KB`,
  );

  // ⑤b DB 体积：**只卡斜率**（字节/任务），不卡总量 —— 记录本来就随任务数线性长
  //     （`e2e-soak-app` ⑦ 的同款口径：线性才让长档短档可比；「45 分钟涨到 600MB」不是判据，
  //     因为那是设计使然，卡总量只会得到一个恒红的假闸）。
  assert.ok(dbBytes.length >= 4, `DB 体积采样不足（${dbBytes.length} 次）—— 脚本 bug，不是跳过`);
  const qd = Math.max(1, Math.floor(dbBytes.length / 4));
  const dbHead = avg(dbBytes.slice(0, qd));
  const dbTail = avg(dbBytes.slice(-qd));
  const tasksHead = tasksAtDbSample[0] ?? 0;
  const tasksTail = tasksAtDbSample[tasksAtDbSample.length - 1] ?? 0;
  const bytesPerTask = (dbTail - dbHead) / Math.max(1, tasksTail - tasksHead);
  assert.ok(
    bytesPerTask <= 64 * 1024,
    `DB 每任务 ${(bytesPerTask / 1024).toFixed(1)}KB（前 1/4 → 后 1/4，共 ${tasksTail - tasksHead} 个任务）> 64KB —— 记录里在攒东西`,
  );

  // ⑥ heapUsed 有界（同 e2e-soak 的口径：丢前 20% 预热，末 3 均值 vs 前 3 均值）
  assert.ok(
    memSamples.length >= 10,
    `内存采样不足（${memSamples.length} 个）—— 采样间隔缩放失效，这是脚本 bug，不是跳过`,
  );
  const warm = memSamples.slice(Math.ceil(memSamples.length * 0.2));
  const headAvg = avg(warm.slice(0, 3).map((s) => s.heap));
  const tailAvg = avg(warm.slice(-3).map((s) => s.heap));
  assert.ok(
    tailAvg - headAvg < 48 * 1024 * 1024,
    `heapUsed 热身后仍增长 ${mb(tailAvg - headAvg)}（${mb(headAvg)} → ${mb(tailAvg)}）—— 疑似泄漏`,
  );

  // ⑦ 跨段就必须 link、且 link 必须**指对**（循环里逐条核过「指向上一段 runId」才计入 linked）：
  //    恢复段 trace 经 `link` 挂到上一段 ——
  //    挂起/恢复不许把 trace 记账绕过去（「每次 run 产出可观测调用树」是框架的对外承诺）。
  //    判据用**观察到的**第一段 runId 与终态 runId 比对（在循环里逐条数的），不按臂名猜 ——
  //    臂名与段数的对应是实现细节，写死会让断言在实现优化后变成假红。
  assert.ok(
    multiSegment > 0,
    '没有任何任务跨段（挂起 → 恢复这条路径一次都没被压到）—— 驱动或注入坏了，这档在空转',
  );
  assert.equal(
    linked,
    multiSegment,
    `跨段任务只有 ${linked}/${multiSegment} 条的恢复段 trace 挂上了上一段（link 断了 = 调用树断成两棵）`,
  );

  // 不撤看门狗，换最后一档短宽限：它 unref 过、自己吊不住进程；main 返回后进程若没退，
  // 到点它照样响 —— ⑧ 要抓的「断言完还有句柄吊着」正是这一档（撤掉就永远没人报了）。
  armWatchdog(WATCHDOG_FINAL_GRACE_MS);
  // 跑绿了才清掉临时库；红了留着 —— 那正是唯一能用来复盘的东西（路径会打在报错里）
  rmSync(dbDir, { recursive: true, force: true });
  console.log(
    `\nOK —— soak 全过：${submittedCount} 任务 / ${rounds} 轮，四条臂逐笔对账（${ARMS.map(
      (a) => `${a}=${byArm[a]}`,
    ).join(' ')}），` +
      `事件恰好一次（${signalsSent} 投递全被幂等拒住重复），挂起记录体积持平（${(
        headBytes / 1024
      ).toFixed(1)}KB → ${(tailBytes / 1024).toFixed(1)}KB），` +
      `DB 每任务 ${(bytesPerTask / 1024).toFixed(1)}KB（线性），` +
      `heap ${mb(headAvg)} → ${mb(tailAvg)}（热身后），干净退出。`,
  );
}

await main();
