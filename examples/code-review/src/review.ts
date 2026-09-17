import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemPrompt, attachScore, createApp } from '@migor/agentia';
import type { AgentApp, ModelClient, Trace, TraceSink, TypedSchema } from '@migor/agentia';
import { MODEL } from './config.js';
import { providers } from './registry.js';

/** 产物目录：按本文件位置解析（src/ 与 dist/ 下都指向示例根的 out/），不从 cwd 猜 */
export const OUT_DIR = fileURLToPath(new URL('../out', import.meta.url));
export const TRACE_FILE = join(OUT_DIR, 'trace.jsonl');
export const REPORT_FILE = join(OUT_DIR, 'report.json');

/** 评审报告的结构化结果类型（resultSchema 校验通过后进 result.typed） */
export interface ReviewReport {
  findings: Array<{
    file: string;
    line: number;
    severity: 'critical' | 'major' | 'minor';
    title: string;
    detail: string;
  }>;
  summary: string;
  riskLevel: 'high' | 'medium' | 'low';
}

/** 结构化输出 schema：TypedSchema 挂幻影类型，app.run 的 result.typed 自动推导为 ReviewReport */
export const resultSchema: TypedSchema<ReviewReport> = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: '逐条评审发现',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'detail'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: '一段总体结论' },
    riskLevel: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['findings', 'summary', 'riskLevel'],
  additionalProperties: false,
};

const TASK =
  '评审本服务自带的评审对象仓库（fixture/）。流程：先拉 review_rubric 拿评审标准，' +
  '用 list_files / read_file 通读代码，委派 security_scan 做安全专项深挖，' +
  '再用 summarize 汇总定级，最后提交结构化评审报告。';

/**
 * 自定义 file sink —— TraceSink 缝的最小演示：run 收尾拿到完整 Trace，一行 JSON 追加落盘。
 * 产物直接可被 `agentia report` / `agentia diff` 消费（裸 Trace 是它们收的两种行格式之一）。
 */
export function fileTraceSink(file: string): TraceSink {
  mkdirSync(dirname(file), { recursive: true });
  return {
    export(trace) {
      appendFileSync(file, `${JSON.stringify(trace)}\n`);
    },
  };
}

/**
 * 覆盖率评分 sink —— 在线评估 recipe 的确定性版：评的不是「模型表现好不好」这种主观维度，
 * 而是「评审有没有找齐 fixture 里的种子问题」（5 处，见 fixture/README.md）。
 * 顺序要紧：它在 file sink **之前**投递，score 事件才进落盘的 trace。
 */
const SEEDED = ['硬编码', 'MD5', '路径穿越', '竞态', 'TLS'];
export const fixtureCoverageSink: TraceSink = {
  export(trace: Trace) {
    const submit = trace.spans
      .flatMap((s) => s.events)
      .find(
        (e) => e.name === 'tool.input' && (e.body as { tool?: string }).tool === 'submit_result',
      );
    // 事件体的 input 已被框架按 maxEventChars 口径字符串化 —— 直接在其文本里数种子命中
    const input = (submit?.body as { input?: unknown } | undefined)?.input;
    const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
    const hit = SEEDED.filter((k) => text.includes(k));
    attachScore(trace, {
      name: 'fixture_coverage',
      value: hit.length / SEEDED.length,
      source: 'code-review-fixture',
      comment: `种子问题命中 ${hit.length}/${SEEDED.length}${hit.length < SEEDED.length ? `，漏：${SEEDED.filter((k) => !hit.includes(k)).join('、')}` : ''}`,
    });
  },
};

/** 装配应用（demo 与真模型共用同一份装配，差别只在 client） */
export function buildApp(): AgentApp {
  return createApp({
    name: 'code-review',
    providers,
    system: new SystemPrompt().add(
      'role',
      '你是代码评审服务的评审主控。你不亲自逐行读代码之外的臆测：所有结论都要落到' +
        '工具读到/扫到的真实内容上。按用户给的流程编排能力，最后提交结构化评审报告。',
      true, // 静态段（打缓存 breakpoint）
    ),
    model: MODEL,
    maxTotalTokens: 100_000, // 成本硬管控：超限以 budget_exceeded 收尾（算失败）
    // 给 deepseek-v4-flash 定价（$/1M tokens）—— 不在内置价格表的模型必须经这条缝定价，
    // 否则成本恒 undefined、maxCostUsd 护栏静默失效（usage.unpriced 事件会看得见）
    priceOverrides: { 'deepseek-v4-flash': { in: 0.1, out: 0.2 } },
    sinks: [fixtureCoverageSink, fileTraceSink(TRACE_FILE)],
  });
}

/** 跑一次完整评审：落 trace + 结构化报告 + 打印 token/成本摘要 */
export async function runReview(opts: { client?: ModelClient }): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(TRACE_FILE, ''); // 一次性 CLI 示例：每次跑从空文件开始，行数即可数
  const app = buildApp();
  console.log(`[code-review] 菜单：${app.tools.map((t) => t.name).join(', ')}`);

  const { result } = await app.run([{ role: 'user', content: TASK }], {
    resultSchema,
    ...(opts.client ? { client: opts.client } : {}),
  });

  const typed = result.typed;
  if (!typed) {
    throw new Error(
      `模型未提交结构化结果（stopReason=${result.stopReason}）—— 报告无法产出，算失败`,
    );
  }
  writeFileSync(REPORT_FILE, `${JSON.stringify(typed, null, 2)}\n`);

  const bySeverity = (s: string) => typed.findings.filter((f) => f.severity === s).length;
  console.log(
    `[code-review] run 完成：stopReason=${result.stopReason}，主循环 ${result.iterations} 回合`,
  );
  console.log(
    `[code-review] 结论：${typed.findings.length} 个问题` +
      `（critical=${bySeverity('critical')} major=${bySeverity('major')} minor=${bySeverity('minor')}），` +
      `整体定级 ${typed.riskLevel}`,
  );
  console.log(`[code-review] 摘要：${typed.summary}`);

  const u = result.trace.totalUsage;
  console.log(
    `[code-review] tokens：输入 ${u.inputTokens} / 输出 ${u.outputTokens}` +
      `（缓存读 ${u.cacheReadTokens} / 写 ${u.cacheCreationTokens}），模型 ${MODEL}`,
  );
  console.log(
    u.costEstimate !== undefined
      ? `[code-review] 估算成本：$${u.costEstimate}（priceOverrides 定价 $0.1/$0.2 每百万 tokens）`
      : `[code-review] 估算成本：未定价（模型 ${MODEL} 不在价格表 —— 用 priceOverrides 补上）`,
  );

  const events = result.trace.spans.reduce((n, s) => n + s.events.length, 0);
  console.log(
    `[code-review] trace → out/trace.jsonl（${result.trace.spans.length} 个 span / ${events} 个事件）` +
      `；报告 → out/report.json`,
  );
  console.log(
    '[code-review] 调优报告：agentia report out/trace.jsonl；两版对比：agentia diff out/trace.jsonl out/trace-b.jsonl',
  );
}
