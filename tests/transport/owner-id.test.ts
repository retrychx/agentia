import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatOwnerId, parseOwnerId } from '../../src/transport/owner-id.js';

/**
 * ownerId 的**写 → 读回**（纯件）。它一个人身上挂着两件事：
 * ① 给「同主机吗」提供主机名；② 给「问哪个 pid」提供 pid。任一读错，租约判定都会静默变味
 * （读不到主机名 ⇒ 退回新鲜度，看起来「还能跑」，其实那条硬判据已经没了）。
 */
describe('owner-id —— 认领者标识的格式真源（2026-09-28）', () => {
  it('写-读往返：pid 与主机名都原样回来', () => {
    const id = formatOwnerId(1234, 'agent-host.local', 'aabbccdd');
    assert.equal(id, 'p1234@agent-host.local-aabbccdd');
    assert.deepEqual(parseOwnerId(id), { pid: 1234, host: 'agent-host.local' });
  });

  it('主机名里带 `-` 是常态：切分点由「串尾 8 位十六进制」唯一确定，`-1` 不会被吃进后缀', () => {
    // 切错就等于「解析不出来 ⇒ 退回新鲜度」——静默降级，不报错。
    // 撑住这条的是正则里的 `$` 与 `{8}`：去掉锚点、或把 `{8}` 放宽成 `{1,8}`，本用例就红。
    // （`(.+?)` 与 `(.+)` 在这里**等价** —— 两端锚 + 定长尾巴把切分点钉死了，28 组夹具实测零差异；
    //  写成惰性只是把意图写在脸上，不是判据本身。）
    assert.deepEqual(parseOwnerId(formatOwnerId(7, 'my-host-1', 'deadbeef')), {
      pid: 7,
      host: 'my-host-1',
    });
  });

  it('主机名本身就以 `-<8 位十六进制>` 收尾：切分点仍然在后缀那一处', () => {
    assert.deepEqual(parseOwnerId(formatOwnerId(9, 'x-deadbeef', '12345678')), {
      pid: 9,
      host: 'x-deadbeef',
    });
  });

  it('旧格式（升级前写下的 `p<pid>-<rand>`）：pid 读得到，主机名是 undefined ⇒ 判定侧退回新鲜度', () => {
    assert.deepEqual(parseOwnerId('p4321-deadbeef'), { pid: 4321, host: undefined });
  });

  it('形状不认识的串一律 undefined（自定义标识、夹具里的假串）', () => {
    for (const bad of [
      'proc-other', // 没有 pid 段（测试夹具）
      'p999-otherproc', // 后缀不是十六进制（9 个字符，含非十六进制字符）
      'p1-thisproc', // 同上
      '', // 空串
      'p-abcdef00', // 没有数字
      'p12-abcdef0', // 后缀只有 7 位
      'p12-abcdef000', // 后缀 9 位
      'p12-ABCDEF00', // 大写十六进制：本格式恒小写（不认识就判不了，不猜）
      '12-abcdef00', // 少了 p
      'p12@host-abcdef00x', // 尾巴上有杂字
    ]) {
      assert.equal(parseOwnerId(bad), undefined, bad);
    }
  });

  it('边界：pid 必须为正的安全整数（`p0` / 超长数字都不是 pid）', () => {
    assert.equal(parseOwnerId('p0-abcdef00'), undefined, 'pid 0 不是进程');
    assert.equal(parseOwnerId(`p${'9'.repeat(400)}-abcdef00`), undefined, '溢出成 Infinity');
  });
});
