import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * 手写文档面的**形状**护栏：`app.run` / `executeRun` 返回 `AgentRunOutput = { run, result }`，
 * `finalText` / `trace` / `stopReason` 全在 `result` 上。
 *
 * 为什么单开一条：官网 `docs.html` 与单源 `docs/usage-guide.md` 里那段「出参护栏」示例
 * 原本写的是 `out.finalText` —— 而 `out` 是 `{ run, result }`，于是判断恒为 undefined，
 * 护栏永不触发，页面上却像在生效。这类手写片段**没有任何东西在编译它**（api.html 只被
 * 表格守卫盯着，usage-guide 只被表格与成员名守卫盯着），所以用一条定向 lint 钉住这个
 * 具体形状 —— 它挡不住「别的错误写法」，但挡得住已经发生过的那一种。
 */
describe('文档面的 run 输出形状', () => {
  const fragments = join(repoRoot, 'packages', 'website', 'src', 'fragments');
  const files = [
    join(repoRoot, 'docs', 'usage-guide.md'),
    ...readdirSync(fragments)
      .filter((f) => f.endsWith('.html'))
      .map((f) => join(fragments, f)),
  ];

  it('凡出现 .finalText 的行，接收方必须是 result（AgentRunOutput = { run, result }）', () => {
    const problems: string[] = [];
    let seen = 0;
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('.finalText')) return;
          seen += 1;
          if (!/result\.finalText/.test(line)) {
            problems.push(`${file.slice(repoRoot.length)}:${i + 1}`);
          }
        });
    }
    // 扫描面自检：文档里确实存在若干处 .finalText（写法变了 / 文件被移走时要报出来，
    // 否则这条守卫会悄悄变成「什么都没检查」）
    assert.ok(seen >= 2, `只扫到 ${seen} 处 .finalText，守卫的扫描面可能已经失效`);
    assert.deepEqual(
      problems,
      [],
      `finalText 只能从 result 上取（run 输出是 { run, result }）：\n${problems.join('\n')}`,
    );
  });
});
