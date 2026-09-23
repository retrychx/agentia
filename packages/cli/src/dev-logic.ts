/**
 * dev 环（server 侧）的**纯判定** —— 从 `dev.ts` 那台隐式状态机里抽出的「规则」部分。
 * 为什么不进 `panel-logic.ts`：那是**下发浏览器**的模块（STATIC 白名单、W2/W3 守卫），
 * server 侧纯件进去会随产物下发。这里只有判定、没有状态 ——「谁在什么时候调用它」仍由
 * `dev.ts` 的闭包决定（那是方案 B 的事，见 docs/plans/2026-09-23-cli-structure.md）。
 * 判据单源化的理由：F1 / G1 都是「同一判据两处各写一份、改一处漏一处」的产物。
 */

/** 受理新 run 的闸（`submitRun` 的 409）。必须**同时**看 `launching`：受理到 run 发出
 *  之间有一次 `await restart`，只判 `running` 会放两个请求进来（F1）。判据只此一份。 */
export function canAcceptRun(state: { running: boolean; launching: boolean }): boolean {
  return !state.running && !state.launching;
}

/** 文件变更该不该延后到 run 收尾（`onFileChange`：true ⇒ 记 `pendingRestart`）。
 *  与受理闸**同一条**忙闲判据 —— 刻意委托、不复制条件（两处各写就会漂，F1）。 */
export function shouldDeferRestart(state: { running: boolean; launching: boolean }): boolean {
  return !canAcceptRun(state);
}

/** 子进程退出的原因文案（G1 的落点）：判据是「跟 spawn 那一刻比，这一代有没有写出
 *  新原因」（`lastError !== errBaseline`），**不是** `lastError ?? generic` —— lastError
 *  全程没有清零点（告警条靠它长存），`??` 会把上一代留下的旧错误当成这一代退出的原因
 *  （归因误导）。`generic` 由调用方给：「没等到 ready 就退」与「意外退出」文案不同。 */
export function exitReason(args: {
  lastError: string | null;
  errBaseline: string | null;
  generic: string;
}): string {
  const { lastError, errBaseline, generic } = args;
  return lastError !== null && lastError !== errBaseline ? lastError : generic;
}

export type AbortDecision = 'idempotent' | 'send';

/** 「中止」的幂等判定（`abortRun`）：升级计时器在 ⇒ 中止已发出，再点一次**不该**挂
 *  第二个计时器（两个计时器到点会触发两次 restart，第二次打在刚重启好的 runner 上）。 */
export function abortDecision(args: { hasTimer: boolean }): AbortDecision {
  return args.hasTimer ? 'idempotent' : 'send';
}

/** 能力选择变没变（变了要重启进程 —— D8：进程边界是孤儿 MCP 子进程的唯一回收口）。
 *  形状约定：`prev` 的 `null` = 全量、`next` 的 `undefined` = 全量（`normalizeToolSources`
 *  的手笔），两者不交叉配对。比较用 `join('\u0000')` 而非 `join()`：缺省分隔符是逗号，
 *  来源名里若出现逗号会让 `['a,b']` 与 `['a','b']` 撞成同一串。顺序归一是上游的活。 */
export function sameToolSources(prev: string[] | null, next: string[] | undefined): boolean {
  if (prev === null) return next === undefined;
  if (next === undefined) return false;
  return prev.join('\u0000') === next.join('\u0000');
}

export type PickGate = 'accept' | 'reject';

/** 原生文件夹选择框的串行化（`pickFolder`）：同时只许一个在飞 —— 弹两个系统对话框
 *  叠在一起，用户分不清哪个在回应谁，第二个请求 409。 */
export function pickGate(args: { inFlight: boolean }): PickGate {
  return args.inFlight ? 'reject' : 'accept';
}
