/**
 * trace 记录成本基准（bench，**不进 verify-all / CI** —— 与 e2e:live / e2e:soak 同档，要看时才跑）。
 *
 * 为什么要有它：`docs/spec.md` §9.4 的开放问题是「全量记录成本 vs 截断/采样默认阈值」——
 * 这类问题的答案必须是**数字**，不是印象。本脚本给出「一条 run 的 trace 有多大」的实测，
 * 采样率/容量预算据此倒推（配方见 `docs/observability.md` 2.3）。
 *
 * 零 token、零网络：模型侧是 `scriptedClient`（`src/eval`），工具是本文件里的假工具，
 * 出参大小由 `PAYLOAD_ROWS` 控制，于是「大出参」这一档可以按需造出来。
 *
 *   npm run bench:trace                                  # 每工具调用约 1.8 KB
 *   PAYLOAD_ROWS=1000 CALLS='[5]' npm run bench:trace     # 每工具调用约 30 KB
 *   PAYLOAD_ROWS=1000 CALLS='[5,20,100]' npm run bench:trace
 *
 * 三种记账口径都要看，因为**缺省 vs 不截断**的差距才是 §9.4 的关键：
 * 缺省（按事件类型分别收敛：入参/成功出参 2000、失败出参 1000）、不截断（`maxEventChars: false`）、
 * 截断 200。实测结论（2026-09-21）：大出参下「不截断」是缺省的 **13.7×**
 * —— 这个倍数就是「为什么默认阈值不能取消」。
 */
import { SystemPrompt, Tool, createApp, scriptedClient } from '../src/index.js';

/** 假工具出参的规模（行数）—— 每行约 30 字节，故 1000 行 ≈ 30 KB */
const ROWS = Number(process.env.PAYLOAD_ROWS ?? '40');
/** 每次测量的工具调用次数（脚本形状：N 次 tool_use + 1 次 end_turn） */
const CALLS = JSON.parse(process.env.CALLS ?? '[0,1,5,20]') as number[];

/** 每步模型响应的 usage（真实量级：1.2K 入 / 260 出 / 800 缓存读） */
const USAGE = { input_tokens: 1200, output_tokens: 260, cache_read_input_tokens: 800 };

const obj = { type: 'object', properties: {}, additionalProperties: false } as const;

/** 近似「工具出参是一坨结构化数据」 */
const payload = (rows: number): string =>
  JSON.stringify({
    rows: Array.from({ length: rows }, (_, i) => ({ id: i, name: `row-${i}`, ok: true })),
  });

class BenchTools {
  @Tool({ description: '取一批数据', schema: obj })
  fetch_rows(): string {
    return payload(ROWS);
  }
  @Tool({ description: '再来一批', schema: obj })
  fetch_more(): string {
    return payload(ROWS);
  }
}

const toolUseStep = (i: number) => ({
  id: `step-${i}`,
  model: 'claude-opus-5',
  stop_reason: 'tool_use' as const,
  usage: USAGE,
  content: [
    { type: 'tool_use', id: `tu${i}`, name: i % 2 === 0 ? 'fetch_rows' : 'fetch_more', input: {} },
  ],
});
const endTurnStep = (calls: number) => ({
  id: `done-${calls}`,
  model: 'claude-opus-5',
  stop_reason: 'end_turn' as const,
  usage: USAGE,
  content: [{ type: 'text', text: `共处理 ${calls} 批数据。` }],
});

interface Row {
  mode: string;
  calls: number;
  turns: number;
  spans: number;
  events: number;
  bytes: number;
  bytesPerEvent: number;
  maxEventBytes: number;
}

async function measure(calls: number, mode: string, maxEventChars?: number | false): Promise<Row> {
  const app = await createApp({
    name: 'bench-trace-cost',
    system: new SystemPrompt().add('role', '你是助手。', true),
    providers: [{ provide: 'tools', useClass: BenchTools }],
    toolSources: ['tools'],
    ...(maxEventChars === undefined ? {} : { maxEventChars }),
  });
  const steps = [...Array.from({ length: calls }, (_, i) => toolUseStep(i)), endTurnStep(calls)];
  const { result } = await app.run([{ role: 'user', content: '取几批数据' }], {
    client: scriptedClient(steps as never),
  });
  if (result.stopReason === 'error') throw new Error(`基准跑失败：${JSON.stringify(result.error)}`);
  const trace = result.trace!;
  const events = trace.spans.flatMap((s) => s.events);
  const bytes = Buffer.byteLength(JSON.stringify(trace), 'utf8');
  return {
    mode,
    calls,
    turns: calls + 1,
    spans: trace.spans.length,
    events: events.length,
    bytes,
    bytesPerEvent: events.length === 0 ? 0 : Math.round(bytes / events.length),
    maxEventBytes: Math.max(
      0,
      ...events.map((e) => Buffer.byteLength(JSON.stringify(e.body ?? null), 'utf8')),
    ),
  };
}

async function main(): Promise<void> {
  // 三种口径：缺省（框架自带的按类型收敛）、不截断、以及一个更紧的 200 —— 差距才是结论
  const modes: Array<[string, number | false | undefined]> = [
    ['缺省', undefined],
    ['不截断', false],
    ['截断200', 200],
  ];
  const rows: Row[] = [];
  for (const calls of CALLS) {
    for (const [mode, chars] of modes) rows.push(await measure(calls, mode, chars));
  }

  console.log(`出参规模 ≈ ${ROWS} 行（约 ${Math.round(payload(ROWS).length / 1024)} KB/次）\n`);
  console.log(
    '口径 | 工具调用 | llm.turn | span 数 | 事件数 | trace 字节 | 字节/事件 | 最大单事件',
  );
  for (const r of rows) {
    console.log(
      `${r.mode} | ${r.calls} | ${r.turns} | ${r.spans} | ${r.events} | ${r.bytes} | ${r.bytesPerEvent} | ${r.maxEventBytes}`,
    );
  }

  // 放大倍数：同一次调用数下，「不截断」相对「缺省」—— 这是 §9.4 的那个关键数字
  console.log('\n不截断 / 缺省 的放大倍数（按工具调用数）：');
  for (const calls of CALLS) {
    const base = rows.find((r) => r.calls === calls && r.mode === '缺省')!;
    const full = rows.find((r) => r.calls === calls && r.mode === '不截断')!;
    const ratio = base.bytes === 0 ? 0 : Math.round((full.bytes / base.bytes) * 100) / 100;
    console.log(`  调用 ${calls} 次：${base.bytes} → ${full.bytes} 字节（${ratio}×）`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
