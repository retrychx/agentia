/**
 * dev inspector 的 trace sink：把每次 run 的 trace POST 给本地 inspector 服务。
 *
 * 归 CLI 所有（框架侧只提供 registerDefaultTraceSink 这个通用扩展点，不含 dev 逻辑）。
 * 观测失败一律静默 —— 面板没开、已关、或端口被占，都不该影响开发流程。
 */
export interface InspectSink {
  export(trace: unknown): Promise<void>;
}

export function createInspectSink(opts: {
  port: number;
  host?: string;
  /**
   * dev token（D0 的鉴权）。走**自定义头**而不是 URL：这个进程不是浏览器，
   * 没有 cookie 可用，而把 token 拼进 URL 会进日志。
   */
  token?: string;
}): InspectSink {
  const url = `http://${opts.host ?? '127.0.0.1'}:${opts.port}/ingest`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['x-agentia-token'] = opts.token;
  return {
    async export(trace: unknown): Promise<void> {
      try {
        // Node 18+ 全局 fetch；这里不做降级 —— dev 场景 Node 版本由 dev.ts 统一把关
        await fetch(url, { method: 'POST', headers, body: JSON.stringify(trace) });
      } catch {
        /* 面板未开 / 已关：静默 */
      }
    },
  };
}

/**
 * **增量**记账事件的出口（`onTraceEvent` 的落点）：逐笔 POST 给 inspector。
 *
 * 与上面那个 sink 的两点不同，都是刻意的：
 * - **不 await**：框架派发事件是同步的（它不 await 订阅者），所以这里只能 fire-and-forget。
 *   于是自己排一条 **FIFO 链**串起来 —— 每笔等上一笔的 fetch 结束再发。串行是必需的：
 *   并行 fetch 会走不同的连接，面板就可能**先收到 `span.end` 再收到 `span.begin`**
 *   （折回时那条 end 因「未知 spanId」被丢弃，树上少一个节点）。
 * - **失败静默**：与 trace sink 同款纪律（面板没开 / 已关 / 端口被占都不该影响 dev）。
 *   丢的是「此刻看到」，不是「最终能查到」—— 收尾那份整棵 trace 走的是另一条缝。
 *
 * ⚠️ 不设队列上限：事件条数由框架的 `traceLimits.maxEvents` 兜（超限停记），
 * 而且这条链的读者是本机面板（毫秒级）。真积压了，说明面板已经不可用，
 * 那正是「静默丢掉」的场景。
 */
export interface InspectEventSink {
  /** 送一笔（同步返回，内部排队；顺序与调用顺序一致） */
  send(event: unknown): void;
}

export function createInspectEventSink(opts: {
  port: number;
  host?: string;
  token?: string;
}): InspectEventSink {
  const url = `http://${opts.host ?? '127.0.0.1'}:${opts.port}/ingest-event`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['x-agentia-token'] = opts.token;
  let chain: Promise<void> = Promise.resolve();
  return {
    send(event: unknown): void {
      chain = chain.then(async () => {
        try {
          await fetch(url, { method: 'POST', headers, body: JSON.stringify(event) });
        } catch {
          /* 面板未开 / 已关 / 连接被拒：静默（观测失败不击穿 dev） */
        }
      });
    },
  };
}
