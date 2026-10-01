/**
 * agentia × Terminal-Bench —— 容器内的一次任务执行入口。
 *
 * 由 `harbor_agent.py`（Harbor 适配层）在任务容器里调用：
 *   AGENTIA_TB_INSTRUCTION=/installed-agent/instruction.txt node dist/run.js
 *
 * 它只做三件事：把指令喂给主 agent → 跑完拿 trace → **把 trace 直译成 ATIF** 落盘。
 * 第三件是本例真正的价值：Terminal-Bench 只判「测试过没过」（reward 0/1），
 * 而 ATIF 轨迹是**过程证据** —— 过没过之外还能回答「它是真做对了还是瞎猫碰上死耗子」。
 *
 * 环境变量：
 *   AGENTIA_TB_INSTRUCTION  指令文件路径（Harbor 侧写好再传进来）
 *   AGENTIA_ATIF_OUT        ATIF 落盘路径（缺省 /logs/agent/trajectory.json，Harbor 会收）
 *   AGENTIA_MODEL           模型名（不给走框架默认）
 *   AGENTIA_TB_CWD          会话初始工作目录（缺省 /app）
 *   AGENTIA_MAX_ITERATIONS  循环上限（缺省 200，见下方 MAX_ITERATIONS 注释）
 *   AGENTIA_PRICE_IN/OUT    覆盖单价（$/1M tokens），成对给才生效
 *   ANTHROPIC_API_KEY       由 `harbor run --ae` 注入（默认端点）
 *   DEEPSEEK_API_KEY        设了就走 DeepSeek（框架自带 OpenAI 兼容适配器，换 baseURL）
 *   DEEPSEEK_BASE_URL       覆盖 DeepSeek 端点（缺省 https://api.deepseek.com）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AGENTIA_VERSION, SystemPrompt, createApp } from '@migor/agentia';
import { traceToAtif } from './atif.js';
import { ShellTools, closeShellSessions } from './bash.js';
import { resolveModel } from './model.js';

const INSTRUCTION_PATH = process.env.AGENTIA_TB_INSTRUCTION ?? '/installed-agent/instruction.txt';
const ATIF_OUT = process.env.AGENTIA_ATIF_OUT ?? '/logs/agent/trajectory.json';
const binding = resolveModel();

/** 循环上限缺省。⚠️ 不能吃框架缺省（40）：Terminal-Bench 的任务是**长程**的。 */
const DEFAULT_MAX_ITERATIONS = 200;
const envMaxIterations = Number.parseInt(process.env.AGENTIA_MAX_ITERATIONS ?? '', 10);
const MAX_ITERATIONS =
  Number.isInteger(envMaxIterations) && envMaxIterations > 0
    ? envMaxIterations
    : DEFAULT_MAX_ITERATIONS;

/**
 * 主 agent 的角色设定：只说「怎么做」，不重复任务内容（指令在 user 消息里）。
 *
 * ⚠️ 最后那条（收尾自查）是从实测里长出来的，不是凭感觉加的条款。
 * `polyglot-c-py` 在 `-k 5` 下 **5/5 全错，且 5 条错在同一个地方**：断言要求工作目录里
 * 只有交付物 `main.py.c`，而 5 条都把自测用的编译产物留在了那儿
 * （`cmain`、`cmain_strict`、`t.c`、`t`、`err.txt`、`__pycache__`）。
 * 唯一过的那条（更早一轮）最后一步恰好是 `rm -rf __pycache__ && ls -la`。
 * 另一个 harness 在同一条断言上错法一致 ⇒ 这是**通用 agent 纪律**的缺口，
 * 不是某道题的知识缺口。所以写成通用条款（按任务规定的最终状态自查、清掉自测产物），
 * **不写死任何一道题的文件名**。
 *
 * 同时留了反向保险：自测产物与交付物分不清时宁可留着 —— 这条纪律的目的是别多交，
 * 不是拿「整洁」当理由把要交的东西删掉。
 */
const ROLE =
  '你是一个在 Linux 终端里完成任务的 agent。\n' +
  '- 用 run_command 执行 shell；会话保持状态，cd 之后不必重复。\n' +
  '- 改完要自己验证（跑测试 / 看输出），别只说「已完成」。\n' +
  '- 不要用交互式命令（vim / less / 需要 stdin 输入的），重定向写文件用 cat <<EOF 或 tee。\n' +
  '- 命令失败先看报错再重试，不要盲目换写法。\n' +
  '- 收尾前按任务要求的**最终状态**自查一遍（`ls` 看一眼目录里到底有什么）：\n' +
  '  自测、调试为了验证而造出来的东西（编译中间产物、临时脚本、`__pycache__` 之类）要清掉，\n' +
  '  任务要求的交付物一个都不能少。分不清哪个是哪个时**宁可留着**，别拿「整洁」当理由\n' +
  '  把要交的东西删了。';

