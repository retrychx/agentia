/**
 * Windows 上 npm / npx 是 .cmd shim：不带 shell 的 spawn / spawnSync 无法直接执行
 * （ENOENT）。统一在这里按平台点名 —— 保持 CLI 零依赖（不引 cross-spawn）。
 */
export function npmBin(bin: 'npm' | 'npx', platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${bin}.cmd` : bin;
}
