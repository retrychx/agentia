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
 *   AGENTIA_MAX_ITERATIONS  循环上限（缺省 500，见下方 DEFAULT_MAX_ITERATIONS 注释）
 *   AGENTIA_PRICE_IN/OUT    覆盖单价（$/1M tokens），成对给才生效
 *   ANTHROPIC_API_KEY       由 `harbor run --ae` 注入（默认端点）
 *   DEEPSEEK_API_KEY        设了就走 DeepSeek（框架自带 OpenAI 兼容适配器，换 baseURL）
 *   DEEPSEEK_BASE_URL       覆盖 DeepSeek 端点（缺省 https://api.deepseek.com）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENTIA_VERSION, SystemPrompt, createApp } from '@migor/agentia';
import { traceToAtif } from './atif.js';
import { ShellTools, closeShellSessions } from './bash.js';
import { resolveModel } from './model.js';

const INSTRUCTION_PATH = process.env.AGENTIA_TB_INSTRUCTION ?? '/installed-agent/instruction.txt';
const ATIF_OUT = process.env.AGENTIA_ATIF_OUT ?? '/logs/agent/trajectory.json';
/** 与 ATIF 同目录：`/logs/agent` 是 Harbor 的 agent 日志契约目录（见 `harbor_agent.py`）。 */
const STATUS_OUT = join(dirname(ATIF_OUT), 'agentia-run-status.json');
const binding = resolveModel();

/**
 * **harness 侧的预算**拦下的收尾原因 —— 撞到它们不等于「模型答错了」。
 *
 * 语义与框架自己的分类表一致：`src/engine/types.ts` 把这两个字面量注释成
 * 「是护栏拦下的，不是正常收尾」。区别只在于**护栏是谁设的**：
 * `max_iterations` / `budget_exceeded` 都是**本适配器**设的（见 `DEFAULT_MAX_ITERATIONS`），
 * 而任务自己的预算是 Harbor 的 wall clock —— 后者超了会被记成 `AgentTimeoutError`
 * （exception 桶）。⇒ 这两者必须落进同一个桶，否则同一个「预算用光」
 * 在榜上是两种命运（一个 exception、一个 reward=0）。
 *
 * ⚠️ **刻意不含 `'error'`**：模型调到一半报错确实也可疑，但本轮没有病例
 * （唯一观测到的 `stop=error` 是 0 token，已被下一条守卫接住），
 * 按本仓「先有病例再有设备」的规矩不预先扩。
 */
const HARNESS_STOP_REASONS = new Set(['max_iterations', 'budget_exceeded']);

/**
 * 循环上限缺省。⚠️ 不能吃框架缺省（40）：Terminal-Bench 的任务是**长程**的。
 *
 * ⚠️ 2026-10-02 **从 200 抬到 500**，依据是三轮实跑里同一枚指纹：
 * **步数恰好落在「1 + 上限」上**（`steps = 1 条 user + N 条 agent`）——
 * 4.0 上复现 3 次（r2 的 `interleaved-vigenere`、验证批的 `risk-scorer-replay` /
 * `rs-archive-clone`，都是 **201**），旧 2.0 时代是同一个形状（**41**，见 README §六 坑 6）。
 *
 * ⚠️ **别拿轨迹形态当判据，这两条都试过、都不成立**（实测见 README §六 坑 6）：
 * ① 「末步带 `tool_calls`」在 2.0 的**成功**轨迹里同样出现（末步是提交哨兵
 * `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`）⇒ 零区分度；
 * ② 「末步不是提交哨兵」在 **4.0 上恒真** —— 4.0 的任务指令里没有这个提交机制，
 * 已收口的 **25 条** 4.0 轨迹里**一条都没出现**哨兵（连 `gsea-proteomics` 那条
 * 做对、且明确写出收尾总结的也没有）。
 * ⇒ **只有步数对得上上限才是判据**，其余都是旁证。
 *
 * 判据是**「谁先咬人」**：这几条 trial 的墙钟只用了 13.7～22.5 分钟，而给的是 2 小时
 * ⇒ 咬住它们的是**我们自己的旋钮**，不是任务的预算。`rs-archive-clone` 最能说明问题——
 * 验证器第一条断言就报 `/app/archive-clone` **不存在**：交付物在 200 步时**还没被写出来**，
 * 这条 0 分量的是配置，不是能力。
 *
 * 500 这个值的取法：真实收尾的步数分布里最高一条是 **191**（`atrx-vep-crispr`，
 * 自然收尾），500 给到 2.6 倍余量；同时它仍是一道**防跑飞的护栏**
 * （实测 token 量级约 15 万 prompt tokens/步 ⇒ 最坏情况单题几十美元，
 * 由 `--agent-timeout-multiplier` 与 wall clock 一起兜底）。
 */
