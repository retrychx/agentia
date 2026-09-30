/**
 * 离线自检 —— **不需要 Docker、不需要模型 API key**。
 *
 * 为什么要它：适配器真正的风险不在「装不装得进容器」，而在「产出的 ATIF 过不过得了
 * Harbor 的校验器」（step_id 必须从 1 连续、observation 的 source_call_id 必须命中
 * 同一步的 tool_call_id、多余字段一律 forbid）。这些约束靠肉眼读代码看不出来。
 *
 * 所以这里用框架的 `scriptedClient` 喂一段写死的模型响应 —— agent 会**真的**
 * 起一个 bash、真的执行一条命令 —— 把 trace 直译成 ATIF 落盘，再交给
 * `scripts/verify_atif_schema.py` 用 Harbor 那份 `Trajectory` 模型校验。
 *
 *   npm run build && npm run selftest            # 产 out/atif-sample.json
 *   python3 scripts/verify_atif_schema.py        # 用它校验（需 harbor 在 PYTHONPATH）
 *
 * ⚠️ 它证明的是「转换器 + trace 记账是对的」，**不**证明「agent 能完成任务」——
 * 后者要真模型 + 真容器。别拿自检通过当跑分。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AGENTIA_VERSION, SystemPrompt, createApp, scriptedClient } from '@migor/agentia';
import { ShellTools, closeShellSessions } from './bash.js';
import { traceToAtif } from './atif.js';

const OUT = process.env.AGENTIA_ATIF_OUT ?? 'out/atif-sample.json';
const INSTRUCTION = '在终端里打印一句话，证明你能执行 shell。';

/** 两段写死的模型响应：第一段调一次工具，第二段收尾（与真实工具调用形状一致） */
const SCRIPT = [
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '先确认 shell 能用。' },
      {
        type: 'tool_use',
        id: 'toolu_selftest_1',
        name: 'run_command',
        input: { command: 'echo hello-from-agentia' },
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: '已完成：shell 可用。' }] },
];

const app = await createApp({
  name: 'agentia-terminal-bench-selftest',
  providers: [{ provide: 'shell', useClass: ShellTools }],
  system: new SystemPrompt().add('role', '你是自检用的 agent。', true),
  model: 'scripted/model',
  traceContent: 'full',
  maxEventChars: false, // 与 run.ts 同口径：自检要验的就是「不截断」那条路径
});

const { result } = await app.run([{ role: 'user', content: INSTRUCTION }], {
  client: scriptedClient(SCRIPT),
});

const atif = traceToAtif(result.trace, {
  instruction: INSTRUCTION,
  agentVersion: AGENTIA_VERSION,
  modelName: 'scripted/model',
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(atif, null, 2)}\n`);
await closeShellSessions(); // 不收尾的话长驻 bash 会吊住 node，进程永远不退出

const toolCalls = atif.steps.reduce((n, s) => n + (s.tool_calls?.length ?? 0), 0);
const observations = atif.steps.reduce((n, s) => n + (s.observation?.results.length ?? 0), 0);
process.stdout.write(
  `[selftest] 写出 ${OUT}\n` +
    `[selftest] steps=${atif.steps.length} tool_calls=${toolCalls} observations=${observations}\n` +
    `[selftest] 下一步：python3 scripts/verify_atif_schema.py\n`,
);
