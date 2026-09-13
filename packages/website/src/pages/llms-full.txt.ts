import type { APIRoute } from 'astro';
import guide from '../../../../docs/usage-guide.md?raw';

/**
 * /llms-full.txt —— 供 AI 整篇注入的**完整**使用说明。
 *
 * 内容来自仓库单源 `docs/usage-guide.md`（CLI 脚手架生成的项目 AGENTS.md 同一份），
 * 构建期拼接为纯文本 —— 站点上不会出现第二份手写说明，也就不会与框架漂移。
 *
 * ⚠️ 单源**必须**用 `?raw` 构建期注入，别改回 `readFileSync(new URL(…, import.meta.url))`：
 * Astro 7 把端点打进 `dist/.prerender/chunks/`，`import.meta.url` 因此指向**产物目录**，
 * 相对路径会解析成 `packages/docs/usage-guide.md` → 构建期 ENOENT（与源码位置无关了）。
 */
export const GET: APIRoute = () => {
  return new Response(guide, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
