/**
 * Agentia —— 生产可观测栈：四个现成 sink（零依赖、零 engine 改动）。
 *
 * 全部只消费 `TraceSink` 出口（spec §9.3）：run 收尾（成功 / 失败两条路径）后框架把完整
 * Trace 交给每个 sink，sink 抛错被吞、不影响 run。落地形态（落库 / 采样 / 脱敏 / 日志）
 * 全由这里组合 —— 框架不内建、不含 dev 逻辑，sink 的 endpoint / 库路径一律由宿主显式传入。
 *
 * 这是**示例代码**，可以直接拷进你的宿主工程 —— 它只 import 框架的公共类型面
 * （`@migor/agentia`），不碰任何内部路径。
 *
 * 组合方式（数组顺序 = 调用顺序，最外层先看到原始 trace）：
 *
 *   import { DatabaseSync } from 'node:sqlite';
 *
 *   const db = new DatabaseSync('agentia.db');          // 与 SqliteTaskStore 同一个库文件
 *   const sink = sampleSink({ rate: 0.1, sinks: [      // ① 采样（错误 run 全留）
 *     redactSink({ keys: ['authorization', 'api_key'], // ② 脱敏（先脱，下游都拿不到原文）
 *       sinks: [
 *         sqliteTraceSink({ db }),                     // ③ 落库：span 与 run 记录同库
 *         jsonLogSink(),                               // ④ 日志：一行 JSON，带 runId
 *       ] }),
 *   ] });
 *
 *   createApp({ name: 'svc', providers, sinks: [sink] });
 *
 * 详细说明与「按 runId 检索一次历史 run」的查法见 `docs/observability.md`。
 */
import { DatabaseSync } from 'node:sqlite';
import type { Span, Trace, TraceSink } from '@migor/agentia';

const REDACTED = '[REDACTED]';

/** 依次投递；逐个 try —— 一个下游抛错不影响其余下游（与框架对 sink 的态度一致） */
async function fanOut(sinks: readonly TraceSink[], trace: Trace): Promise<void> {
  for (const s of sinks) {
    try {
      await s.export(trace);
    } catch {
      /* 观测失败不得影响别的 sink，更不得影响 run */
    }
  }
}

// ---------------------------------------------------------------------------
// ① 采样：按 runId 确定性取舍，错误 run 一律保留
// ---------------------------------------------------------------------------

export interface SampleSinkOptions {
  /** 采样率 [0,1]：保留比例。`0` = 只留错误 run，`1` = 全留。 */
  rate: number;
  /** 被保留的 trace 交给它们 */
  sinks: readonly TraceSink[];
}

