# Phase A（成本与稳定性）实现计划

> **状态**：已评审，执行中。分叉全按设计文档 §7 的建议 A 拍板。
> **日期**：2026-09-11
> **上游**：`docs/plans/2026-09-11-agent-service-hardening.md` §3

**Goal**：让框架能**叫停在飞的 run**、**对可重试失败自动重试**、**把模型输出流式下发给客户端**。

**Architecture**：`signal` 作为可选参数从入口（HTTP / AsyncRunner / app.run）一路贯穿到 `ModelClient.messages.stream`；重试在 `agentLoop` 内建（消费既有的 `classifyError.retryable`）；SSE 在 `transport/http.ts` 做内容协商，复用已有的 `onText`。全部零新增依赖。

**非目标**：异步任务的流式（`GET /tasks/:id/stream`，需 run 内事件跨进程）、SSE 的单元级事件（`unit.start/end`）、工具的真中断（无 signal 给工具就无法回滚副作用）。

**验证**：`npm run typecheck && npm run build && npm run typecheck:types && npm run typecheck:tests && npm run build:cli && npm test && npm run e2e && npm run build:website` 全绿。

---

## A1 取消传播（AbortSignal）

### A1.1 新增 `src/core/abort.ts`
**File**: Create `src/core/abort.ts`；Test `tests/core/abort.test.ts`

零依赖合成多个 signal（Node 18 无 `AbortSignal.any`，手写）：

```ts
/** 合成多个中断源（任一触发即中止）；忽略 undefined；空集返回永不中止的 signal。 */
export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal
```

- 测试：单源中止 → 合成中止；已中止的源 → 立即中止；全 undefined → 不中止；多源任一中止。
- 命令：`node --import tsx --test tests/core/abort.test.ts`，期望全过。

### A1.2 `src/core/tool.ts` 结构面加 signal
- `ModelClient.messages.stream` 的 params 加 `signal?: AbortSignal;`（注释说明:SDK 天然支持，实现须转发）。
- `ToolRunContext` 加 `signal?: AbortSignal;`（工具自行决定是否尊重；框架不强制中断）。

### A1.3 `src/engine/types.ts`
- `AgentStopReason` 加 `'aborted'`（注释：调用方主动取消）。
- `RunAgentOptions` 加 `signal?: AbortSignal;`。

### A1.4 `src/engine/errors.ts` 认 AbortError
- `classifyError` 最前面加：`if (isAbortError(e)) return { type: 'aborted', message: 'run 已被取消', retryable: false };`
- 新增导出 `isAbortError(e): boolean`（`e` 的 `name === 'AbortError'`，兼容 DOMException 与普通 Error）。
- Test `tests/engine/errors.test.ts` 增一例。

### A1.5 `src/engine/loop.ts`：传递 + 以 `aborted` 收尾（**不 throw**）
- `agentLoop` 每回合开始前：`if (signal?.aborted) { stopReason='aborted'; error={...}; finished=true; break; }`
- `client.messages.stream({... , signal})`。
- `catch (e)`：`recorder.end(turnId, {status:'error', error: classifyError(e)})`；若 `isAbortError(e) || signal?.aborted` → 置 `stopReason='aborted'`、`error`、`finished=true`、`break`（**不再 throw**，让 run 以确定方式收尾）；否则 `throw e`。
- Test `tests/engine/loop.test.ts`：预中止的 signal → `stopReason==='aborted'`、`run.status==='failed'`；回合中途 abort（mock 的 `finalMessage` 抛 AbortError）→ 同断言。

### A1.6 `src/runtime/spec.ts`
- `RunInvocationOptions` 加 `signal?: AbortSignal;`（注释：调用方中断源，透传到模型请求）。

### A1.7 `src/runtime/run.ts`
- `executeRun` 把 `signal` 传进 `runAgent`（若未显式传则透传 `options.signal`）。
- Test `tests/runtime/run.test.ts` 增一例：abort 后 run 为 failed/aborted。

### A1.8 `src/transport/async.ts`：`runTimeoutMs` 从「放弃等待」升级为「真中止」
- `#execute` 里：`const ac = new AbortController();` 与 `rec.spec.options?.signal` 用 `combineSignals` 合成，塞进 `callOpts.signal`。
- `#raceTimeout(p, taskId, signal)`：超时分支里**先 `ac.abort()`** 再 reject；`signal` 由 `#execute` 建并在超时时 abort。
- 注释改写：从「只是放弃等待」改为「对尊重 signal 的模型客户端是真中止；不尊重者仍等价于放弃等待」。
- Test `tests/transport/async.test.ts`：runTimeoutMs=20 + 慢 app → 任务 failed，且 app 收到的 signal 被 abort。

### A1.9 `src/transport/http.ts`：客户端断开 → abort
- `POST /run`：`const ac = new AbortController();`、`res.once('close', () => { if (!res.writableEnded) ac.abort(); })`，`app.run(messages, { rethrow:false, signal: ac.signal })`。
- Test `tests/transport/http.test.ts`：请求被销毁 → run 记录为 aborted（可用 fake app 记录收到的 signal 状态）。

---

## A2 重试与退避

### A2.1 新增 `src/engine/retry.ts`
**File**: Create `src/engine/retry.ts`；Test `tests/engine/retry.test.ts`

