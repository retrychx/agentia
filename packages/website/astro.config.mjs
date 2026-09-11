// @ts-check
import { defineConfig } from 'astro/config';

// 官网构建配置。
// - build.format: 'file' —— 产物输出 index.html / playground.html / docs.html / api.html，
//   与迁移前的既有 URL 完全一致（避免 /playground/ 这类目录式 URL 造成外链 404）。
// - 全静态输出，无 adapter；直接丢给 Cloudflare Pages。
export default defineConfig({
  site: 'https://agentia-web.pages.dev',
  build: {
    format: 'file',
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
  devToolbar: { enabled: false },
});
