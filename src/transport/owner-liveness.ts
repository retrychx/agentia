/**
 * Agentia —— 「这条记录的主人还在吗」的判定（2026-09-28）。
 *
 * 为什么单独成件：`resume-policy.ts` 是**纯**策略（不碰进程、不碰 store），而这个问题
 * 必须问操作系统。两者之间的缝就是这个文件：做成「ownerId + 本机主机名 ⇒ 活着 / 不在 /
 * 判不了」的判定，探针可注入 ⇒ 三种结论的边界都能被穷尽单测，策略侧只消费结论。
 *
 * **三态而不是布尔**：「判不了」必须与「不在」分开。判不了的三种来源：
 * - **异主机**：pid 是各机器自己的命名空间，本机问不到别人家的 pid；
 * - **旧格式 ownerId**（升级前写下的 `p<pid>-<rand>`，没有 `@host`）：不知道是哪台机器写的；
 * - **形状不认识的串**（宿主自定的标识、测试夹具）：更不知道。
 * 三者一律 `undefined` ⇒ 策略侧退回新鲜度启发式 ≡ 升级前行为（不清楚就不乱抢）。
 *
 * 探针语义（`process.kill(pid, 0)`；实测记录见 `tests/transport/owner-liveness.test.ts`）：
 * - 进程在 ⇒ 正常返回；**`EPERM` 也是「在」**（归别人的进程，本进程无权发信号 —— pid 1 即此）；
 * - 进程不在 ⇒ 一律 `ESRCH`，**包括超过 `kern.maxprocperuid` 的 pid**（macOS 实测
 *   2784 / 2785 / 999999 / 4194303 / 99999999 全是 ESRCH）⇒ 不需要「pid 太大」这类边角分类；
 * - 其他 errno ⇒ `undefined`（判不了）。
 *
 * ⚠️ 残留风险，两种都只会「**晚一点**才捡」，不会「抢错」：
 * ① **PID 复用**：撞号进程活着 ⇒ 误判为「主人在」。**自愈** —— 那个进程一退出，
 *    下一次扫描就 `ESRCH` ⇒ 立刻可抢；
 * ② **僵尸**（父进程没 `wait` 收尸，pid 仍留在进程表里）⇒ 同①。框架不探 `/proc/<pid>/stat`
 *    的 `Z`：macOS 没有 `/proc`，跨平台拿不到，为一个边角引平台分支不划算。
 * 刻意**不加时间硬上限**兜这两种 —— 加上限 = 把租约换回新鲜度启发式，「长跑被抢」那个 bug
 * 原样回来（那才是真·重复执行）。取舍：宁可偶尔晚捡，不可偶尔抢跑。
 */
import { parseOwnerId } from './owner-id.js';

/** 探针：等价于 `process.kill(pid, 0)` —— 正常返回 = 进程在，抛错则看 `e.code` */
export type SignalProbe = (pid: number) => void;

const defaultProbe: SignalProbe = (pid) => {
  process.kill(pid, 0);
};

/**
 * `true` = 同主机且进程在（**无论记录多老都不许抢**）；
 * `false` = 同主机但进程不在（崩溃孤儿，**立刻可抢**，不等保鲜期）；
 * `undefined` = 判不了（异主机 / 旧格式 / 坏形状 / 意外 errno）⇒ 交给新鲜度启发式。
 */
export function ownerAlive(
  ownerId: string,
  host: string,
  probe: SignalProbe = defaultProbe,
): boolean | undefined {
  const parsed = parseOwnerId(ownerId);
  if (parsed === undefined || parsed.host === undefined) return undefined;
  if (parsed.host !== host) return undefined;
  try {
    probe(parsed.pid);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}
