/**
 * Agentia gRPC 宿主示例 —— **第 4 个宿主**（前三个：HTTP 同步 RPC / 异步任务 / 定时）。
 *
 * 演示「宿主只做翻译」这条缝：
 *
 *   gRPC 请求  →  `normalizeMessages`  →  `app.run` / `runner.submit`
 *   run 结果   →  响应消息
 *
 * 业务侧（能力声明、菜单、trace 记账、成本管控）**一行都不改** —— 四种触发共用同一份
 * `RunInput` 契约，「换宿主不换语义」（spec §1）。
 *
 * 四处框架语义在这里被接上（这也是本示例存在的理由 —— 样板本身很短，难的是知道要接哪几处）：
 *   ① deadline / 客户端取消 → `AbortSignal`（不接上，客户端走了 run 还会跑完，白烧 token）
 *   ② metadata `traceparent` → `options.traceContext`（跨进程关联：run 根记一条 link）
 *   ③ 框架错误分类 → gRPC 状态码（`classifyError` 认的是**数据属性**，不是 instanceof 厂商错误类）
 *   ④ trace → 落盘 sink（「trace 决定你敢不敢上线」：RPC 只回业务结果，调用树落服务端）
 *
 * 与 HTTP 宿主的逐条对照（`src/transport/http.ts` 是框架里那份参考实现）：
 *   Run        ↔ `POST /run`
 *   RunStream  ↔ `POST /run` + `Accept: text/event-stream`（帧名一一对应 text.delta / run.end）
 *   Submit     ↔ `POST /tasks`
 *   GetTask    ↔ `GET /tasks/:id`
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  AsyncRunner,
  InMemorySessionStore,
  InMemoryTaskStore,
  SystemPrompt,
  classifyError,
  createApp,
  normalizeMessages,
  parseTraceparent,
} from '@migor/agentia';
import type { AgentRunOutput, Trace, TraceSink } from '@migor/agentia';
import { providers } from './registry.js';

// ── 与 proto 对应的消息形状 ────────────────────────────────────────────────────
// proto-loader 只给运行时结构，编译期这一份自己声明（比 `any` 诚实：字段名写错会报错）。
interface RunRequestMsg {
  input: string;
  sessionId: string;
  maxIterations: number;
  maxTotalTokens: number;
}
interface RunReplyMsg {
  runId: string;
  status: string;
  stopReason: string;
  finalText: string;
  spans: number;
  inputTokens: number;
  outputTokens: number;
  error: string;
}
interface RunChunkMsg {
  textDelta?: string;
  end?: RunReplyMsg;
}
interface SubmitReplyMsg {
  taskId: string;
}
interface TaskQueryMsg {
  taskId: string;
}
interface TaskReplyMsg {
  taskId: string;
  status: string;
  runId: string;
  finalText: string;
  error: string;
}

/**
 * 一元调用与服务端流调用**共有**的那部分表面。
 * 写成结构类型而不是 `ServerUnaryCall | ServerWritableStream`，是为了不必为了共用一段逻辑
 * 而把泛型参数抄两遍（也避免落到 `any`）。
 */
interface CancellableCall {
  /** 客户端取消 / deadline 到期 —— grpc-js 对两者都发这个事件 */
  on(event: 'cancelled', listener: () => void): unknown;
  getDeadline(): Date | number;
}

const PORT = process.env.PORT ?? '50051';
const TRACE_FILE = resolve(process.env.AGENTIA_TRACE_FILE ?? 'out/trace.jsonl');
// dist/main.js 与 src/main.ts 都在示例根下的一层里 ⇒ 这个相对位置两边都成立
const PROTO_PATH = fileURLToPath(new URL('../proto/agent.proto', import.meta.url));

/**
 * trace 落盘 sink（演示用的最小实现）：一行一个 run 的完整调用树。
 *
 * 产物可直接喂 `agentia report out/trace.jsonl` 看调优报告、喂 `agentia diff` 做 A/B。
 * 生产环境换成 OTLP / 落库 / 脱敏 / 采样那几个现成 sink 即可（`examples/observability/`）。
 */
function fileTraceSink(file: string): TraceSink {
  mkdirSync(dirname(file), { recursive: true });
  return {
    export(trace: Trace): void {
      appendFileSync(file, `${JSON.stringify(trace)}\n`);
    },
  };
}

