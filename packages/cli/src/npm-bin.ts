/**
 * Windows 上 npm / npx 是 .cmd shim：Node 修补 CVE-2024-27980（18.20.2 / 20.12.2 / 21.7.3+）后，
 * 不带 shell 直接 spawn .cmd 会 EINVAL。统一在这里产出 spawn 描述（cross-spawn 同思路，
 * 保持零依赖）：win32 走 cmd.exe 包装 + 逐参数脱敏，其余平台原样直 spawn。
 *
 * 为什么不用 options.shell:true —— shell:true 时 Node 把「命令 + 参数」用空格 join 后
 * 整体塞给 cmd.exe，参数**不做任何转义**；而 add 的参数是用户输入的包名/本地路径，
 * 含 `&` / `|` / `%` 即成命令注入。所以这里走 cmd.exe 包装并逐参数脱敏
 * （算法取自 cross-spawn lib/util/escape.js，https://qntm.org/cmd）。
 */

export interface SpawnSpec {
  command: string;
  args: string[];
  /** 透传给 spawn / spawnSync 的选项（win32 下命令行已自行转义，须设 windowsVerbatimArguments） */
  options: { windowsVerbatimArguments?: boolean };
}

// cmd.exe 元字符（见 http://www.robvanderwoude.com/escapechars.php）
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** 命令名脱敏（npm.cmd 本身）：不加引号，只 ^ 脱敏元字符 */
function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, '^$1');
}

/**
 * 参数脱敏：反斜杠+引号序列按 CreateProcess 规则翻倍转义，整体加双引号，
 * 再对 cmd 元字符加 ^（`^` 落在引号外才生效，所以先加引号后脱敏）。
 */
function escapeCmdArg(arg: string): string {
  let out = arg
    // 反斜杠序列 + 引号：反斜杠翻倍，引号加反斜杠
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    // 末尾反斜杠序列翻倍（随后会拼上收尾引号）
    .replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  return out.replace(CMD_META_CHARS, '^$1');
}

/**
 * npm / npx 的 spawn 描述：win32 返回 cmd.exe 包装（参数已脱敏，
 * 全局安装的 npm.cmd 非 node_modules/.bin 代理 shim，单层 ^ 脱敏即可）；
 * 其余平台原样返回（直接 spawn 可执行文件）。
 */
export function npmSpawn(
  bin: 'npm' | 'npx',
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.comspec,
): SpawnSpec {
  if (platform !== 'win32') return { command: bin, args, options: {} };
  const shellCommand = [escapeCmdCommand(`${bin}.cmd`), ...args.map(escapeCmdArg)].join(' ');
  return {
    command: comspec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { windowsVerbatimArguments: true },
  };
}
