import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时本地醒目警告+跳过、CI 判失败 —— 不许静默 skip）。 */
const DIST = fileURLToPath(new URL('../dist/npm-bin.js', import.meta.url));
let npmSpawn = null;
if (distReadyOrLoud(DIST, 'packages/cli/dist/npm-bin.js ')) {
  ({ npmSpawn } = await import(new URL('../dist/npm-bin.js', import.meta.url).href));
}
const SKIP = !npmSpawn ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

describe('npmSpawn（CVE-2024-27980 后裸 spawn .cmd 会 EINVAL，win32 走 cmd.exe 包装）', {
  skip: SKIP,
}, () => {
  it('非 win32：原样直 spawn，不带 cmd 包装', () => {
    assert.deepEqual(npmSpawn('npx', ['tsx', 'watch', 'src/main.ts'], 'darwin'), {
      command: 'npx',
      args: ['tsx', 'watch', 'src/main.ts'],
      options: {},
    });
    assert.deepEqual(npmSpawn('npm', ['install', 'foo'], 'linux').command, 'npm');
  });

  it('win32：cmd.exe /d /s /c 包装 + windowsVerbatimArguments', () => {
    const spec = npmSpawn('npm', ['install', 'foo'], 'win32');
    assert.equal(spec.command, 'cmd.exe');
    assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
    // 每个参数都加引号再 ^ 脱敏引号（cross-spawn 同算法）
    assert.equal(spec.args[3], '"npm.cmd ^"install^" ^"foo^""');
    assert.equal(spec.options.windowsVerbatimArguments, true);
  });

  it('win32：优先用 comspec 环境变量（可被注入覆盖）', () => {
    const spec = npmSpawn('npm', ['install', 'foo'], 'win32', 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
  });

  it('win32：用户输入含 cmd 元字符会被 ^ 脱敏（add 的注入面，shell:true 做不到）', () => {
    // `agentia add "foo & calc"`：不脱敏就是命令注入
    const spec = npmSpawn('npm', ['install', 'foo&calc.exe'], 'win32');
    const line = spec.args[3];
    assert.ok(line.includes('^&'), `元字符应被 ^ 脱敏，实际: ${line}`);
    assert.ok(!line.includes(' & '), `不得出现未脱敏的命令分隔符，实际: ${line}`);
  });

  it('win32：含空格的参数被引号包裹（本地路径安装）', () => {
    const spec = npmSpawn('npm', ['install', 'my pkg@1.0.0'], 'win32');
    assert.equal(spec.args[3], '"npm.cmd ^"install^" ^"my^ pkg@1.0.0^""');
  });

  it('缺省取 process.platform（本机行为）', () => {
    const spec = npmSpawn('npx', ['tsx']);
    if (process.platform === 'win32') {
      assert.equal(spec.args[1], '/s');
    } else {
      assert.equal(spec.command, 'npx');
    }
  });
});
