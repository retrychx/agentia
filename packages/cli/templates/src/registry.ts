// Agentia 能力注册表 —— 由 agentia CLI 维护（agentia g 自动更新，也可手工编辑）
// @agentia:imports
// @agentia:imports-end
import type { Provider } from '@migor/agentia';

/** 显式装配路线：createApp({ providers, system: ... })（与 discover 目录扫描二选一或混用） */
export const providers: Provider[] = [
  // 「工作目录」以**值**注入给需要它的能力（消费方式见 src/tools/read-file/index.ts）。
  // 想改成固定路径 / 从环境变量取，改这一行即可 —— 这是显式装配路线的意义。
  //
  // ⚠️ 与 src/app.ts 里那份 `WORKDIR` 是**二选一**的关系，混用时**顺序承重**：
  // createApp 对同 token 是「后注册覆盖先注册」—— 把这份 providers 拼在 app.ts 那份
  // **之后**，dev 面板喂进来的 workdir 会被这里的 `process.cwd()` 静默顶掉。
  // 要混用就让本注册表排在前（让 app.ts 的值赢），否则只留一边。
  { provide: 'WORKDIR', useValue: process.cwd() },
  // @agentia:entries
  // @agentia:entries-end
];
