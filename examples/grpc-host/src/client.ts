/**
 * 示例的 gRPC 客户端。
 *
 * 存在两个理由：
 *   ① `npm run client` 能手动跑一遍（README 里的演示）；
 *   ② `scripts/e2e-grpc.ts` **import 这一份**来验证 —— 客户端与验证用同一份代码，
 *      不会出现「验证的是另一套写法」这种自欺。
 *
 * 它只做客户端该做的事：拼 metadata（traceparent / idempotency-key）、给 deadline、
 * 把回调包成 Promise。服务端语义（谁去 abort、trace 记什么）一律不在这边。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export interface RunReply {
  runId: string;
  status: string;
  stopReason: string;
  finalText: string;
  spans: number;
  inputTokens: number;
  outputTokens: number;
  error: string;
}
export interface TaskReply {
  taskId: string;
  status: string;
  runId: string;
  finalText: string;
  error: string;
}
export interface CallOptions {
  /** 客户端 deadline（毫秒）。到期服务端会 abort 掉在飞的 run —— 见 main.ts 的 abortOnCancel */
  deadlineMs?: number;
  /** W3C traceparent：会被服务端记成 run 根的一条 link（跨进程关联） */
  traceparent?: string;
  /** 异步去重键（at-least-once 语义：重复投递不重复执行） */
  idempotencyKey?: string;
  /** 会话标识：同一会话的多轮 run 共享历史 */
  sessionId?: string;
}
export interface GrpcAgentClient {
  run(input: string, opts?: CallOptions): Promise<RunReply>;
  /** 返回收到的增量帧与末帧（末帧即整份结果，对应 SSE 的 run.end） */
  runStream(input: string, opts?: CallOptions): Promise<{ deltas: string[]; end?: RunReply }>;
  submit(input: string, opts?: CallOptions): Promise<string>;
  getTask(taskId: string): Promise<TaskReply>;
  close(): void;
}

/** proto-loader 生成的客户端是运行时的，编译期这一份自己声明（比 `any` 诚实） */
interface RawAgentClient extends grpc.Client {
  run(
    req: { input: string; sessionId: string; maxIterations: number; maxTotalTokens: number },
    md: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: RunReply) => void,
  ): grpc.ClientUnaryCall;
  runStream(
    req: { input: string; sessionId: string; maxIterations: number; maxTotalTokens: number },
    md: grpc.Metadata,
    opts: grpc.CallOptions,
  ): grpc.ClientReadableStream<{ textDelta?: string; end?: RunReply }>;
  submit(
    req: { input: string; sessionId: string; maxIterations: number; maxTotalTokens: number },
    md: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: { taskId: string }) => void,
  ): grpc.ClientUnaryCall;
  getTask(
    req: { taskId: string },
    md: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: TaskReply) => void,
  ): grpc.ClientUnaryCall;
}

// 用 fileURLToPath 而不是 URL.pathname：后者在 Windows 上会带出 `/C:/…` 这种前缀
const PROTO_PATH = fileURLToPath(new URL('../proto/agent.proto', import.meta.url));

export function makeGrpcClient(address: string): GrpcAgentClient {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    agentia: { demo: { Agent: new (a: string, c: grpc.ChannelCredentials) => grpc.Client } };
  };
  const client = new loaded.agentia.demo.Agent(
    address,
    grpc.credentials.createInsecure(),
  ) as unknown as RawAgentClient;

  /** 请求体：proto 里只有 input 是必填语义，其余留空即「用框架缺省」 */
  const req = (input: string, opts?: CallOptions) => ({
    input,
    sessionId: opts?.sessionId ?? '',
    maxIterations: 0,
    maxTotalTokens: 0,
  });
  const metadata = (opts?: CallOptions): grpc.Metadata => {
    const md = new grpc.Metadata();
    if (opts?.traceparent !== undefined) md.set('traceparent', opts.traceparent);
    if (opts?.idempotencyKey !== undefined) md.set('idempotency-key', opts.idempotencyKey);
    return md;
  };
  /** 不传 deadlineMs 就不设 deadline（交回 grpc-js 的缺省：无上限） */
  const callOpts = (opts?: CallOptions): grpc.CallOptions =>
    opts?.deadlineMs !== undefined ? { deadline: new Date(Date.now() + opts.deadlineMs) } : {};

  return {
    run: (input, opts) =>
      new Promise((resolve, reject) => {
        client.run(req(input, opts), metadata(opts), callOpts(opts), (err, res) =>
          err ? reject(err) : resolve(res),
        );
      }),

    runStream: (input, opts) =>
      new Promise((resolve, reject) => {
        const deltas: string[] = [];
        let end: RunReply | undefined;
        const stream = client.runStream(req(input, opts), metadata(opts), callOpts(opts));
        stream.on('data', (chunk) => {
          if (chunk.textDelta !== undefined) deltas.push(chunk.textDelta);
          if (chunk.end !== undefined) end = chunk.end;
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(end !== undefined ? { deltas, end } : { deltas }));
      }),

    submit: (input, opts) =>
      new Promise((resolve, reject) => {
        client.submit(req(input, opts), metadata(opts), callOpts(opts), (err, res) =>
          err ? reject(err) : resolve(res.taskId),
        );
      }),

    getTask: (taskId) =>
      new Promise((resolve, reject) => {
        client.getTask({ taskId }, new grpc.Metadata(), {}, (err, res) =>
          err ? reject(err) : resolve(res),
        );
      }),

    close: () => client.close(),
  };
}

/** `npm run client` 走这里：手动演示四个 RPC（README 的执行版） */
async function main(): Promise<void> {
  const address = process.argv[2] ?? '127.0.0.1:50051';
  const client = makeGrpcClient(address);
  const line = (s: string): void => console.log(s);

  line(`→ 连 ${address}`);
  const unary = await client.run('回显 ping', {
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  });
  line(`[Run] status=${unary.status} stopReason=${unary.stopReason} spans=${unary.spans}`);
  line(`[Run] finalText=${JSON.stringify(unary.finalText)}`);
  line(`[Run] runId=${unary.runId}（== traceId）tokens=${unary.inputTokens}/${unary.outputTokens}`);

  const streamed = await client.runStream('回显 ping');
  line(`[RunStream] ${streamed.deltas.length} 个增量帧，末帧 status=${streamed.end?.status}`);

  const taskId = await client.submit('回显 ping', { idempotencyKey: 'client-demo-1' });
  const again = await client.submit('回显 ping', { idempotencyKey: 'client-demo-1' });
  line(`[Submit] taskId=${taskId}；同 key 重投 = ${again}（at-least-once 去重）`);

  for (;;) {
    const rec = await client.getTask(taskId);
    if (rec.status !== 'queued' && rec.status !== 'running') {
      line(`[GetTask] status=${rec.status} finalText=${JSON.stringify(rec.finalText)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  client.close();
}

// 只在被直接执行时跑（被 e2e import 时不跑）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
