import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicClient } from '../../src/index.js';
import { splitSignal } from '../../src/integrations/anthropic.js';
import { waitFor } from '../helpers.js';

/**
 * `createAnthropicClient` 是 `@anthropic-ai/sdk` 在框架内的**唯一实例化点**。
 *
 * 前三段守「缝」本身：① 返回值满足 `ModelClient` 结构面（构造期不触网）；② 自定义项透传不抛错；
 * ③ **signal 真的被搬到传输层** —— 这条是 2026-09-14 补的：此前实现是直接
 * `return new Anthropic(...)`，而 `ModelClient` 契约把 `signal` 放在 **params 内部**、
 * SDK 只在 `RequestOptions` 里认它 ⇒ signal 被**静默丢弃**，中止在飞请求失效。
 *
 * 「真正的模型调用」仍由 mock client 在别处覆盖；但**中止**这一条不用真端点也能守 ——
 * 下面用本地假端点（零 key、零外网）钉死「abort 后必须断开」，旧实现会在这里**挂住**。
 */
describe('createAnthropicClient（默认 ModelClient 的唯一实例化点）', () => {
  it('返回满足 ModelClient 结构面的对象（构造期不触网）', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test' });
    assert.equal(typeof client.messages.stream, 'function', '须提供 messages.stream');
  });

  it('自定义项（apiKey / baseURL）透传，构造不抛错', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-test',
      baseURL: 'http://localhost:1',
    });
    assert.equal(typeof client.messages.stream, 'function');
  });
});

describe('splitSignal：契约的 signal 必须被搬到 SDK 的 RequestOptions', () => {
  it('signal 从 body 里被摘出来（留在 body 里 = 被 SDK 静默丢弃）', () => {
    const ac = new AbortController();
    const { body, options } = splitSignal({ model: 'm', max_tokens: 8, signal: ac.signal });
    assert.equal('signal' in body, false, 'body 里不得残留 signal');
    assert.equal(options.signal, ac.signal, 'signal 必须出现在 options 里');
    assert.equal(body.model, 'm', '其余字段原样进 body');
  });

  it('没有 signal 时不产生冗余键（不改变 SDK 既有行为）', () => {
    const { body, options } = splitSignal({ model: 'm' });
    assert.deepEqual(options, {});
    assert.deepEqual(body, { model: 'm' });
  });

  it('signal 为 null / undefined 一律不搬（契约里是可选字段）', () => {
    for (const s of [null, undefined]) {
      const { body, options } = splitSignal({ model: 'm', signal: s });
      assert.deepEqual(options, {});
      assert.equal('signal' in body, false);
    }
  });
});

describe('中止在飞请求（零 key、零外网：本地假端点）', () => {
  it('abort 后请求必须断开；旧实现（signal 留在 body）会在这里挂住', async () => {
    // 假端点**故意不响应**：请求就此挂在飞 —— 正是「调用方想中止在飞 run」的场景。
    let hits = 0;
    const server = createServer((_req, _res) => {
      hits += 1; // 收到即可，不写响应、不结束
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
        maxRetries: 0, // 别让 SDK 重试掩盖「没断」这件事
      });
      const ac = new AbortController();
      const s = client.messages.stream({
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      });
      // 触发点用**假端点真收到请求**，不用 sleep 猜时间（确定性）
      await waitFor(() => hits > 0, '假端点收到请求', 5_000);
      ac.abort();

      const outcome = await Promise.race([
        s.finalMessage().then(
          () => 'resolved',
          (e: unknown) => `rejected:${(e as Error).name}`,
        ),
        new Promise<string>((r) => setTimeout(() => r('hung'), 3_000)),
      ]);
      assert.notEqual(
        outcome,
        'hung',
        'abort 之后 3s 仍未结束 ⇒ signal 没被转发到传输层（在飞 run 无法中止）',
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
