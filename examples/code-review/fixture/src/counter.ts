// fixture 评审对象：账户余额模块。
// ⚠️ 本文件是故意的评审素材（见 fixture/README.md），不要把问题修掉。

let balance = 100;

const settle = () => new Promise<void>((done) => setTimeout(done, 5));

export async function withdraw(amount: number): Promise<boolean> {
  // check-then-act 竞态：检查余额与扣减之间隔着一次 await，
  // 两个并发请求都能通过检查 → 余额被扣成负数（双花）
  if (balance >= amount) {
    await settle(); // 模拟跨行清算延迟
    balance -= amount;
    return true;
  }
  return false;
}

export function currentBalance(): number {
  return balance;
}
