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
 */
export interface SseWriter {
  /** 写一个事件帧（data 走 JSON.stringify） */
  event(name: string, data: unknown): void;
  /** 写一个注释帧（心跳） */
  comment(text: string): void;
  /** 结束响应；之后再 event/comment 都是 no-op */
  close(): void;
  /** 响应是否已关闭 */
  readonly closed: boolean;
}

export function sseWriter(res: ServerResponse): SseWriter {
  let closed = false;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 关掉 nginx 一类反代的响应缓冲（否则事件被攒着一起发，流式就没意义了）
    'x-accel-buffering': 'no',
  });
  return {
    get closed(): boolean {
      return closed;
    },
    event(name: string, data: unknown): void {
      if (closed) return;
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string): void {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    close(): void {
      if (closed) return;
      closed = true;
      res.end();
    },
  };
}
