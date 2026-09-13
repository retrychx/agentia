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
let generateCapability = null;
if (existsSync(DIST)) {
  ({ resolvePackageName } = await import(new URL('../dist/add.js', import.meta.url).href));
  ({ doctor } = await import(new URL('../dist/doctor.js', import.meta.url).href));
  ({ generateCapability } = await import(new URL('../dist/generate.js', import.meta.url).href));
}
const SKIP = !resolvePackageName ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

describe('add.resolvePackageName', { skip: SKIP }, () => {
  it('file: 协议本地路径 → 解析出 package.json 的 name（原实现把 file:./pkg 当包名）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-pkg-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-capabilities' }));
      assert.equal(resolvePackageName(`file:${dir}`), 'my-capabilities');
      assert.equal(resolvePackageName(dir), 'my-capabilities'); // 裸绝对路径同样可解析
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

describe('doctor 能力入口候选', { skip: SKIP }, () => {
  it('index.js 入口的能力不算「缺少入口文件」（与框架 ENTRY_CANDIDATES 一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'src', 'tools', 'thumb'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tools', 'thumb', 'index.js'), 'export default class {}');
      process.chdir(dir);
      // 未登记只是「警告」，入口齐全 → 无 error → 返回 0
      assert.equal(doctor(), 0);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('老布局（根 units/ + units.ts）→ 明确提示迁移，而不是去扫不存在的新布局', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-legacy-'));
    const cwd = process.cwd();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => {
      logs.push(a.join(' '));
    };
    try {
      mkdirSync(join(dir, 'units', 'echo'), { recursive: true });
      writeFileSync(join(dir, 'units', 'echo', 'index.ts'), 'export default class {}');
      writeFileSync(join(dir, 'units.ts'), 'export const providers = [];');
      process.chdir(dir);
      const code = doctor();
      process.exitCode = undefined;
      assert.equal(code, 0, '老布局只是警告，不是错误');
      const out = logs.join('\n');
      assert.ok(out.includes('老布局'), `应提示老布局，实际:\n${out}`);
      assert.ok(out.includes('src/registry.ts'), '提示里应给出迁移落点');
    } finally {
      console.log = realLog;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('老布局下 agentia g 拒绝写入（不悄悄在旁边长出新目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-gen-legacy-'));
    const cwd = process.cwd();
    const realErr = console.error;
    console.error = () => {};
    try {
      mkdirSync(join(dir, 'units'), { recursive: true });
      writeFileSync(join(dir, 'units.ts'), 'export const providers = [];');
      process.chdir(dir);
      const code = generateCapability('tool', 'echo');
      process.exitCode = undefined;
      assert.equal(code, 1, '老布局下应拒绝生成');
      assert.ok(!existsSync(join(dir, 'src')), '不应新建 src/ —— 否则项目里会同时存在两套能力目录');
    } finally {
      console.error = realErr;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跨分类目录同名 → 判为错误（四个目录共用一套 DI token，装配期只会留一个）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-dup-'));
    const cwd = process.cwd();
    try {
      for (const d of ['tools', 'skills']) {
        mkdirSync(join(dir, 'src', d, 'weather'), { recursive: true });
        writeFileSync(join(dir, 'src', d, 'weather', 'index.ts'), 'export default class {}');
      }
      process.chdir(dir);
      const code = doctor();
      process.exitCode = undefined; // doctor 发现错误时会置 exitCode：别让它污染测试进程
      assert.equal(code, 1, '跨目录同名应判为错误');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
