import type { AppCallable } from './async.js';
import type { RunInvocationOptions } from './spec.js';
import { normalizeMessages } from './spec.js';

/**
 * Agentia —— 同步 RPC 传输（spec §6.3 同步请求 / §6.6 v1 边界）。
 * 纯适配层：把「任意任务入参 → messages」接 app.run。宿主（HTTP 路由 /
 * AWS Lambda / RPC handler）直接调用返回的 handler，或 runSync。
 * 同一入参形态与 AsyncRunner.submit 一致 —— 触发三类共用一份契约。
 */

/** 一次同步 run：规范化入参后立即执行并等待终态。 */
export function runSync(
  app: AppCallable,
  input: unknown,
  opts?: RunInvocationOptions,
): ReturnType<AppCallable['run']> {
  return app.run(normalizeMessages(input), opts);
}

/** 生成 (input, opts?) → run 结果的同步 handler。 */
export function createSyncHandler(
  app: AppCallable,
): (input: unknown, opts?: RunInvocationOptions) => ReturnType<AppCallable['run']> {
  return (input, opts) => runSync(app, input, opts);
}
