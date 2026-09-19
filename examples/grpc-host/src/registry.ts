import type { Provider } from '@migor/agentia';
import Echo from './tools/echo/index.js';

/**
 * 显式注册表（与 `agentia g` 维护的形状一致：`{ provide: '<文件夹名>', useClass: <类> }`）。
 *
 * ⚠️ 换宿主**不需要动这一份** —— 这正是本示例要证明的事：能力声明、菜单、trace 记账
 * 与 HTTP 宿主那份完全同形，变的只有「谁把请求翻译成 RunInput」。
 */
export const providers: Provider[] = [{ provide: 'echo', useClass: Echo }];
