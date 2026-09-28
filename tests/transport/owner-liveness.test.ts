import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { formatOwnerId } from '../../src/transport/owner-id.js';
import { ownerAlive } from '../../src/transport/owner-liveness.js';
import type { SignalProbe } from '../../src/transport/owner-liveness.js';

/**
 * 「主人还在吗」= 租约判定：`true` 活着 / `false` 不在（崩溃孤儿，立刻可抢）/ `undefined`
 * **判不了**（异主机、旧格式、坏形状、意外 errno）。
 *
 * 这里钉的是**分类**，不是 `process.kill` 本身 —— 探针注入之所以必要，就是因为
 * 「不在」与「判不了」必须分开（前者可抢、后者退回新鲜度），而这两种在真实环境里
 * 没法穷尽构造（EPERM / 僵尸 / 权限）。
 */

const HOST = 'agent-host.local';
const thrower =
  (code: string | undefined): SignalProbe =>
  () => {
    const e = new Error('probe') as NodeJS.ErrnoException;
    if (code !== undefined) e.code = code;
    throw e;
  };

/** 探针「被问过没有」——判不了的三种来源都**不该**惊动操作系统（问别的机器的 pid 无意义） */
const counting = (verdict: SignalProbe): { probe: SignalProbe; calls: number[] } => {
  const calls: number[] = [];
  return {
    calls,
    probe: (pid) => {
      calls.push(pid);
      verdict(pid);
    },
  };
};

describe('owner-liveness —— 租约判定（三态）', () => {
  it('同主机 + 探针不抛 ⇒ true（进程在，无论记录多老）', () => {
    assert.equal(
      ownerAlive(formatOwnerId(4242, HOST, 'aabbccdd'), HOST, () => {}),
      true,
    );
  });

  it('同主机 + ESRCH ⇒ false（不在了 = 崩溃孤儿，判定侧据此立刻可抢）', () => {
    assert.equal(ownerAlive(formatOwnerId(4242, HOST, 'aabbccdd'), HOST, thrower('ESRCH')), false);
  });

  it('EPERM 也是「在」：归别人的进程问不了信号，但它确实占着那个 pid', () => {
    // 真实情形就是 pid 1（init）：非 root 用户 kill(1, 0) 得 EPERM，而 init 当然活着。
    // 若把它当「不在」，每个宿主进程都会去抢 init「留下」的任务 —— 方向恰好错反。
    assert.equal(ownerAlive(formatOwnerId(1, HOST, 'aabbccdd'), HOST, thrower('EPERM')), true);
  });

  it('意外 errno ⇒ undefined（判不了，退回新鲜度；不猜、也不抢）', () => {
    for (const code of ['EINVAL', 'ENOSYS', undefined]) {
      assert.equal(
        ownerAlive(formatOwnerId(4242, HOST, 'aabbccdd'), HOST, thrower(code)),
        undefined,
        String(code),
      );
    }
  });

  it('异主机的记录：判不了，且**不去问**本机的同名 pid', () => {
    // 判成「不在」会是灾难：别的机器上半死的记录一律立刻被抢。
    // pid 是各机器自己的命名空间 —— 本机的 pid 4242 与那台的 pid 4242 毫无关系。
    const { probe, calls } = counting(() => {});
    assert.equal(
      ownerAlive(formatOwnerId(4242, 'other-host.local', 'aabbccdd'), HOST, probe),
      undefined,
    );
    assert.deepEqual(calls, [], '异主机的记录不许惊动本机进程表');
  });

  it('旧格式（没有 @host）⇒ 判不了：不知道是哪台机器写的', () => {
    const { probe, calls } = counting(() => {});
    assert.equal(ownerAlive('p4242-aabbccdd', HOST, probe), undefined);
    assert.deepEqual(calls, []);
  });

  it('形状不认识的串 ⇒ 判不了（问都不用问）', () => {
    const { probe, calls } = counting(() => {});
    for (const bad of ['proc-other', 'p999-otherproc', '']) {
      assert.equal(ownerAlive(bad, HOST, probe), undefined, bad);
    }
    assert.deepEqual(calls, []);
  });

  it('真实探针冒烟：本进程活着 / 已收尸的子进程不在（顺带钉住 errno 分类没反）', () => {
    // ① 本进程自己：写进 ownerId 的那套格式 + 真探针 ⇒ 必须说「在」。
    //    （这里同时走的是默认探针 —— 上面那些用例全都注入了探针，这条补上真身。）
    assert.equal(ownerAlive(formatOwnerId(process.pid, hostname(), 'aabbccdd'), hostname()), true);
    // ② init（pid 1）：存在 ⇒ true。macOS 上是 EPERM 分支、root 容器里是正常返回分支，
    //    两条都判「在」—— 这正是 EPERM 归入「在」的那条口径在真实环境里的样子。
    assert.equal(ownerAlive(formatOwnerId(1, hostname(), 'aabbccdd'), hostname()), true);
    // ③ 起一个立刻退出的子进程并由 spawnSync 收尸 ⇒ pid 已不在 ⇒ ESRCH ⇒ false。
    const reaped = spawnSync(process.execPath, ['-e', '']);
    assert.equal(typeof reaped.pid, 'number');
    assert.equal(
      ownerAlive(formatOwnerId(reaped.pid as number, hostname(), 'aabbccdd'), hostname()),
      false,
    );
  });
});