const DEFAULT_MAX_ITERATIONS = 500;
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
   *
   * 这个值本身也翻过车：40 → 200 之后，**4.0 上又出现了同一枚指纹（201）**。
   * 当前取值与依据见 `DEFAULT_MAX_ITERATIONS`。
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
/**
 * 旁路状态文件 —— **补一个实测出来的黑洞**。
 *
 * 下面那行人可读结论（`[agentia] stop=…`）打在 **stdout** 上，而 Harbor 收集的是
 * `/logs/agent/` **目录里的文件**，agent 的 stdout **只在失败时**才被塞进 `_exec` 的异常正文
 * （实测：`jobs/2026-10-02__tb40-verify4/` 里逐文件找过，`[agentia]` 一个字符都没有 ——
 * 四条正好都是「正常退出」）。⇒ 一次**成功退出**的 trial，手里没有任何产物能回答
 * 「它是正常收尾的，还是我们放行了一种没分类的停法」；而 `reward.txt` 对所有情况都只写 0/1。
 *
 * ATIF 本身不带这个字段（`ATIF-v1.8` 没有 stop_reason），这里**刻意不往 ATIF 里塞
 * 非规范字段** —— Harbor 是要解析那个文件的。所以另起一个文件。
 *
 * 与 `trajectory.json` 同目录 ⇒ 跟着 Harbor 的 `/logs/agent` 契约目录一起被收走
 * （`trial.py::_download_role_logs` 走的是**整目录**下载，不是只取那一个文件名）。
 *
 * 刻意**不包 try/catch**：它写的是 ATIF 刚刚成功写过的那**同一个目录**，
 * 因此不引入任何新的失败模式（写不进去的话上一行早就抛了）。
 */
const status = {
  stop_reason: result.stopReason,
  error_type: result.error?.type ?? null,
  iterations: result.iterations,
  max_iterations: MAX_ITERATIONS,
  /** 步数 = 1 条 user + N 条 agent ⇒ 撞上限的指纹是 `max_iterations + 1` */
  steps: atif.steps.length,
  prompt_tokens: atif.final_metrics?.total_prompt_tokens ?? 0,
  completion_tokens: atif.final_metrics?.total_completion_tokens ?? 0,
  cost_usd: atif.final_metrics?.total_cost_usd ?? 0,
  truncated_by_harness: HARNESS_STOP_REASONS.has(result.stopReason),
};
await writeFile(STATUS_OUT, `${JSON.stringify(status, null, 2)}\n`);
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

/**
 * ⚠️ 第二个例外：**被我们自己的预算掐断，也不算 agent 的 0 分**（2026-10-02 新增）。
 *
 * 与上一条同一个形状、同一个判据，只是触发点不同：上一条是「一次模型调用都没成功」，
 * 这一条是「跑到一半被自己的旋钮停住」。实测病例（4.0，三轮共 3 条）见
 * `DEFAULT_MAX_ITERATIONS` 与 README §六 坑 6 —— 最露骨的一条是 `rs-archive-clone`：
 * 撞上限时交付物 `/app/archive-clone` **还没被创建**，验证器第一条断言直接
 * `AssertionError: /app/archive-clone does not exist`。
 *
 * 为什么必须非零退出：**同一个「预算用光」不能有两种命运。** 任务自带的预算
 * （Harbor 的 wall clock）超了会被记成 `AgentTimeoutError`（exception 桶），
 * 那么我们自己设的步数/成本上限超了也该进同一个桶 —— 否则「我配的旋钮」
 * 会被写进榜里当成「模型不会做」。
 *
 * ⚠️ 这一条**改变了报数口径**：截断的 trial 不再落进「完成」桶。
 * 所以 `agentia-run-status.json` 里留了 `truncated_by_harness` 与 `max_iterations`
 * —— 事后要复核「有几条是没跑完的」有据可查，别把「已剔除」读成「全跑完了」。
 */
if (HARNESS_STOP_REASONS.has(result.stopReason)) {
  await new Promise<void>((resolve) => {
    process.stderr.write(
      `[agentia] 被本适配器的预算掐断：stop=${result.stopReason} ` +
        `iterations=${result.iterations}/${MAX_ITERATIONS} steps=${atif.steps.length}` +
        `${result.error ? ` error=${result.error.type}` : ''}。` +
        '这属于「没跑完」，不是 agent 的 0 分 ⇒ 主动非零退出，让 Harbor 记成 exception。\n',
      () => resolve(),
    );
  });
  process.exit(3);
}
process.exit(0);
