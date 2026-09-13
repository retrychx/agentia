import { DatabaseSync } from 'node:sqlite';
import { metricsSink } from '@migor/agentia';
import type { TraceSink } from '@migor/agentia';
// 四个现成 sink 来自本地小包 ../observability（也可以用 docs/observability.md 里的代码自己写）
import { jsonLogSink, redactSink, sampleSink, sqliteTraceSink } from '@migor/agentia-observability';

/**
 * 观测栈组装 —— 把 docs/observability.md 的四条配方接成一个真实组合。
 *
 * 链路（数组顺序 = 调用顺序）：
 *
 *   metrics（全量，不吃采样 —— 指标要准）
 *   sampleSink（采样；错误 run 一律保留）
 *     └ redactSink（先脱敏，保证下游都拿不到原文）
 *         ├ sqliteTraceSink（落库；与 SqliteTaskStore 同库文件）
 *         └ jsonLogSink（一 run 一行 JSON，runId 贯穿）
 *
 * 全部零 engine 改动、零新增依赖、零新出口。
 */
export interface Observability {
  /** 交给 `createApp({ sinks })` */
  sinks: TraceSink[];
  /** 按 runId 检索历史 run（回放调试的入口） */
  traces: ReturnType<typeof sqliteTraceSink>;
  /** Prometheus 文本（挂 /metrics） */
  metrics: ReturnType<typeof metricsSink>;
  close(): void;
}

export function buildObservability(opts: { dbPath: string; sampleRate: number }): Observability {
  const db = new DatabaseSync(opts.dbPath);
  const traces = sqliteTraceSink({ db });
  const metrics = metricsSink({ prefix: 'agentia_' });
  const log = jsonLogSink({ labels: { service: 'complete-example', env: process.env.NODE_ENV ?? 'dev' } });

  const sampled = sampleSink({
    rate: opts.sampleRate,
    sinks: [
      redactSink({
        // 字段级脱敏（框架只做长度截断，这层得宿主自己兜）
        keys: ['authorization', 'api_key', 'apikey', 'password', 'cookie', 'x-api-key'],
        // 顺带遮掉手机号 / 邮箱这类 PII
        patterns: [/1[3-9]\d{9}/g, /[\w.+-]+@[\w-]+\.[\w.]+/g],
        sinks: [traces, log],
      }),
    ],
  });

  return {
    sinks: [metrics, sampled],
    traces,
    metrics,
    close: () => db.close(),
  };
}
