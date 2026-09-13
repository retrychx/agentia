<!--
提交 PR 前请确认：
- `bash scripts/verify-all.sh` 8/8 全绿；改过 mcp.ts 另跑 `npm run e2e:mcp`
- 新行为带了测试；语义变更同步了 `docs/spec.md` §10
- 改了 `docs/usage-guide.md` 时已重建派生物（dist/AGENTS.md、llms.txt）
- 新增公共导出已同步官网 api.html
-->

## 做了什么

<!-- 一两句话说明这个 PR 解决的问题。关联 issue：Fixes #123 -->

## 为什么这么做

<!-- 设计取舍、被否掉的替代方案、以及任何"看起来可以更简单"的地方为什么不行 -->

## 兼容性

- [ ] 无破坏性变更
- [ ] 有破坏性变更（在下方说明迁移方式，并在提交信息里用 `!` 标记）

## 验证

<!-- 贴关键输出。若是修 bug，说明"修复前的现象"与"为什么以前没被发现" -->

```
bash scripts/verify-all.sh
→ 8/8 全绿
```

## 自查

- [ ] 分层未越界（改了依赖方向则同步改了 `layering.test.ts` 的 `ALLOWED`）
- [ ] 没引入新的运行时依赖（可选能力走 duck-typed / peer）
- [ ] 文档与代码没有漂移（单源 + 守卫测试已跑）
