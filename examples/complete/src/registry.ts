import type { Provider } from '@migor/agentia';
import Echo from './tools/echo/index.js';
import HouseStyle from './prompts/house-style/index.js';
import OutlineWriter from './skills/outline-writer/index.js';
import Researcher from './subagents/researcher/index.js';

/**
 * 显式注册表 —— 形状与 `agentia g` 维护的 `src/registry.ts` 完全一致
 * （`{ provide: '<文件夹名>', useClass: <类> }`），所以两者可互换、可混用。
 *
 * 另一条路线是目录扫描：`createApp({ discover: ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'] })`
 * （返回 Promise），与显式装配同 token 时**显式优先**。
 */
export const providers: Provider[] = [
  { provide: 'echo', useClass: Echo },
  { provide: 'outline-writer', useClass: OutlineWriter },
  { provide: 'researcher', useClass: Researcher },
  { provide: 'house-style', useClass: HouseStyle },
];
