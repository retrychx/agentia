/**
 * 上线演练 —— 拿真模型、真任务，把 [`docs/deployment.md`](../../docs/deployment.md) 的
 * 十条清单**逐条真跑一遍**，并把每条实测读数落盘。
 *
 * 它证的不是「模型聪不聪明」，是**宿主接线对不对**：
 *   ① 拒未鉴权（§3）· ② /metrics 不鉴权这条边界是真的（§3）· ③ /healthz 的就绪判据（§4）
 *   ④ 审批挂起 → 人批 → 恢复（§2 HITL）· ⑤ SIGKILL 后同库重启续跑**到成功**（§2 崩溃演练）
 *   ⑥ 预算保险丝真的会咬、且算失败而非静默截断（§6）
 *   ⑦ SIGTERM → drain → 退出码 0，且停机宽限 > drain 超时（§5）
 *
 * 跑法（key 不落盘，从 ~/.hermes/.env 取）：
 *   set -a; . ~/.hermes/.env; set +a
 *   cd examples/patrol && npm run drill
 *
 * **默认跑源码（tsx src/main.ts），但 Dockerfile 的 CMD 跑的是编译产物** ——
 * 二者只差一层编译，可「源码能跑」推不出「产物能跑」（构建配置错、入口路径错都不会
 * 在源码路径上暴露）。所以入口可切：
 *   PATROL_DRILL_ENTRY=dist npm run build && PATROL_DRILL_ENTRY=dist npm run drill
 * 十一条断言一字不改地用在产物上，产物那条路才配叫「验过」。
 *
 * 产物：`<PATROL_DRILL_OUT>/drill-readings.json`（缺省 ./.drill-out/，已 gitignore）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.PATROL_DRILL_OUT ?? join(HERE, '.drill-out'));
const TOKEN = 'drill-token-' + Math.random().toString(36).slice(2, 10);

// 每次演练都在**干净副本**上跑：隔离动作会真的移动文件，不能让它弄脏仓库里的示例工作区
const RUN_DIR = join(OUT, `run-${Date.now()}`);
const WS = join(RUN_DIR, 'workspace');
const REPORTS = join(RUN_DIR, 'reports');
const DB = join(RUN_DIR, 'patrol.db');

interface Phase {
  id: string;
  title: string;
  ok: boolean;
  readings: Record<string, unknown>;
  note?: string;
}
const phases: Phase[] = [];

/** 两个服务进程的日志攒在这里 —— 某个阶段红了时，最后 40 行是最有用的线索 */
const serviceLogs: string[] = [];

function record(
  id: string,
  title: string,
  ok: boolean,
  readings: Record<string, unknown>,
  note?: string,
) {
  phases.push({ id, title, ok, readings, ...(note ? { note } : {}) });
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${id} ${title}`);
  for (const [k, v] of Object.entries(readings)) console.log(`      ${k}: ${JSON.stringify(v)}`);
  if (note) console.log(`      note: ${note}`);
}

// ── 起服务 ────────────────────────────────────────────────────────────────
interface Service {
  proc: ChildProcess;
  logs: string[];
  port: number;
}

/**
 * 被演练的入口 —— 缺省源码，`PATROL_DRILL_ENTRY=dist` 换成编译产物。
 * 判据取**显式相等**（不是「非 dist 就是源码」）：拼错一个字母时应当**响亮失败**，
 * 不是静默回落到源码 —— 那会让人以为「产物验过了」而其实验的是源码。
 */
const ENTRY: readonly string[] =
  process.env.PATROL_DRILL_ENTRY === undefined || process.env.PATROL_DRILL_ENTRY === 'src'
    ? ['--import', 'tsx', 'src/main.ts']
    : process.env.PATROL_DRILL_ENTRY === 'dist'
      ? ['dist/main.js']
      : (() => {
          throw new Error(
            `PATROL_DRILL_ENTRY 只认 'src' / 'dist'，收到 ${JSON.stringify(process.env.PATROL_DRILL_ENTRY)}`,
          );
        })();

// 产物不存在就别等到 30 秒就绪超时再报错（那时日志里只有一句 MODULE_NOT_FOUND）
if (ENTRY[0] === 'dist/main.js' && !existsSync(join(HERE, 'dist/main.js'))) {
  throw new Error('PATROL_DRILL_ENTRY=dist 但 dist/main.js 不存在 —— 先跑 `npm run build`');
}

function spawnService(extraEnv: Record<string, string> = {}): Promise<Service> {
  const logs: string[] = [];
  const proc = spawn(process.execPath, [...ENTRY], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: '0',
      PATROL_ROOT: WS,
      PATROL_REPORTS: REPORTS,
      PATROL_DB: DB,
      PATROL_TOKEN: TOKEN,
      PATROL_MAX_TOKENS: process.env.PATROL_MAX_TOKENS ?? '120000',
      PATROL_MAX_COST_USD: process.env.PATROL_MAX_COST_USD ?? '3',
      PATROL_MAX_ITERATIONS: process.env.PATROL_MAX_ITERATIONS ?? '16',
      PATROL_DRAIN_TIMEOUT_MS: '15000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<Service>((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error(`服务 ${30_000}ms 未就绪:\n${logs.join('\n')}`)),
      30_000,
    );
    const onLine = (line: string) => {
      logs.push(line);
      serviceLogs.push(line);
      const m = line.match(/\[boot\] listening on :(\d+)/);
      if (m) {
        clearTimeout(timer);
        res({ proc, logs, port: Number(m[1]) });
      }
    };
    let buf = '';
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) onLine(l);
      });
    }
    proc.on('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`服务在就绪前退出（code=${code}）:\n${logs.join('\n')}`));
    });
  });
}

async function waitExit(proc: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    proc.once('exit', (code) => {
      clearTimeout(t);
      res(code);
    });
  });
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────
interface Res {
  status: number;
  body: unknown;
  text: string;
}
async function api(
  port: number,
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = `Bearer ${TOKEN}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON（如 Prometheus 文本）保持原样 */
  }
  return { status: r.status, body, text };
}