```ts
export interface RetryOptions {
  maxAttempts?: number;   // 含首次；缺省 3；1 = 关闭
  baseDelayMs?: number;   // 缺省 500
  maxDelayMs?: number;    // 缺省 8000
  jitter?: number;        // 0~1；缺省 0.2
  isRetryable?: (err: unknown) => boolean;   // 缺省 classifyError(e).retryable
  onRetry?: (info: { attempt: number; delayMs: number; error: SpanError }) => void;
}
export const DEFAULT_RETRY: Required<Omit<RetryOptions, 'onRetry' | 'isRetryable'>>;
export function resolveRetry(o: RetryOptions | false | undefined): Required<RetryOptions> | null;
export function backoffDelay(attempt: number, r: Required<RetryOptions>): number;  // 指数 + 上限 + 抖动
export function sleep(ms: number, signal?: AbortSignal): Promise<void>;            // 可中断
```

- `backoffDelay` 测试：1→base、2→2×base、封顶 maxDelayMs、抖动在 ±jitter 内（注入固定随机源或断言区间）。

### A2.2 选项贯通
- `RunAgentOptions.retry?: RetryOptions | false`；`AppOptions.retry?`（应用级缺省）；`RunInvocationOptions.retry?`（单次覆盖）。

### A2.3 `src/engine/loop.ts`：回合级重试
- 把「`begin('llm.turn')` → stream → `finalMessage`」包进重试循环：
  - **每次尝试开一个 `llm.turn` span**；`attempt > 1` 时 `setAttribute(turnId, 'retry.attempt', attempt)`。
  - 失败时 `recorder.end(turnId, {status:'error', error})`；可重试则 `recorder.event(turnId, 'llm.retry', {attempt, delayMs, error: type})` + `onRetry` + `await sleep(delay, signal)` + 继续。
  - **可重试条件（全部满足）**：未 abort、配置允许、`attempt < maxAttempts`、`isRetryable(e)`、**本次尝试未产出任何文本**（`onText` 未被调用）。
  - 不可重试 → `throw e`（保持既有语义）。
  - 成功 → 退出循环，`turnId` 供后续 tool 事件/usage 使用。
- 关键：`onText` 改经「标记已产出」的包装器再转发，避免重试造成重复文本。

### A2.4 测试 `tests/engine/loop.test.ts`
- 第 1 次 429、第 2 次成功 → `succeeded`；trace 里两个 `llm.turn`（1 error 1 ok）；`onRetry` 调用一次。
- 已产出文本后失败 → **不重试**（`onRetry` 未被调）。
- `retry: false` → 不重试。

---

## A3 SSE 流式下发

### A3.1 新增 `src/transport/sse.ts`
**File**: Create `src/transport/sse.ts`；Test `tests/transport/sse.test.ts`

```ts
export interface SseWriter { event(name: string, data: unknown): void; comment(text: string): void; close(): void; }
export function sseWriter(res: ServerResponse): SseWriter;   // 写头 text/event-stream + 帧
```
- 测试：假 `res`（记录 writeHead/write/end）断言头与帧格式（`event: x\ndata: {...}\n\n`）。

### A3.2 `src/transport/http.ts`：内容协商
- `POST /run`：若 `String(req.headers.accept).includes('text/event-stream')` → SSE 路径：
  - 先做既有的解析/闸门（**流开前的错误仍走普通 HTTP 状态码**）；
  - `const sse = sseWriter(res)`；`sse.event('run.start', { runId: '(pending)' })`… 注意 runId 在 run 结束才知道 → 改由 `run.end` 携带完整 `RunHttpResponse`；`run.start` 只发 `{}` 或省略。
  - `app.run(messages, { rethrow:false, signal, onText: (d) => sse.event('text.delta', { text: d }) })`
  - 结束 → `sse.event('run.end', body)` + `sse.close()`；流开之后出错 → `sse.event('error', { message })`。
  - 心跳 `setInterval(() => sse.comment('ping'), 15000).unref()`，收尾 clear。
  - `res.once('close', ...)` → abort（同 A1.9）。
- **不带 Accept 的请求逐字保持现状**（向后兼容）。

### A3.3 测试 `tests/transport/http.test.ts`
- 起真 `http.createServer(createHttpHandler(app))`，`fetch` 带 `Accept: text/event-stream` 读流：断言至少 2 帧 `text.delta` 且最后一帧是 `run.end`。
- 不带 Accept → 仍回 JSON（回归保护）。

---

## 收尾（必须）
1. `docs/spec.md §10` 追加本轮决策记录（**含行为变更**：`runTimeoutMs` 由「放弃等待」变「真中止」；重试缺省开启；新增 `AgentStopReason: 'aborted'`；新增 `RunInvocationOptions.signal`）。
2. `docs/usage-guide.md §7` 更新「模型调用不可中断」那条边界（改为：尊重 signal 的客户端可被中止）。
3. `docs/roadmap.md` R7 候选同步（本计划完成后 Phase A 移出候选/标记已落地）。
4. `src/index.ts` 导出新公开面：`combineSignals`、`isAbortError`、`RetryOptions`、`DEFAULT_RETRY`。
5. 全链验证 + 官网重建（`usage-guide` 派生 → `llms.txt`/`llms-full.txt`）+ 部署 + 线上回读。
