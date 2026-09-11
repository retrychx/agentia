import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/* 对构建产物测试（未构建时跳过而非报错 —— 免得只跑 npm test 的人卡在构建前置上）。 */
const DIST = fileURLToPath(new URL('../dist/add.js', import.meta.url));
let resolvePackageName = null;
let doctor = null;
if (existsSync(DIST)) {
  ({ resolvePackageName } = await import(new URL('../dist/add.js', import.meta.url).href));
  ({ doctor } = await import(new URL('../dist/doctor.js', import.meta.url).href));
}
const SKIP = !resolvePackageName ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

describe('add.resolvePackageName', { skip: SKIP }, () => {
  it('file: 协议本地路径 → 解析出 package.json 的 name（原实现把 file:./pkg 当包名）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-pkg-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-units' }));
      assert.equal(resolvePackageName(`file:${dir}`), 'my-units');
      assert.equal(resolvePackageName(dir), 'my-units'); // 裸绝对路径同样可解析
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('npm 包名：去版本后缀、保留 scope', () => {
    assert.equal(resolvePackageName('@scope/foo@1.2.3'), '@scope/foo');
    assert.equal(resolvePackageName('plain@2.0.0'), 'plain');
    assert.equal(resolvePackageName('plain'), 'plain');
  });
});

describe('doctor 单元入口候选', { skip: SKIP }, () => {
  it('index.js 入口的单元不算「缺少入口文件」（与框架 ENTRY_CANDIDATES 一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'units', 'thumb'), { recursive: true });
      writeFileSync(join(dir, 'units', 'thumb', 'index.js'), 'export default class {}');
      process.chdir(dir);
      // 未登记只是「警告」，入口齐全 → 无 error → 返回 0
      assert.equal(doctor(), 0);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