/** FNV-1a → [0,1)。用 runId 做种子，同一 run 的判定**确定**（便于回放 / 复现，不是随机数） */
function hashFraction(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/**
 * 采样闸门。量大时全量导出会压垮 OTLP 后端 / 撑爆落库表，这里是第一道闸。
 * **失败 run 永不采样掉** —— 采样为了省成本，不能省掉最该看的那些。
 */
export function sampleSink(opts: SampleSinkOptions): TraceSink {
  const { rate, sinks } = opts;
  if (!(rate >= 0 && rate <= 1)) {
    throw new Error(`sampleSink: rate 必须在 [0,1]，收到 ${opts.rate}`);
  }
  return {
    async export(trace: Trace): Promise<void> {
      if (trace.status === 'error' || hashFraction(trace.traceId) < rate) {
        await fanOut(sinks, trace);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ② 脱敏：按字段名（+可选正则）抹掉敏感值，深拷贝不改原 trace
// ---------------------------------------------------------------------------

export interface RedactOptions {
  /** 命中即抹掉的**字段名**（大小写不敏感的子串匹配），如 `['authorization','api_key','password']` */
  keys?: readonly string[];
  /** 额外：对字符串值做正则替换（如手机号 / 邮箱 / 内部 ID 形态） */
  patterns?: readonly RegExp[];
  /** 脱敏后的 trace 交给它们 */
  sinks: readonly TraceSink[];
}

function hitKey(key: string, keys: readonly string[]): boolean {
  const k = key.toLowerCase();
  return keys.some((needle) => k.includes(needle.toLowerCase()));
}

function redactString(s: string, patterns: readonly RegExp[]): string {
  let out = s;
  for (const p of patterns) out = out.replace(p, REDACTED);
  return out;
}

/** 递归深拷贝 + 抹值：原 trace 不被改动（其余 sink 仍拿得到原文） */
function redactValue(value: unknown, keys: readonly string[], patterns: readonly RegExp[]): unknown {
  if (typeof value === 'string') return redactString(value, patterns);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, keys, patterns));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = hitKey(k, keys) ? REDACTED : redactValue(v, keys, patterns);
  }
  return out;
}

/**
 * 脱敏闸门。框架只做**长度截断**（`includeToolIO: false` 是粗粒度开关），
 * 字段级 redaction 在这里 —— trace 会带用户输入与工具 IO，内部合规得自己兜。
 * 放在链路上游，保证下游（落库 / 日志）拿到的都已是脱敏副本。
 */
export function redactSink(opts: RedactOptions): TraceSink {
  const keys = opts.keys ?? [];
  const patterns = opts.patterns ?? [];
  const { sinks } = opts;
  return {
    async export(trace: Trace): Promise<void> {
      const clean: Trace = {
        ...trace,
        totalUsage: { ...trace.totalUsage },
        spans: trace.spans.map((span) => ({
          ...span,
          attributes: redactValue(span.attributes, keys, patterns) as Span['attributes'],
          events: span.events.map((e) => ({ ...e, body: redactValue(e.body, keys, patterns) })),
          ...(span.error
            ? { error: { ...span.error, message: redactString(span.error.message, patterns) } }
            : {}),
        })),
      };
      await fanOut(sinks, clean);
    },
  };
}

// ---------------------------------------------------------------------------
// ③ 落库：span 与 run 记录同库（spec §9.3 那句「同库存储」的落地）
// ---------------------------------------------------------------------------

export interface SqliteTraceSinkOptions {
  /**
   * 库文件路径（自建连接，`close()` 会关）**或**已有连接。
   * 与 `SqliteTaskStore` 共库时传同一个路径 —— 于是 run 记录（`tasks` 表）与
   * trace（`traces` / `spans` 表）落在**一个库文件**里，DBA 一条 SQL 就能关联。
   */
  db: DatabaseSync | string;
}

export interface RunSummary {
  runId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  tokens: number;
  costUsd: number | null;
}

/** `spans` 表的一行 —— 反规范化列，供直接查（慢 span / 错误 span / token 大户），不必解析 JSON */
export interface SpanRow {
  spanId: string;
  runId: string;
  parentSpanId: string | null;
  kind: string;
  name: string;
  status: string;
  startedAt: number;
  /** 未收尾（失败路径的半截 trace）时为 null */
  endedAt: number | null;
  /** 毫秒；未收尾时为 null */
  durationMs: number | null;
  errorType: string | null;
  retryable: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attributes: Record<string, unknown>;
  events: unknown[];
}

export interface SqliteTraceSink extends TraceSink {
  /** 按 runId 取回**完整** trace（JSON 列反序列化），即「按 runId 检索一次历史 run」 */
  getTrace(runId: string): Trace | undefined;
  /** 按 runId 取 span 明细行（`spans` 表的反规范化列，见 `SpanRow`） */
  getSpans(runId: string): SpanRow[];
  /** 最近 N 条 run 摘要（按开始时间倒序） */
  listRecent(limit?: number): RunSummary[];
  /** 仅当连接是本 sink 自建时才真正关闭 */
  close(): void;
}

/**
 * 落库 sink：`traces` 一 run 一行（全量 JSON + 反规范化列），`spans` 一 span 一行。
 * 反规范化列（status / tokens / cost / started_at）供 DBA 直接统计，不必解析 JSON。
 *
 * 建表用 `IF NOT EXISTS`，与 `SqliteTaskStore` 共存于同一个库文件；
 * `busy_timeout` 与它一致，多进程共库不会 `SQLITE_BUSY`。
 */
export function sqliteTraceSink(opts: SqliteTraceSinkOptions): SqliteTraceSink {
  const owned = typeof opts.db === 'string';
  const db = owned ? new DatabaseSync(opts.db as string) : (opts.db as DatabaseSync);

  if (owned) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      run_id TEXT PRIMARY KEY,
      status TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      cost_usd REAL,
      json TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT,
      name TEXT,
      status TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      error_type TEXT,
      retryable INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      attributes_json TEXT,
      events_json TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_spans_run ON spans(run_id)');

  const insertTrace = db.prepare(
    `INSERT OR REPLACE INTO traces
       (run_id, status, started_at, ended_at, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSpan = db.prepare(
    `INSERT OR REPLACE INTO spans
       (span_id, run_id, parent_span_id, kind, name, status, started_at, ended_at,
        error_type, retryable, input_tokens, output_tokens, attributes_json, events_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    export(trace: Trace): void {
      const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
      const u = trace.totalUsage;
      insertTrace.run(
        trace.traceId,
        trace.status,
        root?.startedAt ?? 0,
        root?.endedAt ?? null,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheCreationTokens,
        u.costEstimate ?? null,
        JSON.stringify(trace),
      );
      for (const s of trace.spans) {
        const su = s.usage;
        insertSpan.run(
          s.spanId,
          trace.traceId,
          s.parentSpanId,
          s.kind,
          s.name,
          s.status,
          s.startedAt,
          s.endedAt ?? null,
          s.error?.type ?? null,
          s.error ? (s.error.retryable ? 1 : 0) : null,
          su?.inputTokens ?? null,
          su?.outputTokens ?? null,
          JSON.stringify(s.attributes),
          JSON.stringify(s.events),
        );
      }
    },

    getTrace(runId: string): Trace | undefined {
      const row = db.prepare('SELECT json FROM traces WHERE run_id = ?').get(runId) as
        | { json: string }
        | undefined;
      return row ? (JSON.parse(row.json) as Trace) : undefined;
    },

    getSpans(runId: string): SpanRow[] {
      const rows = db
        .prepare(
          `SELECT span_id, run_id, parent_span_id, kind, name, status, started_at, ended_at,
                  error_type, retryable, input_tokens, output_tokens, attributes_json, events_json
             FROM spans WHERE run_id = ? ORDER BY started_at`,
        )
        .all(runId) as Array<{
        span_id: string;
        run_id: string;
        parent_span_id: string | null;
        kind: string;
        name: string;
        status: string;
        started_at: number;
        ended_at: number | null;
        error_type: string | null;
        retryable: number | null;
        input_tokens: number | null;
        output_tokens: number | null;
        attributes_json: string;
        events_json: string;
      }>;
      return rows.map((r) => ({
        spanId: r.span_id,
        runId: r.run_id,
        parentSpanId: r.parent_span_id,
        kind: r.kind,
        name: r.name,
        status: r.status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.ended_at === null ? null : r.ended_at - r.started_at,
        errorType: r.error_type,
        retryable: r.retryable === null ? null : r.retryable === 1,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        attributes: JSON.parse(r.attributes_json) as Record<string, unknown>,
        events: JSON.parse(r.events_json) as unknown[],
      }));
    },

    listRecent(limit = 20): RunSummary[] {
      const rows = db
        .prepare(
          `SELECT run_id, status, started_at, ended_at,
                  input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens,
                  cost_usd
             FROM traces ORDER BY started_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{
        run_id: string;
        status: string;
        started_at: number;
        ended_at: number | null;
        tokens: number;
        cost_usd: number | null;
      }>;
      return rows.map((r) => ({
        runId: r.run_id,
        status: r.status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        tokens: r.tokens,
        costUsd: r.cost_usd,
      }));
    },

    close(): void {
      if (owned) db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// ④ 日志关联：一 run 一行 JSON，runId 贯穿 —— 从日志能跳到 trace
// ---------------------------------------------------------------------------

export interface JsonLogSinkOptions {
  /** 落一行的通道，缺省 `process.stdout.write`（容器里就是 stdout 采集） */
  write?: (line: string) => void;
  /** 附在每个 run 行上的静态标签（service / env / version…） */
  labels?: Record<string, string>;
  /** 时间源（测试可注入） */
  now?: () => number;
}

/**
 * 结构化日志 sink。框架**没有日志层**（全仓库只有 7 处 `console.error/warn` 兜底），
 * 这一层得宿主自己补：把 trace 压成**一行 JSON**（带 `runId`），于是
 * 「日志 grep 到 runId → 查 trace」与「trace 看到异常 → 搜同名日志」双向可跳。
 */
export function jsonLogSink(opts: JsonLogSinkOptions = {}): TraceSink {
  const write = opts.write ?? ((line: string) => void process.stdout.write(line));
  const labels = opts.labels ?? {};
  const now = opts.now ?? (() => Date.now());

  return {
    export(trace: Trace): void {
      const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
      const turns = trace.spans.filter((s) => s.kind === 'llm.turn');
      const u = trace.totalUsage;
      const entry: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        level: trace.status === 'error' ? 'error' : 'info',
        msg: 'run.finished',
        runId: trace.traceId, // ← 与 trace / 落库主键同一个，日志与 trace 的接缝就在这
        traceId: trace.traceId,
        status: trace.status,
        ...(root && root.endedAt !== undefined ? { durationMs: root.endedAt - root.startedAt } : {}),
        iterations: turns.length,
        tokens: {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadTokens,
          cacheCreation: u.cacheCreationTokens,
        },
        ...(u.costEstimate !== undefined ? { costUsd: u.costEstimate } : {}),
        ...(root?.error
          ? { error: { type: root.error.type, message: root.error.message, retryable: root.error.retryable } }
          : {}),
        ...labels,
      };
      write(`${JSON.stringify(entry)}\n`);
    },
  };
}
