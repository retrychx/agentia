import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../core/tool.js';

/**
 * Agentia —— 默认 ModelClient：Anthropic Messages API。
 *
 * **为什么要有这个工厂**：这是 `@anthropic-ai/sdk` 在框架内的**唯一实例化点**。
 * 引擎（`engine/loop.ts`）只经由此处取默认 client，不再散落 `new Anthropic()`。两个好处：
 *
 * ① **使用者不必接触厂商 SDK 的类** —— 想自定义只传 `apiKey` / `baseURL`
 *    （或直接用环境变量 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`）；
 * ② 厂商 SDK 成为一个**可替换的实现细节** —— 将来若换自研 fetch 实现（去掉依赖），
 *    只动这一个文件，引擎与公共契约都不变。
 *
 * 契约：返回值必须满足 `core` 的 `ModelClient` 结构面（Anthropic SDK 天然满足）。
 */
export interface AnthropicClientOptions {
  /** 缺省读环境变量 `ANTHROPIC_API_KEY` */
  apiKey?: string;
  /** 缺省读环境变量 `ANTHROPIC_BASE_URL`（兼容端点 / 网关） */
  baseURL?: string;
  /** 其余构造参数原样透传给 SDK（高级用法） */
  [key: string]: unknown;
}

/** 创建默认 ModelClient（Anthropic）。不传则完全走 SDK 的默认凭据解析。 */
export function createAnthropicClient(options: AnthropicClientOptions = {}): ModelClient {
  return new Anthropic(options as ConstructorParameters<typeof Anthropic>[0]);
}
