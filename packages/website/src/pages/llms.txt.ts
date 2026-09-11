import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';

/**
 * /llms.txt —— llms.txt 约定的入口索引（给联网 AI 助手）。
 *
 * - `/llms-full.txt` 是完整使用说明（由仓库单源 docs/usage-guide.md 生成）；
 * - 本站是静态托管，没有后端，因此这里只列事实与链接。
 */
export const GET: APIRoute = () => {
  const guide = readFileSync(new URL('../../../../docs/usage-guide.md', import.meta.url), 'utf8');

  // 从单源里抠出 API 名单，保证这里的清单不会与说明漂移
  const roster = new Map<string, string[]>();
  let heading = '';
  for (const raw of guide.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('###')) {
      heading = line.replace(/^#+\s*/, '').replace(/`/g, '');
      continue;
    }
    const m = /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|/.exec(line);
    if (m && heading) {
      const list = roster.get(heading) ?? [];
      list.push(m[1]);
      roster.set(heading, list);
    }
  }

  const apiLines = [...roster.entries()]
    .map(([h, names]) => `- ${h}: ${names.join(', ')}`)
    .join('\n');

  const body = `# Agentia

> 面向应用开发者的声明式 agent 服务开发框架：用装饰器 + 显式 DI 声明 tool / skill / subagent / prompt 四类单元，主 agent 编排执行，交付可上线的 Agent 服务。npm 包 \`@migor/agentia\` 与 \`@migor/cli\`；ESM、Node ≥ 18。

本文件是所有内容的纯文本入口。**需要完整说明时读 \`/llms-full.txt\`**（同一份单源的完整版）。

## 文档

- [完整使用说明（供 AI 整篇注入）](/llms-full.txt): API 速查、类型链路、常见错误 —— 由仓库单源 \`docs/usage-guide.md\` 生成
- [官网首页](/): 框架定位与四类单元
- [文档页](/docs): 指南与代码示例
- [API 参考](/api): 导出面清单
- [Playground](/playground): 浏览器内跑一次真实 run（自带 Key，直连 Anthropic / DeepSeek）

## 安装与脚手架

\`\`\`bash
npm i @migor/agentia
npx @migor/cli create my-app     # 生成项目（含使用者向 AGENTS.md）
npx @migor/cli dev               # tsx watch + 本地 inspector 面板
npx @migor/cli doctor            # 静态体检
\`\`\`

## 导出面（按说明文档的分节）

${apiLines}

## 已知边界（如实标注）

- \`@Tool\` 方法入参**必须显式标注类型**；TS 不会从 JSON Schema 反向推断方法形参。
- 不给 \`fromZod<T>\` 时 schema 与方法签名无关联（不校验，仅透传）。
- 黑板键默认无类型，需用 \`declare module\` 合并 \`Blackboard\` 才有补全。
- 单元由运行时装饰器注册表收集，故 TS 层**没有**「单元清单」类型。
- \`strict\` 仅透传给 Anthropic；框架的 schema 校验是**子集**（\`format\`/\`minimum\` 等不校验）。

## 可选

- [GitHub](https://github.com/retrychx/agentia)
`;

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
