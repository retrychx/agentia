/**
 * 崩溃恢复的**认领判定** —— 从 AsyncRunner 里抽出的第四个协作件
 * （slot-pool → approval-policy → drain-gate → 这里）。
 *
 * 为什么单独成件：这几条规则就是「同一任务被重复执行」那个 bug 的所在地。它以匿名 `filter`
 * 的形式存在时，每条规则的**边界**（自己进程的必跳、他进程刚起的别抢、无主记录立刻捡）
 * 只能靠读代码去确认，错了也不会有人告诉你 —— 只会看到副作用与花费翻倍。
 * 抽成具名函数后，「跳过原因」成为返回值的一部分，每条规则与边界都能被直接单测。
 *
 * 纯的边界：不碰 store、不改 rec、不派发 —— 只回答「这条记录我能不能抢」。
 */
import type { TaskRecord } from '../store/store.js';

/** 不该被我认领的原因（诊断用；命名本身也是文档） */
export type ResumeSkipReason =
  /** 不在 queued/running：终态没什么可续的；`awaiting_approval` 在等人，不是孤儿 */
  | 'terminal'
  /** ownerId 是本进程：它一定还活着，重派只会让同一任务跑两遍 */
  | 'own-process'
  /** 他进程刚起的记录（在 `staleAfterMs` 保鲜期内）：别抢，那边还活着 */
  | 'too-fresh';

export interface ResumeClaimOptions {
  /** 本进程标识（AsyncRunner 恒为字符串，不会是 undefined） */
  ownerId: string;
  /** >0 时启用「他进程记录保鲜期」；0 = 不看他进程的起跑时间，立刻可抢 */
  staleAfterMs: number;
  now: number;
}

/**
 * 能否认领这条记录：`undefined` = 可以，否则给出跳过原因。
 *
 * 判定顺序（与抽取前的 filter **逐字一致**，顺序本身有语义）：
 * 1. 状态不合法 → `terminal`（先判状态：终态记录即便 ownerId 是自己也不该被"续跑"）；
 * 2. `ownerId` 等于本进程 → `own-process`；
 * 3. 启用了保鲜期**且**记录有主 → 起跑时间（`startedAt` 退化到 `createdAt`）至今
 *    不足保鲜期 → `too-fresh`；边界是**严格小于**（恰好到期即可抢）。
 *
 * ⚠️ 第 3 条要求「有主」：**无主记录（ownerId === undefined）永远可抢**，不受保鲜期约束 ——
 * 否则崩溃留下的孤儿会因为"看起来太新"而永远没人捡。
 */
export function resumeSkipReason(
  rec: TaskRecord,
  opts: ResumeClaimOptions,
): ResumeSkipReason | undefined {
  if (rec.status !== 'queued' && rec.status !== 'running') return 'terminal';
  if (rec.ownerId === opts.ownerId) return 'own-process';
  if (opts.staleAfterMs > 0 && rec.ownerId !== undefined) {
    const since = rec.startedAt ?? rec.createdAt;
    if (opts.now - since < opts.staleAfterMs) return 'too-fresh';
  }
  return undefined;
}
