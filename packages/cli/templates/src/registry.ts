// Agentia 能力注册表 —— 由 agentia CLI 维护（agentia g 自动更新，也可手工编辑）
// @agentia:imports
// @agentia:imports-end
import type { Provider } from '@migor/agentia';

/** 显式装配路线：createApp({ providers, system: ... })（与 discover 目录扫描二选一或混用） */
export const providers: Provider[] = [
  // 「工作目录」以**值**注入给需要它的能力（消费方式见 src/tools/read-file/index.ts）。
  // 想改成固定路径 / 从环境变量取，改这一行即可 —— 这是显式装配路线的意义。
  { provide: 'WORKDIR', useValue: process.cwd() },
  // @agentia:entries
  // @agentia:entries-end
];