// ── 装配：这一段与 HTTP 宿主的示例逐字同形（换宿主不改业务侧）─────────────────────
const app = await createApp({
  name: 'grpc-host-example',
  providers,
  system: new SystemPrompt().add(
    'role',
    '你是 gRPC 宿主示例的主 agent，按任务自主调度菜单里的能力。',
    true,
  ),
  sinks: [fileTraceSink(TRACE_FILE)],
  maxTotalTokens: 200_000, // 单条 run 的 token 上限（硬管控，超限以 budget_exceeded 收尾）
});

const runner = new AsyncRunner(app, { store: new InMemoryTaskStore(), runTimeoutMs: 120_000 });
/** 会话历史（多轮 run 共享）。生产换持久化实现即可 —— 缝是同一个 `SessionStore`。 */
const sessions = new InMemorySessionStore();

// ── 宿主侧的三处翻译 ───────────────────────────────────────────────────────────

/**
 * 「该中止了」→ `AbortSignal`。
 *
 * 框架不订阅信号、不猜宿主语义（这是刻意的：进程级决策属于宿主，见 spec §10）。
 * 所以宿主必须把两件事翻译进去：**客户端主动取消**与**deadline 到期**。
 * 少了这一步，客户端已经走了，服务端还会把这次 run 跑完 —— token 照烧。
 */
function abortOnCancel(call: CancellableCall): AbortController {
  const ac = new AbortController();
  call.on('cancelled', () => ac.abort());
  const deadline = call.getDeadline();
  const at = typeof deadline === 'number' ? deadline : deadline.getTime();
  // 未设 deadline 时 grpc-js 给 Infinity ⇒ 不排定时器
  const ms = at - Date.now();
  if (Number.isFinite(ms) && ms > 0) setTimeout(() => ac.abort(), ms).unref?.();
  return ac;
}

/** 从 metadata 取首个值（没有则 undefined）—— 一元/流/异步三处共用 */
function metadataValue(metadata: grpc.Metadata, key: string): string | undefined {
  const first = metadata.get(key)[0];
  return typeof first === 'string' ? first : undefined;
}

/**
 * 一次调用的框架入参。三处翻译都在这：中断、入站链路、会话。
 *
 * `exactOptionalPropertyTypes` 下「不传这个键」与「传了个 undefined」不同（见 AGENTS.md），
 * 所以这里一律**条件展开**，不写 `{ traceContext: maybeUndefined }`。
 */
function callOptions(
  req: RunRequestMsg,
  ac: AbortController,
  traceContext: ReturnType<typeof parseTraceparent>,
): {
  signal: AbortSignal;
  traceContext?: { traceId: string; spanId?: string };
  session?: { store: InMemorySessionStore; id: string };
  maxIterations?: number;
  maxTotalTokens?: number;
} {
  return {
    signal: ac.signal,
    ...(traceContext !== undefined ? { traceContext } : {}),
    ...(req.sessionId !== '' ? { session: { store: sessions, id: req.sessionId } } : {}),
    ...(req.maxIterations > 0 ? { maxIterations: req.maxIterations } : {}),
    ...(req.maxTotalTokens > 0 ? { maxTotalTokens: req.maxTotalTokens } : {}),
  };
}

/** run 输出 → 响应消息。trace 本身**不**回传（落服务端 sink），只回它的轮廓。 */
function toReply(out: AgentRunOutput): RunReplyMsg {
  const { trace } = out.result;
  return {
    runId: out.run.runId,
    status: out.run.status,
    stopReason: out.result.stopReason,
    finalText: out.result.finalText,
    spans: trace.spans.length,
    inputTokens: trace.totalUsage.inputTokens,
    outputTokens: trace.totalUsage.outputTokens,
    error: out.result.error?.message ?? '',
  };
}

/**
 * 框架错误 → gRPC 状态码。
 *
 * 判据与引擎**同源**：`classifyError` 认的是数据属性（数值 `status` / errno `code`），
 * 不是 `instanceof` 厂商错误类（SDK 的错误类 `name` 恒为 'Error'，压缩即失效 —— 见 AGENTS.md）。
 * 宿主照抄同一条口径，才不会在多实例 / 压缩后错判，也才能和 trace 里的分类对上号。
 */
