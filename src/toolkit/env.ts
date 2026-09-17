import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Agentia —— 可选的 `.env` 引导工具（零依赖手写解析，Node ≥18 即可用）。
 *
 * 定位：**框架自身不会自动读 `.env`** —— 读哪个文件、什么时候读，是宿主的启动决策。
 * 本函数把它收成一行显式调用（`agentia create` 生成的 `src/main.ts` 首行就是它）：
 *
 * ```ts
 * import { createApp, loadEnvFile } from '@migor/agentia';
 *
 * loadEnvFile(); // 缺省读 cwd/.env；已存在的真实环境变量优先，不会被文件覆盖
 * const app = await createApp({ ... });
 * ```
 *
 * **为什么不塞进 `createApp` 自动做**：读 `.env` 会改 `process.env`，而 `.env` 是按 cwd 找的。
 * 隐式生效后，「同一份代码换个目录跑结果不同」和「本地多放了个 `.env`，测试行为悄悄变了」
 * 都会变成要花时间排查的悬案。显式一行，时机与路径都摆在文件里（`loadEnvFile({ path })`）。
 *
 * **为什么不放 CLI**：`agentia dev` 只是宿主之一。放 CLI 会让 `node dist/main.js`、docker、
 * 别的宿主都读不到 —— 那才是真的「只有 dev 生效」（与 spec §10 的决策一致）。
 *
 * 解析规则（刻意窄，够用就好）：
 * - 逐行 `KEY=VALUE`：允许 `export ` 前缀、`=` 两侧空白；空行与 `#` 开头整行忽略；
 * - 单引号内**原样**；双引号内认 `\n` `\r` `\t` `\"` `\\`；未加引号的值里 ` #` 起为行内注释；
 * - **不做变量展开**（`${VAR}` 原样保留）、不合并多行续行（行尾 `\`）—— 需要这些请上专门的库；
 * - 键名只认 `[A-Za-z_][A-Za-z0-9_]*`；既不像 `KEY=VALUE` 又不是注释的行**直接抛错**（附行号）——
 *   静默跳过等于让你以为「配上了其实没配上」。
 */

/** `loadEnvFile` 的选项 */
export interface LoadEnvOptions {
  /** 文件路径，缺省 `.env`（相对 `process.cwd()` 解析） */
  path?: string;
  /** `true` = 文件里的值**覆盖**已存在的进程环境变量（缺省 `false`：真实环境变量优先） */
  override?: boolean;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 解析 `.env` 文本 → 键值表（不碰 `process.env`，纯函数；抛错信息带行号） */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 先剥 BOM：Windows 记事本存过的 .env 会带上 \uFEFF，不剥会让第一个键名匹配失败
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) throw new Error(`.env 第 ${i + 1} 行不是 KEY=VALUE：${raw}`);
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) throw new Error(`.env 第 ${i + 1} 行键名非法：${key || '(空)'}`);
    // __proto__ 走原型 setter：`out['__proto__'] = 'v'`（字符串值）被**静默忽略** ——
    // 正是本文件「静默跳过 = 以为配上了其实没配上」要防的事，显式拒绝
    if (key === '__proto__') {
      throw new Error(`.env 第 ${i + 1} 行键名 "__proto__" 不可用（会走原型 setter 被静默吞掉）`);
    }
    out[key] = parseValue(body.slice(eq + 1));
  }
  return out;
}

function parseValue(raw: string): string {
  const v = raw.trim();
  // 引号值：扫到**闭合引号**为止，其后只允许空白或行内注释。
  //
  // 不能用 `v.startsWith('"') && v.endsWith('"')` 判定 —— `A="x" # 注释` 的结尾是
  // 注释不是引号，那样会掉进未加引号分支，只剥掉 ` # 注释` 而把 `"x"`（**含字面引号**）
  // 原样写进 process.env：密钥带着引号发出去、每个请求 401，而 .env 文件看上去完全正确。
  // 这正是本文件开头「静默跳过 = 以为配上了其实没配上」要防的那类事。
  const quoted = matchQuoted(v);
  if (quoted !== null) return quoted;
  // 未加引号：` #` 起为行内注释（`#` 紧贴值不当作注释，避免吃掉含 # 的 token）
  const hash = v.search(/\s#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/** 双引号内的转义：只认 `\n \r \t \" \\`，其余（如 `\q`）原样保留 */
function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
  );
}

/**
 * `v` 以引号开头且能扫到闭合引号时，返回引号**内层**（双引号解转义）；否则返回 null，
 * 交给未加引号分支。
 *
 * 闭合引号之后只允许空白或 `#` 行内注释 —— 还有别的残留（`A="x" y`）当作「没配引号」，
 * 回退旧行为原样返回，不猜。
 */
function matchQuoted(v: string): string | null {
  const quote = v[0];
  if (quote !== '"' && quote !== "'") return null;
  let i = 1;
  while (i < v.length) {
    // 双引号内 `\"` 不算闭合（单引号内无转义，与原实现一致）
    if (quote === '"' && v[i] === '\\') {
      i += 2;
      continue;
    }
    if (v[i] === quote) break;
    i++;
  }
  if (i >= v.length) return null; // 未闭合
  const rest = v.slice(i + 1).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  const inner = v.slice(1, i);
  return quote === '"' ? unescapeDouble(inner) : inner;
}

/**
 * 读 `.env` 并写进 `process.env`，返回**本次真正生效**的键值。
 *
 * 三条语义（都刻意，别当成实现细节）：
 * - **文件不存在 = 正常情况**（首次 clone、CI、生产靠真实环境变量）→ 静默返回 `{}`，
 *   不制造「没建 .env 就跑不起来」的假依赖；
 * - **已有环境变量优先**：`process.env` 里已定义（哪怕空串）的键不覆盖 —— 这样 CI / docker /
 *   命令行的显式变量永远赢过文件，`override: true` 才反过来；
 * - 想知道「到底生效没」看返回值，别去看文件。
 */
export function loadEnvFile(options: LoadEnvOptions = {}): Record<string, string> {
  const path = resolve(options.path ?? '.env');
  if (!existsSync(path)) return {};
  const parsed = parseEnvText(readFileSync(path, 'utf8'));
  const applied: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!options.override && process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied[key] = value;
  }
  return applied;
}
