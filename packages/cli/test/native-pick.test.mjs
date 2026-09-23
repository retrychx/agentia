import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。⚠️ 绝不真调 pickFolderNative() ——
 * osascript / zenity 会弹出**真对话框**把 CI 挂死；这里只测纯函数与接线。 */
const DIST = fileURLToPath(new URL('../dist/native-pick.js', import.meta.url));
let P = null;
if (existsSync(DIST)) P = await import(new URL('../dist/native-pick.js', import.meta.url).href);
const SKIP = !P ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

const none = () => false;
const all = () => true;

describe('native-pick：平台 → 命令候选（resolvePicker 纯解析）', { skip: SKIP }, () => {
  it('darwin → osascript（choose folder）；win32 → powershell FolderBrowserDialog', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const mac = P.resolvePicker('darwin', none);
    assert.equal(mac.command, 'osascript');
    assert.match(mac.args.join(' '), /choose folder/, '要是目录选择框而不是文件选择框');
    const win = P.resolvePicker('win32', none);
    assert.equal(win.command, 'powershell');
    assert.match(win.args.join(' '), /FolderBrowserDialog/);
    // 这两个平台的候选是系统自带 ⇒ 不依赖探测结果
    assert.deepEqual(P.resolvePicker('darwin', all), mac);
    assert.deepEqual(P.resolvePicker('win32', all), win);
  });

  it('linux → 先 zenity 后 kdialog；都没有 ⇒ null（调用方翻译成 501）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const zenity = P.resolvePicker('linux', (c) => c === 'zenity');
    assert.equal(zenity.command, 'zenity');
    assert.ok(zenity.args.includes('--directory'), 'zenity 要选目录不是选文件');
    const kdialog = P.resolvePicker('linux', (c) => c === 'kdialog');
    assert.equal(kdialog.command, 'kdialog');
    assert.equal(P.resolvePicker('linux', none), null, '两个都没有 ⇒ null（501 的判据）');
    const both = P.resolvePicker('linux', all);
    assert.equal(both.command, 'zenity', '都在时 zenity 优先（顺序是契约的一部分）');
  });

  it('不认识的平台 ⇒ null', async (t) => {
    if (SKIP) return t.skip(SKIP);
    assert.equal(P.resolvePicker('freebsd', all), null);
  });
});

describe('native-pick：取消判定（isCancel 纯判定）', { skip: SKIP }, () => {
  it('darwin：非 0 退出 + stderr 含 User canceled ⇒ 取消；其它失败不算', async (t) => {
    if (SKIP) return t.skip(SKIP);
    assert.equal(P.isCancel('darwin', 1, null, 'execution error: User canceled. (-128)', ''), true);
    assert.equal(P.isCancel('darwin', 1, null, 'syntax error', ''), false, '真错误不是取消');
    assert.equal(P.isCancel('darwin', 0, null, '', '/Users/x/\n'), false, '选中了就不是取消');
  });

  it('darwin：取消认**错误码 (-128)**，不认英文文案（非英文系统文案本地化、码不变）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    // 本地化文案 + 恒定的 -128（中文系统实测形态）⇒ 取消
    assert.equal(P.isCancel('darwin', 1, null, 'execution error: 用户已取消。 (-128)', ''), true);
    // 只有英文文案、没有码（理论兜底路径）⇒ 仍算取消
    assert.equal(P.isCancel('darwin', 1, null, 'User canceled', ''), true);
    // 有别的错误码（如 -1743 权限被拒）⇒ 不是取消，是失败（该报 501 而不是假装取消）
    assert.equal(
      P.isCancel('darwin', 1, null, 'execution error: 不允许。 (-1743)', ''),
      false,
      '别的错误码 ≠ 取消',
    );
  });

  it('win32 / linux：两个流都空 ⇒ 取消（覆盖 win32 的 code=0 与 zenity 的 code=1）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    assert.equal(P.isCancel('win32', 0, null, '', ''), true, 'win32 取消 = 空输出');
    assert.equal(P.isCancel('linux', 1, null, '', ''), true, 'zenity 取消 = code 1 且无输出');
    assert.equal(
      P.isCancel('linux', 1, null, 'cannot open display', ''),
      false,
      'stderr 有话 ⇒ 是真错误（没有 DISPLAY），不是取消',
    );
    assert.equal(P.isCancel('win32', 0, null, '', 'C:\\work\r\n'), false, '选中了就不是取消');
  });

  it('被 signal 杀掉（dev 退出收编）一律视同取消', async (t) => {
    if (SKIP) return t.skip(SKIP);
    assert.equal(P.isCancel('darwin', null, 'SIGTERM', '', ''), true);
    assert.equal(P.isCancel('linux', null, 'SIGKILL', 'boom', ''), true);
  });
});

describe('native-pick：输出归一化（normalizePickedPath 纯判定）', { skip: SKIP }, () => {
  it('去尾部换行 / \\r\\n；空输出 ⇒ null（取消）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    assert.equal(P.normalizePickedPath('linux', '/home/u/work\n'), '/home/u/work');
    assert.equal(P.normalizePickedPath('win32', 'C:\\work\r\n'), 'C:\\work');
    assert.equal(P.normalizePickedPath('darwin', ''), null);
    assert.equal(P.normalizePickedPath('darwin', '\n'), null);
  });

  it('macOS 的尾斜杠归一掉（根目录 / 除外）；空格与非 ASCII 原样扛住', async (t) => {
    if (SKIP) return t.skip(SKIP);
    assert.equal(
      P.normalizePickedPath('darwin', '/Users/x/我的 项目/\n'),
      '/Users/x/我的 项目',
      'osascript 的 POSIX path 带尾斜杠，要归一掉',
    );
    assert.equal(P.normalizePickedPath('darwin', '/\n'), '/', '根目录不能归一成空串');
    assert.equal(P.normalizePickedPath('linux', '/home/u/我的 项目\n'), '/home/u/我的 项目');
  });
});

/**
 * 接线判据（不真弹框）：dev 钩子必须接上 pickFolderNative，进程退出必须收编，
 * inspector 必须有 /api/fs/pick 路由。同 inspector.test.mjs 的「页面必须真的走它」风格 ——
 * 抽出来不接上等于没接。
 */
describe('native-pick：接线（源码级）', () => {
  const src = (rel) =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
  const devSrc = src('dev.ts');
  const inspectorSrc = src('inspector.ts');
  // 路由表 2026-09-23 自 inspector.ts 切到 inspector-routes.ts（方案 §3 C）。
  // 这条断言守的是「路由在场」，不是「它写在哪个文件里」⇒ 跟着路由走。
  const routesSrc = src('inspector-routes.ts');

  it('dev.ts：钩子接上 pickFolderNative，且退出路径收编（killActivePickers）', () => {
    assert.match(devSrc, /import \{[^}]*pickFolderNative[^}]*\} from '\.\/native-pick\.js'/);
    assert.match(devSrc, /pickFolder,|pickFolder: pickFolder/, 'dev 钩子组里要有 pickFolder');
    assert.match(devSrc, /killActivePickers\(\)/, '退出路径必须收掉在飞的选择框（防孤儿）');
  });

  it('POST /api/fs/pick 路由在场（路由在 inspector-routes.ts、钩子形状在 inspector.ts）', () => {
    assert.match(routesSrc, /path === '\/api\/fs\/pick'/);
    assert.match(
      inspectorSrc,
      /pickFolder\(\): Promise<string \| null>/,
      'DevHooks 要有 pickFolder',
    );
  });
});
