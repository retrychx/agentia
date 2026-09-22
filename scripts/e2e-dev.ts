// dev 环端到端验证：`agentia dev` 真的能驱动用户工程跑一次 run。
//
// 运行：npm run e2e（先 build 框架与 CLI，再 tsx 跑本脚本）
//
// ## 为什么单独有这一条（它补的是一整块空白）
//
// 2026-09-22 落 dev 调试环时，`scripts/` 下**没有任何**东西碰过 `agentia dev`：
// `rg -ln "agentia dev|dev-runner" scripts/*.ts` 返回空，e2e-cli 只断言了生成的
// `package.json` 里有 `dev` 这个 script 名。于是 dev.ts / dev-runner.ts /
// inspector-page.html 这一整块（本轮改动里最大的一块）**零覆盖**。
//
// 代价当场就付了：写完门禁全绿，随手写的真跑探针一次就抓出**两个真缺陷**——
//   ① `spawn('npx', ['tsx', …])`：npx 是包装器，它不给孙进程转发 fd 3 的 IPC 通道，
//      runner 里 `process.send` 变成 undefined（而代码写的是 `process.send?.()`，可选链），
//      所有协议消息静默丢弃 ⇒ 面板永远等不到 ready、`POST /run` 永远回不来；
//      没有 IPC 通道后事件循环排空，进程还会以 **code=0 干净退出**（看起来像「用户代码跑完了」）。
//   ② `loadEnvFile()` 留在 main.ts，而 dev 环只 import app.ts、从不执行 main.ts
//      ⇒ `npm run dev` 静默读不到 `.env`，`npm start` 读得到。
//
// 两条都**不是**单测能拦的形状：单测问的是「模板函数返回了什么」，而这两条要
// 「把 CLI 起起来、把 runner 拉起来、把一次 run 真跑完」才看得见。所以本脚本的断言
// 全部是**行为**的，且各钉住一个缺陷：
//   · 能力菜单非空             → ①（菜单是 runner 经 IPC 报回来的；父进程在 ready 前
//                                拿的是初值 `[]`，所以「非空」才等于「IPC 通了」）
//   · run 成功且正文来自假端点 → ②（key 与 base_url **只**写在工程 `.env` 里，
//                                进程环境里被显式删掉 ⇒ 不读 .env 必失败）
//   · 收窄能力后请求体真的变窄 → 面板的能力选择器真接线了（不是摆设）
//   · 改 `.md` 触发重启且能恢复 → G3b 那条承诺（旧实现静默无感）在真进程里成立
//   · 换能力选择的重启窗口内第二次 POST /run 必须 409 → §6 待定 5 的「默认拒绝」在那条
//     窄窗口上真的成立（只看 `running` 的闸会放两个 run 并发进来）
//   · 坏掉的会话文件必须出现在 warning 通道 → 否则历史静默消失、新历史写不进去
//   · `agentia dev -- "问题"` 的 prompt 真的到了模型手上 → 裸 CLI 那条会把 `--` 当 prompt
//   · Ctrl+C 之后 runner（连它那棵进程树）必须真的没了 → 旧的 50 ms 硬退会丢 SIGKILL 兜底
//   · run 在飞期间就有增量记账帧、且折回 == 收尾的整棵 trace → 右栏实时（①）。旧形态下
//     `playTrace` 只在收尾后调一次，一次十几秒的 run 期间右栏是死的；这条同时钉住
//     「帧真的在收尾前送到」与「面板的折回规则与框架的记账一致」（后者框架自己有单测，
//     但**经过 HTTP + SSE 这条路**有没有丢/乱序，只有这里看得见）
//
// ⚠️ 模型侧是**本进程里的**假 Anthropic 端点（零网络、零 token），所以全程必须
//    `spawn` + await，**不能用 spawnSync**：同步等待会阻塞事件循环，子进程永远等不到响应。
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`DEV E2E FAIL: ${msg}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const tmp = mkdtempSync(join(tmpdir(), 'agentia-dev-'));

/** 假端点回的正文：只要看到它，就证明这次 run 真的打到了我们那个假端点 */
const REPLY = 'DEV_E2E_OK';

interface SseEvent {
  event: string;
  data: string;
}

/** 已收到的 `dev` 帧。等事件、报超时现场都靠它 */
const seen: SseEvent[] = [];

/**
 * 开一条 `/stream` 并把收到的帧推进 `seen`。
 *
 * 为什么用 SSE 而不是轮询 `/api/runs`：`finalText` **只以返回值存在** —— 引擎刻意
 * 不把它挂进 trace，面板拿到的唯一途径就是 IPC 的 `run-done` → 这里。轮询拿不到它，
 * 而「回复正文是什么」正是「这次 run 真的成功了」最直接的证据。
 */
async function openStream(base: string, token: string): Promise<AbortController> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/stream?t=${encodeURIComponent(token)}`, {
    signal: ctrl.signal,
  });
  assert(res.ok, `/stream 应 200，实际 ${res.status}`);
  const body = res.body;
  // 不用 `assert(body !== null, …)`：本脚本的 assert 不是断言函数（没有 `asserts` 签名），
  // tsc 不会因此收窄类型。显式抛一次最省事，也照样响亮。
  if (body === null) throw new Error('DEV E2E FAIL: /stream 没有响应体');
  void (async () => {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let cut = buf.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev !== undefined && data !== undefined) seen.push({ event: ev, data });
        cut = buf.indexOf('\n\n');
      }
    }
  })().catch(() => {
    /* abort 收尾时的正常路径 */
  });
  return ctrl;
}

/** 已收到的 `dev` 帧里，`kind` 匹配的那些（报超时现场与「有没有多余重启」都用它） */
function devFrames(kind: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of seen) {
    if (e.event !== 'dev') continue;
    try {
      const obj = JSON.parse(e.data) as Record<string, unknown>;
      if (obj.kind === kind) out.push(obj);
    } catch {
      /* 非 JSON 的帧不该出现在 dev 通道，忽略 */
    }
  }
  return out;
}