/** TaskRecord 的字段名以 `src/store/store.ts` 为准（是 `taskId`，**不是** `id`） */
interface TaskRecordLite {
  taskId: string;
  status: string;
  suspendedReason?: string;
  pendingApprovals?: string[];
  error?: { type?: string; message?: string };
  result?: { stopReason?: string; iterations?: number };
}
async function pollTask(port: number, id: string): Promise<TaskRecordLite> {
  const r = await api(port, `/tasks/${encodeURIComponent(id)}`, { auth: true });
  return r.body as TaskRecordLite;
}
async function waitFor(
  port: number,
  id: string,
  pred: (t: TaskRecordLite) => boolean,
  ms: number,
  label: string,
): Promise<TaskRecordLite> {
  const t0 = Date.now();
  for (;;) {
    const rec = await pollTask(port, id);
    if (pred(rec)) return rec;
    if (Date.now() - t0 > ms)
      throw new Error(`等 ${label} 超时（${ms}ms），最后一次状态：${JSON.stringify(rec)}`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n=== 巡检上线演练 ===\n产出目录: ${OUT}\n被验入口: node ${ENTRY.join(' ')}\n`);
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  cpSync(join(HERE, 'sample-workspace'), WS, { recursive: true });
  console.log(`干净副本就绪: ${WS}\n`);

  const svc = await spawnService();
  const port = svc.port;
  // 服务起没起（就绪信号）本身是一条读数；**入口**也记进去 ——
  // 读数文件脱离上下文后，得能自证「这份读数验的是源码还是产物」
  record('P0', '服务启动并打印就绪信号', true, { port, entry: ENTRY.join(' ') });

  // ── §3 鉴权 ───────────────────────────────────────────────────────────
  const noAuth = await api(port, '/tasks', { method: 'POST', body: { input: 'x' } });
  // 已鉴权但体不合法 ⇒ 400（不是 401）—— 证明「鉴权」与「入参校验」是两件事
  const badBody = await api(port, '/tasks', { method: 'POST', auth: true, body: {} });
  record(
    'P1',
    '§3 鉴权：未带 token 被拒；已鉴权但体不合法是 400（两件事）',
    noAuth.status === 401 && badBody.status === 400,
    { 未鉴权_POST_tasks: noAuth.status, 已鉴权但空体_POST_tasks: badBody.status },
  );
  const metricsRes = await api(port, '/metrics');
  record(
    'P2',
    '§3 /metrics 不鉴权（边界已登记，须由反代限制）',
    metricsRes.status === 200,
    { GET_metrics: metricsRes.status, 首行: metricsRes.text.split('\n')[0]?.slice(0, 60) ?? '' },
    '这是 usage-guide §7 登记的边界，不是缺陷',
  );

  // ── §4 /healthz ──────────────────────────────────────────────────────
  const hz = await api(port, '/healthz');
  record(
    'P3',
    '§4 /healthz 就绪判据',
    hz.status === 200 && (hz.body as { ok: boolean }).ok === true,
    {
      ...(hz.body as Record<string, unknown>),
    },
  );

  // ── §2 HITL：审批挂起 → 人批 → 恢复 ────────────────────────────────────
  const TARGET = 'notes/legacy/2023-brainstorm.md';
  const submit = await api(port, '/tasks', {
    method: 'POST',
    auth: true,
    body: {
      // ⚠️ 入站体是 `{ input, idempotencyKey?, options? }`（http-shapes.ts 的 TaskSubmitBody）——
      //    不是 `{ prompt }`。发错了框架回 400（input 为空），不是 500。
      input:
        `巡检这份代码库（就是你的巡检根），写一份 Markdown 报告到 patrol.md（用 write_report）。\n` +
        `报告要求：目录概况 + 至少 3 条有证据的发现（每条附 路径:行号 与原文片段）+ 建议隔离的文件。\n` +
        `写完后，对 ${TARGET} 调用一次 quarantine_path，reason 写清理由。`,
    },
  });
  const taskId = (submit.body as { taskId: string }).taskId;
  record('P4', '§2 提交异步任务', submit.status === 202 || submit.status === 201, {
    状态码: submit.status,
    taskId,
    初始状态: (submit.body as { status: string }).status,
  });

  let approvalOk = false;
  let approvalReading: Record<string, unknown> = {};
  try {
    const suspended = await waitFor(
      port,
      taskId,
      (t) => t.status === 'suspended',
      240_000,
      '审批挂起',
    );
    approvalReading = {
      状态: suspended.status,
      挂起原因: suspended.suspendedReason,
      待决项: suspended.pendingApprovals ?? [],
    };
    const ids = suspended.pendingApprovals ?? [];
    const decisions: Record<string, { approved: boolean; reason: string }> = {};
    for (const id of ids) decisions[id] = { approved: true, reason: 'drill：人批通过' };
    const ap = await api(port, `/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: 'POST',
      auth: true,
      body: { decisions, decidedBy: 'drill' },
    });
    approvalReading.审批响应 = ap.status;
    const done = await waitFor(
      port,
      taskId,
      (t) => t.status === 'succeeded' || t.status === 'failed',
      240_000,
      '审批后收尾',
    );
    approvalReading.收尾状态 = done.status;
    approvalOk = suspended.status === 'suspended' && ids.length > 0 && done.status === 'succeeded';
  } catch (e) {
    approvalReading.错误 = (e as Error).message;
  }
  record('P5', '§2 审批挂起 → 人批 → 恢复收尾', approvalOk, approvalReading);

  // 报告与隔离的**落到盘上的**证据（不看模型自述，看文件系统）
  const reportPath = join(REPORTS, 'patrol.md');
  const quarantinedDir = join(REPORTS, 'quarantine');
  const movedAway = !existsSync(join(WS, TARGET));
  const quarantined = listFiles(quarantinedDir);
  record(
    'P6',
    '产物与副作用真的落在盘上',
    existsSync(reportPath) && movedAway && quarantined.length > 0,
    {
      报告存在: existsSync(reportPath),
      报告字节: existsSync(reportPath) ? readFileSync(reportPath).byteLength : 0,
      原件仍在巡检根内: movedAway ? '否（已移走）' : '是（未隔离）',
      隔离区文件: quarantined,
    },
  );

  const traceFile = join(REPORTS, 'traces', 'trace.jsonl');
  record('P7', '§7 trace sink 落盘', existsSync(traceFile), {
    trace文件: existsSync(traceFile),
    trace行数: existsSync(traceFile)
      ? readFileSync(traceFile, 'utf8').trim().split('\n').length
      : 0,
  });

  // ── §2 崩溃演练：SIGKILL 后同库重启续跑 ────────────────────────────────
  const crashSubmit = await api(port, '/tasks', {
    method: 'POST',
    auth: true,
    body: {
      // 刻意**轻**：崩溃演练验的是「续跑接得上」，不是「模型能不能啃大活」。
      // 若任务本身会撞预算保险丝，失败原因就掺了第二种因素，这条断言就不再干净。
      input:
        '读 README.md 和 src/app.ts 两个文件，然后用 write_report 写一份 150 字的中文摘要到 crash-report.md。',
    },
  });
  const crashId = (crashSubmit.body as { taskId: string }).taskId;
  const running = await waitFor(
    port,
    crashId,
    (t) => t.status === 'running' || t.status === 'succeeded' || t.status === 'failed',
    60_000,
    '任务进入 running',
  );
  const killedAt = running.status;
  svc.proc.kill('SIGKILL');
  await waitExit(svc.proc, 10_000);
  console.log(`   （已在状态 ${killedAt} 时 SIGKILL，进程已死）`);

  const beforeRestart = await readDbStatus(DB, crashId);
  const svc2 = await spawnService();
  const resumedLog = svc2.logs.find((l) => l.includes('续跑'));
  let crashOk = false;
  let crashReading: Record<string, unknown> = {};
  try {
    const after = await waitFor(
      svc2.port,
      crashId,
      (t) => t.status === 'succeeded' || t.status === 'failed',
      300_000,
      '崩溃后续跑收尾',
    );
    crashReading = {
      被杀时状态: killedAt,
      重启前库内状态: beforeRestart,
      重启日志: resumedLog ?? '（未打印续跑行）',
      续跑后状态: after.status,
      续跑后stopReason: after.result?.stopReason,
    };
    // 断言收严到 **succeeded**：这里只许成功，不许 failed —— 否则失败原因（预算 / 模型 /
    // 工具）会混进来，这条就不再是在验「续跑接得上」了（第一版就是这么糊过去的）
    crashOk = after.status === 'succeeded';
  } catch (e) {
    crashReading = {
      被杀时状态: killedAt,
      重启前库内状态: beforeRestart,
      错误: (e as Error).message,
    };
  }
  record('P8', '§2 崩溃演练：SIGKILL → 同库重启 → 续跑**成功**收尾', crashOk, crashReading);

  // ── §6 预算保险丝：真的会咬，且**算失败**不是静默截断 ────────────────────
  const budgetSubmit = await api(svc2.port, '/tasks', {
    method: 'POST',
    auth: true,
    body: {
      input: '把巡检根下每个文件都完整读一遍，然后写一份尽可能长的逐文件报告到 big.md。',
      // 单次任务覆盖（RunInvocationOptions.maxTotalTokens）—— 用很小的上限把保险丝钉死，
      // 不必真烧十几万 token 等它自然触发
      options: { maxTotalTokens: 3_000 },
    },
  });
  const budgetId = (budgetSubmit.body as { taskId: string }).taskId;
  let budgetOk = false;
  let budgetReading: Record<string, unknown> = {};
  try {
    const done = await waitFor(
      svc2.port,
      budgetId,
      (t) => t.status === 'succeeded' || t.status === 'failed',
      180_000,
      '预算超限收尾',
    );
    budgetReading = {
      收尾状态: done.status,
      stopReason: done.result?.stopReason,
      错误类型: done.error?.type,
      错误文案: done.error?.message,
      回合数: done.result?.iterations,
      设的上限: 3_000,
    };
    budgetOk = done.status === 'failed' && done.result?.stopReason === 'budget_exceeded';
  } catch (e) {
    budgetReading = { 错误: (e as Error).message };
  }
  record(
    'P9',
    '§6 预算保险丝：超限以 budget_exceeded 收尾并**算失败**',
    budgetOk,
    budgetReading,
    '读数是「真咬了一次」的现场，不是抄文档',
  );

  // ── §5 优雅停机 ───────────────────────────────────────────────────────
  const t0 = Date.now();
  svc2.proc.kill('SIGTERM');
  const exitCode = await waitExit(svc2.proc, 30_000);
  const drainMs = Date.now() - t0;
  record(
    'P10',
    '§5 SIGTERM → drain → 退出码 0',
    exitCode === 0,
    { 退出码: exitCode, drain耗时ms: drainMs, drain超时ms: 15_000 },
    'compose 的 stop_grace_period=25s 必须 > 这里 15s，否则宽限先到、容器被 SIGKILL',
  );

  // ── 落盘读数 ──────────────────────────────────────────────────────────
  const allOk = phases.every((p) => p.ok);
  const out = {
    ranAt: new Date().toISOString(),
    model: process.env.AGENTIA_MODEL ?? 'deepseek-v4-pro',
    node: process.version,
    allOk,
    phases,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'drill-readings.json'), JSON.stringify(out, null, 2));

  console.log(`\n=== 演练结束：${phases.filter((p) => p.ok).length}/${phases.length} 通过 ===`);
  console.log(`读数已落盘: ${join(OUT, 'drill-readings.json')}`);
  if (!allOk) {
    console.log('\n--- 服务日志（尾部 40 行，排障用）---');
    for (const l of serviceLogs.slice(-40)) console.log(l);
    process.exitCode = 1;
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * 不经服务直读 SQLite 里那条记录的状态 —— 崩溃后服务已死，只能自己读库。
 * 表结构见 `src/store/sqliteStore.ts`（`tasks(task_id, status, wake_at, json)`）。
 */
async function readDbStatus(dbPath: string, taskId: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const script =
    `const {DatabaseSync}=require('node:sqlite');` +
    `const db=new DatabaseSync(${JSON.stringify(dbPath)});` +
    `const r=db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(${JSON.stringify(taskId)});` +
    `process.stdout.write(JSON.stringify(r??null));`;
  try {
    const raw = execFileSync(process.execPath, ['--no-warnings', '-e', script], {
      encoding: 'utf8',
    });
    const row = JSON.parse(raw) as { status: string } | null;
    return row?.status ?? '（库里没有这条记录）';
  } catch (e) {
    return `（读库失败：${(e as Error).message.slice(0, 120)}）`;
  }
}

await main();
