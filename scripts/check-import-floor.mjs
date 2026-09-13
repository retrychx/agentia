// 守住 package.json 的 engines 声明（>=18）—— 把它变成**可执行**的。
//
// 为什么需要：本包的 store 层用了 node:sqlite（Node ≥22.5 才提供的内置模块）。
// 早先是对它**顶层静态 import**，而 `src/index.ts` 又 eager 再导出 SqliteTaskStore，
// 于是**整个包**在 Node 18/20 上「加载即崩」（ERR_UNKNOWN_BUILTIN_MODULE）——
// 可 engines 里写着 >=18。声明与实现不一致，而且无人守（CI 只跑 Node 22）。
//
// 本脚本在**最低支持版本**上真跑一遍：包可导入 + 关键导出在 + SqliteTaskStore
// 要么可用、要么给出可读报错（而不是崩溃）。任何一步退化，CI 立刻红。

import assert from 'node:assert/strict';

const mod = await import('../dist/index.js');

// 1) 包可被导入（这一步就是当初会崩的地方）
const exportsCount = Object.keys(mod).length;
assert.ok(exportsCount > 50, `导出面过少：${exportsCount}`);

// 2) 关键导出在位
for (const name of ['createApp', 'Tool', 'AsyncRunner', 'SqliteTaskStore', 'createBudgetPolicy']) {
  assert.ok(name in mod, `缺少导出：${name}`);
}

// 3) SqliteTaskStore：新 Node 应可用；旧 Node 应是**可读报错**而非崩溃
const [major, minor] = process.versions.node.split('.').map(Number);
const sqliteSupported = major > 22 || (major === 22 && minor >= 5);

if (sqliteSupported) {
  const store = new mod.SqliteTaskStore(':memory:');
  store.save({ taskId: 't1', status: 'queued', spec: {}, createdAt: Date.now() });
  assert.equal(store.get('t1')?.taskId, 't1', 'SqliteTaskStore 读写异常');
  console.log(
    `OK  Node ${process.versions.node}：包可导入（${exportsCount} 导出）、SqliteTaskStore 可用`,
  );
} else {
  assert.throws(
    () => new mod.SqliteTaskStore(':memory:'),
    /需要 Node ≥ 22\.5/,
    '旧 Node 上 SqliteTaskStore 应给出可读报错',
  );
  console.log(
    `OK  Node ${process.versions.node}：包可导入（${exportsCount} 导出）、SqliteTaskStore 给出可读报错`,
  );
}
