// fixture 评审对象：文件上传模块。
// ⚠️ 本文件是故意的评审素材（见 fixture/README.md），不要把问题修掉。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UPLOAD_DIR = '/var/uploads';

export async function saveUpload(name: string, data: Buffer): Promise<string> {
  // name 直接来自用户请求，未做任何校验：
  // 传 "../../etc/cron.d/pwn" 就越出 UPLOAD_DIR 写任意路径（路径穿越）
  const dest = join(UPLOAD_DIR, name);
  await writeFile(dest, data);
  return dest;
}