const app = await createApp({
  name: 'agentia-terminal-bench',
  // 形状与 `agentia g` 维护的 registry.ts 一致：{ provide, useClass }
  providers: [{ provide: 'shell', useClass: ShellTools }],
  system: new SystemPrompt().add('role', ROLE, true),
  ...(binding.model ? { model: binding.model } : {}),
  ...(binding.priceOverrides ? { priceOverrides: binding.priceOverrides } : {}),
  /**
   * ⚠️ 必须显式抬高，别吃框架缺省的 40 —— 实测（官方 `terminal-bench-sample`，两轮 `-k 1`）：
   * 凡步数**恰好到 41** 的轨迹，末步**都还带着 `tool_calls`**（干活干到一半被掐），
   * 而**所有做对的都在 40 步以内**。撞上限时框架会如实置 `stopReason='max_iterations'`
   * 并带结构化 error，但 **Terminal-Bench 只读 reward.txt ⇒ 记成 0**，
   * 与「模型答错」在榜上**无从区分**。缺省 40 会让长程任务的分数被系统性压低。
   */
  maxIterations: MAX_ITERATIONS,
  // ⚠️ 必须开：ATIF 的 step.message 来自 trace 的 assistant 正文，
  // 缺省不记正文（docs/usage-guide.md §7）⇒ 不开的话轨迹里每步都是空串，
  // 看着像「转换丢了数据」，其实是从源头就没记。
  traceContent: 'full',
  // 工具 I/O 不截断：轨迹是评测的**过程证据**，截断过的半截 JSON 在 ATIF 里
  // 只能退化成 `_raw`（见 atif.ts 的 parseArguments）。代价是 trace 可能很大
  // （`cat` 一个大文件就会几 MB）—— 评测场景认这个代价。
  maxEventChars: false,
});

const instruction = await readFile(INSTRUCTION_PATH, 'utf8');
const { result } = await app.run([{ role: 'user', content: instruction }], {
  ...(binding.client ? { client: binding.client } : {}),
});
const atif = traceToAtif(result.trace, {
  instruction,
  agentVersion: AGENTIA_VERSION,
  ...(binding.model ? { modelName: binding.model } : {}),
});

await mkdir(dirname(ATIF_OUT), { recursive: true });
await writeFile(ATIF_OUT, `${JSON.stringify(atif, null, 2)}\n`);
// 必须收尾：长驻 bash 会让 node 的事件循环不空 ⇒ 进程不退出 ⇒ trial 挂到超时。
await closeShellSessions();

// 人可读的一行结论：Harbor 的 job 日志里能直接看到，不用去翻 JSON。
// 等它真的刷出去再退 —— stdout 是管道，`write` 之后立刻 `exit` 会把这一行截掉。
await new Promise<void>((resolve) => {
  process.stdout.write(
    `[agentia] stop=${result.stopReason}${result.error ? ` error=${result.error.type}` : ''} ` +
      `steps=${atif.steps.length} ` +
      `tokens=${atif.final_metrics?.total_prompt_tokens ?? 0}/${atif.final_metrics?.total_completion_tokens ?? 0} ` +
      `cost_usd=${atif.final_metrics?.total_cost_usd ?? 0} atif=${ATIF_OUT}\n`,
    () => resolve(),
  );
});

/**
 * ⚠️ 收尾之后仍**硬退**，这不是保险，是实测缺口。
 *
 * `closeShellSessions()` 只收我们自己开的那些会话；容器里还可能留着**别的**句柄
 * （agent 用 `&` 起的后台进程及其子孙），任何一个都会让事件循环不空。
 * 实测（官方 `terminal-bench-sample` 的 `qemu-startup`）：agent 第 35 步就交了收尾总结、
 * ATIF 也已落盘，进程却**空转 47 分钟**才被 Harbor 的超时杀掉 ⇒
 * 记成 `AgentTimeoutError` —— **一次做成的任务被记成「超时」**，
 * 而且把 `--timeout-multiplier` 调大只会让空转更久。
 *
 * 入口的契约是「写完产物就走」：产物此刻已经落盘，再等下去不会多出任何东西，
 * 只会把成功读成失败。退出码给 0 —— 判分是验证器的事，不在这里。
 */

/**
 * ⚠️ 唯一的例外：**零 token = 这次 trial 根本没开始，不能算成 agent 的 0 分**。
 *
 * 实测（4.0 的 `intrastat-meldung`，2026-10-02）：轨迹里只有 3 条空的 assistant 步、
 * 间隔恰好 ~15 分钟（模型请求超时的节奏），`total_prompt_tokens = 0` ——
 * 也就是说**一次成功的模型调用都没有**。Harbor 照常跑了验证器并记 `reward=0`，
 * 于是它在 `result.json` 里落进「完成」桶，和「模型答错」在榜上无从区分。
 *
 * 非零退出 ⇒ Harbor 记成 `NonZeroAgentExitCodeError`（基础设施异常）。
 * 这与装载阶段那条 TLS 自检是同一条原则：**让失败发生在正确的地方**。
 * 判据只认「零」这个字面值 —— 只要有过一次成功的调用就放行，不替「跑得不好」背锅。
 */
const promptTokens = atif.final_metrics?.total_prompt_tokens ?? 0;
if (promptTokens === 0) {
  await new Promise<void>((resolve) => {
    process.stderr.write(
      `[agentia] 零 token：整个 run 没有一次成功的模型调用` +
        `（stop=${result.stopReason}${result.error ? ` error=${result.error.type}` : ''}）。` +
        '这属于基础设施异常，不是 agent 的 0 分 ⇒ 主动非零退出，让 Harbor 记成 exception。\n',
      () => resolve(),
    );
  });
  process.exit(2);
}
process.exit(0);
