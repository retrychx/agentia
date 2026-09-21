/**
 * 构建前清掉 dist/ —— 与脚手架模板的 `scripts/clean.mjs` 同一个理由：
 *
 * `tsc` **不会删除**它不再产出的文件。目录重构 / 文件改名之后，旧路径的产物会留在 `dist/`
 * 里，而 `files: ["dist"]` 意味着它们**直接进 tarball**（tarball 里出现源码中已不存在的模块 =
 * 使用者拿到幽灵文件）。发布前手工 `rm -rf dist` 一直是发版检查表的一项；把它做成 `build`
 * 的第一步，这条就再也不用靠人记得。
 *
 * ⚠️ 顺序要紧：必须在 `tsc` **之前**（先清后建）。放进 copy-assets 里会把刚编译出来的产物删掉。
 * ⚠️ 默认只清**本次要构建的那棵树**（`root`）—— 别顺手把兄弟包的 dist 也删了：本机可能
 * 有别的 agent 正在用 `packages/cli/dist` 跑东西。
 *
 * 用法：`node scripts/clean-dist.mjs [root|cli|all]`（缺省 root）
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TREES = {
  root: ['../dist'],
  cli: ['../packages/cli/dist', '../packages/trace-view/dist'],
};

const target = process.argv[2] ?? 'root';
const rels = target === 'all' ? [...TREES.root, ...TREES.cli] : TREES[target];
if (!rels) {
  console.error(`clean-dist：未知目标 "${target}"（支持 root / cli / all）`);
  process.exit(1);
}
for (const rel of rels) {
  rmSync(fileURLToPath(new URL(rel, import.meta.url)), { recursive: true, force: true });
}