function toServiceError(e: unknown): grpc.ServiceError {
  const classified = classifyError(e);
  const code =
    classified.type === 'rate_limit'
      ? grpc.status.RESOURCE_EXHAUSTED
      : classified.type === 'server' || classified.type === 'connection'
        ? grpc.status.UNAVAILABLE
        : classified.type === 'timeout'
          ? grpc.status.DEADLINE_EXCEEDED
          : classified.type === 'aborted'
            ? grpc.status.CANCELLED
            : classified.type === 'api'
              ? grpc.status.INVALID_ARGUMENT // 4xx：调用方写错了
              : // 入参不合法：框架用 TaskInputError 标记「调用方的错」。它不是厂商错误、也没有
                // status 属性，classifyError 认不出来（该类未进公共导出面），所以按 name 认一次。
                e instanceof Error && e.name === 'TaskInputError'
                ? grpc.status.INVALID_ARGUMENT
                : grpc.status.INTERNAL;
  return Object.assign(new Error(classified.message), {
    code,
    details: classified.message,
    metadata: new grpc.Metadata(),
  }) as grpc.ServiceError;
}

/** 客户端已经放弃这个调用时不回帧：回了也没人要，且会往一个已取消的调用上写 */
function abandoned(call: { cancelled: boolean }): boolean {
  return call.cancelled;
}

// ── 服务实现：四个 RPC 都是「翻译 + 交出去」────────────────────────────────────

const implementation = {
  /** 一元：跑一次同步 run（↔ `POST /run`） */
  async run(
    call: grpc.ServerUnaryCall<RunRequestMsg, RunReplyMsg>,
    callback: grpc.sendUnaryData<RunReplyMsg>,
  ): Promise<void> {
    const ac = abortOnCancel(call);
    const traceparent = metadataValue(call.metadata, 'traceparent');
    const traceContext = traceparent === undefined ? undefined : parseTraceparent(traceparent);
    try {
      const out = await app.run(normalizeMessages(call.request.input), {
        ...callOptions(call.request, ac, traceContext),
        // rethrow:false —— 与 AsyncRunner 对齐：run 的硬失败是**业务结果**（status/error 字段），
        // 不是传输错误。只有宿主层面的失败（入参不可规整、停机中）才用非 OK 状态码。
        rethrow: false,
      });
      if (abandoned(call)) return;
      callback(null, toReply(out));
    } catch (e) {
      if (abandoned(call)) return;
      callback(toServiceError(e));
    }
  },

  /** 服务端流：增量文本逐帧下发（↔ `POST /run` + SSE）。帧名与 SSE 事件一一对应。 */
  async runStream(call: grpc.ServerWritableStream<RunRequestMsg, RunChunkMsg>): Promise<void> {
    const ac = abortOnCancel(call);
    const traceparent = metadataValue(call.metadata, 'traceparent');
    const traceContext = traceparent === undefined ? undefined : parseTraceparent(traceparent);
    try {
      const out = await app.run(normalizeMessages(call.request.input), {
        ...callOptions(call.request, ac, traceContext),
        rethrow: false,
        // onText 就是 SSE 那条路径用的同一个缝：流式不是 gRPC 特例，是框架的一等能力
        onText: (delta) => {
          if (!call.cancelled) call.write({ textDelta: delta });
        },
      });
      if (call.cancelled) return;
      call.write({ end: toReply(out) }); // 末帧 = SSE 的 run.end
      call.end();
    } catch (e) {
      // 流已开：只能用状态码收口，不能再改「响应码」（同 HTTP 侧发不出 200 之后的处理）
      call.destroy(toServiceError(e));
    }
  },

  /** 异步：投任务即回 taskId（↔ `POST /tasks`）。去重键走 metadata `idempotency-key`。 */
  submit(
    call: grpc.ServerUnaryCall<RunRequestMsg, SubmitReplyMsg>,
    callback: grpc.sendUnaryData<SubmitReplyMsg>,
  ): void {
    // 停机中不接单 —— HTTP 宿主这里回 503，gRPC 对应 UNAVAILABLE
    if (runner.isDraining) {
      callback(
        Object.assign(new Error('服务正在优雅停机，不再接受新任务'), {
          code: grpc.status.UNAVAILABLE,
          details: 'draining',
          metadata: new grpc.Metadata(),
        }) as grpc.ServiceError,
      );
      return;
    }
    const traceparent = metadataValue(call.metadata, 'traceparent');
    const traceContext = traceparent === undefined ? undefined : parseTraceparent(traceparent);
    const idempotencyKey = metadataValue(call.metadata, 'idempotency-key');
    try {
      // at-least-once 去重：同一个 idempotencyKey 重复投递不会重复执行
      const rec = runner.submit(call.request.input, {
        source: 'grpc',
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        options: callOptions(call.request, new AbortController(), traceContext),
      });
      callback(null, { taskId: rec.taskId });
    } catch (e) {
      callback(toServiceError(e));
    }
  },

  /** 异步：查任务终态（↔ `GET /tasks/:id`） */
  async getTask(
    call: grpc.ServerUnaryCall<TaskQueryMsg, TaskReplyMsg>,
    callback: grpc.sendUnaryData<TaskReplyMsg>,
  ): Promise<void> {
    // ⚠️ try/catch 不是风格，是保命：grpc-js 不接管 async handler 返回的 Promise，
    // store 抛错（Redis 断连等）会成为 unhandledRejection —— Node ≥15 默认**终止进程**。
    // 同文件的 run / runStream / submit 都 catch，这里一样。
    try {
      const rec = await runner.poll(call.request.taskId);
      if (!rec) {
        callback(
          Object.assign(new Error(`没有这个 taskId：${call.request.taskId}`), {
            code: grpc.status.NOT_FOUND,
            details: 'not found',
            metadata: new grpc.Metadata(),
          }) as grpc.ServiceError,
        );
        return;
      }
      callback(null, {
        taskId: rec.taskId,
        status: rec.status,
        runId: rec.runId ?? '',
        finalText: rec.result?.finalText ?? '',
        error: rec.error?.message ?? '',
      });
    } catch (e) {
      callback(toServiceError(e));
    }
  },
};

