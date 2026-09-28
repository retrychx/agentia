/**
 * 崩溃恢复的**认领判定** —— 从 AsyncRunner 里抽出的第四个协作件
 * （slot-pool → approval-policy → drain-gate → 这里）。
 *
 * 为什么单独成件：这几条规则就是「同一任务被重复执行」那个 bug 的所在地。它以匿名 `filter`
 * 的形式存在时，每条规则的**边界**（自己进程的必跳、他进程刚起的别抢、无主记录立刻捡）
 * 只能靠读代码去确认，错了也不会有人告诉你 —— 只会看到副作用与花费翻倍。
 * 抽成具名函数后，「跳过原因」成为返回值的一部分，每条规则与边界都能被直接单测。
 *
 * 2026-09-28 补了一档更硬的判据：**「主人还活着吗」**（`ownerAlive` ⇒ `owner-alive`）。
 * 在此之前只有「新鲜度」一条启发式（`too-fresh`），它的两个方向都会出错（长跑被抢 /
 * 崩溃孤儿饿死，见 `owner-alive` 的说明）。判定分级：能问到 pid 就信 pid，问不到才退回时间。
 *
 * 纯的边界：不碰 store、不改 rec、不派发 —— 只回答「这条记录我能不能抢」。
 */
import type { TaskRecord } from '../store/store.js';

/** 不该被我认领的原因（诊断用；命名本身也是文档） */
export type ResumeSkipReason =
  /** 不在 queued/running（也不是挂起）：终态没什么可续的 */
  | 'terminal'
  /**
   * 挂起（`suspended`）：**不是孤儿** —— 它由各自那条闸唤醒（`approval` 等决定、
   * `timer` 等到点），崩溃续跑语义不适用于「在等」。单列一档而不是并进 `terminal`：
   * 一条在睡的 run 被具名成「终态」是**静默说错话**（2026-09-27 调研 §1 事实 4 点的
   * 就是这一处），而这个字段的全部用途就是诊断 —— 说错等于没有。
   */
  | 'suspended'
  /** ownerId 是本进程：它一定还活着，重派只会让同一任务跑两遍 */
  | 'own-process'
  /**
   * **同主机、且那个 pid 还活着**（2026-09-28 加）：比 `too-fresh` 准一个量级 ——
   * 它是「主人在」的**直接证据**，不是「记录看起来还新」的推测。长跑的 run 因此不再
   * 因为「起跑很久了」被当孤儿抢走（那是真·重复执行）。
   */
  | 'owner-alive'
  /**
   * 他进程刚起的记录（在 `staleAfterMs` 保鲜期内）：别抢，那边还活着。
   * ⚠️ 这是**判不了「主人在不在」时**的兜底 —— 异主机、或升级前写下的旧格式 ownerId。
   * 同主机能直接问 pid（见 `owner-alive`），那时这条不参与。
   */
  | 'too-fresh';

export interface ResumeClaimOptions {
  /** 本进程标识（AsyncRunner 恒为字符串，不会是 undefined） */
  ownerId: string;
  /** >0 时启用「他进程记录」的判定；0 = 完全不看他进程，立刻可抢（单进程旧语义） */
  staleAfterMs: number;
  now: number;
  /**
   * 「这条记录的主人还活着吗」—— `true` = 活着、`false` = 死了、`undefined` = **判不了**。
   *
   * 注入而不是在这里直接 `process.kill`：① 本文件要保住**纯**（不碰进程、不碰 store，
   * 边界才能被穷尽单测）；② 判定依赖主机名与 pid 语义，那是 transport 的现场知识
   * （`owner-id.ts` 负责格式，`AsyncRunner` 负责问操作系统），策略只消费结论。
   *
   * 只在 `staleAfterMs > 0` 时被调用（缺省 0 = 不看他进程，与升级前逐字一致）。
   */
  ownerAlive?: (ownerId: string) => boolean | undefined;
}

/**
 * 能否认领这条记录：`undefined` = 可以，否则给出跳过原因。
 *
 * 判定顺序（顺序本身有语义）：
 * 1. 挂起 → `suspended`（先摘出来：它不是终态、也不是我的活 —— 唤醒是各自的闸的事）；
 * 2. 状态不合法 → `terminal`（先判状态：终态记录即便 ownerId 是自己也不该被"续跑"）；
 * 3. `ownerId` 等于本进程 → `own-process`；
 * 4. 启用了他进程判定（`staleAfterMs > 0`）**且**记录有主：
 *    - `ownerAlive(ownerId) === true` → `owner-alive`（**无论记录多老都不抢**）；
 *    - `=== false`（同主机但进程没了 = 崩溃孤儿）→ **立刻可抢**（不再被保鲜期挡住）；
 *    - `undefined`（异主机 / 旧格式 ownerId）→ 退回下面那条新鲜度启发式。
 * 5. 新鲜度：起跑时间（`startedAt` 退化到 `createdAt`）距今不足保鲜期 → `too-fresh`；
 *    边界是**严格小于**（恰好到期即可抢）。
 *
 * ⚠️ 第 4/5 条要求「有主」：**无主记录（ownerId === undefined）永远可抢**，不受保鲜期约束。
 * 注意这句话的**保护范围有限** —— `AsyncRunner.submit` 恒写 ownerId（`p<pid>@<host>-<rand>`），
 * 所以「崩溃留下的记录」通常**有** ownerId，能不能捡靠的是第 4 条那个 pid 存活判定
 * （2026-09-28 之前只有第 5 条 ⇒ 崩溃孤儿在保鲜期内会饿死，见 `owner-alive`）。
 */
export function resumeSkipReason(
  rec: TaskRecord,
  opts: ResumeClaimOptions,
): ResumeSkipReason | undefined {
  if (rec.status === 'suspended') return 'suspended';
  if (rec.status !== 'queued' && rec.status !== 'running') return 'terminal';
  if (rec.ownerId === opts.ownerId) return 'own-process';
  if (opts.staleAfterMs > 0 && rec.ownerId !== undefined) {
    const alive = opts.ownerAlive?.(rec.ownerId);
    if (alive === true) return 'owner-alive';
    if (alive === undefined) {
      const since = rec.startedAt ?? rec.createdAt;
      if (opts.now - since < opts.staleAfterMs) return 'too-fresh';
    }
    // alive === false：同主机、进程已不在 ⇒ 崩溃孤儿，直接可抢（不参与新鲜度）
  }
  return undefined;
}
