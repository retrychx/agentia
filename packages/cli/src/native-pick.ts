/**
 * OS 原生文件夹选择器（dev 面板「工作目录」控件的「用系统选择器…」路径）。
 *
 * 为什么存在：浏览器**拿不到**用户所选文件夹的绝对路径（`<input webkitdirectory>` 只给
 * 相对路径、File System Access API 只给 handle.name），而 dev 环要的就是绝对路径。
 * 但 CLI 是本机进程 —— 它可以替用户拉起 OS 原生的目录选择框，把选中的绝对路径拿回来。
 * `/api/fs` 的「浏览…」目录浏览器是这条路的**降级**（命令缺失 / 平台不支持时用）。
 *
 * ⚠️ **绝不能在 e2e / CI 里真触发**：osascript / zenity 会弹出**真对话框**把流水线挂死。
 * 所以本模块的「平台 → 命令候选」「取消判定」「输出归一化」全是纯函数（带单测），
 * 真正 spawn 的 `pickFolderNative()` 只由 dev 钩子在用户点击时调用。
 *
 * 防孤儿：选择框是用户可能要放着想一会儿的东西（**不设**超时），但 dev 进程退出时
 * 必须收掉 —— 否则留下一个没人看的 osascript 对话框孤儿。在飞的子进程登记在模块级
 * `active` 里，dev.ts 收尾时调 `killActivePickers()`。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

/** 一条「怎么拉起选择框」的候选：命令 + 参数 */
export interface PickerCandidate {
  command: string;
  args: string[];
}

const MACOS_PICKER: PickerCandidate = {
  command: 'osascript',
  args: ['-e', 'POSIX path of (choose folder with prompt "选择 agent 的工作目录")'],
};

const WINDOWS_PICKER: PickerCandidate = {
  command: 'powershell',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; ' +
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
      "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
  ],
};

const LINUX_PICKERS: ReadonlyArray<[cmd: string, candidate: PickerCandidate]> = [
  ['zenity', { command: 'zenity', args: ['--file-selection', '--directory'] }],
  ['kdialog', { command: 'kdialog', args: ['--getexistingdirectory'] }],
];

/**
 * 「平台 → 命令候选」的纯解析（**导出为单测用**；`has` = 该命令在 PATH 上可用）。
 *
 * darwin / win32 的候选是确定的（osascript / powershell 是系统自带），不需要探测；
 * linux 没有系统级唯一答案，按 zenity → kdialog 顺序探测，都没有 ⇒ `null`
 * （调用方翻译成 501 + 可读报错）。
 */
export function resolvePicker(
  platform: NodeJS.Platform,
  has: (cmd: string) => boolean,
): PickerCandidate | null {
  if (platform === 'darwin') return MACOS_PICKER;
  if (platform === 'win32') return WINDOWS_PICKER;
  if (platform === 'linux') {
    for (const [cmd, candidate] of LINUX_PICKERS) {
      if (has(cmd)) return candidate;
    }
    return null;
  }
  return null;
}

/**
 * 「这次退出算不算用户取消」的纯判定（**导出为单测用**）。
 *
 * 三个平台三种取消信号：
 * - darwin：osascript 取消 = 退出码非 0 + stderr 带 **错误码 `(-128)`** —— AppleScript 的
 *   「用户取消」错误码恒为 -128、**不随系统语言本地化**；文案（"User canceled"）才是
 *   本地化的那部分，只当兜底匹配（非英文系统上只认文案会把「取消」误判成失败 ⇒ 501）。
 * - win32：`ShowDialog()` 不是 OK 就什么都不打印（退出码 0）；powershell 自身出错会写
 *   stderr —— 所以判「**两个流都空**」而不是只看退出码，否则真错误会被误报成「取消」；
 * - linux：zenity / kdialog 取消 = 退出码 1、**无输出**；而「没有 DISPLAY」这类真错误
 *   会往 stderr 写一句 —— 同样落「两个流都空即取消」。
 * - 被 signal 杀掉（dev 进程退出时 `killActivePickers` 收编）一律视同取消。
 */
export function isCancel(
  platform: NodeJS.Platform,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
  stdout: string,
): boolean {
  if (signal !== null) return true;
  if (platform === 'darwin') {
    return code !== 0 && (stderr.includes('(-128)') || /user canceled/i.test(stderr));
  }
  return stdout.trim().length === 0 && stderr.trim().length === 0;
}

/**
 * 选中输出的归一化（**导出为单测用**）：空输出 ⇒ `null`（取消）。
 *
 * 两个坑：
 * - 尾部换行 / `\r\n`（powershell）要去掉，但**只去尾部** —— 路径含空格、非 ASCII
 *   都要原样扛住；
 * - macOS 的 osascript `POSIX path of` 输出**带尾斜杠**（`/Users/x/`），要归一掉
 *   （面板会拿它与 `/api/fs` 列出的路径拼接比对）；根目录 `/` 是唯一例外，不能归一成空串。
 */
export function normalizePickedPath(platform: NodeJS.Platform, stdout: string): string | null {
  const trimmed = stdout.replace(/[\r\n]+$/, '');
  if (trimmed.length === 0) return null;
  if (platform === 'darwin' && trimmed.endsWith('/')) {
    return trimmed.replace(/\/+$/, '') || '/';
  }
  return trimmed;
}

/** 在飞的选择框子进程 —— dev 进程退出时由 `killActivePickers()` 收编，不留 osascript 孤儿 */
const active = new Set<ChildProcess>();

/**
 * 收掉所有还挂着的原生选择框（dev 收尾 / 进程退出时调用）。
 * 被杀掉的子进程在 `pickFolderNative` 那边走「视同取消」（resolve null）——
 * 那时进程本就要没了，没人会读这个值，但**不许挂着一个永不 settle 的 Promise**。
 */
export function killActivePickers(): void {
  for (const child of active) {
    try {
      child.kill();
    } catch {
      /* 已经退出了 */
    }
  }
}

/** linux 上的命令探测（`which` 是事实标准；探测本身失败就当没有） */
function hasCommand(cmd: string): boolean {
  try {
    return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * 拉起 OS 原生目录选择框，返回用户选中的**绝对路径**；用户取消返回 `null`。
 *
 * 平台不支持或命令缺失时**抛错**（消息可读，并指向降级路径「浏览…」）——
 * 调用方（dev 钩子）把它翻译成 501。
 *
 * **不设超时**：用户可能把对话框放着想一会儿；进程退出由 `killActivePickers()` 收编。
 */
export function pickFolderNative(): Promise<string | null> {
  const picker = resolvePicker(process.platform, hasCommand);
  if (picker === null) {
    return Promise.reject(
      new Error(
        process.platform === 'linux'
          ? '找不到 zenity / kdialog —— 原生文件夹选择器不可用，请改用面板的「浏览…」'
          : `这个平台（${process.platform}）没有原生文件夹选择器 —— 请改用面板的「浏览…」`,
      ),
    );
  }
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn(picker.command, picker.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (e) => {
      active.delete(child);
      // 命令缺失（ENOENT）也走这条路 —— 与「平台不支持」同一条可读口径
      reject(
        new Error(
          `原生文件夹选择器起不来（${picker.command}：${e.message}）—— 请改用面板的「浏览…」`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      active.delete(child);
      if (isCancel(process.platform, code, signal, stderr, stdout)) {
        resolve(null);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `原生文件夹选择器失败（${picker.command} 退出 code=${code}）：` +
              `${stderr.trim() || '无输出'} —— 请改用面板的「浏览…」`,
          ),
        );
        return;
      }
      resolve(normalizePickedPath(process.platform, stdout));
    });
  });
}
