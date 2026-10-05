import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Tool } from '@migor/agentia';
import type { Workspace } from '../../workspace.js';

/**
 * 扫描上界。三个都是**宿主侧**的收口，理由同 usage-guide §7：
 * 工具输出没有框架层大小闸，长跑里一次失控的 `search` 就能把上下文撑爆。
 */
const MAX_FILES_SCANNED = 4_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MATCHES = 60;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/** 正则搜索（只读）：在巡检根下递归找匹配行，返回 `路径:行号: 内容` */
export default class SearchText {
  constructor(private readonly ws: Workspace) {}

  @Tool({
    description:
      '在巡检根下递归搜索匹配某正则的行。返回 `路径:行号: 内容`。结果有条数上限，超了会标注 truncated。',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则（不带斜杠），如 "TODO|FIXME"' },
        fileExtension: {
          type: 'string',
          description: '只看这种扩展名的文件，如 ".md"（省略 = 只看常见文本文件）',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    strict: true,
  })
  searchText(input: { pattern: string; fileExtension?: string }): string {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (e) {
      throw new Error(`pattern 不是合法正则：${(e as Error).message}`);
    }
    const root = this.ws.root;
    const ext = input.fileExtension;
    const hits: string[] = [];
    let scanned = 0;
    let skippedBig = 0;
    let truncated = false;

    const walk = (dir: string): void => {
      if (truncated) return;
      for (const name of readdirSync(dir).sort()) {
        if (truncated) return;
        const abs = join(dir, name);
        const st = statSync(abs, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(abs);
          continue;
        }
        if (!st.isFile()) continue;
        if (ext !== undefined && !name.endsWith(ext)) continue;
        if (ext === undefined && !isTextLike(name)) continue;
        if (st.size > MAX_FILE_BYTES) {
          skippedBig++;
          continue;
        }
        if (++scanned > MAX_FILES_SCANNED) {
          truncated = true;
          return;
        }
        const lines = readFileSync(abs, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i] ?? '')) {
            hits.push(`${this.ws.display(abs)}:${i + 1}: ${(lines[i] ?? '').slice(0, 200)}`);
            if (hits.length >= MAX_MATCHES) {
              truncated = true;
              return;
            }
          }
        }
      }
    };
    walk(root);

    return JSON.stringify(
      {
        pattern: input.pattern,
        filesScanned: Math.min(scanned, MAX_FILES_SCANNED),
        skippedLargeFiles: skippedBig,
        matches: hits.length,
        truncated,
        lines: hits,
      },
      null,
      1,
    );
  }
}

function isTextLike(name: string): boolean {
  return /\.(md|txt|json|ya?ml|toml|ts|tsx|js|mjs|cjs|css|html|astro|sh|py|go|rs)$/i.test(name);
}