// ── 起服务 ────────────────────────────────────────────────────────────────────

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false, // 字段名转 camelCase（与上面的消息形状一致）
  enums: String,
  defaults: true,
  oneofs: true, // RunChunk 的 oneof 需要它
});
const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
  agentia: { demo: { Agent: { service: grpc.ServiceDefinition } } };
};

const server = new grpc.Server();
server.addService(
  loaded.agentia.demo.Agent.service,
  implementation as grpc.UntypedServiceImplementation,
);

/**
 * PORT=0 表示「随便给个空闲端口」，并把**实际**端口打进就绪日志。
 * 这不是小巧思：先探一个空闲端口再交给服务去 bind，两步之间会被别的进程抢走（EADDRINUSE）。
 * 由 bindAsync 自己分配、再回报真实端口，才没有这个窗口。
 */
server.bindAsync(`127.0.0.1:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error(`[boot] 绑定失败：${err.message}`);
    process.exit(1);
  }
  // ⚠️ 这行是**就绪信号**（e2e 脚本按它判定服务可用，不靠 sleep 猜时间）—— 改文案要同步改
  //    scripts/e2e-grpc.ts 的解析。
  console.log(`[boot] listening on 127.0.0.1:${port}`);
  console.log('  Agent/Run          一元同步 run');
  console.log('  Agent/RunStream    服务端流（增量文本 + 末帧结果）');
  console.log('  Agent/Submit       异步任务（metadata idempotency-key 去重）');
  console.log('  Agent/GetTask      查任务终态');
  console.log(`  trace → ${TRACE_FILE}（agentia report / diff 可直接消费）`);
});

// ── 优雅停机（框架不订阅信号 —— 这是宿主的职责）────────────────────────────────
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return; // 第二次信号不再拦截，便于强杀
    stopping = true;
    console.log(`[${sig}] 优雅停机……`);
    void (async () => {
      // 拒新单（submit 之后会抛错 → 宿主回 UNAVAILABLE）→ 等在飞任务收尾
      const clean = await runner.drain({ timeoutMs: 15_000 });
      // 再关传输层：等已在处理的 RPC 收尾，超时则强关（未完成的任务下次启动续跑）
      const closed = await new Promise<boolean>((done) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          done(false);
        }, 5_000);
        timer.unref?.();
        server.tryShutdown(() => {
          clearTimeout(timer);
          done(true);
        });
      });
      console.log(clean && closed ? '[bye] 已排空退出' : '[bye] 超时收口，剩余任务下次启动续跑');
      process.exit(0);
    })();
  });
}
