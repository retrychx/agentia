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
 * 契约：返回值必须满足 `core` 的 `ModelClient` 结构面。
 *
 * ⚠️ **不能直接 `return new Anthropic(...)`**（2026-09-14 修）：`ModelClient` 契约把 `signal`
 * 放在 **params 内部**，而 SDK 的签名是 `stream(body, options?)`，`signal` **只在 `RequestOptions`
 * 里认**。把 signal 放 body 里会被 SDK **静默丢弃** ⇒ 调用方无法中止在飞请求。
 * 真端点实测（`scripts/e2e-live.ts` 步骤 ⑤）：
 *
 * | signal 位置 | abort 后的实测结果 |
 * |---|---|
 * | body 内（旧实现） | 收到 **599 个分片后仍跑完**，1.4s 才结束 —— 中止被吞 |
 * | RequestOptions（现实现） | 2 个分片即断，**1ms** 内以 `Request was aborted.` 收场 |
 *
 * 这不只是「少个功能」：`transport/async.ts` 的 `runTimeoutMs` 对外承诺「到点真中止、
 * token 不再继续烧」，靠的就是这个 signal。旧实现下超时的 run 会在后台**继续烧 token**
 * 直到模型自己说完。`integrations/openai.ts` 是手写 fetch，本来就转发 signal（无此问题）。
 */
export interface AnthropicClientOptions {
  /** 缺省读环境变量 `ANTHROPIC_API_KEY` */
  apiKey?: string;
  /** 缺省读环境变量 `ANTHROPIC_BASE_URL`（兼容端点 / 网关） */
  baseURL?: string;
  /** 其余构造参数原样透传给 SDK（高级用法） */
  [key: string]: unknown;
}

/**
 * 把 `ModelClient` 契约里的 `signal`（在 params 内部）拆到 SDK 的 `RequestOptions` 上。
 *
 * 单独导出只为**可测**：这是「默认 client 到底能不能中止在飞请求」的唯一分界点，
 * 白盒探查 SDK 内部不现实，但这一步的输入/输出可以钉死（见 `tests/integrations/anthropic.test.ts`）。
 */
export function splitSignal(params: { signal?: AbortSignal | null; [key: string]: unknown }): {
  body: Record<string, unknown>;
  options: { signal?: AbortSignal };
} {
  const { signal, ...body } = params;
  return { body, options: signal ? { signal } : {} };
}

/** 创建默认 ModelClient（Anthropic）。不传则完全走 SDK 的默认凭据解析。 */
export function createAnthropicClient(options: AnthropicClientOptions = {}): ModelClient {
  const client = new Anthropic(options as ConstructorParameters<typeof Anthropic>[0]);
  const messages = client.messages;
  const nativeStream = messages.stream.bind(messages);
  // 包一层：把契约里的 signal 搬到 RequestOptions（详见文件头注释里的实测对照表）。
  messages.stream = ((body: Record<string, unknown>, requestOptions?: Record<string, unknown>) => {
    const { body: cleanBody, options: signalOptions } = splitSignal(body);
    return nativeStream(cleanBody as never, { ...requestOptions, ...signalOptions });
  }) as typeof messages.stream;
  return client;
}