/**
 * 等第 `skip + 1` 条某类 `dev` 帧（`skip` 用于「同一个脚本里跑多次」的场景 —— 只按
 * 数组头查会永远拿到**第一条**，于是第二次断言断的是第一次的结果，假绿）。
 *
 * 超时时把**已收到的**帧一起报出来 —— 没有这份现场，失败只剩「超时」两个字。
 */
async function waitDev(kind: string, ms: number, skip = 0): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hits = devFrames(kind);
    if (hits.length > skip) return hits[skip] as Record<string, unknown>;
    if (Date.now() > deadline) {
      throw new Error(
        `等第 ${skip + 1} 条 dev/${kind} 超时（${ms} ms，只收到 ${hits.length} 条）。` +
          `全部帧：${JSON.stringify(seen.map((e) => e.data))}`,
      );
    }
    await sleep(50);
  }
}

let dev: ChildProcess | null = null;
let sse: AbortController | null = null;
const devOut: string[] = [];
const fake = createServer();
let fakeBase = '';
/**
 * 被「挂住不回复」开关留在手上的响应（第 10 步）。放在 try 之外是为了 finally 里能收尾 ——
 * 失败路径上留着未 end 的响应，假服务器就关不掉（`fake.close()` 的 callback 永不触发）。
 */
const held: ServerResponse[] = [];

