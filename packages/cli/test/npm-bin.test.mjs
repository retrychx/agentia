import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* 对构建产物测试（未构建时跳过而非报错 —— 免得只跑 npm test 的人卡在构建前置上）。 */
const DIST = fileURLToPath(new URL('../dist/npm-bin.js', import.meta.url));
let npmBin = null;
if (existsSync(DIST)) {
  ({ npmBin } = await import(new URL('../dist/npm-bin.js', import.meta.url).href));
}
const SKIP = !npmBin ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

describe('npmBin（Windows 的 npm/npx 是 .cmd shim，裸 spawn 无法执行）', { skip: SKIP }, () => {
  it('win32 → 点名 .cmd 后缀', () => {
    assert.equal(npmBin('npx', 'win32'), 'npx.cmd');
    assert.equal(npmBin('npm', 'win32'), 'npm.cmd');
  });

  it('其他平台原样返回', () => {
    assert.equal(npmBin('npx', 'darwin'), 'npx');
    assert.equal(npmBin('npm', 'linux'), 'npm');
  });

  it('缺省取 process.platform（本机可执行名）', () => {
    const expected = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    assert.equal(npmBin('npx'), expected);
  });
});
