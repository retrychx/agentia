import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, loadEnvFile, SystemPrompt } from '@migor/agentia';

// 读同目录的 .env（key 写文件里即可，不必每次 export）。框架**不自动**读 .env ——
// 读哪个文件、什么时候读由这里决定；已存在的真实环境变量优先，不会被文件覆盖。
// 想换路径/顺序：loadEnvFile({ path: '.env.local' }) 或直接删掉这一行改用自己的加载器。
loadEnvFile();

// 能力目录按**本文件位置**解析，不是 cwd：开发态（src/main.ts）解析到 src/<分类>/，
// 构建后（dist/main.js）解析到 dist/<分类>/ —— 从任何目录启动都成立。
// ⚠️ 别改回 cwd 相对写法（形如 src/tools 的字符串）：那样 `node dist/main.js` 会去加载 src 下的
// .ts 源码，而装饰器不是可擦除的类型语法，Node 直接跑不了（"Invalid or unexpected token"）。
// filter：空分类目录在构建后不存在（tsc 不为空目录产出 dist/<分类>/），而 discover 对
// 显式给出的不存在路径是报错的 —— 「这类暂时没有能力」不该让启动失败。
const CAPABILITY_DIRS = ['tools', 'skills', 'prompts', 'subagents'];
const app = await createApp({
  name: '__PROJECT_NAME__',
  discover: CAPABILITY_DIRS.map((d) => fileURLToPath(new URL(d + '/', import.meta.url))).filter(
    (dir) => existsSync(dir),
  ),
  system: new SystemPrompt().add('role', '你是 __PROJECT_NAME__ 的主 agent，按任务自主调度菜单里的能力。', true),
});

const { result } = await app.run(
  [{ role: 'user', content: process.argv[2] ?? '介绍一下你自己' }],
);

// 注意：run 失败**不会抛**（硬失败被记进 result.error 与 trace 后正常返回）—— 不显式检查就会
// 「打印一行空白 + 退出 0」，让首次运行（比如忘了配 ANTHROPIC_API_KEY）看起来像成功。
if (result.error) {
  console.error(`run 失败（stopReason=${result.stopReason}）：${result.error.message}`);
  console.error('提示：模型调用读 ANTHROPIC_API_KEY —— 填进 .env（首行 loadEnvFile() 会读）或 export 均可；');
  console.error('      换端点 / 注入自定义 client 见项目内 AGENTS.md。');
  process.exitCode = 1;
}
if (result.finalText) console.log(result.finalText);
