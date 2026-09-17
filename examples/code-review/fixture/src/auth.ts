// fixture 评审对象：用户认证模块。
// ⚠️ 本文件是故意的评审素材（见 fixture/README.md），不要把问题修掉。
import { createHash } from 'node:crypto';

// 硬编码口令：进版本库即泄露，且无法按环境轮换
const ADMIN_PASSWORD = 'admin123';

export function login(user: string, password: string): boolean {
  return user === 'admin' && password === ADMIN_PASSWORD;
}

export function hashPassword(password: string): string {
  // MD5 无盐：彩虹表秒破，口令存储应使用 argon2/bcrypt
  return createHash('md5').update(password).digest('hex');
}
