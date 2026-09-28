/**
 * Agentia —— 认领者标识（`TaskRecord.ownerId`）的**格式真源**（2026-09-28）。
 *
 * 形状：`p<pid>@<host>-<8 位十六进制>`。为什么要带主机名 —— 崩溃恢复那句
 * 「这条记录的主人还活着吗」**不能只看时间**：`staleAfterMs` 是新鲜度（记录起跑多久了），
 * 不是租约（主人是否还在心跳）。两个方向都会判错：
 * - 单段 run 跑超 `staleAfterMs` ⇒ 他进程当孤儿抢走 ⇒ **同一任务跑两遍**；
 * - **崩溃进程**留下的记录仍然带 ownerId（`submit` 恒写）⇒ 落在保鲜期内没人捡 ⇒ 饿死。
 *
 * 带上主机名与 pid 之后：**同主机**可以直接问操作系统（`process.kill(pid, 0)`），
 * 比时间猜准；**异主机**（或升级前写下的旧格式记录）判不了，退回新鲜度启发式 ——
 * 判定分级在 `resume-policy.ts` 的 `ownerAlive` 上，这里只负责「写」与「读回」。
 *
 * 兼容：旧格式 `p<pid>-<8 位十六进制>`（没有 `@host`）解析出来 `host === undefined`，
 * 判定侧按「判不了」处理 ≡ 升级前行为；解析不出来的串（如测试里的 `'p999-otherproc'`）
 * 返回 `undefined`，同样走新鲜度。
 *
 * 纯件：只用 `node:os` 的另一个函数取值由调用方传入（`formatOwnerId` 不自己取主机名）——
 * 判定的可测性靠这个缝，别把它焊死。
 */

export interface ParsedOwnerId {
  readonly pid: number;
  /** `undefined` = 旧格式（无主机名）⇒ 「同主机吗」无从判断 */
  readonly host: string | undefined;
}

/**
 * 切分点靠**锚定结尾的定长后缀**唯一确定：`-` 之后正好 8 位十六进制收在串尾，所以主机名里
 * 带 `-`（`my-host-1`，常态）不会被误切进后缀。
 *
 * `(.+?)` 写成惰性而非贪婪只是把意图写在脸上 —— **实测两种写法在 28 组夹具上结果完全一致**
 * （见 tests/transport/owner-id.test.ts 的说明）：撑住这条的是 `$` 与 `{8}`，不是惰性。
 * 去掉 `$`、或把 `{8}` 放宽成 `{1,8}`，那两条用例就会红。
 */
const OWNER_ID_RE = /^p(\d+)(?:@(.+?))?-([0-9a-f]{8})$/;

/** 拼一个 ownerId（`suffix` 由调用方给随机串；本函数不引 `node:crypto`，保持纯） */
export function formatOwnerId(pid: number, host: string, suffix: string): string {
  return `p${pid}@${host}-${suffix}`;
}

/** 解析 ownerId；形状不认识 ⇒ `undefined`（判定侧据此退回新鲜度启发式） */
export function parseOwnerId(ownerId: string): ParsedOwnerId | undefined {
  const m = OWNER_ID_RE.exec(ownerId);
  if (m === null) return undefined;
  const pid = Number(m[1]);
  // isSafeInteger 而不是 isInteger：`p<超长数字>-…` 会解析成 1e21 / Infinity 这种「整数」，
  // 放过去就等于把垃圾当 pid 递给探针。不是安全整数 ⇒ 形状不成立。
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, host: m[2] };
}