try {
  // —— 1) 建工程 + 接线（与 e2e-cli 同法：只给依赖解析，不 npm install，不联网）——
  execFileSync(process.execPath, [cliPath, 'create', 'dev-app', '--dir', tmp], {
    cwd: tmp,
    encoding: 'utf8',
  });
  const proj = join(tmp, 'dev-app');
  mkdirSync(join(proj, 'node_modules', '@migor'), { recursive: true });
  symlinkSync(repoRoot, join(proj, 'node_modules', '@migor', 'agentia'), 'dir');
  // tsx 是 dev 环的**硬依赖**（runner 要 import 用户的 .ts）：dev.ts 从**用户工程**解析
  // `tsx/cli`。软链一份即等价于「用户装好了 devDependencies」，且不碰网络。
  symlinkSync(join(repoRoot, 'node_modules', 'tsx'), join(proj, 'node_modules', 'tsx'), 'dir');

  // —— 2) 假 Anthropic 端点 ——
  const seenBodies: string[] = [];
  /**
   * 「挂住不回复」开关（第 10 步用）。
   *
   * 为什么需要它：假端点平时**立刻**回完，一次 run 只活几毫秒 —— 那个窗口里根本
   * 插不进一个 `POST /run/abort`。而「中止在飞 run」这条恰恰只有在**真在飞**时
   * 才测得到（否则测到的是 409「没有在飞的 run」那条分支，看着绿、什么都没验）。
   * 打开它之后端点只发 `message_start` 就不再说话，run 就停在模型调用上。
   */
  let holdReply = false;
  fake.on('request', (req, res) => {
    // 被 abort 掐断的连接上再写会 emit 'error'，没有监听器就是未捕获异常
    res.on('error', () => {
      /* 中止路径的正常噪声 */
    });
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      seenBodies.push(raw);
      const ev = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'fake-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      if (holdReply) {
        held.push(res);
        return; // 就停在这里：run 卡在模型调用上，等第 10 步来中止
      }
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: REPLY },
      });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const addr = fake.address();
  assert(typeof addr === 'object' && addr !== null, '假端点没拿到端口');
  fakeBase = `http://127.0.0.1:${(addr as { port: number }).port}`;

  // —— 3) 凭据**只**写进工程 .env，进程环境里显式删干净 ——
  //    这是缺陷 ② 的判据：若 dev 环不读 .env，这次 run 必然拿不到 key / 打不到假端点。
  //    不删的话，本机 export 过 ANTHROPIC_* 的人会得到一条**假绿**。
  writeFileSync(
    join(proj, '.env'),
    `ANTHROPIC_API_KEY=sk-fake-dev-e2e\nANTHROPIC_BASE_URL=${fakeBase}\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;

  // —— 4) 起 agentia dev ——
  dev = spawn(process.execPath, [cliPath, 'dev'], {
    cwd: proj,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer): void => {
    devOut.push(chunk.toString('utf8'));
  };
  dev.stdout?.on('data', collect);
  dev.stderr?.on('data', collect);

  // Inspector 行里同时带 port 与 token —— 面板的入口 URL 就是它，正则从同一处取，不另算。
  const banner = await (async (): Promise<string> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const hit = devOut.join('').match(/Inspector: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/);
      if (hit !== null) return hit[1] as string;
      if (dev.exitCode !== null) {
        throw new Error(`agentia dev 提前退出（code=${dev.exitCode}）。输出：\n${devOut.join('')}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`60s 内没看到 Inspector 行。输出：\n${devOut.join('')}`);
      }
      await sleep(50);
    }
  })();
  const url = new URL(banner);
  const token = url.searchParams.get('t') as string;
  const base = `http://127.0.0.1:${url.port}`;

  const api = async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-agentia-token': token,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  // —— 5) /api/dev：runner 真的就绪了吗（缺陷 ①）——
  //    capabilities 非空是**唯一**能证明「IPC 通了、runner 完成了装配」的信号：
  //    父进程在 ready 之前拿 ChildHandle 的初值回答，而那个初值恰好就是 `[]`。
  //    所以这里必须**轮询**：banner 是 inspector 起来就打的，那时 runner 可能还在装配。
  //    （面板侧不需要轮询 —— 它靠 `runner-ready` 事件补刷，见下面第 8 步。）
  const dev0 = await (async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 60_000;
    let last: Record<string, unknown> = {};
    for (;;) {
      const r = await api('/api/dev');
      assert(r.status === 200, `/api/dev 应 200，实际 ${r.status}`);
      last = r.json;
      if ((r.json.capabilities as string[]).length > 0) return r.json;
      if (r.json.lastError !== null) {
        throw new Error(`runner 装配失败：${JSON.stringify(r.json.lastError)}\n${devOut.join('')}`);
      }
      if (dev.exitCode !== null) {
        throw new Error(`agentia dev 提前退出（code=${dev.exitCode}）\n${devOut.join('')}`);
      }
      if (Date.now() > deadline) {
        throw new Error(
          '60s 内 runner 没报出能力菜单（capabilities 一直是 []）—— 通常是 runner 没发出 ' +
            `ready（IPC 断了）。最后一次 /api/dev：${JSON.stringify(last)}\n${devOut.join('')}`,
        );
      }
      await sleep(100);
    }
  })();
  const caps0 = dev0.capabilities as string[];
  // 钉**精确集合**而不是「非空」：脚手架 create 只生成 src/tools/ 下这两个能力
  // （echo-back / note-writer / style-guide / doc-reviewer 是 `agentia g` 生成的那批）。
  // 精确集合能同时挡住「空菜单」与「多出不该有的 token」两种漂移。
  assert(
    JSON.stringify(caps0) === JSON.stringify(['hello', 'read-file']),
    `新工程的菜单应恰好是 ["hello","read-file"]，实际：${JSON.stringify(caps0)}`,
  );
  assert(dev0.lastError === null, `/api/dev 不该有 lastError：${JSON.stringify(dev0.lastError)}`);

  // —— 6) 鉴权边界：没 token 的请求必须被拒 ——
  //    这是「本机另一个进程能不能随便 curl 你的面板」的那道门。
  const noToken = await fetch(`${base}/api/dev`);
  assert(noToken.status === 403, `不带 token 的 /api/dev 应 403，实际 ${noToken.status}`);

  // —— 7) 真跑一次（全量菜单）——
  sse = await openStream(base, token);
  const ack0 = await api('/run', { method: 'POST', body: { prompt: '冒烟一次' } });
  assert(ack0.status === 202, `POST /run 应 202，实际 ${ack0.status} ${JSON.stringify(ack0.json)}`);
  const done0 = await waitDev('run-done', 60_000);
  assert(
    done0.ok === true,
    `run 应成功 —— 失败通常意味着 dev 环没读工程 .env（key / base_url 只在里面）。` +
      `实际：${JSON.stringify(done0)}`,
  );
  assert(
    done0.finalText === REPLY,
    `回复正文应来自假端点（${REPLY}），实际：${JSON.stringify(done0.finalText)}`,
  );
  assert(
    typeof done0.traceId === 'string',
    `run-done 应带 traceId，实际：${JSON.stringify(done0)}`,
  );
  assert(seenBodies.length === 1, `假端点应被调用 1 次，实际 ${seenBodies.length} 次`);
  for (const t of ['hello', 'read_file']) {
    assert(
      (seenBodies[0] as string).includes(`"name":"${t}"`),
      `全量菜单下请求体应含能力 ${t} —— 缺了说明能力没进模型菜单`,
    );
  }

  // —— 7-bis) 实时右栏（①）：在飞期间就有增量帧，且折回 == 收尾的整棵 trace ——
  //    为什么必须在**真进程 + 真 HTTP + 真 SSE** 里守：单测能测 panel-logic 的折回规则，
  //    但测不到「runner 到底有没有订阅 onTraceEvent」「帧有没有在 run 收尾**之前**送到面板」
  //    —— 而缺口正在后者：旧实现的 `playTrace` 只在收尾后调一次，run 跑着的那十几秒右栏是死的。
  const liveSeen = devFrames('trace-event');
  assert(
    liveSeen.length > 0,
    `run 在飞期间应收到增量记账帧（trace-event），实际 0 条 —— 要么 runner 没订阅 onTraceEvent，` +
      `要么事件没经 /ingest-event 转出来。全部帧：${JSON.stringify(seen.map((e) => e.data))}`,
  );
  const idxLive = seen.findIndex(
    (e) => e.event === 'dev' && e.data.includes('"kind":"trace-event"'),
  );
  const idxDone = seen.findIndex((e) => e.event === 'dev' && e.data.includes('"kind":"run-done"'));
  assert(
    idxLive >= 0 && idxDone >= 0 && idxLive < idxDone,
    `增量帧必须**先于** run-done 到达 —— 先有它才叫实时（晚到等于面板仍是收尾后才画）。` +
      `实际位置：trace-event=${idxLive}, run-done=${idxDone}`,
  );
  // 折回用的是**面板自己那份**规则（CLI 的 dist/panel-logic.js）—— 不是这里重写一遍，
  // 否则这条断言就变成「我自己和自己一致」。
  const liveLogic = (await import(
    pathToFileURL(join(repoRoot, 'packages', 'cli', 'dist', 'panel-logic.js')).href
  )) as {
    emptyTraceAccumulator: () => unknown;
    applyTraceEvent: (acc: unknown, ev: unknown) => boolean;
    partialTrace: (acc: unknown) => { traceId: string; spans: unknown[] };
  };
  /** 把**此刻**收到的增量帧折回成一棵树（每次重算 ⇒ 晚到的帧自动进来） */
  const foldLive = (): { traceId: string; spans: unknown[] } => {
    const acc = liveLogic.emptyTraceAccumulator();
    for (const f of devFrames('trace-event')) liveLogic.applyTraceEvent(acc, f.event);
    return liveLogic.partialTrace(acc);
  };
  const authoritative = (await api(`/api/runs/${String(done0.traceId)}`)).json as {
    traceId: string;
    spans: unknown[];
  };
  // ⚠️ 必须**等链路静默**再比：收尾的整棵 trace 走 `flushSinks`（被 await），而逐笔事件
  //    走 fire-and-forget 的链 —— 最后几笔可能还在路上（这正是框架那条「不保证送达」的
  //    正面表述：晚到可以，最终必须一致）。所以轮询到一致为止，超时才判失败。
  let folded = foldLive();
  const foldDeadline = Date.now() + 5_000;
  while (!isDeepStrictEqual(folded.spans, authoritative.spans) && Date.now() < foldDeadline) {
    await sleep(100);
    folded = foldLive();
  }
  assert(
    folded.traceId === authoritative.traceId,
    `折回的 traceId 应与收尾的 trace 一致（${folded.traceId} vs ${authoritative.traceId}）`,
  );
  assert(
    isDeepStrictEqual(folded.spans, authoritative.spans),
    `折回的 spans 必须**逐字等于**收尾的整棵 trace（框架的折叠不变量，经 HTTP + SSE 之后仍要成立）。` +
      `折回 ${folded.spans.length} 个 span、收尾 ${authoritative.spans.length} 个。\n` +
      `折回：${JSON.stringify(folded.spans)}\n收尾：${JSON.stringify(authoritative.spans)}`,
  );

  // —— 8) 收窄能力：换 toolSources ⇒ 重启 runner，且请求体真的变窄 ——
  //    这一步同时验证「重启」这条路（它在计划里是唯一的资源回收口）与能力选择器真接线。
  const ack1 = await api('/run', {
    method: 'POST',
    body: { prompt: '只留 hello', toolSources: ['hello'] },
  });
  assert(ack1.status === 202, `收窄后的 POST /run 应 202，实际 ${ack1.status}`);
  assert(
    ack1.json.restarted === true,
    `换 toolSources 应重启 runner，实际 ${JSON.stringify(ack1.json)}`,
  );
  const restartEv = await waitDev('runner-restart', 60_000);
  assert(
    typeof restartEv.reason === 'string' && restartEv.reason.includes('toolSources'),
    `重启理由应说明是能力选择变化，实际：${JSON.stringify(restartEv)}`,
  );
  // 重启后必须有一条「就绪」广播 —— 没有它，面板加载时那次 /api/dev（拿到的是初值
  // 空菜单）就永远补不上，能力选择器会空着且无解释。这里在**已连上 SSE 之后**触发重启，
  // 所以能确定性地收到它（冷启动那次同一个 emit 分支，不必另测，也测不稳）。
  await waitDev('runner-ready', 60_000);
  const done1 = await waitDev('run-done', 60_000, 1);
  assert(done1.ok === true, `收窄后的 run 应成功，实际：${JSON.stringify(done1)}`);
  assert(seenBodies.length === 2, `假端点应被调用 2 次，实际 ${seenBodies.length} 次`);
  assert((seenBodies[1] as string).includes('"name":"hello"'), '收窄后请求体仍应含 hello');
  assert(
    !(seenBodies[1] as string).includes('"name":"read_file"'),
    '收窄到 [hello] 后请求体不该再有 read_file —— 有则说明 toolSources 没生效（面板的选择器是摆设）',
  );
  // 重启后菜单必须还在（进程真的回来了，不是「重启成空壳」）
  const dev1 = await api('/api/dev');
  assert(
    (dev1.json.capabilities as string[]).length > 0 && dev1.json.lastError === null,
    `重启后 runner 应恢复正常，实际：${JSON.stringify(dev1.json)}`,
  );

  // —— 9) 改 `.md` ⇒ 重启（G3b）——
  //    旧实现把「文件变 → 重跑」交给 `tsx watch`，而 `.md` 不在 tsx 的 import 图里
  //    ⇒ 改了没反应、也不提示。这里改一个真 `.md`，要求真重启、且重启后能再跑通。
  // 第 3 次 run 的 run-done 是第 3 条（skip=2）—— 用序号而不是「比 before 大」，
  // 因为 before 是从帧里数出来的，两者会互相印证成一个恒真式。
  const before = 2;
  // 写一个**松散**的 .md（直接落在 src/prompts/ 下，不是能力文件夹）——刻意如此：
  // 它不改变装配结果，只测「.md 变了会不会重启」这一条，把变量降到最少。
  writeFileSync(join(proj, 'src', 'prompts', 'probe.md'), '# 新资产\n');
  const mdEv = await waitDev('runner-restart', 30_000, 1);
  assert(
    typeof mdEv.reason === 'string' && mdEv.reason.includes('probe.md'),
    `改 .md 应触发重启且理由里带文件名，实际：${JSON.stringify(mdEv)}`,
  );
  // 第 2 次就绪广播（skip=1）—— 文件变更触发的重启同样要宣告就绪
  await waitDev('runner-ready', 60_000, 1);
  const dev2 = await (async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await api('/api/dev');
      if ((r.json.capabilities as string[]).length > 0) return r.json;
      if (Date.now() > deadline) {
        throw new Error(`改 .md 重启后 runner 没回来：${JSON.stringify(r.json)}`);
      }
      await sleep(50);
    }
  })();
  assert(dev2.lastError === null, `改 .md 重启后不该有 lastError：${JSON.stringify(dev2)}`);
  const ack2 = await api('/run', { method: 'POST', body: { prompt: '重启后再跑一次' } });
  assert(ack2.status === 202, `重启后的 POST /run 应 202，实际 ${ack2.status}`);
  await waitDev('run-done', 60_000, before);

  // —— 9-bis) 改**项目根**的 `.env` ⇒ 也要重启 ——
  //    守的是一条**够不着**的判据：`WATCH_NAMES` 把 `.env` / `.env.local` 列进允许清单
  //    （usage-guide 也把 `.env` 写进「看什么」），但 `watchTree` 的根是 `<projectRoot>/src`，
  //    而 `.env` 在**项目根** ⇒ 旧实现里这条判据永远收不到事件（改 `.env` 静默无感，
  //    与 G3b 同类：文档承诺了、代码够不着）。
  //    ⚠️ **单测抓不到这条**：根是在**调用点**决定的，`watchTree` 自己无从知道该看哪儿 ——
  //    所以它只能在这里守（真跑 + 真改文件）。
  //    ⚠️ 断言必须用「**等第 N+1 帧**」而不是写死序号：上面 ack2 那次 run 已经产生过一条
  //    `runner-restart`（回到全量菜单），写死 `skip=2` 会**立刻拿到那条旧帧** ⇒ 断言失败
  //    的原因与「`.env` 没触发」长得一模一样（我第一次就踩了这个坑：探针假红）。
  const restartsBeforeEnv = devFrames('runner-restart').length;
  const readyBeforeEnv = devFrames('runner-ready').length;
  writeFileSync(
    join(proj, '.env'),
    `ANTHROPIC_API_KEY=sk-fake-dev-e2e\nANTHROPIC_BASE_URL=${fakeBase}\n`,
  );
  const envEv = await waitDev('runner-restart', 30_000, restartsBeforeEnv);
  assert(
    typeof envEv.reason === 'string' && envEv.reason.includes('.env'),
    `改项目根的 .env 应触发重启且理由里带文件名，实际：${JSON.stringify(envEv)}`,
  );
  await waitDev('runner-ready', 60_000, readyBeforeEnv);

  // —— 10) 中止在飞 run（§6 待定 5 的 kill 按钮）——
  //    这一段要守的是「面板不会锁死」：没有它，一个卡住的 run 之后每次 POST /run 都 409。
  //    先让假端点挂住，run 才真的在飞（否则窗口只有几毫秒，测到的是 409 那条分支）。
  holdReply = true;
  const ack3 = await api('/run', { method: 'POST', body: { prompt: '挂着的一次' } });
  assert(ack3.status === 202, `挂住时的 POST /run 应 202，实际 ${ack3.status}`);
  await waitDev('run-start', 30_000, 3);
  const busyState = await api('/api/dev');
  assert(
    busyState.json.running === true,
    `run 在飞时 /api/dev 应说 running=true（面板的两个按钮都由它驱动），实际 ${JSON.stringify(busyState.json)}`,
  );
  // 并发语义（计划 §6 待定 5 建议的「默认拒绝并提示」）：在飞时的第二次 POST /run 必须 409
  const conflict = await api('/run', { method: 'POST', body: { prompt: '插队' } });
  assert(
    conflict.status === 409,
    `在飞时的第二次 POST /run 应 409，实际 ${conflict.status} ${JSON.stringify(conflict.json)}`,
  );

  const aborted = await api('/run/abort', { method: 'POST' });
  assert(aborted.status === 202, `POST /run/abort 应 202，实际 ${aborted.status}`);
  assert(
    aborted.json.accepted === true && aborted.json.escalated === false,
    `假端点只是挂着、run 会正常响应 signal ⇒ 应是优雅中止（不升级重启），实际 ${JSON.stringify(aborted.json)}`,
  );
  const done3 = await waitDev('run-done', 60_000, 3);
  // ⚠️ 判据是 stopReason **不是** ok：引擎的 abortedResult() 刻意带上结构化 error
  //    （取消不是失败，但原因要可查）⇒ 中止的 run `ok` 也是 false。
  //    只认 ok 就会把「我按的中止」当成「run 失败」—— 这条断言就是钉这个口径的。
  assert(
    done3.stopReason === 'aborted',
    `中止后 stopReason 应是 aborted，实际：${JSON.stringify(done3)}`,
  );
  assert(
    typeof done3.traceId === 'string',
    `中止的 run 也要有 traceId ——「中止保得住 trace」是这条设计存在的全部理由（杀进程那条路会丢掉它）：${JSON.stringify(done3)}`,
  );
  // trace 真落盘了（不是「回了个 traceId 但没送出去」）：run 列表里必须能找到它
  const runsAfterAbort = (await api('/api/runs')).json as unknown as Array<{ traceId: string }>;
  assert(
    runsAfterAbort.some((r) => r.traceId === done3.traceId),
    `中止的 run 应出现在 run 列表里（trace 真的落了盘），实际：${JSON.stringify(runsAfterAbort.map((r) => r.traceId))}`,
  );
  // 中止后必须**解锁**（否则面板还是锁死的，那这个按钮就白加了）+ 不留一条假告警
  const afterAbort = await api('/api/dev');
  assert(
    afterAbort.json.running === false,
    `中止后 running 应回 false，实际 ${JSON.stringify(afterAbort.json)}`,
  );
  assert(
    afterAbort.json.lastError === null,
    `用户主动中止**不是**「环坏了」，不该在告警条上留红字，实际 ${JSON.stringify(afterAbort.json.lastError)}`,
  );
  holdReply = false;
  for (const r of held) r.end();
  held.length = 0;
  // —— 11) 清空对话（§6 待定 3）——
  //    「清空」= 换一个 sessionId，**不动** session.json（那是 store 的账，面板只读）。
  const sid0 = (await api('/api/dev')).json.sessionId as string;
  const cleared = await api('/session/clear', { method: 'POST' });
  assert(cleared.status === 200, `POST /session/clear 应 200，实际 ${cleared.status}`);
  assert(
    typeof cleared.json.sessionId === 'string' && cleared.json.sessionId !== sid0,
    `清空应换一个新 id（旧的是 ${sid0}），实际 ${JSON.stringify(cleared.json)}`,
  );
  // 落盘：否则重启 dev 之后刚清空的对话会**自己回来**（最典型的静默不一致）
  assert(
    existsSync(join(proj, '.agentia', 'dev-session-id')),
    '当前会话 id 必须落盘（.agentia/dev-session-id）—— 只在内存里的话重启就退回旧对话',
  );
  assert(
    readFileSync(join(proj, '.agentia', 'dev-session-id'), 'utf8').trim() ===
      cleared.json.sessionId,
    '落盘的 id 应与 /api/dev 报的一致（同一事实两个写法就会漂）',
  );
  // 换完 id 跑一次多轮：会话必须写进**新**那本账 —— 这条能挡住「面板换了 id、
  // runner 还写死旧 id」那类静默不一致（runner 用的是父进程经 IPC 给的 id）。
  const ack4 = await api('/run', {
    method: 'POST',
    body: { prompt: '清空后的第一轮', multiTurn: true },
  });
  assert(ack4.status === 202, `清空后的 POST /run 应 202，实际 ${ack4.status}`);
  await waitDev('run-done', 60_000, 4);
  const sessFile = JSON.parse(readFileSync(join(proj, '.agentia', 'session.json'), 'utf8')) as {
    sessions?: Record<string, unknown[]>;
  };
  const keys = Object.keys(sessFile.sessions ?? {});
  assert(
    keys.includes(cleared.json.sessionId as string),
    `多轮会话应写进新 id「${cleared.json.sessionId}」，实际 keys：${JSON.stringify(keys)}`,
  );
  assert(
    !keys.includes(sid0),
    `清空前的 id「${sid0}」不该被这次 run 写（写进去说明 runner 用的是旧 id），实际 keys：${JSON.stringify(keys)}`,
  );
  // 面板读的 `/api/session` 也要跟着新 id 走（读错 id = 显示一段模型没见过的对话）
  const apiSess = (await api('/api/session')).json.session as { messages?: unknown[] } | null;
  assert(
    apiSess !== null && Array.isArray(apiSess.messages) && apiSess.messages.length > 0,
    // 断言消息里**不许**再发一次同样的请求：那样失败时会多打一次接口，且现场与判据
    // 可能不是同一次响应（读起来像是两回事）
    `/api/session 应返回新会话的消息，实际：${JSON.stringify(apiSess)}`,
  );

  // —— 12) 重启次数总账：确认**dev 环自己的状态没被收进 watch 范围** ——
  //    ⚠️ 这一条钉的是**监视根**，不是 `WATCH_SKIP`：`devServer` 只
  //    `watchTree(<projectRoot>/src)`（外加一个只认 `.env` 的项目根 watch），而 `.agentia/`
  //    （`FileSessionStore.append` 在第一次多轮 run 时 mkdir 的）与 `dist/` 都在**项目根**
  //    —— 根本不在范围内。
  //    所以本步**抓不到** `watchTree` 内部那条「动态新增目录漏判 WATCH_SKIP」的缺陷：
  //    实测过（把修复摘掉）本步照样绿。那条由 `packages/cli/test/panel-logic.test.mjs`
  //    的单测钉着 —— 它自己指定 root，所以能构造「启动后才出现 `dist/`」的形状。
  //    本步守的是**另一件事**，同样值得守：哪天有人把根扩到项目根（一个很自然的想法），
  //    `.agentia/session.json` 就变成「每次多轮 run 重启一次子进程」的自噬循环 ——
  //    那时下面的次数会超、理由里会出现 `.agentia`，两条断言各自报出来。
  //    等过「重启延后到 run 结束」的窗口（`afterRun()` 紧跟在 run-done 之后）再数。
  //    预期恰好 4 次，逐条都能解释（**都不是**自噬）：
  //      ① 第 8 步收窄到 ['hello']；② 第 9 步改 probe.md；③ 第 9-bis 步改项目根的 .env；
  //      ④ 第 9 步那次 run **不传** toolSources = 「回到全量」—— 而当时 runner 的菜单
  //         已经被收窄成 ['hello'] 了，所以这是一次真实的配置变化（CLI 重建为全量菜单）。
  await sleep(1_000);
  const restarts = devFrames('runner-restart');
  assert(
    restarts.length === 4,
    '全程只该有 4 次重启（收窄 toolSources / 改 .md / 改 .env / 回到全量菜单）。多出来通常意味着 ' +
      `watch 根被扩到了项目根（于是 .agentia/ 或 dist/ 进了范围 ⇒ 自噬）。实际：${JSON.stringify(restarts)}`,
  );
  // 真正的判据：这类重启的理由会**带着文件名**（`文件变更：<相对路径>`），
  // 所以按理由筛比按次数筛更准 —— 次数会随无关步骤增减，理由不会。
  for (const r of restarts) {
    const reason = String(r.reason);
    assert(
      !reason.includes('.agentia') && !reason.includes('dist/'),
      `重启理由不该提到 dev 环自己的状态 / 产物目录（那意味着 watch 根被扩到了项目根），实际：${reason}`,
    );
  }

  // —— 13) 并发闸在「换能力选择 ⇒ 重启」的窗口里也要拦得住（§6 待定 5 的默认拒绝）——
  //    这条钉的是一个**窄窗口**：受理到 run 真正发出去之间有 `await restart(...)`
  //    （停旧进程 + spawn 新进程 + 装配，几百毫秒起），而 `running` 只有在 run 真的发进
  //    通道之后才置位 ⇒ 只看 `running` 的闸会在这条路径上放两个请求进来：runner 里两个
  //    `runOnce` 并发、`currentAbort` 被覆盖、`pendingNote` 挂到别人的 traceId 上。
  //    判据不只看状态码，还看**模型被调用了几次** —— 两个请求都放过去的话这里会多一次。
  //    （顺带把会话文件弄坏：下一条要用它验「启动期探测 → warning 通道」。）
  writeFileSync(join(proj, '.agentia', 'session.json'), '{ 这不是合法 JSON');
  const bodiesBeforeRace = seenBodies.length;
  // ⚠️ **不能 await 第一个请求再发第二个** —— 那样第二个请求是在 A 的 restart 完成之后
  //    才发出去的（`POST /run` 的 202 要等 restart 走完才回），压根进不了窗口：
  //    我第一次就是这么写的，反向验证时「摘掉修复照样全绿」= 一个假门禁。
  //    正确做法：先不等 A 的回包，等**重启广播帧**（`restart()` 的第一行就 emit）——
  //    收到它就说明 A 确实在窗口里了（此刻 stopChild / spawnChild 都还没走完）。
  const restartsBeforeRace = devFrames('runner-restart').length;
  const ack5Promise = api('/run', {
    method: 'POST',
    body: { prompt: '换选择的同时再点一次', toolSources: ['hello'] },
  });
  await waitDev('runner-restart', 30_000, restartsBeforeRace);
  const dup = await api('/run', { method: 'POST', body: { prompt: '并发插队' } });
  assert(
    dup.status === 409,
    `换能力选择的重启窗口内，第二个 POST /run 必须 409（默认拒绝）—— 实际 ${dup.status} ` +
      `${JSON.stringify(dup.json)}。放过去就是两个 run 并发、currentAbort 被覆盖`,
  );
  const ack5 = await ack5Promise;
  assert(ack5.status === 202, `换能力选择的 POST /run 应 202，实际 ${ack5.status}`);
  const done5 = await waitDev('run-done', 60_000, 5);
  assert(done5.ok === true, `窗口内的那次 run 应成功，实际：${JSON.stringify(done5)}`);
  await sleep(500); // 留给「被误放进来的第二个 run」一个真发出去的机会（有的话）
  assert(
    seenBodies.length === bodiesBeforeRace + 1,
    `重启窗口内只该有 1 次 run（= 1 次模型调用），实际 ${seenBodies.length - bodiesBeforeRace} 次` +
      '—— 多出来的那次说明第二个请求穿过了闸',
  );

  // —— 14) 会话文件坏掉 ⇒ 必须在 warning 通道上说出来（不许静默当成「第一轮」）——
  //    为什么只能在 dev 环上守：`FileSessionStore` 对坏 JSON 是**响亮抛错**的，而框架在
  //    `runtime/run.ts` 的 load / append 里**刻意吞掉**会话侧异常（既定口径：辅助动作
  //    不击穿 run，memory 水合同源，且有单测钉着）⇒ 文件一坏，历史被当成第一轮、
  //    而且新历史**永远写不进去**，全程无声。所以判据落在「dev 环会不会主动发现并报出来」：
  //    启动期探测 → `ready.warning` → 面板告警条 / `/api/dev`。
  //    上一步那次重启已经带着坏文件重新装配过了 ⇒ 这里直接回读即可。
  const warned = await (async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 30_000;
    let last: Record<string, unknown> = {};
    for (;;) {
      last = (await api('/api/dev')).json;
      if (typeof last.warning === 'string' && last.warning.includes('会话文件')) return last;
      if (Date.now() > deadline) {
        throw new Error(
          `坏掉的会话文件没被报出来（warning=${JSON.stringify(last.warning)}）—— ` +
            `后果是历史静默消失、新历史写不进去\n${devOut.join('')}`,
        );
      }
      await sleep(100);
    }
  })();
  assert(typeof warned.warning === 'string', 'warning 必须非空');

  // —— 15) `agentia dev -- "问题"`：文档化的用法不能被吃掉 ——
  //    它是 README / 工程 README 都写了的入口，而实现只有一行（取第一个非空参数当 prompt）。
  //    "参数被吃掉"没有任何机械检查能挡住 —— 只有真起一次、看**模型收到的 prompt**是什么。
  //    判据取假端点收到的请求体（不是「有没有跑起来」）：prompt 变成 `--` 时模型照样回话，
  //    run 照样成功，只有请求体里那行字能揭穿它。
  //    用**新工程 + 新 dev 进程**：不复用上面那个（它的 argv 是空的，且已经跑到残局）。
  {
    const tmp2 = mkdtempSync(join(tmpdir(), 'agentia-dev-argv-'));
    const prompt = 'E2E_ARGS_PROMPT';
    execFileSync(process.execPath, [cliPath, 'create', 'argv-app', '--dir', tmp2], {
      cwd: tmp2,
      encoding: 'utf8',
    });
    const proj2 = join(tmp2, 'argv-app');
    mkdirSync(join(proj2, 'node_modules', '@migor'), { recursive: true });
    symlinkSync(repoRoot, join(proj2, 'node_modules', '@migor', 'agentia'), 'dir');
    symlinkSync(join(repoRoot, 'node_modules', 'tsx'), join(proj2, 'node_modules', 'tsx'), 'dir');
    writeFileSync(
      join(proj2, '.env'),
      `ANTHROPIC_API_KEY=sk-fake-dev-e2e\nANTHROPIC_BASE_URL=${fakeBase}\n`,
    );
    // 刻意用**裸 CLI + 显式 `--`** 这条形状（cli.ts 的 usage 就是这么写的）：
    // `npm run dev -- "问题"` 里 npm 会吃掉那个 `--`，所以 npm 那条一直是对的 ——
    // 错的是裸 CLI 这条，而它同样被文档化着。
    const argvDev = spawn(process.execPath, [cliPath, 'dev', '--', prompt], {
      cwd: proj2,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out2: string[] = [];
    argvDev.stdout?.on('data', (c: Buffer) => out2.push(c.toString('utf8')));
    argvDev.stderr?.on('data', (c: Buffer) => out2.push(c.toString('utf8')));
    try {
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (seenBodies.some((b) => b.includes(prompt))) break;
        if (argvDev.exitCode !== null) {
          throw new Error(`dev -- "问题" 提前退出（code=${argvDev.exitCode}）：\n${out2.join('')}`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `60s 内假端点没收到 prompt「${prompt}」—— 首次 run 的 prompt 被吃掉了（拿到的是 ` +
              `\`--\`？）\n${out2.join('')}`,
          );
        }
        await sleep(100);
      }
    } finally {
      argvDev.kill('SIGINT');
      const dl = Date.now() + 10_000;
      while (argvDev.exitCode === null && argvDev.signalCode === null && Date.now() < dl) {
        await sleep(50);
      }
      if (argvDev.exitCode === null && argvDev.signalCode === null) argvDev.kill('SIGKILL');
      rmSync(tmp2, { recursive: true, force: true });
    }
  }

  // —— 15-bis) 中止请求落在**装配窗口**里也必须生效 ——
  //    `runOnce` 的顺序是 `send('run-start')` → `await ensureApp(...)` → 才 `new AbortController()`。
  //    窗口内到达的 `run-abort` 只能看到 `currentAbort === null` —— 把它当「没在跑」丢掉的话，
  //    run 照跑，而父进程 5 s 后会把这次**健康的** run 升级成「重启兜底」（trace 丢掉 +
  //    lastError 写成「工具不响应 signal」，一个错误的归因）。
  //    窗口宽度 = `ensureApp` 的重建耗时，**取决于工程**：真工程里有 MCP 握手时是几百毫秒，
  //    所以这里必须把窗口撑开才可复现 —— 做法是给工程的 `createAgentApp` 注入一段延迟
  //    （只在 e2e 的临时工程里），再用**一个会触发重建的 workdir**（带尾斜杠 ≠ 当前 key）
  //    发起 run，紧接着发中止。
  //    判据是 stopReason 必须是 aborted（旧行为会一路跑到 end_turn 正常收尾）。
  {
    const appTs = join(proj, 'src', 'app.ts');
    const src = readFileSync(appTs, 'utf8');
    const marker = 'export async function createAgentApp(';
    const at = src.indexOf(marker);
    assert(at >= 0, '没找到 createAgentApp 的签名行 —— 模板变了？这一步要跟着改');
    const eol = src.indexOf('\n', at);
    writeFileSync(
      appTs,
      `${src.slice(0, eol + 1)}` +
        '  // e2e 注入（只在这个临时工程里）：让装配有真实开销，否则「中止落在装配窗口内」\n' +
        '  // 这条窗口只有几毫秒、永远复现不到。真工程里这段开销来自 MCP 握手那类调用。\n' +
        '  await new Promise((r) => setTimeout(r, 400));\n' +
        `${src.slice(eol + 1)}`,
    );
    const readyBeforeWindow = devFrames('runner-ready').length;
    await waitDev('runner-ready', 60_000, readyBeforeWindow);
    const callsBeforeWindow = seenBodies.length;
    const ack6 = await api('/run', {
      method: 'POST',
      // 尾斜杠 ⇒ app key 与当前那份不同 ⇒ 真走重建那条路（窗口才有宽度）
      body: { prompt: '装配窗口内被中止', workdir: `${proj}/` },
    });
    assert(ack6.status === 202, `窗口用例的 POST /run 应 202，实际 ${ack6.status}`);
    const abWindow = await api('/run/abort', { method: 'POST' });
    assert(abWindow.status === 202, `窗口内中止应 202，实际 ${abWindow.status}`);
    assert(
      abWindow.json.escalated === false,
      `装配窗口内的中止不该升级成重启兜底（那是「把健康的 run 掐掉」）：${JSON.stringify(abWindow.json)}`,
    );
    const done6 = await waitDev('run-done', 60_000, 6);
    assert(
      done6.stopReason === 'aborted',
      '装配窗口内发出的中止必须生效 —— 丢了的话这次 run 会一路跑到 end_turn 正常收尾' +
        `（父进程随后还会把它升级成重启兜底）。实际：${JSON.stringify(done6)}`,
    );
    assert(
      typeof done6.traceId === 'string',
      `装配窗口内被中止的 run 同样要保住 trace，实际：${JSON.stringify(done6)}`,
    );
    assert(
      seenBodies.length === callsBeforeWindow,
      '被中止的 run 不该调到模型（signal 已 abort ⇒ 引擎立刻以 aborted 收尾）',
    );
  }

  // —— 16) Ctrl+C 的收尾：连**不响应 SIGTERM** 的 runner 也不能活成孤儿 ——
  //    旧的 SIGINT 处理器是「shutdown(); setTimeout(() => process.exit(0), 50)」：父进程
  //    50 ms 就没了，而 `stopChild()` 给子进程的宽限期是 3 s（SIGTERM 之后等满才补
  //    SIGKILL）⇒ 那段宽限连同 SIGKILL 兜底一起消失，'exit' 钩子此刻也已空转
  //    （child 早被置 null）⇒ 一个不理 SIGTERM 的 runner 活着成为孤儿（它的 MCP 子进程
  //    同样留着）。真实世界里这就是「某个工具不响应 signal」的形状。
  //    做法：往用户工程里加一行忽略 SIGTERM 的代码（改 .ts 会自动重启 runner，于是
  //    新进程 import 时就装上它），再对 dev 发 Ctrl+C，然后看**那棵进程树是不是真没了**。
  //    只在 POSIX 上跑：win32 走 taskkill /T，进程组语义不同（见 killTree）。
  if (process.platform !== 'win32') {
    appendFileSync(
      join(proj, 'src', 'app.ts'),
      "\n// e2e：模拟「工具不响应 signal」（本行只存在于 e2e 的临时工程里）\nprocess.on('SIGTERM', () => {});\n",
    );
    const readyBeforeSigterm = devFrames('runner-ready').length;
    await waitDev('runner-ready', 60_000, readyBeforeSigterm);
    // ⚠️ 用 `pgrep -P`（父子关系）而不是 `ps -o ppid=`：macOS 的 ps **不认** `-P`／
    //    `-o ppid` 那套组合写法（会 `illegal option`），而 pgrep 在 macOS 与 Linux 都有。
    const pidsOf = (pid: number): number[] => {
      try {
        return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(Number);
      } catch {
        return []; // pgrep 没找到匹配时退出码是 1（不是 0 + 空输出）
      }
    };
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const runnerPids = pidsOf(dev.pid as number);
    assert(
      runnerPids.length > 0,
      `没找到 dev 的子进程（pid=${dev.pid}）—— ps 口径变了？无法验「不留孤儿」`,
    );
    dev.kill('SIGINT');
    const dl = Date.now() + 20_000;
    while (dev.exitCode === null && dev.signalCode === null && Date.now() < dl) await sleep(50);
    assert(dev.exitCode !== null || dev.signalCode !== null, 'SIGINT 后 dev 应在 20s 内退出');
    const leftover = runnerPids.filter(alive);
    assert(
      leftover.length === 0,
      `SIGINT 之后 runner 仍然活着（pid=${leftover.join(',')}）—— 说明 SIGKILL 兜底没跑到：` +
        '父进程在 KILL_GRACE_MS 宽限之前就退出了，子进程（含它自己 spawn 的 MCP 子进程）成了孤儿',
    );
  }

  console.log(
    'dev e2e: OK（IPC 就绪 / .env 生效 / 能力收窄 / .md 重启 / .env 重启 / 中止在飞 run / 清空对话 / ' +
      '重启总账 4 次无自噬 / 重启窗口内的 409 / 坏会话文件报警 / dev -- "问题" 透传 / ' +
      '右栏实时（增量帧先于 run-done，折回 == 收尾） / Ctrl+C 不留孤儿）',
  );
} catch (e) {
  // 失败时把 dev 的输出一起打出来 —— 它是子进程的 stdout/stderr，不主动捞就什么都看不到
  console.error(`\n--- agentia dev 输出 ---\n${devOut.join('')}`);
  throw e;
} finally {
  // 收尾必须在**任何**失败路径上都跑到：留下 dev 进程 = 留下一个占着端口与子进程的孤儿。
  sse?.abort();
  // 失败路径上可能还留着被「挂住」的响应 —— 不收掉，fake.close() 的回调永远不触发
  for (const r of held) r.end();
  held.length = 0;
  if (dev !== null && dev.exitCode === null && dev.signalCode === null) {
    dev.kill('SIGINT');
    const deadline = Date.now() + 10_000;
    while (dev.exitCode === null && dev.signalCode === null && Date.now() < deadline) {
      await sleep(50);
    }
    if (dev.exitCode === null && dev.signalCode === null) dev.kill('SIGKILL');
  }
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
}
