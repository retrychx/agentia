/**
 * 真模型试跑 —— 一次**迷你 trial**，不需要 Docker。
 *
 * ## 它解决什么
 *
 * `selftest` 用的是写死的模型响应，证明的是「转换器 + trace 记账对」；
 * 而「agentia 真接得上 DeepSeek、真能驱动 bash 把一件事做完」必须**真跑一次**。
 * 官方 Terminal-Bench 要容器（本机没有），但「跑一遍完整链路」不需要容器 ——
 * 所以这里把 Terminal-Bench 的形状缩到最小：**预置数据 → agent 用 shell 做 → 机械判分**。
 *
 *   DEEPSEEK_API_KEY=sk-… npm run build && npm run live
 *
 * ## 判分是机械的，不是「看着像完成了」
 *
 * 终点状态写进文件（`sorted.txt`），探针读回来逐行比对期望值 ⇒ reward 只有 0/1，
 * 与 Terminal-Bench 同一个口径（顺便验证了一条：本仓自己说过的
 * 「过程证据（ATIF）之外，reward 必须来自可复算的终态」）。
 *
 * ## ⚠️ 安全边界（别把它当沙箱）
 *
 * 这是**在本机**跑真模型 + 真 shell，不是容器：
 * - 工作目录锁在 `/tmp/agentia-live-<时间戳>`，指令里也写死这个路径；
 * - 但 shell 是长驻会话，模型**技术上**可以 `cd` 出去 —— 它没有任何强制隔离。
 * 想真隔离就用容器（见 README 的 Docker 一节）。这里只做「链路通不通」的验证。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENTIA_VERSION, SystemPrompt, createApp } from '@migor/agentia';
import { traceToAtif } from './atif.js';
import { ShellTools, closeShellSessions } from './bash.js';
import { resolveModel } from './model.js';

const OUT = process.env.AGENTIA_ATIF_OUT ?? 'out/atif-live.json';

/** 故意乱序 + 带两位数：只按字典序排会错，逼它真的按数值排（或至少自己验证） */
const DATA = ['7', '10', '3', '1', '42', '9'];
const EXPECTED = ['1', '3', '7', '9', '10', '42'];

const binding = resolveModel();
if (!binding.client && !process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    '没有模型凭据：给 DEEPSEEK_API_KEY（走 DeepSeek）或 ANTHROPIC_API_KEY（走默认端点）。\n' +
      '只想验证转换器（不需要任何 key）请跑：npm run selftest',
  );
}

const workDir = join(tmpdir(), `agentia-live-${Date.now()}`);
await mkdir(workDir, { recursive: true });
await writeFile(join(workDir, 'data.txt'), `${DATA.join('\n')}\n`);

const INSTRUCTION =
  `目录 ${workDir} 下有 data.txt，每行一个整数。\n` +
  `请把这些整数**按数值从小到大**排序，一行一个，写入同目录的 sorted.txt。\n` +
  `写完后用 cat 回读确认内容正确，然后回答我：最大的数是几。\n` +
  `注意：只按文本的字典序排会把 10 排在 9 前面，那是错的。`;

const ROLE =
  '你是一个在 Linux 终端里完成任务的 agent。\n' +
  '- 用 run_command 执行 shell；会话保持状态，cd 之后不必重复。\n' +
  '- 做完要自己验证（cat 回读），别只说「已完成」。\n' +
  '- 不要用交互式命令，写文件用 cat <<EOF 或 tee。';

const app = await createApp({
  name: 'agentia-terminal-bench-live',
  providers: [{ provide: 'shell', useClass: ShellTools }],
  system: new SystemPrompt().add('role', ROLE, true),
  ...(binding.model ? { model: binding.model } : {}),
  ...(binding.priceOverrides ? { priceOverrides: binding.priceOverrides } : {}),
  traceContent: 'full',
  maxEventChars: false,
});

process.stdout.write(`[live] 工作目录 ${workDir}\n`);
const { result } = await app.run([{ role: 'user', content: INSTRUCTION }], {
  ...(binding.client ? { client: binding.client } : {}),
  // 迷你任务不该跑很久：两道闸防失控（成本闸依赖 priceOverrides 生效）
  maxIterations: 12,
  maxTokens: 4096,
});

// 判分：读终态文件，逐行比对 —— 不读模型自称的「已完成」
let reward = 0;
let actual: string[] = [];
try {
  const raw = await readFile(join(workDir, 'sorted.txt'), 'utf8');
  actual = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  reward = actual.length === EXPECTED.length && actual.every((v, i) => v === EXPECTED[i]) ? 1 : 0;
} catch {
  reward = 0; // 文件不存在 = 没做成，不做任何「也许算对」的宽容判定
}

const atif = traceToAtif(result.trace, {
  instruction: INSTRUCTION,
  agentVersion: AGENTIA_VERSION,
  ...(binding.model ? { modelName: binding.model } : {}),
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(atif, null, 2)}\n`);
await closeShellSessions();

const m = atif.final_metrics;
process.stdout.write(
  `[live] reward=${reward}  got=[${actual.join(',')}]  want=[${EXPECTED.join(',')}]\n` +
    `[live] stop=${result.stopReason}${result.error ? ` error=${result.error.type}` : ''} ` +
    `steps=${atif.steps.length} ` +
    `tokens=${m?.total_prompt_tokens ?? 0}/${m?.total_completion_tokens ?? 0} ` +
    `cost_usd=${m?.total_cost_usd ?? 0}\n` +
    `[live] ATIF → ${OUT}；校验：python3 scripts/verify_atif_schema.py ${OUT}\n` +
    `[live] 工作目录留着可复查：${workDir}\n`,
);

// 清理开关默认关：留着现场才好查「它到底干了什么」
if (process.env.AGENTIA_LIVE_CLEANUP === '1') {
  await rm(workDir, { recursive: true, force: true });
}

// reward=0 也算「跑通了链路」，但脚本自身应当如实反映任务成败：
// 判 0 时退出码非 0 —— 否则 CI/人都会把「跑完」误读成「做对」。
if (reward === 0) process.exitCode = 1;
