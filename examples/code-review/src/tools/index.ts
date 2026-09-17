import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tool } from '@migor/agentia';

/** 评审对象仓库根：按本文件位置解析（不从 cwd 猜 —— 从任何目录起进程结果都一致） */
const FIXTURE_ROOT = fileURLToPath(new URL('../../fixture', import.meta.url));

/** 把模型给的路径约束在评审对象仓库内（越界响亮报错，错误会作为 is_error 回给模型） */
function safeResolve(rel: string): string {
  const abs = resolve(FIXTURE_ROOT, rel);
  if (abs !== FIXTURE_ROOT && !abs.startsWith(FIXTURE_ROOT + sep)) {
    throw new Error(`路径越出评审对象仓库: "${rel}"`);
  }
  return abs;
}

/** 递归收集相对路径（只收文件，跳过 README —— 它是给人类的种子清单，不给评审对象混入提示） */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name !== 'README.md') out.push(relative(FIXTURE_ROOT, p));
  }
  return out;
}

const FILES = () => walk(FIXTURE_ROOT).sort();

/**
 * @Tool ×3 —— 评审对象仓库的只读访问面（确定性能力，主 agent 与安全子 agent 共用）。
 * provider token 是 'tools'：security_scan 用能力级路径 'tools/grep_code' 只借走其中一个。
 */
export default class CodebaseTools {
  @Tool({
    description: '列出评审对象仓库的全部文件（相对路径）',
    schema: { type: 'object', properties: {}, additionalProperties: false },
  })
  list_files(): string[] {
    return FILES();
  }

  @Tool({
    description: '读取评审对象仓库里某个文件的全文（path 为相对路径）',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对仓库根的路径，如 src/auth.ts' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  })
  read_file(input: { path: string }): string {
    const abs = safeResolve(input.path);
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`文件不存在: "${input.path}"（先用 list_files 拿清单）`);
    }
    return readFileSync(abs, 'utf8');
  }

  @Tool({
    description: '对评审对象仓库做正则全文搜索，返回 file:line 命中清单（最多 50 条）',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则，如 password|secret|token' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    strict: true,
  })
  grep_code(input: { pattern: string }): Array<{ file: string; line: number; text: string }> {
    const re = new RegExp(input.pattern, 'i');
    const hits: Array<{ file: string; line: number; text: string }> = [];
    for (const f of FILES()) {
      const lines = readFileSync(join(FIXTURE_ROOT, f), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) hits.push({ file: f, line: i + 1, text: lines[i].trim() });
        if (hits.length >= 50) return hits;
      }
    }
    return hits;
  }
}
