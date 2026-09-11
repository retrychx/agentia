import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';

/**
 * /llms-full.txt —— 供 AI 整篇注入的**完整**使用说明。
 *
 * 内容来自仓库单源 `docs/usage-guide.md`（CLI 脚手架生成的项目 AGENTS.md 同一份），
 * 构建期拼接为纯文本 —— 站点上不会出现第二份手写说明，也就不会与框架漂移。
 */
export const GET: APIRoute = () => {
  const guide = readFileSync(new URL('../../../../docs/usage-guide.md', import.meta.url), 'utf8');
  return new Response(guide, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
