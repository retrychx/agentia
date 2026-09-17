/**
 * 真模型入口（npm start）—— 与 demo **同一份装配、同一个 runReview**，差别只在 client：
 * 不传 client 即走框架默认 Anthropic client（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL，
 * 任何 Anthropic 协议兼容端点都行），模型读 AGENTIA_MODEL（缺省 deepseek-v4-flash，
 * 已在装配时配 priceOverrides）。产物同样落在 out/。
 */
import { loadEnvFile } from '@migor/agentia';
import { runReview } from './review.js';

loadEnvFile(); // 读示例根 .env；真实环境变量优先（已 export 的键不被文件压住）

await runReview({});
