import { createAgentApp } from './app.js';

// 装配在 app.ts 里（与启动分离）：`agentia dev` 的调试环要复用同一个工厂，
// 才能把「能力选择 / 工作目录」喂进 createApp。别把 createApp(...) 搬回这里。
// `.env` 也由 app.ts 读 —— 那才是 `agentia dev` 与 `npm start` **都**会经过的那条路
// （本文件在 dev 环下根本不执行），写在这里会让两个入口的行为不一致。
const app = await createAgentApp();

const { result } = await app.run([{ role: 'user', content: process.argv[2] ?? '介绍一下你自己' }]);

// 注意：run 失败**不会抛**（硬失败被记进 result.error 与 trace 后正常返回）—— 不显式检查就会
// 「打印一行空白 + 退出 0」，让首次运行（比如忘了配 ANTHROPIC_API_KEY）看起来像成功。
if (result.error) {
  console.error(`run 失败（stopReason=${result.stopReason}）：${result.error.message}`);
  console.error('提示：模型调用读 ANTHROPIC_API_KEY —— 填进 .env（src/app.ts 的 loadEnvFile() 会读）或 export 均可；');
  console.error('      换端点 / 注入自定义 client 见项目内 AGENTS.md。');
  process.exitCode = 1;
}
if (result.finalText) console.log(result.finalText);
