/**
 * dev inspector 的 trace sink：把每次 run 的 trace POST 给本地 inspector 服务。
 *
 * 归 CLI 所有（框架侧只提供 registerDefaultTraceSink 这个通用扩展点，不含 dev 逻辑）。
 * 观测失败一律静默 —— 面板没开、已关、或端口被占，都不该影响开发流程。
 */
export interface InspectSink {
  export(trace: unknown): Promise<void>;
}

export function createInspectSink(opts: { port: number; host?: string }): InspectSink {
  const url = `http://${opts.host ?? '127.0.0.1'}:${opts.port}/ingest`;
  return {
    async export(trace: unknown): Promise<void> {
      try {
        // Node 18+ 全局 fetch；这里不做降级 —— dev 场景 Node 版本由 dev.ts 统一把关
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(trace),
        });
      } catch {
        /* 面板未开 / 已关：静默 */
      }
    },
  };
}
