import type { ServerResponse } from 'node:http';

/**
 * Agentia —— SSE（Server-Sent Events）写出器（零依赖）。
 *
 * 帧格式：`event: <name>\ndata: <json>\n\n`；注释帧 `: <text>\n\n` 用作心跳
 * （长时间无数据时中间代理会掐连接）。
 *
 * 语义约束（调用方必须知道）：**一旦写出响应头，HTTP 状态码就定了**（200）。
 * 之后的错误只能以 `error` 事件表达，不能再改成 4xx/5xx —— 所以流开之前的
 * 校验（方法 / 并发闸门 / body 解析）必须先做，那些用普通 HTTP 状态码回。
 *
 * **背压**：`res.write()` 在 socket 发送缓冲写满时返回 `false`，此时 Node 仍会把
 * 后续数据留在内存里排队 —— 一个「连得上但不读」的客户端能凭一条 SSE 连接把宿主
 * 内存吃光（逐 token 下发时尤其快）。所以这里盯着 `res.writableLength`，超过
 * `maxBufferedBytes` 即收口：不再无限缓冲，并回调 `onBackpressure`（宿主据此中止
 * 对应 run，别继续为空耗 token）。做的是**有界缓冲 + 超限收口**，不是静默丢帧 ——
 * 丢帧会让客户端拿到看起来正常、实则残缺的输出。
 */
export interface SseWriter {
  /** 写一个事件帧（data 走 JSON.stringify）；已关闭或积压超限时为 no-op */
  event(name: string, data: unknown): void;
  /** 写一个注释帧（心跳） */
  comment(text: string): void;
  /** 结束响应；之后再 event/comment 都是 no-op */
  close(): void;
  /** 响应是否已关闭 */
  readonly closed: boolean;
}

export interface SseWriterOptions {
  /**
   * 下游积压上限（字节），按 `res.writableLength` 计；缺省 8 MiB。
   * 正常客户端远达不到，实际只拦「连上但不读」的病态消费者。
   */
  maxBufferedBytes?: number;
  /** 因积压超限而收口时回调（收口**先于**回调发生，回调抛错不影响收口） */
  onBackpressure?: (info: { bufferedBytes: number; limitBytes: number }) => void;
}

/** 缺省积压上限：8 MiB —— 一条 8 MiB 都没被读走的流，已经不是「慢」而是「断了」 */
export const SSE_DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export function sseWriter(res: ServerResponse, opts: SseWriterOptions = {}): SseWriter {
  const limitBytes = opts.maxBufferedBytes ?? SSE_DEFAULT_MAX_BUFFERED_BYTES;
  let closed = false;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 关掉 nginx 一类反代的响应缓冲（否则事件被攒着一起发，流式就没意义了）
    'x-accel-buffering': 'no',
  });

  /** 未落盘字节数；假 res（测试替身）没有该属性时按 0 处理 */
  const buffered = (): number => (typeof res.writableLength === 'number' ? res.writableLength : 0);

  const emit = (frame: string): void => {
    if (closed) return;
    const pending = buffered();
    if (pending > limitBytes) {
      // 下游消费不动：先收口，再通知（通知抛错也不改变「已收口」这个事实）
      closed = true;
      try {
        opts.onBackpressure?.({ bufferedBytes: pending, limitBytes });
      } catch {
        /* 通知是副作用，不该把收口变崩溃 */
      }
      res.end();
      return;
    }
    res.write(frame);
  };

  return {
    get closed(): boolean {
      return closed;
    },
    event(name: string, data: unknown): void {
      emit(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string): void {
      emit(`: ${text}\n\n`);
    },
    close(): void {
      if (closed) return;
      closed = true;
      res.end();
    },
  };
}
