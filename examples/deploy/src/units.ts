import type { Provider } from '@migor/agentia';
import Echo from './units/echo/index.js';

/**
 * 显式注册表（与 `agentia g` 维护的形状一致：`{ provide: '<文件夹名>', useClass: <类> }`）。
 * 也可改用目录扫描 `createApp({ discover: 'src/units' })`（返回 Promise）。
 */
export const providers: Provider[] = [{ provide: 'echo', useClass: Echo }];
