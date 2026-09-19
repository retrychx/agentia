// 单测总入口：`npm test` 的唯一实现。
//
// 为什么是它而不是 package.json 里的 `&&` 串联：三段套件用 `&&` 连接时，
// 框架套件一挂，CLI 与 trace-view 套件**静默不跑** —— 而 packages/cli/test 里
// 恰好放着 harvest / diffTraces 的「移植副本逐字对拍」守卫，跳过它等于放掉防线；
// 且 verify-all.sh / CI 把 npm test 当单步，整条链上无人发现跳过。
//
// 本脚本依次 spawn 三个套件，**无论前面成败三个都跑完**，各自透传输出，
// 最后统一汇总并决定退出码。glob 参数原样传给 node --test（由 node 自己展开），
// 与原脚本行为一致；用 process.execPath 起手，不依赖 PATH 里的 node（Windows 同理）。

import { spawn } from 'node:child_process';

const suites = [
  {
    name: '框架套件（tests/**/*.test.ts）',
    args: ['--import', 'tsx', '--test', 'tests/**/*.test.ts'],
  },
  {
    name: 'CLI 套件（packages/cli/test/*.test.mjs）',
    args: ['--test', 'packages/cli/test/*.test.mjs'],
  },
  {
    name: 'trace-view 套件（packages/trace-view/test/*.test.js）',
    args: ['--test', 'packages/trace-view/test/*.test.js'],
  },
];

// 依次跑完全部套件；任一失败不中断后续套件。
const results = [];
for (const suite of suites) {
  console.log(`\n========== ${suite.name} ==========`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, suite.args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`spawn 失败：${err.message}`);
      resolve(1);
    });
    child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  results.push({ name: suite.name, code });
}

console.log('\n========== 套件汇总 ==========');
for (const { name, code } of results) {
  console.log(`${code === 0 ? 'OK ' : '✖ '} ${name}（exit ${code}）`);
}
const failed = results.filter(({ code }) => code !== 0);
if (failed.length > 0) {
  console.error(`\n✖ ${failed.length} 个套件失败：${failed.map(({ name }) => name).join('、')}`);
  process.exit(1);
}
console.log('\nOK  三个套件全部通过');
