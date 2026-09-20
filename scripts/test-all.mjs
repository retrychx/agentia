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
import { fileURLToPath } from 'node:url';

// 覆盖率棘轮走 c8（devDependency），**不是** node 内建的 --experimental-test-coverage：
// 后者在 `--import tsx`（loader hook）下整个失灵 —— 覆盖率报告不产出、阈值永不触发
// （实测：--test-coverage-lines=100 仍然 exit 0，门禁是死的）。c8 经
// NODE_V8_COVERAGE 收各子进程的原始 V8 覆盖率再按 source map 重映射，tsx 下可用。
// 阈值 = 棘轮防退化（2026-09-21 c8 实测：行 98.88 / 分支 91.71 / 函数 98.5，阈值留了余量），
// 不是目标 —— 别追 100%，剩下的多是防御性兜底，凑数测试 = 真空变绿。
// 只挂框架套件：CLI / trace-view 的产物不在 src/ 口径内。
const C8 = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url));
const COVERAGE = {
  lines: 95,
  branches: 85,
  functions: 92,
};

const suites = [
  {
    name: '框架套件（tests/**/*.test.ts，含 c8 覆盖率棘轮）',
    args: [
      C8,
      '--check-coverage',
      '--lines',
      String(COVERAGE.lines),
      '--branches',
      String(COVERAGE.branches),
      '--functions',
      String(COVERAGE.functions),
      '--include',
      'src/**',
      '--reporter',
      'text',
      // c8 之后的参数是被测命令本身：node --import tsx --test …
      process.execPath,
      '--import',
      'tsx',
      '--test',
      'tests/**/*.test.ts',
    ],
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
