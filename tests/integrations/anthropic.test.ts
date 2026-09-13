import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicClient } from '../../src/index.js';

/**
 * `createAnthropicClient` 是 `@anthropic-ai/sdk` 在框架内的**唯一实例化点**。
 * 这两条用例守的是「缝」本身：① 返回值满足 `ModelClient` 结构面（构造期不触网）；
 * ② 自定义项透传不抛错。真正的模型调用由 mock client 在别处覆盖。
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
